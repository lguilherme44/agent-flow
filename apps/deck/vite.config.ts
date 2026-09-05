import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Deck's build.
 *
 * `@contracts` points at the CLI package's own source, and every import through it is
 * type-only: nothing from the core lands in the bundle, but the browser and the server
 * are held to one set of shapes by the compiler rather than by two copies that drift.
 *
 * Local-first, like the server it talks to. No font, script or style is fetched over a
 * network at runtime; the server serves this folder as-is on loopback.
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
    port: 4784,
    // `npm run dev:deck` develops against a real `agent-flow ui` on the default
    // port, so the screen is built against real runs rather than fixtures.
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
    assetsDir: 'assets',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    exclude: ['node_modules/**', 'dist/**'],
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 2,
      },
    },
  },
});
