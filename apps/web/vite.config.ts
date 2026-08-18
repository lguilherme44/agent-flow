import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The dashboard build.
 *
 * `@contracts` points straight at the CLI package's source. Every import through
 * it is type-only, so nothing from the core is bundled — but the browser and the
 * server are held to the same shapes by the compiler rather than by two hand-kept
 * copies that drift the first time a field is added.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@contracts': fileURLToPath(new URL('../../src/contracts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 4783,
    // `npm run dev:web` talks to a real `agent-flow ui` on the default port, so
    // the dashboard is developed against real runs rather than against fixtures.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4782',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Local-first: nothing here is fetched over a network at runtime, and the
    // server serves the folder as-is.
    assetsDir: 'assets',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    // Vitest and Playwright both claim `*.spec.ts`. The browser suites need a real
    // browser and their own runner; collected here they fail on an import of
    // `@playwright/test` and take the unit suite red with them.
    exclude: ['node_modules/**', 'dist/**', 'visual/**', 'e2e/**'],
    // Same cap as the root vitest.config.ts, for the same reason: up to 8
    // worktrees can run `npm run check` (which reaches this suite) at once, and
    // an auto-sized pool per invocation is what exhausted RAM on 2026-08-17.
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 2,
      },
    },
  },
});
