import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
    coverage: {
      provider: 'v8',
      clean: true,
      include: ['src/**/*.ts'],
      // ports/ is type declarations only — nothing to execute, so coverage
      // there would report 0% forever and mean nothing.
      exclude: ['src/**/index.ts', 'src/ports/**'],
      thresholds: {
        // core/ is pure logic — it carries the rules that silently corrupt runs
        // when wrong, so it is held to a much higher bar than the adapters.
        'src/core/**/*.ts': { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  },
});
