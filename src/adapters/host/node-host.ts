import { randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import type { Host } from '../../ports/host.js';

/**
 * This process, as the operating system sees it.
 *
 * `isAlive` uses signal 0, which performs the permission and existence checks a
 * real signal would and delivers nothing. Three outcomes matter:
 *
 *   - no throw — the process exists and we may signal it;
 *   - `ESRCH` — no such process, so the lock that named it is stale;
 *   - `EPERM` — it exists and belongs to someone else. Reported as *alive*,
 *     because the question is whether the holder is still running, not whether we
 *     could interfere with it. Treating it as dead would let one user's run steal a
 *     lock from another's.
 */
export class NodeHost implements Host {
  readonly pid = process.pid;
  readonly hostname = hostname();
  /**
   * `os.homedir()` rather than `process.env.HOME`, which MVP 2 §7.1 forbids
   * reading directly. The difference is not stylistic: `HOME` is an ordinary
   * environment variable that a wrapper script, a CI runner or a sudo invocation
   * can set to anything, and Agent Flow's worktree root is a place it later
   * *removes* directories from.
   */
  readonly homeDir = homedir();

  randomHex(byteLength: number): string {
    // `randomBytes`, not `pseudoRandomBytes` and not `Math.random`: the whole
    // point of the 64 bits in a `gitRunKey` is that a stale namespace cannot be
    // adopted by accident, and that argument rests on the source being real.
    return randomBytes(byteLength).toString('hex');
  }

  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === 'EPERM';
    }
  }
}
