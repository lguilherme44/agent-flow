import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import type {
  ArtifactView,
  HealthResponse,
  ProjectView,
  RunDetailView,
  RunSummaryView,
  RunnerHealthView,
  RunnerView,
  StageViewResponse,
  TaskDetailView,
  TaskSummaryView,
} from '../../src/contracts/index.js';

/**
 * UI-02 … UI-05 — the read-only local API.
 *
 * Exercised through `app.inject`, so no port is bound and no socket is opened.
 * Every fixture lives in memory, which is what lets these run in CI beside the
 * rest of the suite rather than as a separate manual step.
 */

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };
const OTHER = { id: 'other', name: 'other', path: '/other' };

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const PLAN = {
  feature: 'weekly-recurrence',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types for recurrence.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile.'],
      validation: ['test'],
    },
    {
      id: 'FIX-001',
      title: 'Redact the token',
      description: 'The token is logged in full.',
      complexity: 'normal',
      risk: 'high',
      dependencies: [],
      requirements: [],
      correctiveFor: {
        stage: 'final-review',
        findingType: 'security',
        severity: 'critical',
        description: 'The token is logged in full.',
      },
      acceptanceCriteria: ['Redact it.'],
      validation: ['test'],
    },
  ],
};

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(
  options: { projects?: { id: string; name: string; path: string }[] } = {},
) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' });

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  fs.seed('/other/.agent-flow/config.yaml', PROJECT_CONFIG);

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('weekly recurrence');

  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n\nFR-001 — recurrence.\n');
  await store.appendEvent(run.runId, 'stage_completed', {
    stage: 'discovery',
    role: 'architect',
    runner: 'claude',
    model: 'a-model',
    reasoning: 'high',
    reasoningClamped: false,
    attempts: 1,
    startedAt: '2026-08-09T20:00:00.000Z',
    finishedAt: '2026-08-09T20:00:05.000Z',
  });
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'waiting_for_approval',
    tasks: [
      { id: 'TASK-001', state: 'completed', attempts: 1 },
      { id: 'FIX-001', state: 'queued', attempts: 0 },
    ],
  }));

  running = await buildServer({
    fs,
    clock,
    processRunner,
    registry: registryOf(options.projects ?? [PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    pollIntervalMs: 20,
  });

  return { fs, clock, store, run, server: running };
}

describe('UI-02 — the server answers', () => {
  it('reports health', async () => {
    const { server } = await serve();

    const response = await server.app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json<HealthResponse>()).toMatchObject({
      status: 'ok',
      version: '0.1.0',
      projects: 1,
      host: '127.0.0.1',
    });
  });

  it('says where it is bound, so a non-loopback bind is never invisible', async () => {
    const { server } = await serve();
    const health = (await server.app.inject('/api/v1/health')).json<HealthResponse>();

    expect(health.host).toBe('127.0.0.1');
    expect(health.port).toBe(4782);
  });
});

describe('UI-03 — the project registry', () => {
  it('lists registered projects with their current run', async () => {
    const { server, run } = await serve();

    const projects = (await server.app.inject('/api/v1/projects')).json<ProjectView[]>();

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: 'demo',
      path: '/repo',
      stack: 'node',
      currentRunId: run.runId,
      status: 'waiting_for_approval',
    });
  });

  it('names the last finished run separately from the current one (UI-22)', async () => {
    // §81 asks for both, and they are genuinely different facts: a project can
    // have something in flight and something finished at the same moment. The
    // pointer in `current-run` answers only the first.
    const { server, store, run } = await serve();

    const earlier = await store.createRun('an earlier feature');
    await store.updateRun(earlier.runId, (state) => ({ ...state, status: 'completed' }));
    // `createRun` moves the pointer, so the run in flight has to reclaim it.
    await store.setCurrentRun(run.runId);

    const projects = (await server.app.inject('/api/v1/projects')).json<ProjectView[]>();

    expect(projects[0]).toMatchObject({
      currentRunId: run.runId,
      status: 'waiting_for_approval',
      runCount: 2,
      lastRun: { runId: earlier.runId, status: 'completed', feature: 'an earlier feature' },
    });
  });

  it('omits the last run when nothing has finished, rather than inventing one', async () => {
    const { server } = await serve();

    const projects = (await server.app.inject('/api/v1/projects')).json<ProjectView[]>();

    // The only run is waiting for approval. Reporting it as "last" would say a
    // run finished when none has.
    expect(projects[0]?.lastRun).toBeUndefined();
    expect(projects[0]?.runCount).toBe(1);
  });

  it('lists a project that has never run', async () => {
    // What every project looks like the minute after `agent-flow init`, and the
    // row a list has to render without looking broken.
    const { server } = await serve({ projects: [PROJECT, OTHER] });

    const projects = (await server.app.inject('/api/v1/projects')).json<ProjectView[]>();
    const fresh = projects.find((project) => project.id === 'other');

    expect(fresh).toMatchObject({ currentRunId: null, status: null, runCount: 0 });
    expect(fresh?.lastRun).toBeUndefined();
  });

  it('refuses a project id nobody registered', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/runs?projectId=nowhere');

    expect(response.statusCode).toBe(404);
  });

  it('refuses anything shaped like a path', async () => {
    // The security model: ids, never paths. A traversal attempt does not reach
    // a handler that could resolve it — it fails validation at the edge.
    const { server } = await serve();

    for (const attempt of ['../../etc', '/etc/passwd', '..%2f..%2fetc']) {
      const response = await server.app.inject(
        `/api/v1/runs?projectId=${encodeURIComponent(attempt)}`,
      );
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('UI-04 — the run read API', () => {
  it('lists runs newest first', async () => {
    const { server, run } = await serve();

    const runs = (await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      projectId: 'demo',
      runId: run.runId,
      feature: 'weekly recurrence',
      status: 'waiting_for_approval',
      taskCount: 2,
      completedTasks: 1,
    });
  });

  it('spans every project when none is named', async () => {
    const { server } = await serve({ projects: [PROJECT, OTHER] });

    const runs = (await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>();

    // Only /repo has runs; /other is registered and simply has none.
    expect(runs.map((entry) => entry.projectId)).toEqual(['demo']);
  });

  it('gives the list the same progress the detail reports (UI-21)', async () => {
    // The runs list and the run detail must not round this differently. They read
    // the same number from the same place, which is the only way to be sure.
    const { server, run } = await serve();

    const summary = (await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>()[0];
    const detail = (
      await server.app.inject(`/api/v1/runs/${run.runId}`)
    ).json<RunDetailView>();

    expect(summary?.progress).toBe(detail.progress);
    expect(summary?.durationMs).toBe(detail.durationMs);
    // One of two tasks completed, so this is a real number rather than 0 or 100.
    expect(summary?.progress).toBe(50);
  });

  it('returns a run with its progress', async () => {
    const { server, run } = await serve();

    const detail = (
      await server.app.inject(`/api/v1/runs/${run.runId}`)
    ).json<RunDetailView>();

    expect(detail.progress).toBe(50);
    expect(detail.approved).toBe(false);
  });

  it('renders the pipeline including the approval gate', async () => {
    const { server, run } = await serve();

    const stages = (
      await server.app.inject(`/api/v1/runs/${run.runId}/stages`)
    ).json<StageViewResponse[]>();

    expect(stages).toHaveLength(9);
    expect(stages.find((stage) => stage.stage === 'discovery')).toMatchObject({
      status: 'completed',
      runner: 'claude',
      durationMs: 5_000,
    });
    expect(stages.find((stage) => stage.stage === 'approval')?.status).toBe(
      'waiting_approval',
    );
  });

  it('lists tasks with the state the run actually holds', async () => {
    const { server, run } = await serve();

    const tasks = (
      await server.app.inject(`/api/v1/runs/${run.runId}/tasks`)
    ).json<TaskSummaryView[]>();

    expect(tasks.map((task) => task.id)).toEqual(['TASK-001', 'FIX-001']);
    expect(tasks[0]?.state).toBe('completed');
  });

  it('shows a corrective task as corrective rather than as covering a requirement', async () => {
    const { server, run } = await serve();

    const tasks = (
      await server.app.inject(`/api/v1/runs/${run.runId}/tasks`)
    ).json<TaskSummaryView[]>();
    const fix = tasks.find((task) => task.id === 'FIX-001');

    expect(fix?.requirements).toEqual([]);
    expect(fix?.correctiveFor).toEqual({ stage: 'final-review', findingType: 'security' });
  });

  it('returns one task in full', async () => {
    const { server, run } = await serve();

    const task = (
      await server.app.inject(`/api/v1/runs/${run.runId}/tasks/TASK-001`)
    ).json<TaskDetailView>();

    expect(task.description).toContain('Domain types');
    expect(task.acceptanceCriteria).toEqual(['Types compile.']);
    expect(task.log).toEqual([]);
  });

  it('404s on a task that does not exist', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject(`/api/v1/runs/${run.runId}/tasks/TASK-404`);

    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed run id before touching the filesystem', async () => {
    const { server } = await serve();

    expect((await server.app.inject('/api/v1/runs/not-a-run')).statusCode).toBe(400);
    expect((await server.app.inject('/api/v1/runs/..%2f..%2fetc')).statusCode).toBe(400);
  });

  it('lists artifacts, marking what exists', async () => {
    const { server, run } = await serve();

    const artifacts = (
      await server.app.inject(`/api/v1/runs/${run.runId}/artifacts`)
    ).json<ArtifactView[]>();

    const byName = Object.fromEntries(artifacts.map((entry) => [entry.name, entry]));
    expect(byName['sdd']?.available).toBe(true);
    expect(byName['plan']?.available).toBe(true);
    expect(byName['finalReview']?.available).toBe(false);
  });

  it('serves one artifact’s content', async () => {
    const { server, run } = await serve();

    const artifact = (
      await server.app.inject(`/api/v1/runs/${run.runId}/artifacts/sdd`)
    ).json<{ content: string; truncated: boolean }>();

    expect(artifact.content).toContain('FR-001');
    expect(artifact.truncated).toBe(false);
  });

  it('refuses an artifact name that is not one', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject(
      `/api/v1/runs/${run.runId}/artifacts/..%2f..%2fconfig.yaml`,
    );

    expect(response.statusCode).toBe(400);
  });

  it('exposes runner identity without any credential', async () => {
    const { server } = await serve();

    const runners = (await server.app.inject('/api/v1/runners')).json<RunnerView[]>();
    const body = JSON.stringify(runners);

    expect(runners.length).toBeGreaterThan(0);
    expect(runners[0]).toHaveProperty('provider');
    expect(body).not.toMatch(/auth|token|key|secret/i);
  });

  it('reports runner health without probing', async () => {
    // A dashboard polls. A live probe spends quota, so this is the cheap check
    // only — `doctor --deep` stays an explicit act.
    const { server } = await serve();

    const health = (
      await server.app.inject('/api/v1/runners/health')
    ).json<RunnerHealthView[]>();

    expect(health.length).toBeGreaterThan(0);
    expect(health[0]).toHaveProperty('installed');
  });

  it('serves telemetry derived from the run', async () => {
    const { server, run } = await serve();

    const telemetry = (
      await server.app.inject(`/api/v1/runs/${run.runId}/telemetry`)
    ).json<{ entries: unknown[]; summary: { entries: number } }>();

    expect(telemetry.summary.entries).toBe(1);
  });
});

describe('UI-05 — SSE', () => {
  it('opens a stream and keeps it open', async () => {
    const { server } = await serve();

    // `inject` resolves when the handler returns; for a stream that is as soon
    // as the headers are written, which is exactly what this asserts.
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/events',
      payloadAsStream: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    response.stream().destroy();
  });

  it('rejects a filter that is not a project id', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/events?projectId=..%2f..');

    expect(response.statusCode).toBe(400);
  });

  it('publishes what the run records, without a second event store', async () => {
    const { server, store, run } = await serve();

    const received: { type: string; runId: string }[] = [];
    server.bus.subscribe((event) => received.push({ type: event.type, runId: event.runId }));

    await store.appendEvent(run.runId, 'task_started', { task: 'FIX-001', role: 'executor.normal' });
    await store.appendEvent(run.runId, 'task_finished', {
      task: 'FIX-001',
      status: 'completed',
      runner: 'codex',
    });

    await server.watcher.sweep({ publish: true });

    expect(received.map((event) => event.type)).toEqual([
      'task.started',
      'task.completed',
    ]);
    expect(received[0]?.runId).toBe(run.runId);
  });

  it('does not replay history to whoever connects first', async () => {
    // The run above already has events on disk. Priming reads them without
    // publishing, so a dashboard opened against a finished run is not flooded
    // with its whole past — it fetches state over HTTP and subscribes to what
    // happens next.
    const { server } = await serve();

    const received: string[] = [];
    server.bus.subscribe((event) => received.push(event.type));

    await server.watcher.sweep({ publish: true });

    expect(received).toEqual([]);
  });
});
