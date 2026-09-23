import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import {
  forgetProject,
  isProjectDirectory,
  projectHubPath,
  readProjectHub,
  rememberProject,
  rememberProjects,
  samePath,
} from '../../src/app/project-hub.js';

/**
 * The project hub: the one list of directories `agent-flow ui` shows from anywhere.
 *
 * It used to be written only by `ui`, so a project nobody had opened the dashboard in was
 * invisible to it — and opening the dashboard meant `cd` into the project first, which is
 * the chore the hub exists to remove. These tests pin the three operations every other
 * entry point composes.
 */

const GLOBAL = '/home/.agent-flow/config.yaml';
const HUB = projectHubPath(GLOBAL);

function project(fs: InMemoryFileSystem, dir: string): string {
  fs.seed(`${dir}/.agent-flow/config.yaml`, 'roles: {}\n');
  return dir;
}

describe('projectHubPath', () => {
  it('sits next to the global configuration, so --config moves it too', () => {
    expect(projectHubPath('/tmp/x/config.yaml').replace(/\\/g, '/')).toBe('/tmp/x/projects.json');
  });
});

describe('readProjectHub', () => {
  it('is empty when there is no hub yet, or it does not parse', async () => {
    const fs = new InMemoryFileSystem();
    expect(await readProjectHub(fs, GLOBAL)).toEqual([]);

    fs.seed(HUB, '{ nope');
    expect(await readProjectHub(fs, GLOBAL)).toEqual([]);
  });

  it('drops a directory that no longer exists, so a deleted worktree does not linger', async () => {
    const fs = new InMemoryFileSystem();
    project(fs, '/wk/api');
    fs.seed(HUB, JSON.stringify(['/wk/api', '/wk/deleted-worktree', 42]));

    expect(await readProjectHub(fs, GLOBAL)).toEqual(['/wk/api']);
  });

  it('keeps a directory that exists but was never through init — it is a scan root', async () => {
    // `projects add ~/wk` is the way to hand the dashboard a folder of repositories, and the
    // Deck offers their `init` from there. Pruning on "no config" would undo that the moment
    // the hub was next read.
    const fs = new InMemoryFileSystem();
    await fs.mkdirp('/wk');
    fs.seed(HUB, JSON.stringify(['/wk']));

    expect(await readProjectHub(fs, GLOBAL)).toEqual(['/wk']);
  });
});

describe('rememberProject', () => {
  it('adds a directory once, however many commands run in it', async () => {
    const fs = new InMemoryFileSystem();
    project(fs, '/wk/api');

    expect(await rememberProject(fs, GLOBAL, '/wk/api')).toBe(true);
    expect(await rememberProject(fs, GLOBAL, '/wk/api')).toBe(false);
    expect(await readProjectHub(fs, GLOBAL)).toEqual(['/wk/api']);
  });

  it('does not write when nothing changed, so a read-only command leaves no trace', async () => {
    const fs = new InMemoryFileSystem();
    project(fs, '/wk/api');
    await rememberProject(fs, GLOBAL, '/wk/api');
    const writes = fs.writes.length;

    await rememberProject(fs, GLOBAL, '/wk/api');
    expect(fs.writes.length).toBe(writes);
  });

  it('refuses a directory that does not exist', async () => {
    const fs = new InMemoryFileSystem();
    expect(await rememberProject(fs, GLOBAL, '/nowhere')).toBe(false);
    expect(await fs.exists(HUB)).toBe(false);
  });

  it('keeps what was there, pruned', async () => {
    const fs = new InMemoryFileSystem();
    project(fs, '/wk/api');
    project(fs, '/wk/web');
    fs.seed(HUB, JSON.stringify(['/wk/api', '/wk/gone']));

    await rememberProject(fs, GLOBAL, '/wk/web');
    expect(await readProjectHub(fs, GLOBAL)).toEqual(['/wk/api', '/wk/web']);
  });
});

describe('forgetProject', () => {
  it('removes a directory by its path', async () => {
    const fs = new InMemoryFileSystem();
    project(fs, '/wk/api');
    project(fs, '/wk/web');
    await rememberProject(fs, GLOBAL, '/wk/api');
    await rememberProject(fs, GLOBAL, '/wk/web');

    expect(await forgetProject(fs, GLOBAL, '/wk/api')).toBe(true);
    expect(await readProjectHub(fs, GLOBAL)).toEqual(['/wk/web']);
    expect(await forgetProject(fs, GLOBAL, '/wk/api')).toBe(false);
  });
});

describe('samePath', () => {
  it('ignores case and separators on Windows, and only there', () => {
    expect(samePath('C:\\Users\\Me\\wk', 'c:/users/me/wk/', 'win32')).toBe(true);
    expect(samePath('/Users/me/wk', '/users/me/wk', 'darwin')).toBe(false);
    expect(samePath('/wk/api/', '/wk/api', 'linux')).toBe(true);
  });
});

describe('the home directory is never a project (its .agent-flow holds the global config)', () => {
  // Measured on the first real start from a home directory: `~/.agent-flow/config.yaml` IS
  // the global configuration, and it is also exactly the marker a project is recognised by.
  // So the home directory was listed as a project, and written into the hub — which then
  // made every later dashboard walk the whole home directory as a root.
  const HOME_GLOBAL = '/home/me/.agent-flow/config.yaml';

  it('isProjectDirectory says no for the directory that owns the global config', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(HOME_GLOBAL, 'ui: {}\n');
    project(fs, '/home/me/wk/api');

    expect(await isProjectDirectory(fs, '/home/me', HOME_GLOBAL)).toBe(false);
    expect(await isProjectDirectory(fs, '/home/me/wk/api', HOME_GLOBAL)).toBe(true);
    expect(await isProjectDirectory(fs, '/home/me/wk', HOME_GLOBAL)).toBe(false);
  });

  it('drops it from the hub on read, so a hub that already has it heals itself', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(HOME_GLOBAL, 'ui: {}\n');
    project(fs, '/home/me/wk/api');
    fs.seed(projectHubPath(HOME_GLOBAL), JSON.stringify(['/home/me/wk/api', '/home/me']));

    expect(await readProjectHub(fs, HOME_GLOBAL)).toEqual(['/home/me/wk/api']);
  });

  it('refuses to remember it', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(HOME_GLOBAL, 'ui: {}\n');

    expect(await rememberProject(fs, HOME_GLOBAL, '/home/me')).toBe(false);
    expect(await rememberProjects(fs, HOME_GLOBAL, ['/home/me'])).toBe(false);
    expect(await fs.exists(projectHubPath(HOME_GLOBAL))).toBe(false);
  });
});
