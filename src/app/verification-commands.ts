import { CommandResultSchema, type CommandResult, type ProjectConfig } from '../contracts/index.js';
import type { ProcessRunner } from '../ports/process-runner.js';

/** Order matters: cheap and fast checks first, so failures surface sooner. */
export const VERIFICATION_ORDER = ['lint', 'typecheck', 'test', 'build'] as const;
export type VerificationStep = (typeof VERIFICATION_ORDER)[number];

const DEFAULT_TIMEOUT_SECONDS = 900;
/** Enough to diagnose a failure, small enough to put in a prompt. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The shell that runs an operator's command line, on the host this is running on.
 *
 * **`/bin/sh` was hardcoded, and on Windows that is not a shell — it is a spawn failure.**
 * Both callers below turn a configured line into a process, and both asked for `/bin/sh`
 * unconditionally, so on Windows every `lint`, `typecheck`, `test`, `build` and `install`
 * came back `exit 127`. That number describes the machine and is read as a verdict on the
 * code: it is the exact failure `prepareWorkspace` was written to prevent, arriving by
 * another door. Nothing above this line can tell the difference.
 *
 * `/d /s /c` is the invocation `cmd.exe` wants for one command line: `/d` skips AutoRun
 * commands out of the registry — someone else's `HKCU\…\Command Processor\AutoRun` is not
 * part of this run — and `/s` makes `cmd` strip the outer quotes Node puts around the
 * line, which is what keeps `npm run lint` from arriving as a single quoted token.
 *
 * This is deliberately *not* in the `ProcessRunner`. The runner spawns argv; deciding that
 * a configured string needs a shell is this module's decision, and a runner that rewrote
 * `/bin/sh` into `cmd` would be silently reinterpreting every caller's argv.
 */
export function shellInvocation(commandLine: string): { command: string; args: string[] } {
  return process.platform === 'win32'
    ? { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', commandLine] }
    : { command: '/bin/sh', args: ['-c', commandLine] };
}

export interface VerificationOutcome {
  readonly passed: boolean;
  readonly results: CommandResult[];
  /** Steps the project does not define. Not an error (§7). */
  readonly skipped: VerificationStep[];
}

export interface RunVerificationOptions {
  readonly processRunner: ProcessRunner;
  readonly project: ProjectConfig | undefined;
  readonly cwd: string;
  readonly timeoutSeconds?: number;
  readonly onStep?: (step: VerificationStep, result: CommandResult) => void;
}

/**
 * Runs the project's own validation commands.
 *
 * agent-flow runs these itself, never an agent (AD-10). Two reasons, and the
 * second is the one that actually forces it:
 *
 *  - A read-only sandbox cannot run a test suite. Tests write to disk —
 *    coverage output, build caches — so asking a read-only agent to run them is
 *    a contradiction the spec does not resolve (§25 vs §35).
 *  - Knowing whether `npm test` passes should not cost an LLM call. It is a
 *    process exit code.
 *
 * Every command runs even when an earlier one fails: someone fixing a build
 * wants to know the tests are also broken, not to discover it one round later.
 */
export async function runVerification(
  options: RunVerificationOptions,
): Promise<VerificationOutcome> {
  const { processRunner, project, cwd } = options;
  const commands = project?.commands ?? {};

  const results: CommandResult[] = [];
  const skipped: VerificationStep[] = [];

  for (const step of VERIFICATION_ORDER) {
    const command = commands[step]?.trim();

    // A project without a lint script is not a project that failed lint.
    if (command === undefined || command.length === 0) {
      skipped.push(step);
      continue;
    }

    const spawned = await processRunner.run({
      // Through a shell because config holds command lines, not argv.
      ...shellInvocation(command),
      cwd,
      // The operator's own commands, run as they wrote them (PRI-17). `npm test` may
      // need a database URL, a registry token or a language toolchain nobody can enumerate
      // from here, and an allowlist would break real projects to protect against the
      // operator's own configuration. `docs/security.md` already says `project.commands.*`
      // are not isolated; this keeps that true rather than half-true.
      envMode: 'inherit',
      timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });

    const result = CommandResultSchema.parse({
      command,
      // A timeout or a failed spawn is a failure; null would read as "unknown".
      exitCode: spawned.exitCode ?? (spawned.timedOut ? 124 : 127),
      durationMs: spawned.durationMs,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      truncated: spawned.truncated,
    });

    results.push(result);
    options.onStep?.(step, result);
  }

  return {
    passed: results.every((result) => result.exitCode === 0),
    results,
    skipped,
  };
}

export interface RunCommandsOptions {
  readonly processRunner: ProcessRunner;
  /**
   * Already resolved from configuration. Callers must not pass anything that
   * originated in model output — see core/validation-registry.ts.
   */
  readonly commands: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds?: number;
}

/**
 * Runs an explicit list of commands, in order, reporting all of them.
 *
 * Used for per-task validation, where the steps come from resolving the ids a
 * plan referenced rather than from the project's standard lint/test/build set.
 */
export async function runCommands(options: RunCommandsOptions): Promise<VerificationOutcome> {
  const results: CommandResult[] = [];

  for (const command of options.commands) {
    const spawned = await options.processRunner.run({
      ...shellInvocation(command),
      cwd: options.cwd,
      // The operator's own commands, run as they wrote them (PRI-17). `npm test` may
      // need a database URL, a registry token or a language toolchain nobody can enumerate
      // from here, and an allowlist would break real projects to protect against the
      // operator's own configuration. `docs/security.md` already says `project.commands.*`
      // are not isolated; this keeps that true rather than half-true.
      envMode: 'inherit',
      timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });

    results.push(
      CommandResultSchema.parse({
        command,
        exitCode: spawned.exitCode ?? (spawned.timedOut ? 124 : 127),
        durationMs: spawned.durationMs,
        stdout: spawned.stdout,
        stderr: spawned.stderr,
        truncated: spawned.truncated,
      }),
    );
  }

  return { passed: results.every((result) => result.exitCode === 0), results, skipped: [] };
}

/** Compact rendering for a prompt or a terminal. */
export function summariseVerification(outcome: VerificationOutcome): string {
  if (outcome.results.length === 0) {
    return 'No validation commands are configured for this project.';
  }

  const lines = outcome.results.map((result) => {
    const status = result.exitCode === 0 ? 'passed' : `failed (exit ${String(result.exitCode)})`;
    return `- \`${result.command}\` ${status} in ${String(result.durationMs)}ms`;
  });

  if (outcome.skipped.length > 0) {
    lines.push(`- not configured: ${outcome.skipped.join(', ')}`);
  }

  return lines.join('\n');
}

/** Failure output only — the part worth a reviewer's attention. */
export function failureDetail(outcome: VerificationOutcome, maxBytes = 8_000): string {
  const failures = outcome.results.filter((result) => result.exitCode !== 0);
  if (failures.length === 0) return '';

  return failures
    .map((result) => {
      const body = `${result.stdout}\n${result.stderr}`.trim().slice(0, maxBytes);
      return `### \`${result.command}\` (exit ${String(result.exitCode)})\n\n\`\`\`\n${body}\n\`\`\``;
    })
    .join('\n\n');
}
