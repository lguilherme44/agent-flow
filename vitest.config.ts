import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
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
