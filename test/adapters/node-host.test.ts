import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  NodeHost,
  PATH_LIMITS,
  measurePathLength,
  probeWindowsLongPaths,
  resolvePathLimit,
} from '../../src/adapters/host/node-host.js';

/**
 * The path-limit half of the `Host`.
 *
 * §23 marks Windows worktree mode **UNVALIDATED** and this file does not change
 * that: no CI job runs on Windows and nothing here pretends to. What it does
 * validate is the *decision* — given a probe that succeeds or fails, which limit
 * comes out — which is a branch that would otherwise have no test at all on the
 * platform where it matters most.
 */

describe('the platform path limit (§23)', () => {
  it('gives each platform its own limit, not a portable minimum', () => {
    // Linux inheriting macOS's limit would refuse runs that work, with advice
    // the user cannot act on: the path was already short enough.
    expect(resolvePathLimit('linux', () => false)).toBe(4095);
    expect(resolvePathLimit('darwin', () => false)).toBe(1023);
    expect(PATH_LIMITS.linux).toBe(4095);
    expect(PATH_LIMITS.darwin).toBe(1023);
  });

  it('reports the usable width, with the NUL terminator already subtracted', () => {
    // `PATH_MAX` is 4096 and `MAX_PATH` is 260, and both bound a NUL-terminated
    // buffer — so the longest *name* that fits is one less. Publishing the
    // documented figure and comparing with `>` would permit exactly one
    // character more than the filesystem does: an error that appears once, at
    // the deepest file, halfway through a checkout.
    expect(PATH_LIMITS.linux).toBe(4096 - 1);
    expect(PATH_LIMITS.darwin).toBe(1024 - 1);
    expect(PATH_LIMITS.win32Classic).toBe(260 - 1);
    expect(PATH_LIMITS.win32LongPath).toBe(32_767 - 1);
    expect(PATH_LIMITS.other).toBe(1024 - 1);
  });

  it('falls back to the conservative POSIX value on an unknown platform', () => {
    // Refusing too eagerly is recoverable — the user is told to shorten a path.
    // Permitting too much fails mid-checkout, which is not.
    expect(resolvePathLimit('freebsd', () => false)).toBe(PATH_LIMITS.other);
    expect(PATH_LIMITS.other).toBe(1023);
  });

  it('uses the classic Windows limit when the probe fails', () => {
    let asked = 0;
    const limit = resolvePathLimit('win32', () => {
      asked += 1;
      return false;
    });

    expect(limit).toBe(259);
    expect(limit).toBe(PATH_LIMITS.win32Classic);
    expect(asked).toBe(1);
  });

  it('uses the long-path limit when the probe succeeds', () => {
    const limit = resolvePathLimit('win32', () => true);

    expect(limit).toBe(32_766);
    expect(limit).toBe(PATH_LIMITS.win32LongPath);
  });

  it('asks the probe only on Windows', () => {
    // A `mkdir` on every POSIX start-up would be I/O for an answer that is
    // already known.
    let asked = 0;
    const counting = () => {
      asked += 1;
      return true;
    };

    resolvePathLimit('linux', counting);
    resolvePathLimit('darwin', counting);
    resolvePathLimit('freebsd', counting);

    expect(asked).toBe(0);
  });
});

describe('the long-path probe', () => {
  it('answers without throwing, and leaves nothing behind', () => {
    // On POSIX this returns false for an uninteresting reason — the path is
    // creatable but the platform is not Windows, so the answer is never used.
    // What is asserted here is the contract every platform shares: it terminates,
    // it does not throw, and it cleans up.
    const before = readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith('agent-flow-longpath-'),
    );

    expect(() => probeWindowsLongPaths()).not.toThrow();

    const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith('agent-flow-longpath-'));
    expect(after).toEqual(before);
  });

  it('works only under the system temp directory', () => {
    // It must never reach the repository or the worktree root — those are places
    // Agent Flow later *removes* directories from.
    const probeRoot = `agent-flow-longpath-${String(process.pid)}`;

    probeWindowsLongPaths();

    expect(existsSync(`${tmpdir()}/${probeRoot}`)).toBe(false);
    expect(existsSync(`${process.cwd()}/${probeRoot}`)).toBe(false);
  });
});

describe('measuring a path in the platform’s unit', () => {
  // The trap this exists for: `String.length` is right on Windows and wrong on
  // POSIX, and being wrong under-reports exactly the repositories most likely to
  // be near a limit.
  const cjk = '中'.repeat(60);

  it('counts UTF-8 bytes on POSIX', () => {
    expect(measurePathLength('linux', cjk)).toBe(180);
    expect(measurePathLength('darwin', cjk)).toBe(180);
  });

  it('counts UTF-16 units on Windows, which is what MAX_PATH bounds', () => {
    expect(measurePathLength('win32', cjk)).toBe(60);
  });

  it('agrees with itself for ASCII, which is why the bug is easy to miss', () => {
    const ascii = 'src/app/run-git-identity.ts';

    expect(measurePathLength('linux', ascii)).toBe(ascii.length);
    expect(measurePathLength('win32', ascii)).toBe(ascii.length);
  });
});

describe('the real host', () => {
  it('reports a limit and measures in this platform’s unit', () => {
    const host = new NodeHost();

    expect(host.maxPathLength).toBe(resolvePathLimit(process.platform, probeWindowsLongPaths));
    expect(host.measurePathLength('中')).toBe(measurePathLength(process.platform, '中'));
  });

  it('draws entropy of the requested width', () => {
    const host = new NodeHost();

    expect(host.randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(host.randomHex(8)).not.toBe(host.randomHex(8));
  });
});
