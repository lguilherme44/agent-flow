import type { UserConfig } from 'vitest/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Which tests spawn real processes, answered by reading them rather than by a list.
 *
 * The suite has a 400× spread in cost. A pure test runs in single-digit milliseconds; a
 * test that checks out a temporary repository, runs an install in it and merges a marker
 * costs eleven seconds on Linux and more on Windows, where spawning a process is far more
 * expensive. One `testTimeout` over both is a number that is either too tight for the
 * second or meaningless for the first, and it had been too tight: a clean run on Windows
 * reported **129 timeouts at 30 s**, every one of them in this set, and every one of them
 * green when its file ran alone.
 *
 * **The set is derived, not spelled.** A hand-written list is the thing that rots — the
 * next test to grow a subprocess is added to no list, lands in the tight lane, and goes
 * red on somebody else's machine months later. Three properties, and a file needs any one:
 *
 *   - it is named `*.integration.test.ts`, the convention that already existed;
 *   - it imports the temporary-repository fixture, so it runs real Git;
 *   - it imports `NodeProcessRunner`, so it spawns real children.
 *
 * The union covers every file that timed out in the measured run, and
 * `test/architecture.test.ts` asserts that it still can — a predicate that stops matching
 * its subjects would move the slow tests back into the tight lane silently, which is the
 * failure this file exists to prevent.
 */
export const NAMED_INTEGRATION = /\.integration\.test\.ts$/;

/**
 * The modules whose *import* means "this file spawns something".
 *
 * **Import specifiers, never raw text.** The first version scanned the file for the
 * strings and put `test/architecture.test.ts` in the slow lane, because that suite has
 * rules *about* `NodeProcessRunner` and names it in prose — then excluded itself from
 * both lanes and reported "No test files found". Matching prose is the trap this
 * repository names at every other gate it writes, and this file walked into it on the
 * first try.
 */
export const SPAWNING_MODULES = [/fixtures\/temp-repo(\.js)?$/, /process\/node-process-runner(\.js)?$/];

/** Specifiers only — a name in a comment or an assertion is not a dependency. */
function imports(text: string): string[] {
  const out: string[] = [];
  for (const pattern of [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of text.matchAll(pattern)) if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

export function spawnsSubprocesses(file: string, text: string): boolean {
  if (NAMED_INTEGRATION.test(file)) return true;
  return imports(text).some((specifier) => SPAWNING_MODULES.some((m) => m.test(specifier)));
}

/** Every test file, named with `/` on every host — these become globs. */
export function testFiles(root: string): string[] {
  const out: string[] = [];
  const dir = join(root, 'test');

  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.test\.ts$/.test(entry)) out.push(relative(root, full).split(sep).join('/'));
    }
  };

  walk(dir);
  return out.sort();
}

/**
 * The slow lane, as globs relative to the repository root.
 *
 * The name alone is enough; otherwise the file's *imports* decide, never its prose.
 */
export function subprocessLane(root: string): string[] {
  return testFiles(root).filter((file) =>
    spawnsSubprocesses(file, readFileSync(join(root, file), 'utf8')),
  );
}

/**
 * The coverage contract, in one place because two configs need it.
 *
 * `vitest.config.ts` keeps it so a bare `vitest run --coverage` still measures against the
 * real thresholds, and `vitest.coverage.config.ts` — the one the gate runs, over both
 * lanes — keeps it because that is where the number that counts is produced. Two copies
 * of a floor is a floor that drifts downward on one side and nobody notices, since a
 * threshold only ever fails loudly when it is *too high*.
 */
export const COVERAGE: NonNullable<NonNullable<UserConfig['test']>['coverage']> = {
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
};
