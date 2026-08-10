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
  },
});
