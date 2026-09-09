import { defineConfig } from 'vitest/config';
import { COVERAGE } from './vitest.lanes.js';

/**
 * Both lanes at once, for the one gate that must see all of them.
 *
 * Splitting the suite into a fast lane and a subprocess lane gave each an honest timeout
 * and gave coverage a hole: `vitest run --coverage` reads the base config, which now
 * *excludes* the twenty-eight files that spawn a process. Measuring coverage without them
 * would have reported a smaller number against the same thresholds and passed — the
 * thresholds are floors, so dropping the tests that exercise the adapters makes the gate
 * easier rather than louder. A coverage gate that got easier when the suite was
 * reorganised is the definition of a silent hole.
 *
 * So: everything included, and the slow lane's budget, because a run that measures
 * coverage is slower than one that does not. Coverage is its own gate and runs on its own
 * schedule; the minutes it costs are not on anybody's edit loop.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    maxWorkers: 2,
    minWorkers: 1,
    coverage: COVERAGE,
  },
});
