import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * What the published package must be, checked in milliseconds (UI-33).
 *
 * `scripts/packaging-smoke.mjs` proves the package *works* — it packs, installs into
 * a throwaway prefix, hides the checkout's own bundle and drives the result. That
 * takes half a minute and needs npm and a network, so it is not something anybody
 * runs on every save.
 *
 * These are the claims that can be checked from the metadata alone, and every one of
 * them is a mistake that only appears after publishing: a `files` entry for a
 * directory that does not exist, a `bin` pointing outside what ships, a runtime
 * import of a devDependency, a supported Node version nobody tests.
 */

const ROOT = join(import.meta.dirname, '..');

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly engines: { node: string };
  readonly bin: Record<string, string>;
  readonly files: string[];
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;

/** Import specifiers of a source tree, bare package names only. */
function bareImports(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) collect(full);
    }
  };

  const collect = (file: string): void => {
    const text = readFileSync(file, 'utf8');
    // Anchored on the statement, not on the word `from`. A bare `from '…'` also
    // matches English: `doctor.ts` contains the phrase "present but will not run"
    // inside a message, and the first version of this scan reported it as a package.
    const patterns = [
      /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
      /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
      /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g,
      /\bawait import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    for (const specifier of patterns.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => match[1] ?? ''),
    )) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      // Scoped or plain, first segment only: `zod/v4` is still `zod`.
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : (specifier.split('/')[0] as string);
      out.set(name, [...(out.get(name) ?? []), relative(ROOT, file)]);
    }
  };

  walk(abs);
  return out;
}

/**
 * Where the build configs say their output goes, repository-relative.
 *
 * Read from the configs rather than listed here, so a bundler retargeted to
 * `build/` makes this test fail rather than quietly keep asserting about `dist`.
 */
function buildOutputs(): string[] {
  const outputs: string[] = [];

  const tsup = readFileSync(join(ROOT, 'tsup.config.ts'), 'utf8');
  const cliOut = /outDir:\s*'([^']+)'/.exec(tsup)?.[1];
  if (cliOut !== undefined) outputs.push(cliOut);

  const vite = readFileSync(join(ROOT, 'apps/web/vite.config.ts'), 'utf8');
  const webOut = /outDir:\s*'([^']+)'/.exec(vite)?.[1];
  if (webOut !== undefined) outputs.push(`apps/web/${webOut}`);

  expect(outputs, 'no build config declares an output directory').toHaveLength(2);
  return outputs;
}

describe('the published package', () => {
  it('declares nothing that is neither present nor built', () => {
    // `files` carried an entry for a `templates/` directory that never existed and
    // nothing read. npm skips it silently, which is exactly the problem: the next
    // person finds a declared runtime directory and goes looking for what deleted it.
    //
    // "Exists on disk" is the wrong test on its own, and the first version of this was
    // exactly that — green locally, red in CI, because `npm run test` runs before
    // `npm run build` there and `dist/` does not exist yet. So an entry is legitimate
    // when it is present *or* when a build config says it is produced. That still
    // catches `templates`, which is neither.
    const built = buildOutputs();

    for (const entry of manifest.files) {
      const present = existsSync(join(ROOT, entry));
      const produced = built.some(
        (output) => output === entry || output.startsWith(`${entry}/`) || entry.startsWith(`${output}/`),
      );

      expect(
        present || produced,
        `files declares ${entry}, which is neither on disk nor produced by a build ` +
          `(build outputs: ${built.join(', ')})`,
      ).toBe(true);
    }
  });

  it('points its executable at something that ships', () => {
    for (const [name, target] of Object.entries(manifest.bin)) {
      const normalised = target.replace(/^\.\//, '');
      expect(
        manifest.files.some((entry) => normalised.startsWith(entry.replace(/^\.\//, ''))),
        `bin ${name} → ${target} is outside every files entry`,
      ).toBe(true);
    }
  });

  it('imports no devDependency at runtime', () => {
    // A devDependency is not installed for a consumer. Importing one from `src/`
    // produces a package that works in the checkout and throws `Cannot find module`
    // on the first machine that installs it — and the type checker cannot see the
    // difference, because in here they are all just installed.
    const runtime = new Set(Object.keys(manifest.dependencies));
    const dev = new Set(Object.keys(manifest.devDependencies));
    const offenders: string[] = [];

    for (const tree of ['src', 'bin']) {
      for (const [name, files] of bareImports(tree)) {
        if (runtime.has(name)) continue;
        if (dev.has(name)) offenders.push(`${name} (devDependency) in ${files.join(', ')}`);
        else offenders.push(`${name} (undeclared) in ${files.join(', ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('supports the Node versions CI actually runs (D33-F)', () => {
    // Widening or narrowing `engines` silently is how a `>=20` claim becomes untrue.
    // The floor is declared here and the matrix is declared in the workflow; this is
    // the line that makes them one decision.
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const matrix = /node:\s*\[([^\]]+)\]/.exec(workflow)?.[1] ?? '';
    const versions = [...matrix.matchAll(/'(\d+)'/g)].map((match) => Number(match[1]));

    expect(manifest.engines.node).toBe('>=20');
    expect(versions, 'CI tests more than one Node version').toContain(20);
    expect(versions.length).toBeGreaterThan(1);
  });

  it('states a licence', () => {
    expect(manifest.license).toBe('MIT');
  });
});
