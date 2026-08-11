/**
 * This process, and whether another one is still alive.
 *
 * A port because the inter-process lock is decided on facts about the operating
 * system — which process holds it, on which machine, and whether that process
 * still exists — and a use case that read `process.pid` directly could only ever
 * be driven by one caller and tested by none.
 *
 * Deliberately three members. Anything more would be an invitation to reach for
 * the environment, and the run lock is the only thing that needs any of this.
 */
export interface Host {
  /** This process. */
  readonly pid: number;
  /** This machine, as it identifies itself. Used to refuse to judge another one. */
  readonly hostname: string;
  /**
   * Whether a process id currently exists on *this* machine.
   *
   * Only meaningful for a lock written by this hostname. Asking about a pid from
   * another machine would answer a question about a local process that happens to
   * share the number — which is worse than not knowing.
   */
  isAlive(pid: number): boolean;
}
