import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Locates the shipped `prompts/` directory.
 *
 * Resolved from this module's own location, never from `process.cwd()`: the CLI
 * runs inside the user's repository, so cwd says nothing about where agent-flow
 * is installed. Both `npm i -g` and `npx` have to work.
 *
 * The candidate list covers running from source (`src/app/`), from the bundle
 * (`dist/bin/`), and from a package root.
 */
export function resolvePromptsDir(): string {
  return resolveShippedDir('prompts');
}

/**
 * Locates the shipped `guides/` directory — the operator guides `agent-flow instructions`
 * prints. Same resolution as the prompts, for the same reason, so the two can never
 * disagree about where the package is installed.
 */
export function resolveGuidesDir(): string {
  return resolveShippedDir('guides');
}

function resolveShippedDir(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    join(here, '../..', name), // src/app/ → package root, and dist/bin/ → package root
    join(here, '..', name),
    join(here, name),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }

  // Returned rather than thrown: the loader produces a better error, naming the
  // file that could not be found alongside the directory it looked in.
  return resolve(candidates[0] as string);
}
