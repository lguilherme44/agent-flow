import { spawn } from 'node:child_process';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from '../../ports/process-runner.js';

/** Enough for a large agent response, small enough not to threaten the heap. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

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

    return new Promise<ProcessResult>((resolve) => {
      const stdout = new BoundedBuffer(maxBytes);
      const stderr = new BoundedBuffer(maxBytes);

      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        // Inherit the parent environment: the runners depend on each CLI's own
        // local authentication (§54), which lives in the environment and the
        // user's home directory. Wiping it would break the whole premise.
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Escalate if the child ignores the polite request.
        killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      }, options.timeoutSeconds * 1000);

      const finish = (result: Omit<ProcessResult, 'durationMs' | 'truncated'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);

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
          spawnFailed: true,
        });
      });

      child.on('close', (code, signal) => {
        finish({
          exitCode: code,
          signal,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
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
