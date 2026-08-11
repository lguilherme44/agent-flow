/**
 * Filesystem access, behind a port so state handling can be tested in memory.
 *
 * Two members exist for their atomicity rather than for their convenience, and
 * both are part of the contract so an adapter cannot quietly drop the guarantee.
 *
 * `writeFileAtomic` writes to a temp file and renames: run state must never be
 * left half-written, since it is read back on resume and a truncated `state.json`
 * would lose work that was actually completed (AD-06).
 *
 * `createExclusive` is what makes an inter-process lock possible. `exists()` followed
 * by `writeFileAtomic()` cannot be a lock — two processes both see "absent" and both
 * write, which is the TOCTOU race the whole mechanism exists to avoid. The kernel has
 * to be the one deciding who won, so acquisition is a single syscall that either
 * creates the file or fails because someone else did.
 *
 * There is deliberately no `rename` here. An earlier version of the lock reclaimed a
 * stale claim by moving it aside, and that design is gone: the race it lost is written
 * up in `run-execution-lock.ts`. A port kept for a mechanism nothing uses is an
 * invitation to rebuild it.
 */
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean; mtimeMs: number; size: number } | null>;

  /**
   * Creates a file only if it does not exist. One syscall, no window.
   *
   * Returns true when this caller created it and false when it was already there.
   * Never overwrites, and never reports success for a file it did not create — the
   * whole value of this member is that the answer is decided by the kernel.
   */
  createExclusive(path: string, content: string): Promise<boolean>;
}
