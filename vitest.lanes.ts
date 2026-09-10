import type { UserConfig } from 'vitest/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

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
 * red on somebody else's machine months later. Four properties, and a file needs any one:
 *
 *   - it is named `*.integration.test.ts`, the convention that already existed;
 *   - it imports the temporary-repository fixture, so it runs real Git;
 *   - it imports `NodeProcessRunner`, so it spawns real children;
 *   - it, or a local helper beside it, imports `node:child_process` — which is how the
 *     eight-process lock race hid in the tight lane for two milestones.
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

/**
 * Spawning a child with no help from either module above.
 *
 * The predicate's three properties missed the single most process-heavy file in the
 * suite. `run-execution-lock.race.test.ts` is not named `.integration.`, imports neither
 * the repository fixture nor `NodeProcessRunner` — and bundles the lock with esbuild and
 * spawns **eight** Node processes through a local harness. It sat in the tight lane for
 * two milestones, and on a loaded Windows box it failed twice in one gate on assertions
 * about wall-clock windows.
 *
 * So the marker is the import that actually means "a child": `node:child_process`.
 */
const SPAWNS_A_CHILD = /^node:child_process$/;

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

/** Whether a specifier is, by itself, evidence that the importer spawns something. */
function spawningSpecifier(specifier: string): boolean {
  return SPAWNING_MODULES.some((m) => m.test(specifier)) || SPAWNS_A_CHILD.test(specifier);
}

/**
 * Whether a test spawns, following **one** level of its own local helpers.
 *
 * A test that reaches a child through a harness beside it spawns exactly as hard as one
 * that calls `spawn` inline, and the first version of this predicate could not tell the
 * difference — which is how the eight-process lock race ended up in the tight lane.
 *
 * One level, not a full graph. It is enough for a test and the file next to it, it
 * terminates without a visited set, and it stays a rule somebody can hold in their head.
 * `root` is optional so the pure form remains callable from a test that has the text but
 * not the tree; without it only the file's own imports are read.
 */
export function spawnsSubprocesses(file: string, text: string, root?: string): boolean {
  if (NAMED_INTEGRATION.test(file)) return true;

  const specifiers = imports(text);
  if (specifiers.some(spawningSpecifier)) return true;
  if (root === undefined) return false;

  return specifiers.some((specifier) => {
    const helper = localHelper(root, file, specifier);
    return helper !== undefined && imports(helper).some(spawningSpecifier);
  });
}

/** The source of a relative import, as TypeScript on disk. Absent when it is not one. */
function localHelper(root: string, file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  // Specifiers are written `./x.js` and the file on disk is `./x.ts` — the repository
  // compiles with `moduleResolution: nodenext`, so the extension in the import is the
  // *output* one and resolving it literally would find nothing.
  const candidate = join(root, dirname(file), specifier.replace(/\.js$/, '.ts'));
  try {
    return readFileSync(candidate, 'utf8');
  } catch {
    return undefined;
  }
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
    spawnsSubprocesses(file, readFileSync(join(root, file), 'utf8'), root),
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
