import { defineConfig } from 'vitest/config';
import { COVERAGE, subprocessLane } from './vitest.lanes.js';

/**
 * The fast lane: everything that does not spawn a process.
 *
 * `npm run test` runs this and then `vitest.subprocess.config.ts`, in that order, because
 * the two need different budgets and one number cannot serve both. Which files are in
 * which lane is derived by `vitest.lanes.ts` from what the files actually do — see the
 * comment there for the measurement that forced the split.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', ...subprocessLane(import.meta.dirname)],
    environment: 'node',
    /**
     * Raised from the 5s default when M2-07 landed, and the reason is a
     * measurement rather than a preference.
     *
     * The `*.integration.test.ts` layer runs **real Git**: full checkouts, real
     * merges, `worktree add` against a temporary repository per test. Each of
     * those costs a few hundred milliseconds alone and several seconds when the
     * whole suite runs them in parallel — so at 5s the slowest of them were
     * failing on *machine load* while passing individually, in different files on
     * different runs. A timeout that reports contention is a timeout that teaches
     * people to re-run the suite until it is green, which is worse than no signal
     * at all.
     *
     * 30s is still far below any real hang: a deadlocked `git merge` or an
     * unresolved promise fails just as loudly, ten seconds later. **No assertion
     * was relaxed to arrive at this number.**
     */
    testTimeout: 30_000,
    /**
     * Left unset, Vitest sizes its worker pool to the machine's core count —
     * fine for one invocation, not for eight. `MAX_ISOLATED_TASK_CONCURRENCY`
     * (src/core/concurrency.ts) lets 8 worktrees validate at once, each running
     * this suite; 8 concurrent auto-sized pools on a 10-core/16GB machine is
     * what put ~16GB of `node` in the process list and forced a hard reboot on
     * 2026-08-17. Capped so the worst case (8 tasks × 2 workers) stays inside
     * what the machine actually has.
     *
     * **`maxWorkers`, because the cap this used to spell was never in effect.** It said
     * `poolOptions.threads.maxThreads`, and Vitest 2.0 changed the default pool from
     * `threads` to `forks` — so the option named a pool this suite does not use and was
     * read by nothing. The suite had been running one file per core all along: twelve at
     * once here, not two, which is why a Git-heavy file that costs 150 s alone cost 909 s
     * under the pool, and why 129 tests timed out on a clean run. `maxWorkers` is
     * pool-agnostic, so it cannot be quietly detached from the pool again.
     *
     * The reboot this cap exists to prevent was therefore never actually prevented. It
     * is now.
     */
    maxWorkers: 2,
    minWorkers: 1,
    coverage: COVERAGE,
  },
});
