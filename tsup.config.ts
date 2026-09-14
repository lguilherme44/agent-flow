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
  /**
   * The optional parser stays outside the bundle, and that is the whole point of it.
   *
   * Bundling an `optionalDependency` makes it mandatory: the bytes ship whether anyone
   * wanted them or not, and the runtime `import()` that was supposed to be allowed to fail
   * can no longer fail at all. It also does not work — `web-tree-sitter` is emscripten glue
   * that calls CommonJS `require('fs')`, and inlined into an ESM bundle it dies with
   * `Dynamic require of "fs" is not supported`. Measured, on the first build after that
   * import became dynamic.
   *
   * External, the emitted `import('web-tree-sitter')` resolves from `node_modules` at run
   * time — which is what an optional dependency is for.
   */
  external: ['web-tree-sitter', 'tree-sitter-wasms'],
  banner: { js: '#!/usr/bin/env node' },
});
