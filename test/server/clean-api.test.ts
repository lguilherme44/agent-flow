import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { StateStore } from '../../src/app/state-store.js';
import type { CleanView } from '../../src/contracts/index.js';

/**
 * 7.7 — `clean`, over HTTP.
 *
 * Reclaiming a worktree or a ref is the operation that frightens people most, and the only
 * way to ask what it would do was `--dry-run` in a terminal. What makes the screen safe is
 * not the confirmation dialog — it is that the preview and the act are the *same function*
 * down the same path, so what the page shows is what the next call does.
 *
 * These runs are all sequential and have no `gitRunKey`, so `reclaimNamespace` short-
 * circuits and asks Git nothing (§25). The Git half has its own integration suite; what is
 * asserted here is the half that used to live in the CLI: which runs are candidates, what
 * the active run is protected from, and that a dry run writes nothing.
 */

const WRITE_HEADERS = { 'x-agent-flow-client': 'test' } as const;
const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(runs: number) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  fs.seed('/repo/.agent-flow/config.yaml', 'project:\n  name: demo\n  type: node\n');

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const created: string[] = [];
  for (let index = 0; index < runs; index += 1) {
    created.push((await store.createRun(`feature ${String(index)}`)).runId);
  }

  running = await buildServer({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '' }),
    processHost: new FakeHost(),
    registry: registryOf([PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    pollIntervalMs: 20,
  });

  return { fs, store, created, server: running };
}

const clean = async (server: RunningServer, body: Record<string, unknown>) =>
  server.app.inject({ method: 'POST', url: '/api/v1/clean', headers: WRITE_HEADERS, payload: body });

describe('POST /api/v1/clean', () => {
  it('names the runs a cleanup would remove, and removes nothing', async () => {
    const { fs, created, server } = await serve(4);

    const view = (await clean(server, { keep: 2, dryRun: true })).json<CleanView>();

    expect(view.dryRun).toBe(true);
    expect(view.totalRuns).toBe(4);
    // Newest first, so the two oldest are the candidates.
    expect(view.runs.map((run) => run.runId).sort()).toEqual([created[0], created[1]].sort());
    expect(view.runs.every((run) => run.outcome === 'removed')).toBe(true);

    // The whole point of a preview: nothing moved.
    for (const runId of created) {
      expect(await fs.exists(`/repo/.agent-flow/runs/${runId}/state.json`), runId).toBe(true);
    }
  });

  it('removes exactly what the preview named, when asked for real', async () => {
    // The positive control for the sentence above: same options, `dryRun` off, and the
    // runs the preview listed are the runs that are gone.
    const { fs, created, server } = await serve(4);

    const preview = (await clean(server, { keep: 2, dryRun: true })).json<CleanView>();
    const applied = (await clean(server, { keep: 2 })).json<CleanView>();

    expect(applied.dryRun).toBe(false);
    expect(applied.runs.map((run) => run.runId).sort()).toEqual(
      preview.runs.map((run) => run.runId).sort(),
    );
    for (const run of preview.runs) {
      expect(await fs.exists(`/repo/.agent-flow/runs/${run.runId}/state.json`), run.runId).toBe(false);
    }
    // And the ones inside the window are untouched.
    expect(await fs.exists(`/repo/.agent-flow/runs/${String(created[3])}/state.json`)).toBe(true);
  });

  it('protects the active run, and says which one it is', async () => {
    // A cleanup that quietly leaves out the run you are working on and one that cannot see
    // it look identical from the outside.
    const { store, created, server } = await serve(3);
    const oldest = created[0] as string;
    await store.setCurrentRun(oldest);

    const view = (await clean(server, { keep: 0, dryRun: true })).json<CleanView>();

    expect(view.protectedRun).toBe(oldest);
    expect(view.runs.map((run) => run.runId)).not.toContain(oldest);
  });

  it('includes the active run when force says so', async () => {
    const { store, created, server } = await serve(3);
    const oldest = created[0] as string;
    await store.setCurrentRun(oldest);

    const view = (await clean(server, { keep: 0, force: true, dryRun: true })).json<CleanView>();

    expect(view.protectedRun).toBeUndefined();
    expect(view.runs.map((run) => run.runId)).toContain(oldest);
  });

  it('keeps the default window when nobody chose one', async () => {
    // Five, and the number lives in the use case rather than in each caller's argument
    // parsing — a default spelled twice is a page previewing a cleanup the terminal
    // would not perform.
    const { server } = await serve(7);

    const view = (await clean(server, { dryRun: true })).json<CleanView>();

    expect(view.keep).toBe(5);
    expect(view.runs).toHaveLength(2);
  });

  it('says there is nothing to remove rather than saying nothing', async () => {
    const { server } = await serve(2);

    const view = (await clean(server, { dryRun: true })).json<CleanView>();

    expect(view.runs).toEqual([]);
    expect(view.totalRuns).toBe(2);
    expect(view.refused).toBe(false);
  });

  it('drops the cached repository map only when asked', async () => {
    const { fs, server } = await serve(1);
    fs.seed('/repo/.agent-flow/cache/architecture.md', '# map');

    const untouched = (await clean(server, { dryRun: true })).json<CleanView>();
    expect(untouched.cacheRemoved).toBe(false);

    const previewed = (await clean(server, { cache: true, dryRun: true })).json<CleanView>();
    expect(previewed.cacheRemoved).toBe(true);
    expect(await fs.exists('/repo/.agent-flow/cache/architecture.md')).toBe(true);

    const applied = (await clean(server, { cache: true })).json<CleanView>();
    expect(applied.cacheRemoved).toBe(true);
    expect(await fs.exists('/repo/.agent-flow/cache/architecture.md')).toBe(false);
  });

  it('refuses a project it does not know', async () => {
    const { server } = await serve(1);

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/clean?projectId=nowhere',
      headers: WRITE_HEADERS,
      payload: { dryRun: true },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a write that arrives without the client header (PRI-05)', async () => {
    const { server } = await serve(1);

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/clean',
      payload: { dryRun: true },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
