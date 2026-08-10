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

// Found by running the workflow on a real Python repository. Node, Flutter and
// Go all read the project name from the manifest they used to identify the
// stack; Python and Rust ignored theirs and used the directory name. Python
// also declared `test: pytest` and nothing else, while the same file it had
// already parsed declared ruff.
//
// The consequence is not cosmetic. `test` being the only configured validation
// id meant a planned task could carry four acceptance criteria about the diff
// and still pass, because pytest cannot check any of them — the live plan
// review caught exactly that.
describe('Python and Rust read their manifests too', () => {
  it('takes the Python project name from pyproject.toml', async () => {
    const stack = await detect({
      'pyproject.toml': '[project]\nname = "retrykit"\nversion = "0.1.0"\n',
    });

    expect(stack.type).toBe('python');
    expect(stack.name).toBe('retrykit');
  });

  it('falls back to the directory when the manifest declares no name', async () => {
    const stack = await detect({ 'pyproject.toml': '[build-system]\nrequires = ["hatchling"]\n' });

    expect(stack.name).toBe('repo');
  });

  it('declares a lint command when the project declares a linter', async () => {
    const stack = await detect({
      'pyproject.toml': '[project]\nname = "x"\n\n[dependency-groups]\ndev = ["pytest>=8", "ruff>=0.8"]\n',
    });

    expect(stack.commands.lint).toBe('ruff check .');
  });

  it('declares a typecheck command when the project declares a type checker', async () => {
    const stack = await detect({
      'pyproject.toml': '[project]\nname = "x"\n\n[tool.mypy]\nstrict = true\n',
    });

    expect(stack.commands.typecheck).toBe('mypy .');
  });

  it('invents nothing when the manifest declares no tooling', async () => {
    // The Node detector's rule, applied here: a command that does not exist is
    // worse than a missing one, because a task will be planned against it.
    const stack = await detect({ 'pyproject.toml': '[project]\nname = "x"\n' });

    expect(stack.commands.lint).toBeUndefined();
    expect(stack.commands.typecheck).toBeUndefined();
    expect(stack.commands.test).toBe('pytest');
  });

  it('prefixes commands with the runner the lockfile implies', async () => {
    // The same reasoning as `packageManager` for Node: a bare `pytest` reaches
    // whatever happens to be on PATH, which is not necessarily the environment
    // the project pins.
    const stack = await detect({
      'pyproject.toml': '[project]\nname = "x"\n\n[dependency-groups]\ndev = ["ruff"]\n',
      'uv.lock': 'version = 1\n',
    });

    expect(stack.commands.test).toBe('uv run pytest');
    expect(stack.commands.lint).toBe('uv run ruff check .');
  });

  it('takes the Rust package name from Cargo.toml', async () => {
    const stack = await detect({ 'Cargo.toml': '[package]\nname = "slugkit"\nedition = "2021"\n' });

    expect(stack.type).toBe('rust');
    expect(stack.name).toBe('slugkit');
  });

  it('does not mistake a dependency name for the package name', async () => {
    // `name = ` appears under [dependencies] entries too, and the first match
    // in the file is not necessarily the package.
    const stack = await detect({
      'Cargo.toml': '[dependencies]\nserde = { version = "1", package = "serde_core" }\n\n[package]\nname = "slugkit"\n',
    });

    expect(stack.name).toBe('slugkit');
  });
});
