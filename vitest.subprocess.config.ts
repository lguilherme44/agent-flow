import { defineConfig } from 'vitest/config';
import { subprocessLane } from './vitest.lanes.js';

/**
 * The slow lane: the tests that spawn real Git and real children.
 *
 * Same assertions, same parallelism, one different number. **No assertion was relaxed to
 * arrive at it**, which is the same sentence the 30 s budget was written under and the
 * reason this is a second lane rather than a bigger global.
 *
 * **120 s, and the arithmetic is the base config's own.** Measured on Windows: these
 * tests average ~11 s each when their file runs alone, and the slowest single test —
 * `repository_has_submodules` — takes 31 s *with the whole machine to itself*, which is
 * already past the 30 s the suite allowed it. Under the pool they run about three times
 * slower, so the honest budget is an order of magnitude over the isolated cost. A
 * deadlocked `git merge` or an unresolved promise still fails just as loudly, ninety
 * seconds later; what no longer fails is a machine that was busy.
 *
 * The alternative — raising the global to 120 s — was rejected for what it costs the
 * other lane: roughly 4 300 tests that finish in milliseconds would lose a signal that
 * still means something there. A timeout that reports contention teaches people to re-run
 * the suite until it is green, and a timeout that reports nothing teaches them the same
 * thing more slowly.
 */
export default defineConfig({
  test: {
    include: subprocessLane(import.meta.dirname),
    environment: 'node',
    testTimeout: 120_000,
    /**
     * Unchanged from the fast lane, and deliberately.
     *
     * `MAX_ISOLATED_TASK_CONCURRENCY` lets 8 worktrees validate at once, each running this
     * suite; the cap is what keeps the worst case inside the machine, and it is the reason
     * this file does not simply serialise. Serialising the slow lane would put the gate
     * past forty minutes, and a gate nobody waits for is the same failure as a gate nobody
     * trusts.
     */
    maxWorkers: 2,
    minWorkers: 1,
  },
});
