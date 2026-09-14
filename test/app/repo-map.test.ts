import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { testGitCommand } from '../fakes/test-git-command.js';
import { buildRepoMap } from '../../src/app/repo-map.js';
import type { CodeTagger, TaggableFile } from '../../src/ports/code-tagger.js';
import type { FileTags } from '../../src/core/repo-map.js';

const PROJECT = '/repo';

/** Answers from the file's own content, so a test states its graph in one place. */
class FakeTagger implements CodeTagger {
  readonly seen: string[] = [];

  health() {
    return { available: true };
  }

  supportedExtensions(): readonly string[] {
    return ['.ts', '.vue'];
  }

  async tag(files: readonly TaggableFile[]): Promise<readonly FileTags[]> {
    for (const file of files) this.seen.push(file.path);
    return files.map((file) => ({
      path: file.path,
      defs: [...file.content.matchAll(/def:(\w+)/g)].map((m) => m[1] ?? ''),
      refs: [...file.content.matchAll(/ref:(\w+)/g)].map((m) => m[1] ?? ''),
    }));
  }
}

function world(listing: string, files: Record<string, string> = {}) {
  const fs = new InMemoryFileSystem();
  for (const [path, content] of Object.entries(files)) fs.seed(`${PROJECT}/${path}`, content);

  const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: listing });
  return { fs, tagger: new FakeTagger(), git: testGitCommand(processRunner) };
}

const build = (w: ReturnType<typeof world>, extra = {}) =>
  buildRepoMap({ ...w, projectDir: PROJECT, budgetTokens: 5000, ...extra });

describe('buildRepoMap', () => {
  it('maps what Git lists, ranked', async () => {
    const w = world('src/hub.ts\nsrc/user.ts\n', {
      'src/hub.ts': 'def:formatMoney',
      'src/user.ts': 'def:show ref:formatMoney',
    });

    const result = await build(w);

    expect(result?.text.indexOf('src/hub.ts')).toBeLessThan(result?.text.indexOf('src/user.ts') ?? 0);
    expect(result?.tagged).toBe(2);
  });

  it('never reads a file no grammar covers', async () => {
    // On a monorepo most of the tree is images, lockfiles and fixtures. Reading them to
    // discard them is the cost this whole thing exists to avoid.
    const w = world('src/a.ts\ndocs/guide.md\nassets/logo.png\n', {
      'src/a.ts': 'def:a',
      'docs/guide.md': '# guide',
      'assets/logo.png': 'binary',
    });

    await build(w);

    expect(w.tagger.seen).toEqual(['src/a.ts']);
  });

  it('honours paths.source when the project names one', async () => {
    // Measured need: a repository whose `.gitignore` lists a retired app and whose index
    // tracks it anyway, so Git lists it and the legacy code competes for the budget.
    const w = world('src/live.ts\nold/legacy.ts\n', {
      'src/live.ts': 'def:live',
      'old/legacy.ts': 'def:legacy',
    });

    const result = await build(w, { sourcePaths: ['src'] });

    expect(result?.text).toContain('src/live.ts');
    expect(result?.text).not.toContain('old/legacy.ts');
  });

  it('maps the whole tree when no source path is named', async () => {
    // The positive control: narrowing is a lever, not a default, and a repository whose
    // code is its code must not have to declare that.
    const w = world('src/live.ts\nold/legacy.ts\n', {
      'src/live.ts': 'def:live',
      'old/legacy.ts': 'def:legacy',
    });

    const result = await build(w);

    expect(result?.text).toContain('old/legacy.ts');
  });

  it('skips a file too large to be worth parsing', async () => {
    const w = world('src/a.ts\nvendor/bundle.ts\n', {
      'src/a.ts': 'def:a',
      'vendor/bundle.ts': `def:x${' '.repeat(2000)}`,
    });

    await build(w, { maxFileBytes: 500 });

    expect(w.tagger.seen).toEqual(['src/a.ts']);
  });

  it('keeps going when one listed file cannot be read', async () => {
    // Git listed it, and between the listing and the read it went away. One file.
    const w = world('src/a.ts\nsrc/ghost.ts\n', { 'src/a.ts': 'def:a' });

    const result = await build(w);

    expect(result?.tagged).toBe(1);
    expect(result?.text).toContain('src/a.ts');
  });

  it('answers nothing rather than a wrong map when Git cannot list', async () => {
    // "No map" is a state discovery already handles — it is what every run had until now.
    const fs = new InMemoryFileSystem();
    const processRunner = new FakeProcessRunner().always({ exitCode: 128, stderr: 'not a git repository' });

    const result = await buildRepoMap({
      fs,
      git: testGitCommand(processRunner),
      tagger: new FakeTagger(),
      projectDir: PROJECT,
      budgetTokens: 5000,
    });

    expect(result).toBeUndefined();
  });

  it('reports what the budget left out', async () => {
    const listing = Array.from({ length: 40 }, (_, i) => `src/f${String(i)}.ts`).join('\n');
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`src/f${String(i)}.ts`, `def:sym${String(i)}`]),
    );

    const result = await build(world(listing, files), { budgetTokens: 10 });

    expect(result?.omitted).toBeGreaterThan(0);
    expect(result?.candidates).toBe(40);
  });
});
