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
  /**
   * How much of the parent environment the child inherits (PRI-17).
   *
   * **Defaults to `allowlist`**, which is the change: a coding CLI used to receive
   * `{ ...process.env }` — every credential the operator's shell exports, most of which
   * have nothing to do with the task. The list of what a runner actually needs lives in
   * `core/process-environment.ts`, stated as a list of *needs* rather than of dangers, so
   * it fails closed against variables nobody has invented yet.
   *
   * `inherit` is the old behaviour and has exactly two legitimate callers, each of which
   * says why at its call site:
   *
   *   - **the Git boundary**, which subtracts `unsetEnv` instead and would otherwise lose
   *     commit signing and SSH agent access;
   *   - **`project.commands.*`**, which are the operator's own commands run as they wrote
   *     them. An integration test that needs a database URL is not this module's business,
   *     and `docs/security.md` already says those are not isolated.
   *
   * The default is the safe one so that a caller added later is safe by omission. Choosing
   * `inherit` costs a line and a reason, which is the right way round.
   */
  readonly envMode?: 'inherit' | 'allowlist';
  /**
   * Extra names or prefixes the operator declared, from `execution.passEnv`.
   *
   * An entry ending in `_` is a prefix; anything else is an exact name. Only consulted
   * under `allowlist`.
   */
  readonly envPass?: readonly string[];
  readonly timeoutSeconds: number;
  /**
   * Aborts the child, and its whole process group, before its timeout (PRI-09, PRI-14).
   *
   * A timeout is the child running out of *its* patience. This is somebody else running
   * out of theirs — an operator cancelling a run, a coordinator shutting down — and until
   * it existed there was no such thing: the only way to stop an agent mid-flight was to
   * kill the orchestrator, which leaves the agent's own process group alive because
   * nothing signals children when a parent dies.
   *
   * The two paths share one kill, deliberately. A cancel that reached only the direct
   * child would be the exact defect the timeout path already documents: agent CLIs spawn
   * children, those children hold the stdout pipes, and Node reports `close` only once
   * every stream is closed.
   *
   * An already-aborted signal is honoured without spawning anything.
   */
  readonly signal?: AbortSignal;
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
  /**
   * True when the process was stopped because {@link ProcessSpawnOptions.signal} aborted.
   *
   * Separate from {@link timedOut}, because the two mean opposite things to whoever reads
   * the result: a timeout is a failure worth classifying and reporting, a cancellation is
   * an operator decision and must never be recorded as the work having failed.
   */
  readonly cancelled: boolean;
  /** True when the executable itself could not be found or run. */
  readonly spawnFailed: boolean;
  readonly truncated: boolean;
}

export interface ProcessRunner {
  run(options: ProcessSpawnOptions): Promise<ProcessResult>;
}
