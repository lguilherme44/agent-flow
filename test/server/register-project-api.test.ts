import { afterEach, describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { discoveredRegistry, registryOf } from '../../src/server/project-registry.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { StateStore } from '../../src/app/state-store.js';
import type { ProjectCandidateView, ProjectRegisteredView, ProjectView } from '../../src/contracts/index.js';

/**
 * 7.6 — registering a project from the screen.
 *
 * The button existed, disabled, since §68, and the reason was structural rather than
 * lazy: every endpoint names a project by an *id the server issued* (§93), and a
 * directory with no `.agent-flow/` had no id, so no request shape could address it. What
 * closes it is not a path field — it is the walk issuing ids for candidates too, under the
 * same roots, the same depth and the same containment rule.
 */

const WRITE_HEADERS = { 'x-agent-flow-client': 'test' } as const;

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/**
 * A workspace with one registered project and two repositories that are not.
 *
 * `/wk/plain` is a directory with neither, and it must never be offered: half a machine
 * has a directory, and a control plane that proposed every one of them would be a file
 * browser with a worse interface.
 */
async function serve() {
  const fs = new InMemoryFileSystem();
  fs.seed('/wk/known/.agent-flow/config.yaml', 'project:\n  name: known\n  type: node\n');
  fs.seed('/wk/known/.git/HEAD', 'ref: refs/heads/main\n');
  fs.seed('/wk/fresh/.git/HEAD', 'ref: refs/heads/main\n');
  fs.seed('/wk/fresh/package.json', JSON.stringify({ name: 'fresh', scripts: { test: 'vitest run' } }));
  fs.seed('/wk/other/.git/HEAD', 'ref: refs/heads/main\n');
  fs.seed('/wk/plain/notes.md', '# not a repository\n');

  // The walk's flavour, named rather than inherited. On Windows the host's `resolve('/wk')`
  // is a drive-rooted path, and every posix fixture would discover nothing — the seam
  // `discoverProjects` grew in §6.2 exists so a test can say which rules it asserts.
  const registry = discoveredRegistry({ fs, roots: ['/wk'], depth: 2, path: posix });
  await registry.rescan();

  running = await buildServer({
    fs,
    clock: new FixedClock(),
    processRunner: new FakeProcessRunner(),
    processHost: new FakeHost(),
    registry,
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    pollIntervalMs: 20,
  });

  return { fs, server: running };
}

const candidates = async (server: RunningServer): Promise<ProjectCandidateView[]> =>
  (await server.app.inject('/api/v1/projects/candidates')).json<ProjectCandidateView[]>();

describe('GET /api/v1/projects/candidates', () => {
  it('offers the repositories that have never been through init', async () => {
    const { server } = await serve();

    expect((await candidates(server)).map((entry) => entry.id).sort()).toEqual(['fresh', 'other']);
  });

  it('offers no directory that is not a repository', async () => {
    // The positive control for the rule: `/wk/plain` exists, is inside the workspace, and
    // is still not offered — because it has no `.git`.
    const { server } = await serve();

    expect((await candidates(server)).map((entry) => entry.id)).not.toContain('plain');
  });

  it('does not offer a project that is already registered', async () => {
    const { server } = await serve();

    expect((await candidates(server)).map((entry) => entry.id)).not.toContain('known');
  });

  it('leaks no path, on a listing the browser reads', async () => {
    // §93 is about what a request can *name*, and a listing that handed the browser a
    // directory would give it the one thing the model exists to keep out of it.
    const { server } = await serve();

    const raw = (await server.app.inject('/api/v1/projects/candidates')).body;

    expect(raw).not.toContain('/wk/');
  });

  it('offers nothing when the registry was built from a list', async () => {
    // A registry that never walked anything has no directory it could honestly propose.
    running = await buildServer({
      fs: new InMemoryFileSystem(),
      clock: new FixedClock(),
      processRunner: new FakeProcessRunner(),
      processHost: new FakeHost(),
      registry: registryOf([{ id: 'demo', name: 'demo', path: '/repo' }]),
      globalConfigPath: '/home/.agent-flow/config.yaml',
      version: '0.1.0',
      host: '127.0.0.1',
      port: 4782,
      promptsDir: '/install/prompts',
      pollIntervalMs: 20,
    });

    expect(await candidates(running)).toEqual([]);
  });
});

describe('POST /api/v1/projects', () => {
  it('writes the project and reports it as registered', async () => {
    const { fs, server } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: WRITE_HEADERS,
      payload: { candidateId: 'fresh' },
    });
    const view = response.json<ProjectRegisteredView>();

    expect(response.statusCode).toBe(201);
    expect(view.project.id).toBe('fresh');
    expect(view.stack.type).toBe('node');
    expect(view.created).toEqual(expect.arrayContaining(['.agent-flow/config.yaml', 'AGENTS.md']));
    // The file is really there — this is `init`, not a registry entry.
    expect(await fs.exists('/wk/fresh/.agent-flow/config.yaml')).toBe(true);
  });

  it('names created files relative to the project, never absolutely (§21.3)', async () => {
    const { server } = await serve();

    const view = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: WRITE_HEADERS,
        payload: { candidateId: 'fresh' },
      })
    ).json<ProjectRegisteredView>();

    expect(view.created.join('\n')).not.toContain('/wk/');
  });

  it('makes the new project visible to every other route', async () => {
    // The reason the registry had to learn to rescan. Without it the write succeeds, the
    // file is on disk, and the workspace list is still missing it — a screen that told the
    // truth when it rendered and lies by the time anybody reads it.
    const { server } = await serve();

    const before = (await server.app.inject('/api/v1/projects')).json<ProjectView[]>();
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: WRITE_HEADERS,
      payload: { candidateId: 'fresh' },
    });
    const after = (await server.app.inject('/api/v1/projects')).json<ProjectView[]>();

    expect(before.map((project) => project.id)).toEqual(['known']);
    expect(after.map((project) => project.id).sort()).toEqual(['fresh', 'known']);
    // And it stops being a candidate, because it is one no longer.
    expect((await candidates(server)).map((entry) => entry.id)).toEqual(['other']);
  });

  it('carries the warning that would otherwise refuse every task', async () => {
    // PRI-25. A Node project with no committed lockfile is handed `npm install`, which
    // rewrites it, which fails the post-setup cleanliness assertion, which refuses every
    // task in worktree mode. A live run discovered that after paying for planning — and
    // the sentence used to exist only in the terminal.
    const { server } = await serve();

    const view = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: WRITE_HEADERS,
        payload: { candidateId: 'fresh' },
      })
    ).json<ProjectRegisteredView>();

    expect(view.warnings).toContainEqual({ kind: 'install_dirties_tree', command: 'npm install' });
  });

  it('does not warn about a lockfile the repository already tracks', async () => {
    // The positive control: same route, same project, one file different.
    const { fs, server } = await serve();
    fs.seed('/wk/fresh/package-lock.json', '{"lockfileVersion":3}');

    const view = (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: WRITE_HEADERS,
        payload: { candidateId: 'fresh' },
      })
    ).json<ProjectRegisteredView>();

    expect(view.warnings.map((warning) => warning.kind)).not.toContain('install_dirties_tree');
  });

  it('refuses an id it did not issue', async () => {
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: WRITE_HEADERS,
      payload: { candidateId: 'somewhere-else' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses an already-registered project rather than re-initialising it', async () => {
    // `known` is a project id, not a candidate id. The two namespaces are kept apart on
    // purpose: re-running `init` over a live project is a `--force` decision, not a typo.
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: WRITE_HEADERS,
      payload: { candidateId: 'known' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a body with no candidate id', async () => {
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: WRITE_HEADERS,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('holds the AR-01 gate, and writes nothing while it holds', async () => {
    // `init` writes files that have to be committed, and that commit moves HEAD. A run's
    // planningBase is frozen at creation, so committing now would leave it planning
    // against one base and executing against another — the evidence run paid for that.
    const { fs, server } = await serve();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/wk/other' });
    await store.createRun('a feature already in flight');

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: WRITE_HEADERS,
      payload: { candidateId: 'other' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string; forcible: boolean }>()).toMatchObject({
      error: 'active_run',
      forcible: true,
    });
    // "It writes nothing" is half the contract.
    expect(await fs.exists('/wk/other/.agent-flow/config.yaml')).toBe(false);
  });

  it('proceeds under force, and records the override on the run', async () => {
    const { fs, server } = await serve();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/wk/other' });
    const run = await store.createRun('a feature already in flight');

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: WRITE_HEADERS,
      payload: { candidateId: 'other', force: true },
    });
    const view = response.json<ProjectRegisteredView>();

    expect(response.statusCode).toBe(201);
    expect(view.warnings).toContainEqual({
      kind: 'active_run',
      runId: run.runId,
      status: 'running',
    });

    const events = await store.readEvents(run.runId);
    expect(events.map((event) => event.type)).toContain('init_during_active_run');
  });

  it('refuses a write that arrives without the client header (PRI-05)', async () => {
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { candidateId: 'fresh' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
