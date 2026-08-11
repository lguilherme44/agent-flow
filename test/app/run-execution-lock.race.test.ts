import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeHost } from '../../src/adapters/host/node-host.js';
import { SystemClock } from '../../src/adapters/clock/system-clock.js';
import { RunExecutionLock, LOCK_VERSION } from '../../src/app/run-execution-lock.js';
import {
  buildHarness,
  heldIntervals,
  overlaps,
  RUN,
  type Harness,
} from './lock-race-harness.js';

/**
 * AF-L01 — mutual exclusion, proved with real processes and a real filesystem.
 *
 * The policy tests next door run against an in-memory map, which is single-threaded
 * and therefore has no race to lose: they can show that a dead pid is reclaimed and a
 * foreign host is left alone, and they cannot show that two processes cannot both
 * acquire. That is the only claim that matters, and the only way to make it is to run
 * two processes.
 *
 * So the lock is bundled with esbuild — the same bundler the CLI ships through — into
 * a script that acquires and prints the answer, and N copies of it are spawned at
 * once against one lock file on the real disk. Nothing here is simulated: separate
 * OS processes, separate address spaces, one `open(path, 'wx')` each. The spawning
 * lives in `lock-race-harness.ts`; the claims live here.
 *
 * The three tests in the first block are the ones to read. Everything after them is
 * detail.
 */

let harness: Harness;

beforeAll(async () => {
  harness = await buildHarness(join(import.meta.dirname, '../..'));
}, 60_000);

afterAll(async () => {
  await rm(harness.dir, { recursive: true, force: true });
});

function inProcessLock(projectDir: string): RunExecutionLock {
  return new RunExecutionLock({
    fs: new NodeFileSystem(),
    clock: new SystemClock(),
    host: new NodeHost(),
    projectDir,
  });
}

describe('two real processes, one run', () => {
  it('lets exactly one of eight concurrent processes in', async () => {
    // The test this whole mechanism exists for. Eight separate OS processes, started
    // together, racing for one lock file. `exists()` then `write()` would let several
    // through here; `open(path, 'wx')` cannot.
    const projectDir = harness.project();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => harness.attempt(projectDir, 250)),
    );

    const held = heldIntervals(results);
    const refused = results.filter((result) => result.stdout.startsWith('REFUSED'));

    // Exactly one gets in, and the other seven are told who has it. With a 250ms hold
    // and an immediate refusal for a live holder, nobody has a chance to retry into a
    // released lock — so the count is meaningful here as well as the overlap.
    expect(held).toHaveLength(1);
    expect(refused).toHaveLength(7);
    expect(overlaps(held)).toEqual([]);

    for (const result of refused) {
      expect(result.stdout).toContain('"sameHost":true');
      expect(result.stdout).toContain('"holderAlive":true');
      expect(result.code).toBe(3);
    }
  }, 60_000);

  it('refuses a second process while the first is still holding', async () => {
    const projectDir = harness.project();

    const first = harness.attempt(projectDir, 900);
    // Long enough for the first to have the lock, short enough to still be inside its
    // hold window.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await harness.attempt(projectDir, 0);

    expect(second.stdout).toMatch(/^REFUSED/);
    expect(second.code).toBe(3);

    const held = JSON.parse(second.stdout.replace('REFUSED ', '')) as {
      holder: { pid: number; owner: string; operation: string };
      holderAlive: boolean;
    };
    expect(held.holderAlive).toBe(true);
    expect(held.holder.owner).toBe('cli');
    expect(held.holder.operation).toBe('run');

    const finished = await first;
    expect(finished.stdout).toContain('RELEASED');
  }, 60_000);

  it('lets the next process in once the first releases', async () => {
    const projectDir = harness.project();

    const first = await harness.attempt(projectDir, 0);
    expect(first.stdout).toMatch(/^ACQUIRED/);
    expect(first.stdout).toContain('RELEASED');
    // Released means gone from disk, not merely marked.
    expect(await harness.generations(projectDir)).toEqual([]);

    const second = await harness.attempt(projectDir, 0);
    expect(second.stdout).toMatch(/^ACQUIRED/);
  }, 60_000);
});

describe('a process that died holding the lock', () => {
  it('leaves a lock that the next acquisition recovers', async () => {
    const projectDir = harness.project();

    // A real abandonment: the child takes the lock and exits without releasing, which
    // is what Ctrl-C, a crash and SIGKILL all look like from here. No heartbeat has
    // expired, because there is no heartbeat — the pid is the liveness signal.
    const abandoned = await harness.attempt(projectDir, 0, 'abandon');
    expect(abandoned.stdout).toMatch(/^ACQUIRED/);
    expect(await harness.generations(projectDir)).toEqual([1]);

    const stale = JSON.parse(
      await readFile(harness.lockPath(projectDir, 1), 'utf8'),
    ) as { pid: number };
    // The pid is real and the process is genuinely gone.
    expect(new NodeHost().isAlive(stale.pid)).toBe(false);

    const result = await inProcessLock(projectDir).acquire({
      runId: RUN,
      owner: 'server',
      operation: 'run',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.recoveredStale?.pid).toBe(stale.pid);
    // Superseded rather than deleted-then-recreated: generation 2 is the holder and
    // generation 1 is tidied away only after that claim was confirmed as the highest.
    expect(result.lease.lock.generation).toBe(2);
    expect(await harness.generations(projectDir)).toEqual([2]);
  }, 60_000);

  it('is recovered by exactly one of several processes racing for it', async () => {
    // The second race, and the subtler one. Every process agrees the lock is stale, so
    // every one of them tries to claim it — and the reclaim is where the first design
    // of this lock failed. Nothing is moved or deleted to make room now: each claimant
    // creates the *next* generation, exactly one wins that create, and the losers find
    // a higher number than the one they published and stand down before doing any work.
    const projectDir = harness.project();

    const abandoned = await harness.attempt(projectDir, 0, 'abandon');
    expect(abandoned.stdout).toMatch(/^ACQUIRED/);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => harness.attempt(projectDir, 250)),
    );

    const held = heldIntervals(results);

    // At least one gets in — the stale lock does not block the run forever.
    expect(held.length).toBeGreaterThanOrEqual(1);
    // And no two are ever inside it together, which is the whole claim. More than one
    // *acquisition* is legitimate here: a process refused during the reclaim retries,
    // and a retry that lands after the holder released is correct. What must never
    // happen is two holders at once.
    expect(overlaps(held)).toEqual([]);
    // Nobody ended up holding a lock somebody else had reclaimed underneath them.
    expect(new Set(held.map((entry) => entry.pid)).size).toBe(held.length);
  }, 60_000);
});

describe('generations on real disk', () => {
  it('starts from one again after every release', async () => {
    // There is no TTL and nothing sweeping the directory, so "the numbers do not climb
    // forever" is a property of release rather than of cleanup. Six real processes in
    // sequence, each taking the lock and letting go of it: every one of them is
    // generation 1, and the directory is empty in between.
    const projectDir = harness.project();

    for (let round = 0; round < 6; round += 1) {
      const result = await harness.attempt(projectDir, 0);
      expect(result.stdout).toMatch(/gen=1\b/);
      expect(await harness.generations(projectDir)).toEqual([]);
    }
  }, 60_000);
});

describe('a lock written by another machine', () => {
  it('is not stolen, even though the pid is not alive here', async () => {
    const projectDir = harness.project();
    const fs = new NodeFileSystem();

    await fs.writeFileAtomic(
      harness.lockPath(projectDir, 1),
      `${JSON.stringify({
        version: LOCK_VERSION,
        generation: 1,
        runId: RUN,
        pid: 424_242,
        hostname: 'a-different-machine',
        owner: 'server',
        operation: 'run',
        createdAt: '2026-08-10T19:00:00.000Z',
      })}\n`,
    );

    const result = await harness.attempt(projectDir, 0);

    // Conservative on purpose. A pid from another host names a local process that
    // happens to share the number, and acting on that is how a run gets executed
    // twice. Agent Flow is local-first and this is not a distributed lock.
    expect(result.stdout).toMatch(/^REFUSED/);
    expect(result.stdout).toContain('"sameHost":false');
    expect(JSON.parse(await readFile(harness.lockPath(projectDir, 1), 'utf8'))).toMatchObject({
      hostname: 'a-different-machine',
    });
  }, 60_000);
});

describe('release on the way out', () => {
  it('releases when the work throws', async () => {
    // The `finally` in `withExecutionLock` is what makes this hold, and it is checked
    // here at the lock's own level too: a lease released in a `finally` leaves nothing
    // behind for the next caller to have to recover.
    const projectDir = harness.project();
    const lock = inProcessLock(projectDir);

    const acquired = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    await expect(
      (async () => {
        try {
          throw new Error('the scheduler blew up');
        } finally {
          await acquired.lease.release();
        }
      })(),
    ).rejects.toThrow('the scheduler blew up');

    expect(await harness.generations(projectDir)).toEqual([]);
    const next = await harness.attempt(projectDir, 0);
    expect(next.stdout).toMatch(/^ACQUIRED/);
  }, 60_000);
});
