import { describe, it, expect } from 'vitest';
import { posix } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import {
  assignIds,
  discoverProjects,
  registryOf,
  slug,
} from '../../src/server/project-registry.js';
import { ProjectIdSchema } from '../../src/contracts/index.js';

/**
 * UI-03 — project discovery.
 *
 * The registry is the filesystem security boundary (§93): every endpoint names
 * a project by id, and the only ids that exist are the ones produced here from
 * directories the operator pointed the server at.
 */

const CONFIG = 'project:\n  name: demo\n  type: node\n';

function world(paths: readonly string[]): InMemoryFileSystem {
  const fs = new InMemoryFileSystem();
  for (const path of paths) fs.seed(`${path}/.agent-flow/config.yaml`, CONFIG);
  return fs;
}

describe('discoverProjects', () => {
  it('finds a project in the root itself', async () => {
    const fs = world(['/wk/api']);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk/api'] });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk/api']);
  });

  it('finds several under one root', async () => {
    const fs = world(['/wk/api', '/wk/web']);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'] });

    expect(found.projects.map((project) => project.id)).toEqual(['api', 'web']);
  });

  it('ignores a directory that was never initialised', async () => {
    // A `runs/` folder left behind is a leftover, not a project. Listing it
    // would offer the user something with no configuration to read.
    const fs = world(['/wk/api']);
    fs.seed('/wk/leftover/.agent-flow/runs/AF-2026-001/state.json', '{}');

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'] });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk/api']);
  });

  it('stops at the configured depth', async () => {
    // Unbounded scanning of a home directory is a start-up that takes minutes
    // and reads places nobody asked it to.
    const fs = world(['/wk/a/b/c/deep']);

    expect((await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 2 })).projects).toEqual([]);
    expect((await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 4 })).projects).toHaveLength(1);
  });

  it('never descends into a dependency directory', async () => {
    const fs = world(['/wk/api']);
    fs.seed('/wk/node_modules/thing/.agent-flow/config.yaml', CONFIG);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 4 });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk/api']);
  });

  it('descends past a project, for a monorepo holding initialised packages', async () => {
    const fs = world(['/wk/mono', '/wk/mono/packages/api']);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 4 });

    expect(found.projects.map((project) => project.path)).toEqual([
      '/wk/mono',
      '/wk/mono/packages/api',
    ]);
  });

  it('returns nothing rather than failing on an unreadable root', async () => {
    const fs = new InMemoryFileSystem();

    expect((await discoverProjects({ fs, path: posix, roots: ['/nowhere'] })).projects).toEqual([]);
  });
});

describe('a workspace is the directory the operator named, and nothing else (UI-29, §93)', () => {
  it('does not follow a link out of the workspace', async () => {
    // The failure this exists to stop: a link in `~/wk` pointing at a repository
    // in `~/private`, and a server the operator believes is serving `~/wk`
    // publishing it on a local port. `stat` cannot see this — it follows the
    // link and reports an ordinary directory.
    const fs = world(['/wk/api', '/private/secrets']);
    fs.link('/wk/elsewhere', '/private/secrets');

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk/api']);
    expect(found.skipped).toEqual([
      { path: '/wk/elsewhere', reason: 'outside_workspace', resolved: '/private/secrets' },
    ]);
  });

  it('follows a link that stays inside the workspace', async () => {
    // Refusing every link would be a different rule, and a worse one: a
    // workspace that arranges its own repositories with links is arranging what
    // the operator already chose.
    const fs = world(['/wk/repos/api']);
    fs.link('/wk/current', '/wk/repos/api');

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.skipped).toEqual([]);
    // One project, not two. The walk keys on the resolved path, so the same
    // directory reached twice is the same project — reporting it twice would put
    // one run history under two ids.
    expect(found.projects.map((project) => project.path)).toEqual(['/wk/repos/api']);
  });

  it('terminates on a link that points back up its own tree', async () => {
    const fs = world(['/wk/api']);
    fs.link('/wk/api/self', '/wk');

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 6 });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk/api']);
  });

  it('resolves the root too, so a linked workspace is not entirely rejected', async () => {
    // `agent-flow ui ~/wk` where `~` is itself a link — common on machines with
    // a relocated home directory. Comparing a resolved child against a raw root
    // would find nothing at all, and the operator would be told their workspace
    // is empty.
    const fs = world(['/real/wk/api']);
    fs.link('/home/me/wk', '/real/wk');

    const found = await discoverProjects({ fs, path: posix, roots: ['/home/me/wk'], depth: 2 });

    expect(found.projects.map((project) => project.id)).toEqual(['api']);
    expect(found.skipped).toEqual([]);
  });

  it('never lets one root be a prefix of another by accident', async () => {
    // `/wk` must not contain `/wknight`, which a bare `startsWith` says it does.
    const fs = world(['/wknight/api']);
    fs.link('/wk/near', '/wknight');
    fs.seed('/wk/.agent-flow/config.yaml', CONFIG);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk']);
    expect(found.skipped.map((entry) => entry.resolved)).toEqual(['/wknight']);
  });

  it('caps a depth beyond the bound rather than honouring it', async () => {
    const fs = world(['/wk/a/b/c/d/e/f/g/deep']);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 99 });

    expect(found.projects).toEqual([]);
  });
});

/**
 * 7.6 — the repositories the workspace could register.
 *
 * A candidate is the answer to "what am I allowed to offer", and it has to obey exactly
 * the rules a project does: inside the root, resolved rather than followed, bounded by the
 * same depth. The walk issues the ids, which is the whole reason a browser can ask for one
 * without ever naming a directory (§93).
 */
describe('candidates for registration', () => {
  const repo = (paths: readonly string[], projects: readonly string[] = []): InMemoryFileSystem => {
    const world = new InMemoryFileSystem();
    for (const path of paths) world.seed(`${path}/.git/HEAD`, 'ref: refs/heads/main\n');
    for (const path of projects) world.seed(`${path}/.agent-flow/config.yaml`, CONFIG);
    return world;
  };

  it('offers a repository that has never been through init', async () => {
    const fs = repo(['/wk/api']);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.projects).toEqual([]);
    expect(found.candidates.map((candidate) => candidate.path)).toEqual(['/wk/api']);
  });

  it('offers nothing for a directory that is not a repository', async () => {
    // The rule `discoverProjects` already applies to `package.json`, one step earlier:
    // half a machine has a directory, and a control plane that proposed every one of them
    // would be a file browser with a worse interface.
    const fs = new InMemoryFileSystem();
    fs.seed('/wk/notes/README.md', '# not a repository\n');

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.candidates).toEqual([]);
  });

  it('does not offer a repository that is already a project', async () => {
    const fs = repo(['/wk/api'], ['/wk/api']);

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk/api']);
    expect(found.candidates).toEqual([]);
  });

  it('offers a checkout whose .git is a file, as a worktree or a submodule has', async () => {
    // `exists` rather than `stat`: a check that only accepted a directory would hide
    // exactly the checkouts somebody works in.
    const fs = new InMemoryFileSystem();
    fs.seed('/wk/api/.git', 'gitdir: /wk/main/.git/worktrees/api\n');

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.candidates.map((candidate) => candidate.path)).toEqual(['/wk/api']);
  });

  it('refuses a repository reached by a link out of the workspace', async () => {
    // The same rule as a project's, and it has to be: a candidate id is a write target.
    const fs = repo(['/wk/api', '/private/secrets']);
    fs.link('/wk/elsewhere', '/private/secrets');

    const found = await discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 });

    expect(found.candidates.map((candidate) => candidate.path)).toEqual(['/wk/api']);
    expect(found.skipped.map((entry) => entry.resolved)).toEqual(['/private/secrets']);
  });

  it('never gives a candidate an id a project already holds', async () => {
    // Two checkouts sharing a basename, one registered and one not. Colliding would let a
    // candidate shadow a project on every route that resolves an id.
    const fs = repo(['/a/api', '/b/api'], ['/a/api']);

    const found = await discoverProjects({ fs, path: posix, roots: ['/a', '/b'], depth: 2 });

    expect(found.projects.map((project) => project.id)).toEqual(['api']);
    expect(found.candidates.map((candidate) => candidate.id)).toEqual(['api-2']);
  });

  it('issues ids the routes will accept', () => {
    const fs = repo(['/wk/My Repo!']);

    return discoverProjects({ fs, path: posix, roots: ['/wk'], depth: 3 }).then((found) => {
      for (const candidate of found.candidates) {
        expect(ProjectIdSchema.safeParse(candidate.id).success, candidate.id).toBe(true);
      }
    });
  });
});

describe('project ids', () => {
  it('always match what the routes will accept', () => {
    // If an id could not round-trip through the URL schema, the project would
    // be listed and then unreachable.
    const ids = assignIds([
      '/wk/BeaHub API',
      '/wk/my_project',
      '/wk/...',
      '/wk/123-numbers',
    ]).map((project) => project.id);

    for (const id of ids) expect(ProjectIdSchema.safeParse(id).success).toBe(true);
  });

  it('separates two checkouts that share a name', () => {
    // One id for two working trees would show one run history for both — and,
    // once write actions exist, route an approval to whichever won.
    const ids = assignIds(['/a/api', '/b/api']).map((project) => project.id);

    expect(ids).toEqual(['api', 'api-2']);
  });

  it('never produces an empty id', () => {
    expect(slug('...')).toBe('project');
    expect(slug('')).toBe('project');
  });
});

describe('registryOf', () => {
  const projects = [
    { id: 'api', name: 'api', path: '/wk/api' },
    { id: 'web', name: 'web', path: '/wk/web' },
  ];

  it('resolves an id to its project', () => {
    expect(registryOf(projects).get('web')?.path).toBe('/wk/web');
  });

  it('has no answer for an id it never issued', () => {
    expect(registryOf(projects).get('elsewhere')).toBeUndefined();
  });

  it('defaults to the first, which is where the UI was started', () => {
    expect(registryOf(projects).primary()?.id).toBe('api');
  });
});
