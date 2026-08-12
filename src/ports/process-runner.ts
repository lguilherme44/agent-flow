/**
 * Spawning a child process, behind a port so the whole tool can be tested
 * without launching anything (R-13).
 *
 * Both runner adapters and the verification command runner (AD-10) go through
 * this, which is why the shape is deliberately generic.
 */
export interface ProcessSpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Variables to delete from the inherited environment, applied before `env`.
   *
   * `env` can only ever *set* a variable, because the child's environment is the
   * parent's with these overrides merged on top. That is the right default —
   * every runner depends on the parent's `PATH`, `HOME` and the CLI
   * authentication that lives there — and it leaves one thing impossible:
   * removing an inherited variable that changes how the child interprets its own
   * arguments.
   *
   * Git is where that matters. `GIT_DIR` in the environment relocates the
   * repository a command operates on regardless of `cwd`, and there is no value
   * that reads as "unset": probed, `GIT_DIR=` fails with
   * `not a git repository: ''`. So removal has to be expressible, and the Git
   * boundary is the only caller that asks for it (see `GIT_HOSTILE_ENVIRONMENT`
   * in `src/adapters/git/git-command.ts`).
   *
   * Deliberately a removal list rather than an "empty environment" switch: a
   * child started with a scrubbed environment would lose the authentication the
   * runners depend on, which is a much larger change than the problem needs.
   */
  readonly unsetEnv?: readonly string[];
  readonly timeoutSeconds: number;
  /** Fed to the child's stdin, then closed. */
  readonly stdin?: string;
  /** Beyond this, output is truncated and the result says so. */
  readonly maxOutputBytes?: number;
  /**
   * Grace period between SIGTERM and SIGKILL. A CLI that traps SIGTERM must not
   * be able to hold the pipeline open indefinitely.
   */
  readonly killGraceMs?: number;
}

export interface ProcessResult {
  /** Null when the process was killed by a signal rather than exiting. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when the process was killed for exceeding its timeout (R-11). */
  readonly timedOut: boolean;
  /** True when the executable itself could not be found or run. */
  readonly spawnFailed: boolean;
  readonly truncated: boolean;
}

export interface ProcessRunner {
  run(options: ProcessSpawnOptions): Promise<ProcessResult>;
}
