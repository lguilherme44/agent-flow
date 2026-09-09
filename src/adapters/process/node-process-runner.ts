import { spawn } from 'node:child_process';
import { agentEnvironment } from '../../core/process-environment.js';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from '../../ports/process-runner.js';

/** Enough for a large agent response, small enough not to threaten the heap. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Whether `process.kill(-pid)` can signal a process group.
 *
 * POSIX only. On Windows `detached` opens a new console instead of a process group and
 * there is no negative-pid convention, so this stays false there — and the tree is killed
 * with `taskkill /T /F` instead. See {@link NodeProcessRunner.run}'s `killTree`, which is
 * the fix this constant was left here to hang off.
 */
const SUPPORTS_PROCESS_GROUPS = process.platform !== 'win32';

/**
 * Accumulates child output with a hard ceiling.
 *
 * An agent that decides to cat the whole repository should degrade into a
 * truncated log, not into an out-of-memory crash in the orchestrator.
 */
class BoundedBuffer {
  private readonly chunks: string[] = [];
  private size = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    if (this.overflowed) return;

    if (this.size + chunk.length <= this.limit) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }

    this.chunks.push(chunk.slice(0, Math.max(0, this.limit - this.size)));
    this.chunks.push(`\n… [truncated: output exceeded ${this.limit} bytes]`);
    this.overflowed = true;
  }

  get truncated(): boolean {
    return this.overflowed;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

/**
 * The environment the child is given.
 *
 * Two shapes, chosen by the caller (PRI-17). `allowlist` is the default and builds an
 * environment from what a runner needs; `inherit` is the parent's, minus `unsetEnv`.
 *
 * Under `inherit`, `delete` rather than assigning an empty string, because for the
 * variables that mode exists for the two are not the same: Git reads `GIT_DIR=''` as a
 * repository path that happens to be empty and fails, rather than as an absent variable.
 * `undefined` values would also survive into `spawn` on some Node versions as the literal
 * string, so the key is removed outright.
 */
function environmentFor(options: ProcessSpawnOptions): NodeJS.ProcessEnv {
  if ((options.envMode ?? 'allowlist') === 'allowlist') {
    // `unsetEnv` is honoured here too, for the caller that wants both — a removal is a
    // stronger statement than the allowlist's silence, and a name that is both allowed
    // and explicitly unset must not survive.
    const { env } = agentEnvironment(
      process.env,
      options.env ?? {},
      options.envPass === undefined ? {} : { pass: options.envPass },
    );

    for (const name of options.unsetEnv ?? []) {
      delete env[name];
    }

    return env;
  }

  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const name of options.unsetEnv ?? []) {
    delete env[name];
  }

  return { ...env, ...options.env };
}

/**
 * The real ProcessRunner.
 *
 * It never throws for a failing child: a non-zero exit, a timeout and a missing
 * executable are all ordinary outcomes reported in the result. Deciding what
 * they *mean* belongs to the runner adapter above (§22.1), which is the only
 * layer that knows how its CLI expresses "out of quota" versus "crashed".
 */
export class NodeProcessRunner implements ProcessRunner {
  async run(options: ProcessSpawnOptions): Promise<ProcessResult> {
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const startedAt = Date.now();

    // Asked before spawning. A signal that is already aborted must not start a process
    // and then immediately kill it: the child would run for whatever time the spawn takes,
    // and on a cancelled run that is an agent invocation somebody is billed for.
    if (options.signal?.aborted === true) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        cancelled: true,
        spawnFailed: false,
        truncated: false,
      };
    }

    return new Promise<ProcessResult>((resolve) => {
      const stdout = new BoundedBuffer(maxBytes);
      const stderr = new BoundedBuffer(maxBytes);

      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        // Built, not inherited, unless the caller asked for inheritance and said why
        // (PRI-17). The runners still receive each CLI's own local authentication (§54);
        // what they no longer receive is every other credential the operator's shell
        // exports.
        env: environmentFor(options),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Puts the child in its own process group so the whole tree can be
        // signalled at once. Without this the timeout does not work at all:
        // the agent CLIs and every validation command spawn children of their
        // own, those children inherit the stdout pipes, and Node emits `close`
        // only once the process has exited *and* every stream is closed. Killing
        // just the direct child leaves the promise pending until the grandchild
        // finishes on its own — measured at 4s against a 300ms timeout.
        //
        // Not unref'd: the parent must stay alive to collect the output.
        detached: SUPPORTS_PROCESS_GROUPS,
      });

      /**
       * Signals the whole tree, by whichever mechanism the platform has.
       *
       * POSIX: a negative pid means "the group". It throws ESRCH once nothing is left to
       * signal, which is the normal end state rather than an error.
       *
       * **Windows: `taskkill /T`, and it is not a nicety.** There is no process group and
       * no negative-pid convention there, so `child.kill()` reaches only the direct child
       * — and every case this runner exists for spawns children: the agent CLIs, `npm
       * test`, anything shelled out. Node emits `close` once the process has exited *and*
       * every inherited stdout pipe is closed, so killing only the parent leaves the
       * promise pending until the grandchild finishes on its own. Measured on POSIX before
       * the group fix: 4s against a 300ms timeout. Windows had that defect for the whole
       * MVP, with a comment saying so and nothing hanging off it.
       *
       * `taskkill` is fire-and-forget: it is spawned detached from this runner's own
       * bookkeeping, and its failure — the tree already gone, most often — is the normal
       * end state, exactly as ESRCH is on POSIX. `/F` because the graceful half of the
       * escalation has no Windows equivalent worth the wait: there is no SIGTERM for a
       * console process that is not attached to this console, so the grace period below
       * degrades into a delay before the only signal that works.
       */
      const killTree = (signal: NodeJS.Signals): void => {
        try {
          if (SUPPORTS_PROCESS_GROUPS && child.pid !== undefined) {
            process.kill(-child.pid, signal);
            return;
          }

          if (process.platform === 'win32' && child.pid !== undefined) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            }).on('error', () => {
              // `taskkill` missing from PATH is not something this runner can repair,
              // and the direct-child kill below is still better than nothing.
              child.kill(signal);
            });
            return;
          }

          child.kill(signal);
        } catch {
          // Already gone, or never started. Either way there is nothing to do.
        }
      };

      /**
       * SIGTERM now, SIGKILL after the grace period.
       *
       * Shared by the timeout and the cancellation, which is the point: a cancel that
       * signalled only the direct child would leave exactly the orphans the `detached`
       * flag above exists to prevent, and the two paths would drift.
       */
      const stopTree = (): void => {
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), graceMs);
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        stopTree();
      }, options.timeoutSeconds * 1000);

      if (options.signal !== undefined) {
        onAbort = (): void => {
          cancelled = true;
          stopTree();
        };
        // `once`, so a signal reused across several spawns does not accumulate listeners
        // and warn at ten. The matching `removeEventListener` is in `finish`, for the
        // ordinary case where the child exits first and the signal outlives it.
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const finish = (result: Omit<ProcessResult, 'durationMs' | 'truncated'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);

        resolve({
          ...result,
          durationMs: Date.now() - startedAt,
          truncated: stdout.truncated || stderr.truncated,
        });
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

      // ENOENT and friends. The Codex CLI fails exactly here when its native
      // binary is missing while the npm package is still installed.
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish({
          exitCode: null,
          signal: null,
          stdout: stdout.toString(),
          stderr: `${stderr.toString()}${error.message}`,
          timedOut: false,
          cancelled,
          spawnFailed: true,
        });
      });

      child.on('close', (code, signal) => {
        finish({
          exitCode: code,
          signal,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          // A cancelled child that also passed its timeout is reported as cancelled: the
          // operator's decision is the reason it stopped, and classifying it as a timeout
          // would record the work as having failed.
          timedOut: timedOut && !cancelled,
          cancelled,
          spawnFailed: false,
        });
      });

      if (options.stdin !== undefined) {
        child.stdin?.on('error', () => {
          // The child may exit before reading stdin; that is its business.
        });
        child.stdin?.end(options.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }
}
