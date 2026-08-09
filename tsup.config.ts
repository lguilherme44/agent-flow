import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['bin/agent-flow.ts'],
  outDir: 'dist/bin',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
