import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { PromptLoader, PromptError } from '../../src/app/prompt-loader.js';
import { resolvePromptsDir } from '../../src/app/prompt-paths.js';

const PROMPTS = '/pkg/prompts';

function makeLoader(files: Record<string, string>) {
  const fs = new InMemoryFileSystem();
  for (const [name, content] of Object.entries(files)) fs.seed(`${PROMPTS}/${name}`, content);
  return new PromptLoader({ fs, promptsDir: PROMPTS });
}

const VALID = `---
role: sdd
permissions: read-only
outputFormat: markdown
requiredVars: [featureRequest, architecture]
---
# SDD

Feature: {{featureRequest}}

Architecture:
{{architecture}}
`;

describe('loading', () => {
  it('parses front matter and body', async () => {
    const prompt = await makeLoader({ 'sdd.md': VALID }).load('sdd');
    expect(prompt.meta.role).toBe('sdd');
    expect(prompt.meta.permissions).toBe('read-only');
    expect(prompt.body).toContain('# SDD');
    expect(prompt.body).not.toContain('---');
  });

  it('reports a missing prompt file by name', async () => {
    await expect(makeLoader({}).load('sdd')).rejects.toThrowError(PromptError);
    await expect(makeLoader({}).load('sdd')).rejects.toThrow(/sdd/);
  });

  it('rejects a prompt with no front matter', async () => {
    // Front matter is how a prompt declares what it needs. Without it the
    // orchestrator cannot check anything before spending a call.
    const loader = makeLoader({ 'sdd.md': '# Just a body\n' });
    await expect(loader.load('sdd')).rejects.toThrowError(PromptError);
  });

  it('rejects front matter that fails validation', async () => {
    const loader = makeLoader({ 'sdd.md': '---\nrole: not-a-real-role\n---\nbody\n' });
    await expect(loader.load('sdd')).rejects.toThrow(/role/);
  });

  it('defaults permissions to read-only', async () => {
    // The safe default. A prompt that needs to write has to say so explicitly.
    const loader = makeLoader({ 'x.md': '---\nrole: sdd\n---\nbody\n' });
    expect((await loader.load('x')).meta.permissions).toBe('read-only');
  });
});

describe('rendering', () => {
  const loader = makeLoader({ 'sdd.md': VALID });

  it('substitutes declared variables', async () => {
    const prompt = await loader.load('sdd');
    const rendered = prompt.render({
      featureRequest: 'recurring bookings',
      architecture: 'a monolith',
    });

    expect(rendered).toContain('Feature: recurring bookings');
    expect(rendered).toContain('a monolith');
    expect(rendered).not.toContain('{{');
  });

  it('fails before spending a call when a required variable is missing', async () => {
    // The cheapest possible failure: no process spawned, no quota burned.
    const prompt = await loader.load('sdd');

    expect(() => prompt.render({ featureRequest: 'x' })).toThrowError(PromptError);
    expect(() => prompt.render({ featureRequest: 'x' })).toThrow(/architecture/);
  });

  it('rejects an empty value for a required variable', async () => {
    // An empty string satisfies the key check but produces a prompt with a hole
    // in it, which is worse than failing — the model answers about nothing.
    const prompt = await loader.load('sdd');
    expect(() => prompt.render({ featureRequest: 'x', architecture: '   ' })).toThrowError(
      PromptError,
    );
  });

  it('leaves an undeclared placeholder alone rather than guessing', async () => {
    const loader2 = makeLoader({
      'x.md': '---\nrole: sdd\nrequiredVars: [a]\n---\n{{a}} and {{b}}\n',
    });
    const prompt = await loader2.load('x');
    expect(prompt.render({ a: 'A' })).toContain('{{b}}');
  });

  it('substitutes every occurrence of a variable', async () => {
    const loader2 = makeLoader({
      'x.md': '---\nrole: sdd\nrequiredVars: [a]\n---\n{{a}} {{a}} {{a}}\n',
    });
    expect((await loader2.load('x')).render({ a: 'z' })).toContain('z z z');
  });

  it('does not treat substituted content as a template', async () => {
    // A repository file containing {{...}} must not be re-expanded. Otherwise
    // project content could inject placeholders into the prompt.
    const loader2 = makeLoader({
      'x.md': '---\nrole: sdd\nrequiredVars: [a, b]\n---\n{{a}}|{{b}}\n',
    });
    const rendered = (await loader2.load('x')).render({ a: '{{b}}', b: 'REAL' });
    expect(rendered.trim()).toBe('{{b}}|REAL');
  });
});

describe('packaging', () => {
  it('resolves the prompts directory relative to the installed package', () => {
    // Must work under both `npm i -g` and `npx`, where cwd is unrelated to
    // where the package actually lives.
    const dir = resolvePromptsDir();
    expect(dir).toMatch(/prompts$/);
  });
});
