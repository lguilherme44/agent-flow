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
  maxSimultaneous,
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

/**
 * Waits until some other process is holding the lock, rather than guessing when.
 *
 * A generation file exists exactly while somebody holds it — the first test asserts that
 * none is left behind afterwards — so its presence is the handshake. Bounded, because a
 * child that dies before acquiring must fail an assertion rather than hang the suite.
 */
async function heldByAnother(projectDir: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await harness.generations(projectDir)).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no process took the lock within ${String(timeoutMs)}ms`);
}

function inProcessLock(projectDir: string): RunExecutionLock {
  return new RunExecutionLock({
    fs: new NodeFileSystem(),
    clock: new SystemClock(),
    host: new NodeHost(),
    projectDir,
  });
}

describe('the exclusion detector can see what it forbids', () => {
  // The count assertion used to stand next to these and is gone: it was a statement about
  // the scheduler, not about the lock. That leaves `overlaps` and `maxSimultaneous`
  // carrying the whole claim, and a detector that returned "no overlap" for everything
  // would make the test above pass forever on a lock that does nothing.
  const interval = (pid: number, from: number, to: number) => ({ pid, from, to });

  it('reports two holders whose intervals cross', () => {
    const crossing = [interval(1, 0, 100), interval(2, 50, 150)];

    expect(overlaps(crossing)).not.toEqual([]);
    expect(maxSimultaneous(crossing)).toBe(2);
  });

  it('reports nothing for holders that merely follow one another', () => {
    const sequential = [interval(1, 0, 100), interval(2, 100, 200)];

    expect(overlaps(sequential)).toEqual([]);
    expect(maxSimultaneous(sequential)).toBe(1);
  });

  it('treats a holder that never released as holding until the end of time', () => {
    // The conservative reading `heldIntervals` documents: no RELEASED line means the
    // process abandoned the lock, and anything acquired afterwards overlaps it.
    const abandoned = [interval(1, 0, Number.POSITIVE_INFINITY), interval(2, 10, 20)];

    expect(overlaps(abandoned)).not.toEqual([]);
  });
});

describe('two real processes, one run', () => {
  it('lets exactly one of eight concurrent processes in', async () => {
    // The test this whole mechanism exists for. Eight separate OS processes racing
    // for one lock file. `exists()` then `write()` would let several through here;
    // `open(path, 'wx')` cannot.
    //
    // **They are held at a barrier first**, and that is what makes the count below
    // a statement about the lock. The earlier version spawned eight children and
    // hoped they all reached `acquire()` inside the winner's 250ms hold; under load
    // a straggler arrived after the winner had released and acquired the lock
    // legitimately, which the count read as a failure. Probed: with the hold
    // removed the distribution was 1, 2, 3 and 4 acquisitions across 25 rounds —
    // and `overlaps` was empty in every one of them, because nothing was ever
    // wrong. The barrier removes the assumption instead of widening the window.
    const projectDir = harness.project();

    const results = await harness.race(projectDir, 8, 250);

    const held = heldIntervals(results);
    const refused = results.filter((result) => result.stdout.startsWith('REFUSED'));

    // Everybody answered, and somebody got in. **Not "exactly one got in"** — that
    // assertion was here, and it was wrong for a reason this file had already written
    // down two paragraphs above without following it through.
    //
    // The barrier removes the *start-up* assumption: all eight are inside `acquire()`
    // when GO fires. It does not remove the *scheduling* one. The winner holds for
    // 250 ms of wall clock, and a contender the OS deschedules for longer than that
    // wakes, finds the lock free, and takes it — a second acquisition that is perfectly
    // correct. Measured: two acquisitions in one gate run on a loaded Windows box, with
    // `overlaps` empty, which is this file's own recorded finding ("the distribution was
    // 1, 2, 3 and 4 acquisitions across 25 rounds — and `overlaps` was empty in every
    // one of them, because nothing was ever wrong").
    //
    // A count would only ever catch "the winner released too early", which is not a
    // property of the lock. What the lock promises is below, and it is asserted exactly.
    expect(held.length + refused.length).toBe(8);
    expect(held.length).toBeGreaterThanOrEqual(1);
    // The property itself, and the only one that distinguishes a lock from a no-op.
    expect(overlaps(held)).toEqual([]);
    // At most one holder at any instant, stated directly rather than inferred.
    expect(maxSimultaneous(held)).toBe(1);
    // And nothing is left behind for the next caller to recover.
    expect(await harness.generations(projectDir)).toEqual([]);

    // Every loser refused, and refused for a reason the lock actually has.
    //
    // The earlier version required all seven to report `sameHost: true` and
    // `holderAlive: true`, and CI on Node 20 found the assumption: production has a
    // *second* legitimate refusal. When the generation exists but the file is
    // half-written, `acquire` cannot parse a holder, treats the lock as held anyway
    // — the one move that cannot double-execute a run — and refuses with no holder
    // to compare a hostname against, so `sameHost` is false and `holderAlive` is
    // absent. That is the fail-closed branch working, not an exclusion failure: the
    // five assertions above had already passed when this one fired.
    //
    // So the shape is checked as a shape, parsed rather than string-matched, and
    // both refusals are accepted. Shape B is deliberately **not** required — a test
    // that demanded a half-written read would be timing-dependent in the direction
    // the barrier above exists to remove.
    for (const result of refused) {
      expect(result.code).toBe(3);

      const refusal = JSON.parse(result.stdout.replace('REFUSED ', '')) as {
        runId: string;
        holder?: { pid: number; hostname: string };
        sameHost: boolean;
        holderAlive?: boolean;
      };
      expect(refusal.runId).toBe(RUN);

      if (refusal.holder === undefined) {
        // Shape B — the holder's file could not be read on the final attempt.
        expect(refusal.sameHost).toBe(false);
        expect(refusal.holderAlive).toBeUndefined();
        continue;
      }

      // Shape A — the holder was read, and it is this machine's live process.
      //
      // `sameHost: true` is the load-bearing half. Every contender here is this
      // process's own child, so a *readable* holder reported as foreign would mean
      // the hostname comparison is broken — which is why the check is written as
      // "holder present implies sameHost", and not as "either shape will do".
      expect(refusal.sameHost).toBe(true);
      expect(refusal.holderAlive).toBe(true);
    }
  }, 60_000);

  it('refuses a second process while the first is still holding', async () => {
    const projectDir = harness.project();

    // Held long enough that the observation below cannot fall off the end of it, and the
    // second attempt is not started until the lock file is *actually* on disk.
    //
    // It used to sleep 300 ms and hope. Measured under a loaded gate: the first child —
    // a fresh Node process running a bundled script — had not acquired yet, so the second
    // one took the lock legitimately, and the assertion read that as an exclusion failure.
    // Same class of assumption the barrier in the test above exists to remove, still
    // present here; waiting for the file removes it rather than widening the window.
    const first = harness.attempt(projectDir, 4_000);
    await heldByAnother(projectDir);
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

    const results = await harness.race(projectDir, 8, 250);

    const held = heldIntervals(results);

    // At least one gets in — the stale lock does not block the run forever.
    expect(held.length).toBeGreaterThanOrEqual(1);
    // And no two are ever inside it together, which is the whole claim. More than one
    // *acquisition* is legitimate here: a process refused during the reclaim retries,
    // and a retry that lands after the holder released is correct. What must never
    // happen is two holders at once.
    expect(overlaps(held)).toEqual([]);
    expect(maxSimultaneous(held)).toBe(1);
    // Nobody ended up holding a lock somebody else had reclaimed underneath them.
    expect(new Set(held.map((entry) => entry.pid)).size).toBe(held.length);
    expect(await harness.generations(projectDir)).toEqual([]);
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
