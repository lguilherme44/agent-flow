import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { detectStack } from '../../src/config/stack-detection.js';

const PROJECT = '/repo';
const detect = (files: Record<string, string>) => {
  const fs = new InMemoryFileSystem();
  for (const [path, content] of Object.entries(files)) fs.seed(`${PROJECT}/${path}`, content);
  return detectStack(fs, PROJECT);
};

describe('marker files (§7)', () => {
  it('detects Node from package.json', async () => {
    const stack = await detect({ 'package.json': '{"name":"api"}' });
    expect(stack.type).toBe('node');
    expect(stack.name).toBe('api');
  });

  it('detects Flutter from pubspec.yaml', async () => {
    const stack = await detect({ 'pubspec.yaml': 'name: my_app\n' });
    expect(stack.type).toBe('flutter');
    expect(stack.name).toBe('my_app');
  });

  it('detects Python from pyproject.toml', async () => {
    const stack = await detect({ 'pyproject.toml': '[project]\nname = "svc"\n' });
    expect(stack.type).toBe('python');
  });

  it('detects Go from go.mod', async () => {
    const stack = await detect({ 'go.mod': 'module github.com/x/y\n' });
    expect(stack.type).toBe('go');
    expect(stack.name).toBe('y');
  });

  it('detects Rust from Cargo.toml', async () => {
    const stack = await detect({ 'Cargo.toml': '[package]\nname = "crate"\n' });
    expect(stack.type).toBe('rust');
  });

  it('falls back to unknown without failing', async () => {
    // An unrecognised repository must still get a usable config file (§7).
    const stack = await detect({ 'README.md': '# hello' });
    expect(stack.type).toBe('unknown');
    expect(stack.commands).toEqual({});
  });

  it('names the project after its directory when the marker has no name', async () => {
    const stack = await detect({ 'package.json': '{}' });
    expect(stack.name).toBe('repo');
  });
});

describe('commands come from the repository, not from assumptions', () => {
  it('reads real scripts out of package.json', async () => {
    // Guessing `npm run lint` for a project that has no lint script would
    // produce a verification step that fails for the wrong reason.
    const stack = await detect({
      'package.json': JSON.stringify({
        name: 'api',
        scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc' },
      }),
    });

    expect(stack.commands).toEqual({
      install: 'npm install',
      test: 'npm run test',
      lint: 'npm run lint',
      build: 'npm run build',
    });
  });

  it('omits commands the project does not define', async () => {
    const stack = await detect({
      'package.json': JSON.stringify({ name: 'api', scripts: { test: 'vitest' } }),
    });

    expect(stack.commands.test).toBe('npm run test');
    expect(stack.commands.lint).toBeUndefined();
    expect(stack.commands.typecheck).toBeUndefined();
  });

  it('picks the package manager from the lockfile', async () => {
    const stack = await detect({
      'package.json': JSON.stringify({ name: 'api', scripts: { test: 'vitest' } }),
      'pnpm-lock.yaml': '',
    });

    expect(stack.commands.install).toBe('pnpm install');
    expect(stack.commands.test).toBe('pnpm run test');
  });

  it('recognises a yarn lockfile', async () => {
    const stack = await detect({
      'package.json': JSON.stringify({ name: 'api', scripts: { test: 'jest' } }),
      'yarn.lock': '',
    });
    expect(stack.commands.install).toBe('yarn install');
  });

  it('uses the conventional commands for a stack without a script table', async () => {
    const stack = await detect({ 'pubspec.yaml': 'name: app\n' });
    expect(stack.commands.test).toBe('flutter test');
    expect(stack.commands.lint).toBe('flutter analyze');
  });

  it('survives a malformed package.json', async () => {
    // A broken manifest is a reason to fall back, not to crash `init`.
    const stack = await detect({ 'package.json': '{ not json' });
    expect(stack.type).toBe('node');
    expect(stack.commands).toEqual({ install: 'npm install' });
  });
});

describe('source paths', () => {
  it('suggests conventional directories that actually exist', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${PROJECT}/package.json`, '{"name":"api"}');
    await fs.mkdirp(`${PROJECT}/src`);

    const stack = await detectStack(fs, PROJECT);
    expect(stack.paths.source).toEqual(['src']);
  });

  it('suggests nothing when no conventional directory is present', async () => {
    const stack = await detect({ 'package.json': '{"name":"api"}' });
    expect(stack.paths.source).toEqual([]);
  });
});
