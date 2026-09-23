import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { runProjectsCommand } from '../../src/cli/projects.js';
import { main } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { projectHubPath, readProjectHub } from '../../src/app/project-hub.js';
import type { GlobalOptions } from '../../src/cli/index.js';

/**
 * `agent-flow projects` and the hub filling itself after every command.
 */

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  cwd: '/wk',
  globalConfigPath: '/home/.agent-flow/config.yaml',
  verbose: false,
  dryRun: false,
  json: false,
  strict: false,
  ...over,
});

const quiet = (): { out: string[]; write: (text: string) => void } => {
  const out: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { out, write: (text) => out.push(text) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runProjectsCommand', () => {
  it('adds directories relative to where it was typed, and lists them by kind', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/wk/api/.agent-flow/config.yaml', 'x: 1\n');
    await fs.mkdirp('/wk/repos');
    const { out, write } = quiet();

    expect(await runProjectsCommand('add', ['api', '/wk/repos'], globals({ cwd: '/wk' }), fs, write, posix.resolve)).toBe(ExitCode.OK);
    expect(await readProjectHub(fs, globals().globalConfigPath)).toEqual(['/wk/api', '/wk/repos']);

    out.length = 0;
    await runProjectsCommand('list', [], globals(), fs, write);
    expect(out.join('')).toMatch(/project\s+\S*api/);
    expect(out.join('')).toMatch(/folder\s+\S*repos/);
  });

  it('refuses a directory that does not exist, and says which', async () => {
    const fs = new InMemoryFileSystem();
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });

    expect(await runProjectsCommand('add', ['/nowhere'], globals(), fs, () => undefined)).toBe(ExitCode.CONFIG_ERROR);
    expect(errors.join('')).toContain('No such directory');
  });

  it('refuses the home directory and says why, instead of "already in"', async () => {
    // `~/.agent-flow/config.yaml` is the global config, so home can never be a project;
    // the hub dropped it silently and the command claimed it was already listed.
    const fs = new InMemoryFileSystem();
    await fs.mkdirp('/home');
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    const out: string[] = [];

    expect(await runProjectsCommand('add', ['/home'], globals(), fs, (text) => out.push(text), posix.resolve)).toBe(ExitCode.CONFIG_ERROR);
    expect(errors.join('')).toContain('holds the global configuration');
    expect(out.join('')).not.toContain('already in');
  });

  it('removes by path, or by the name the dashboard shows when only one entry has it', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdirp('/wk/api');
    await fs.mkdirp('/wk/web');
    fs.seed(projectHubPath(globals().globalConfigPath), JSON.stringify(['/wk/api', '/wk/web']));
    const { write } = quiet();

    expect(await runProjectsCommand('remove', ['web'], globals(), fs, write, posix.resolve)).toBe(ExitCode.OK);
    expect(await readProjectHub(fs, globals().globalConfigPath)).toEqual(['/wk/api']);
  });
});

describe('the hub fills itself after any command (postAction)', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function world(): { project: string; config: string; hub: string } {
    root = mkdtempSync(join(tmpdir(), 'af-hub-'));
    const project = join(root, 'api');
    mkdirSync(join(project, '.agent-flow'), { recursive: true });
    writeFileSync(join(project, '.agent-flow', 'config.yaml'), 'project:\n  name: api\n  type: node\n');
    const config = join(root, 'home', 'config.yaml');
    mkdirSync(join(root, 'home'), { recursive: true });
    return { project, config, hub: projectHubPath(config) };
  }

  it('adds the project a command ran in', async () => {
    const { project, config, hub } = world();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main(['node', 'agent-flow', '--cwd', project, '--config', config, 'config', 'list', '--global']);

    expect(JSON.parse(readFileSync(hub, 'utf8'))).toEqual([project]);
  });

  it('leaves `projects remove` undone on its way out, which is the point of it', async () => {
    const { project, config, hub } = world();
    writeFileSync(hub, JSON.stringify([project]));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await main(['node', 'agent-flow', '--cwd', project, '--config', config, 'projects', 'remove', '.']);

    expect(JSON.parse(readFileSync(hub, 'utf8'))).toEqual([]);
  });

  it('adds nothing for a directory that is not a project', async () => {
    const { config, hub } = world();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main(['node', 'agent-flow', '--cwd', root!, '--config', config, 'config', 'list', '--global']);

    expect(existsSync(hub)).toBe(false);
  });
});
