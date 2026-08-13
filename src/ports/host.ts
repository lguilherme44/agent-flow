/**
 * The machine this process runs on, as far as anything above needs to know it.
 *
 * A port because these are facts about the operating system — which process holds
 * the run lock, on which machine, whether that process still exists, and where
 * this user's files live — and a use case that read `process.pid` or
 * `process.env.HOME` directly could only ever be driven by one caller and tested
 * by none.
 *
 * Deliberately small, and it grew by exactly one member for MVP 2. An earlier
 * version of this comment said three members were the limit because a fourth
 * would be an invitation to reach for the environment. The fourth is `homeDir`,
 * and it is here for the opposite reason: MVP 2 §7.1 puts Agent Flow's worktrees
 * and its empty hooks directory under the user's home, and requires that `~` be
 * resolved through this port *rather than* from `process.env.HOME`. Declaring it
 * is what makes the alternative — every adapter resolving home for itself — the
 * thing an architecture test can see.
 */
export interface Host {
  /** This process. */
  readonly pid: number;
  /** This machine, as it identifies itself. Used to refuse to judge another one. */
  readonly hostname: string;
  /**
   * The current user's home directory, absolute.
   *
   * Agent Flow's machine-wide state lives under `<homeDir>/.agent-flow` (§7.1):
   * the worktree root and the owned empty hooks directory. A test supplies a
   * temporary directory here, which is the only reason the worktree adapter's
   * integration tests can create and destroy real worktrees without writing into
   * the developer's actual home.
   */
  readonly homeDir: string;
  /**
   * `byteLength` bytes from a cryptographic source, as lowercase hex.
   *
   * Here rather than in a utility module because it is a fact about the machine
   * — the operating system's entropy pool — and because `gitRunKey` depends on
   * it being genuinely unpredictable (§5.2). The suffix exists so a new run
   * cannot adopt the refs of a deleted run with the same id; a `Math.random`
   * behind this signature would look unpredictable and would not be, and the
   * failure would be invisible until two runs collided.
   *
   * A port rather than a direct `randomBytes` call for one practical reason:
   * a test can make it deterministic, which is the only way to assert that two
   * runs refuse to share a namespace rather than merely observing that they
   * happened not to.
   */
  randomHex(byteLength: number): string;
  /**
   * Whether a process id currently exists on *this* machine.
   *
   * Only meaningful for a lock written by this hostname. Asking about a pid from
   * another machine would answer a question about a local process that happens to
   * share the number — which is worse than not knowing.
   */
  isAlive(pid: number): boolean;
}
