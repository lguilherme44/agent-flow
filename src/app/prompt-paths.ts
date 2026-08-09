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
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    join(here, '../../prompts'), // src/app/ → package root
    join(here, '../prompts'), // dist/bin/ → package root
    join(here, 'prompts'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }

  // Returned rather than thrown: the loader produces a better error, naming the
  // prompt that could not be found alongside the directory it looked in.
  return resolve(candidates[0] as string);
}
