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
