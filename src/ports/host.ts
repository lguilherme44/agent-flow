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
   * Whether a process id currently exists on *this* machine.
   *
   * Only meaningful for a lock written by this hostname. Asking about a pid from
   * another machine would answer a question about a local process that happens to
   * share the number — which is worse than not knowing.
   */
  isAlive(pid: number): boolean;
}
