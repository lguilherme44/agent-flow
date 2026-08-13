import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  /**
   * The platform's path limit, and whether long paths lift it (§23).
   *
   * Resolved per platform rather than as a portable minimum: Linux's `PATH_MAX`
   * is 4096 and macOS's is 1024, and giving Linux the smaller one would refuse
   * runs that work, with advice the user cannot act on.
   *
   * Windows: the classic limit, or the extended one when long paths work —
   * detected by trying, since the registry value alone does not decide it. The
   * decision is in {@link resolvePathLimit} and the probe in
   * {@link probeWindowsLongPaths}, split so the branch is testable without a
   * Windows machine. The integration itself stays UNVALIDATED (§23).
   *
   * The value is the longest pathname that fits — the NUL terminator is already
   * subtracted (see {@link PATH_LIMITS}), so a caller compares against it
   * directly.
   */
  readonly maxPathLength = resolvePathLimit(process.platform, probeWindowsLongPaths);

  measurePathLength(value: string): number {
    return measurePathLength(process.platform, value);
  }

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

/**
 * The longest **pathname** each platform accepts, in the unit it counts in.
 *
 * These are the real limits rather than a portable lowest common denominator:
 * §23 says "the platform limit", and giving Linux macOS's value would refuse
 * runs that work — a refusal the user cannot act on, since the advice would be
 * to shorten a path that was already short enough.
 *
 * **Every number here excludes the NUL terminator**, and the off-by-one that
 * makes that worth stating is real: `PATH_MAX` is 4096 on Linux, but it bounds
 * a NUL-terminated buffer, so the longest pathname it will actually accept is
 * 4095 bytes. The same is true of `MAX_PATH` on Windows — 260 counts the
 * terminator, so 259 is the usable width. Leaving the constants at the
 * documented figures and comparing with `>` would silently permit exactly one
 * character more than the filesystem does, which is the kind of error that
 * appears once, at the deepest file, halfway through a checkout.
 *
 * So: {@link Host.maxPathLength} is *the longest pathname that fits*, and
 * `projected > maxPathLength` is the refusal. There is no second adjustment
 * anywhere, and no caller needs to know a terminator exists.
 */
export const PATH_LIMITS = {
  /** `PATH_MAX` (4096) in `linux/limits.h`, less the NUL. Bytes. */
  linux: 4095,
  /** `PATH_MAX` (1024) in `sys/syslimits.h`, less the NUL. Bytes. */
  darwin: 1023,
  /** The classic `MAX_PATH` (260), less the NUL. UTF-16 code units. */
  win32Classic: 259,
  /**
   * Long-path support, less the NUL.
   *
   * 32767 is the figure the Win32 documentation gives for the extended-length
   * limit and is itself approximate — it is a property of the API rather than of
   * any one filesystem, and NTFS bounds individual components separately. It is
   * normalised the same way as the others so that one contract holds everywhere,
   * and it is generous enough that the approximation cannot decide a real case:
   * anything near it fails for a component limit first.
   */
  win32LongPath: 32_766,
  /** Anything else: the conservative POSIX value, since the real one is unknown. */
  other: 1023,
} as const;

/**
 * The platform's limit, given a way to find out whether long paths work.
 *
 * Split from the probe so the decision is testable without a Windows machine.
 * Windows integration stays **UNVALIDATED** (§23) — what this seam validates is
 * the branch, not the operating system.
 */
export function resolvePathLimit(
  platform: NodeJS.Platform,
  longPathsWork: () => boolean,
): number {
  if (platform === 'linux') return PATH_LIMITS.linux;
  if (platform === 'darwin') return PATH_LIMITS.darwin;
  if (platform === 'win32') {
    return longPathsWork() ? PATH_LIMITS.win32LongPath : PATH_LIMITS.win32Classic;
  }
  return PATH_LIMITS.other;
}

/**
 * How long a path is, in the unit its filesystem counts in.
 *
 * **`String.length` is the wrong answer on POSIX and the right one on Windows**,
 * which is why this exists rather than being inlined. `PATH_MAX` on Linux and
 * macOS bounds a NUL-terminated byte string, so a path of accented or CJK
 * characters is longer than its JavaScript length — sometimes three times
 * longer. `MAX_PATH` on Windows bounds a wide-character string, and JavaScript
 * strings are already UTF-16, so there the two agree.
 *
 * Getting this wrong is not cosmetic: it under-measures exactly the repositories
 * whose paths are most likely to be near a limit.
 */
export function measurePathLength(platform: NodeJS.Platform, value: string): number {
  return platform === 'win32' ? value.length : Buffer.byteLength(value, 'utf8');
}

/**
 * Whether this Windows accepts a path past the classic limit.
 *
 * Answered by attempting one, because the registry value alone does not decide
 * it — the process also needs a manifest opting in, and a Node build without one
 * fails on a machine whose registry says long paths are on. Trying is the only
 * check that measures what will actually happen.
 *
 * Everything it creates is under the system temp directory and is removed in a
 * `finally`. It never touches the repository or the worktree root.
 */
export function probeWindowsLongPaths(): boolean {
  const root = join(tmpdir(), `agent-flow-longpath-${String(process.pid)}`);
  const segment = 'a'.repeat(80);
  const probe = join(root, segment, segment, segment, segment);

  try {
    mkdirSync(probe, { recursive: true });
    return probe.length > PATH_LIMITS.win32Classic;
  } catch {
    return false;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A probe directory left behind costs nothing and must not fail a command.
    }
  }
}
