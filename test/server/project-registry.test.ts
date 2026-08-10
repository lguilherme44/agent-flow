import { describe, it, expect } from 'vitest';
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

    const found = await discoverProjects({ fs, roots: ['/wk/api'] });

    expect(found.map((project) => project.path)).toEqual(['/wk/api']);
  });

  it('finds several under one root', async () => {
    const fs = world(['/wk/api', '/wk/web']);

    const found = await discoverProjects({ fs, roots: ['/wk'] });

    expect(found.map((project) => project.id)).toEqual(['api', 'web']);
  });

  it('ignores a directory that was never initialised', async () => {
    // A `runs/` folder left behind is a leftover, not a project. Listing it
    // would offer the user something with no configuration to read.
    const fs = world(['/wk/api']);
    fs.seed('/wk/leftover/.agent-flow/runs/AF-2026-001/state.json', '{}');

    const found = await discoverProjects({ fs, roots: ['/wk'] });

    expect(found.map((project) => project.path)).toEqual(['/wk/api']);
  });

  it('stops at the configured depth', async () => {
    // Unbounded scanning of a home directory is a start-up that takes minutes
    // and reads places nobody asked it to.
    const fs = world(['/wk/a/b/c/deep']);

    expect(await discoverProjects({ fs, roots: ['/wk'], depth: 2 })).toEqual([]);
    expect(await discoverProjects({ fs, roots: ['/wk'], depth: 4 })).toHaveLength(1);
  });

  it('never descends into a dependency directory', async () => {
    const fs = world(['/wk/api']);
    fs.seed('/wk/node_modules/thing/.agent-flow/config.yaml', CONFIG);

    const found = await discoverProjects({ fs, roots: ['/wk'], depth: 4 });

    expect(found.map((project) => project.path)).toEqual(['/wk/api']);
  });

  it('descends past a project, for a monorepo holding initialised packages', async () => {
    const fs = world(['/wk/mono', '/wk/mono/packages/api']);

    const found = await discoverProjects({ fs, roots: ['/wk'], depth: 4 });

    expect(found.map((project) => project.path)).toEqual([
      '/wk/mono',
      '/wk/mono/packages/api',
    ]);
  });

  it('returns nothing rather than failing on an unreadable root', async () => {
    const fs = new InMemoryFileSystem();

    expect(await discoverProjects({ fs, roots: ['/nowhere'] })).toEqual([]);
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
