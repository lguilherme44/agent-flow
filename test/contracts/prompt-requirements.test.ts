import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which prompts need a filesystem is a fact three places repeat, and they drifted.
 *
 * `openai-runner.ts` said "the two that do are discovery and implementation" while
 * `code-review.md` had declared `workingDirectory: true` — and that one is the
 * expensive omission, because it lands on `finalReviewer` and fails at the *end*
 * of a run. Nobody noticed because the comment was written once and the prompt
 * frontmatter moved on.
 *
 * This reads the frontmatter and fails when the list stops matching, so the next
 * prompt that needs a working directory cannot be added quietly.
 */
const promptsDir = join(fileURLToPath(new URL('../../prompts', import.meta.url)));

function promptsNeedingWorkingDirectory(): string[] {
  return readdirSync(promptsDir)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => /^\s*workingDirectory:\s*true\s*$/m.test(readFileSync(join(promptsDir, file), 'utf8')))
    .map((file) => file.replace(/\.md$/, ''))
    .sort();
}

describe('the prompts that need a filesystem', () => {
  it('are exactly the three the openai-runner refuses to serve', () => {
    // Change this list only together with the comment in
    // `src/adapters/runners/openai-runner.ts` and the README's count.
    expect(promptsNeedingWorkingDirectory()).toEqual(['code-review', 'discovery', 'implementation']);
  });

  it('are named in the adapter that turns them away', () => {
    const adapter = readFileSync(
      fileURLToPath(new URL('../../src/adapters/runners/openai-runner.ts', import.meta.url)),
      'utf8',
    );
    for (const prompt of promptsNeedingWorkingDirectory()) {
      expect(adapter).toContain(prompt);
    }
  });

  it('leaves the rest servable by an endpoint, and there are nine of them', () => {
    const all = readdirSync(promptsDir).filter((f) => f.endsWith('.md'));
    expect(all.length - promptsNeedingWorkingDirectory().length).toBe(9);
  });
});
