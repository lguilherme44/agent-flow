import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { MAX_EVENT_LOG_LINES } from '../../src/server/run-reader.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import { ContextTelemetryRecorder } from '../../src/app/context-telemetry-recorder.js';
import { PlanSchema, type TaskState } from '../../src/contracts/index.js';
import { planHash } from '../../src/app/approval.js';
import { attemptLogName, runPaths } from '../../src/app/paths.js';
import type {
  ActionErrorView,
  ActionJobView,
  AnalyticsView,
  ApprovalGateView,
  ConfigView,
  ArtifactView,
  HealthResponse,
  ProjectView,
  PromptContentView,
  PromptView,
  RoleRouteView,
  RunDagView,
  RunDetailView,
  RunEventLogView,
  RunSummaryView,
  RunnerHealthView,
  RunnerTypeView,
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

/**
 * What a same-origin client sends on a write (PRI-05).
 *
 * `inject` is not a browser: it sends no `Origin`, which is exactly the shape the guard
 * treats as "not a page" and admits only on the strength of this header. Every test
 * below is about a *use case*, so it authenticates the way the CLI does and leaves the
 * boundary itself to `request-guard.test.ts`.
 */
const WRITE_HEADERS = { 'x-agent-flow-client': 'test' } as const;

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
  const host = new FakeHost();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  fs.seed('/other/.agent-flow/config.yaml', PROJECT_CONFIG);

  // The shipped prompts, as the installation would hold them. Front matter only
  // where it matters to a test: `implementation` writes, everything else reads.
  for (const name of [
    'discovery',
    'architecture-impact',
    'sdd',
    'planning',
    'plan-review',
    'verification',
    'final-review',
  ]) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\noutputFormat: json\nrequiredVars: [task, sdd]\n---\n\n# implementation\n',
  );

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
      { id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 },
      { id: 'FIX-001', state: 'queued', attempts: 0, infrastructureFailures: 0 },
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
    promptsDir: '/install/prompts',
    processHost: host,
    pollIntervalMs: 20,
  });

  return { fs, clock, host, store, run, server: running };
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

    // Ten since M6: `code-review` executes per task and shows as a phase.
    expect(stages).toHaveLength(10);
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

  it('hands over the audit log as written, oldest first, stamped with its project', async () => {
    const { server, run } = await serve();

    const response = await server.app.inject(`/api/v1/runs/${run.runId}/events`);
    expect(response.statusCode).toBe(200);

    const log = response.json<RunEventLogView>();
    expect(log.runId).toBe(run.runId);
    expect(log.projectId).toBe('demo');
    expect(log.truncated).toBe(false);
    expect(log.total).toBe(log.events.length);
    // `createRun` writes the first line; `serve()` appends the discovery completion.
    expect(log.events.map((event) => event.type)).toEqual(['run_created', 'stage_completed']);
    // The detail crosses intact — it is the same object the SSE bridge already spreads.
    expect(log.events[1]?.detail).toMatchObject({ stage: 'discovery', runner: 'claude' });
  });

  it('answers 404 for the audit log of a run that does not exist', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/runs/AF-2026-999/events');

    expect(response.statusCode).toBe(404);
  });

  it('keeps the newest audit lines when the log outgrows the cap, and says so', async () => {
    const { server, run, store } = await serve();

    // Two already exist; the cap is generous, so the test pushes past it deliberately
    // rather than lowering it — the constant is the product's, not the test's.
    for (let index = 0; index < MAX_EVENT_LOG_LINES; index += 1) {
      await store.appendEvent(run.runId, 'stage_context_measured', { index });
    }

    const log = (
      await server.app.inject(`/api/v1/runs/${run.runId}/events`)
    ).json<RunEventLogView>();

    expect(log.truncated).toBe(true);
    expect(log.total).toBe(MAX_EVENT_LOG_LINES + 2);
    expect(log.events).toHaveLength(MAX_EVENT_LOG_LINES);
    // The origin was cut, not the present.
    expect(log.events[0]?.type).not.toBe('run_created');
    expect(log.events.at(-1)?.detail).toMatchObject({ index: MAX_EVENT_LOG_LINES - 1 });
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

  /**
   * C-07 (AR-02) — the log the dashboard could never find.
   *
   * `paths.ts` writes `implementation-<TASK>-attempt-<n>.log` in worktree mode; the reader
   * asked for `implementation-<TASK>.log`. So every isolated run returned `[]` for every
   * task, and an operator who wanted to see what an attempt did opened a terminal — which
   * is the behaviour AR-02 exists to remove.
   */
  describe('attempt logs (C-07)', () => {
    it('finds the log an isolated attempt actually wrote', async () => {
      const { server, run, fs } = await serve();
      fs.seed(
        runPaths('/repo', run.runId).log(attemptLogName('TASK-001', 1)),
        'repair=1 failed errorCode=execution_failed\nsoft-denying tool confirmation "Bash"\n',
      );

      const task = (
        await server.app.inject(`/api/v1/runs/${run.runId}/tasks/TASK-001`)
      ).json<TaskDetailView>();

      expect(task.log.join('\n')).toContain('soft-denying');
    });

    it('exposes each attempt separately, newest last', async () => {
      const { server, run, fs } = await serve();
      const paths = runPaths('/repo', run.runId);
      fs.seed(paths.log(attemptLogName('TASK-001', 1)), 'first attempt\n');
      fs.seed(paths.log(attemptLogName('TASK-001', 2)), 'second attempt\n');
      fs.seed(paths.log(attemptLogName('TASK-001', 3)), 'third attempt\n');

      const task = (
        await server.app.inject(`/api/v1/runs/${run.runId}/tasks/TASK-001`)
      ).json<TaskDetailView>();

      expect(task.attemptLogs?.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
      expect(task.attemptLogs?.[2]?.lines.join('\n')).toContain('third attempt');
    });

    it('shows the newest attempt in the flat log, so one field still answers "what happened"', async () => {
      const { server, run, fs } = await serve();
      const paths = runPaths('/repo', run.runId);
      fs.seed(paths.log(attemptLogName('TASK-001', 1)), 'first attempt\n');
      fs.seed(paths.log(attemptLogName('TASK-001', 2)), 'second attempt\n');

      const task = (
        await server.app.inject(`/api/v1/runs/${run.runId}/tasks/TASK-001`)
      ).json<TaskDetailView>();

      expect(task.log.join('\n')).toContain('second attempt');
      expect(task.log.join('\n')).not.toContain('first attempt');
    });

    it('still reads the sequential name, which has no attempt suffix', async () => {
      // A sequential run writes `implementation-<TASK>.log` and always did. Fixing the
      // isolated path must not break the one that was working.
      const { server, run, fs } = await serve();
      fs.seed(runPaths('/repo', run.runId).log('implementation-TASK-001'), 'sequential run\n');

      const task = (
        await server.app.inject(`/api/v1/runs/${run.runId}/tasks/TASK-001`)
      ).json<TaskDetailView>();

      expect(task.log.join('\n')).toContain('sequential run');
    });
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

  it('publishes every runner type the installation supports, with what declaring one takes', async () => {
    const { server } = await serve();

    const types = (await server.app.inject('/api/v1/runner-types')).json<RunnerTypeView[]>();

    // Every adapter the registry can build, so an editor offering these offers all of
    // them — the failure this replaces was a list of runner names living in a browser.
    expect(types.map(({ type }) => type)).toEqual([
      'agy-cli', 'claude-code-cli', 'codex-cli', 'openai-compatible',
    ]);

    const endpoint = types.find(({ type }) => type === 'openai-compatible');
    expect(endpoint?.fields).toContainEqual({ name: 'baseUrl', required: true });
    expect(endpoint?.fields).toContainEqual({ name: 'apiKeyEnv', required: false, secretEnv: true });
    // It has no working directory and cannot write, which is why the resolver refuses it
    // for the executors. A screen that offers it needs to be able to say so.
    expect(endpoint?.capabilities.supportsWorkingDirectory).toBe(false);

    const cli = types.find(({ type }) => type === 'claude-code-cli');
    expect(cli?.capabilities.supportsWorkingDirectory).toBe(true);
    expect(cli?.capabilities.supportedReasoningLevels.length).toBeGreaterThan(0);

    // A field is a name and a requirement, never a value: `apiKeyEnv` is described, and
    // the variable it would name is not read here at all. The probe endpoint the
    // description is built with must not escape either.
    expect(JSON.stringify(types)).not.toContain('127.0.0.1');
    for (const field of types.flatMap(({ fields }) => fields)) {
      expect(Object.keys(field).filter((key) => !['name', 'required', 'secretEnv'].includes(key))).toEqual([]);
    }
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
    expect(telemetry).not.toHaveProperty('context');
  });

  it('adds separately labelled estimated context observations when they exist', async () => {
    const { server, store, run } = await serve();
    new ContextTelemetryRecorder(store).record(run.runId, {
      stage: 'primary_context',
      source: 'primary_runner',
      provenance: 'runtime_observation',
      estimatedInputTokens: 120,
      estimatedPrimaryContextTokens: 50,
      estimatedAvoidedTokens: 70,
    });
    await Promise.resolve();

    const response = await server.app.inject(`/api/v1/runs/${run.runId}/telemetry`);
    const telemetry = response.json<{
      summary: { entries: number };
      context?: {
        basis: string;
        aggregate: { estimatedInputTokens?: number; estimatedAvoidedTokens?: number };
      };
    }>();

    expect(response.statusCode).toBe(200);
    expect(telemetry.summary.entries).toBe(1);
    expect(telemetry.context).toMatchObject({
      basis: 'estimated_operational_not_billing',
      aggregate: { estimatedInputTokens: 120, estimatedAvoidedTokens: 70 },
    });
    expect(JSON.stringify(telemetry.context)).not.toMatch(/cost|price|billingTokens/i);
  });

  it('keeps current telemetry available when a hostile legacy event line is malformed', async () => {
    const { server, fs, run } = await serve();
    await fs.appendFile(
      `/repo/.agent-flow/runs/${run.runId}/events.jsonl`,
      '{malformed credential=do-not-reflect\n',
    );

    const response = await server.app.inject(`/api/v1/runs/${run.runId}/telemetry`);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ summary: { entries: number } }>().summary.entries).toBe(1);
    expect(response.body).not.toContain('do-not-reflect');
  });

  it('404s telemetry for an unknown run', async () => {
    const { server } = await serve();
    const response = await server.app.inject('/api/v1/runs/AF-2026-999/telemetry');
    expect(response.statusCode).toBe(404);
  });
});

describe('UI-28 — the dependency graph', () => {
  /** A plan with a chain, a fan-out and a fan-in, replacing the fixture's two tasks. */
  const GRAPH_PLAN = {
    feature: 'weekly-recurrence',
    tasks: ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'].map((id, index) => ({
      id,
      title: `task ${id}`,
      description: 'a task.',
      complexity: 'normal',
      risk: 'low',
      dependencies:
        index === 0 ? [] : index === 3 ? ['TASK-002', 'TASK-003'] : ['TASK-001'],
      requirements: ['FR-001'],
      acceptanceCriteria: ['it works.'],
      validation: ['test'],
    })),
  };

  async function withGraph(plan: unknown = GRAPH_PLAN) {
    const context = await serve();
    await context.store.writeArtifact(
      context.run.runId,
      'plan',
      JSON.stringify(plan, null, 2),
    );
    return context;
  }

  it('answers with the plan’s edges and a drawing rank', async () => {
    const { server, run } = await withGraph();

    const dag = (await server.app.inject(`/api/v1/runs/${run.runId}/dag`)).json<RunDagView>();

    expect(dag.runId).toBe(run.runId);
    expect(dag.edges).toContainEqual({ from: 'TASK-001', to: 'TASK-002' });
    expect(dag.edges).toContainEqual({ from: 'TASK-003', to: 'TASK-004' });
    // The fan-in sits behind its slowest branch, not its first.
    expect(dag.nodes.find((node) => node.taskId === 'TASK-004')?.depth).toBe(2);
    expect(dag.invalid).toBeUndefined();
  });

  it('carries no status, model or duration', async () => {
    // Structure only. Folding the runtime metadata in here would mean re-laying
    // out a graph every time a task ticked over — and would put a second answer
    // to "what state is this task in" on the wire.
    const { server, run } = await withGraph();

    const dag = (await server.app.inject(`/api/v1/runs/${run.runId}/dag`)).json<RunDagView>();

    expect(Object.keys(dag.nodes[0] ?? {}).sort()).toEqual(['depth', 'taskId']);
  });

  it('reports a dependency the plan does not contain instead of inventing a node', async () => {
    const { server, run } = await withGraph({
      feature: 'weekly-recurrence',
      tasks: [
        {
          ...GRAPH_PLAN.tasks[0],
          id: 'TASK-002',
          dependencies: ['TASK-000'],
        },
      ],
    });

    const dag = (await server.app.inject(`/api/v1/runs/${run.runId}/dag`)).json<RunDagView>();

    expect(dag.nodes.map((node) => node.taskId)).not.toContain('TASK-000');
    expect(dag.unresolved).toEqual([{ taskId: 'TASK-002', dependsOn: 'TASK-000' }]);
  });

  it('names a cycle rather than drawing a ranking that cannot exist', async () => {
    const { server, run } = await withGraph({
      feature: 'weekly-recurrence',
      tasks: [
        { ...GRAPH_PLAN.tasks[0], id: 'TASK-001', dependencies: ['TASK-002'] },
        { ...GRAPH_PLAN.tasks[0], id: 'TASK-002', dependencies: ['TASK-001'] },
      ],
    });

    const dag = (await server.app.inject(`/api/v1/runs/${run.runId}/dag`)).json<RunDagView>();

    expect(dag.invalid?.kind).toBe('cycle');
    // Both tasks are still there. A blank screen explains nothing, and the point
    // of the view is to show what the plan says — including that it is impossible.
    expect(dag.nodes.map((node) => node.taskId)).toEqual(
      expect.arrayContaining(['TASK-001', 'TASK-002']),
    );
  });

  it('agrees with the task list about every task’s state', async () => {
    // The rule this endpoint exists to keep: one derivation, two views. A table
    // saying QUEUED beside a graph saying READY is two answers about one task.
    const { server, run, store } = await withGraph();
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [
        { id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 },
        { id: 'TASK-002', state: 'failed', attempts: 1, infrastructureFailures: 0 },
        { id: 'TASK-003', state: 'queued', attempts: 0, infrastructureFailures: 0 },
        { id: 'TASK-004', state: 'queued', attempts: 0, infrastructureFailures: 0 },
      ],
    }));

    const tasks = (
      await server.app.inject(`/api/v1/runs/${run.runId}/tasks`)
    ).json<TaskSummaryView[]>();
    const dag = (await server.app.inject(`/api/v1/runs/${run.runId}/dag`)).json<RunDagView>();

    const stateOf = (id: string) => tasks.find((task) => task.id === id)?.state;

    // TASK-003's dependency finished, so the graph calls it ready; TASK-004 sits
    // behind a failure and will never start, which is not the same as "queued".
    expect(stateOf('TASK-003')).toBe('ready');
    expect(stateOf('TASK-004')).toBe('blocked');
    expect(dag.nodes.map((node) => node.taskId).sort()).toEqual(
      tasks.map((task) => task.id).sort(),
    );
  });

  it('refuses a run nobody has', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/runs/AF-2026-999/dag');

    expect(response.statusCode).toBe(404);
  });
});

describe('UI-29 — a workspace of several projects', () => {
  /** Two projects, each with a run of its own. */
  async function workspace() {
    const context = await serve({ projects: [PROJECT, OTHER] });
    const other = new StateStore({ fs: context.fs, clock: context.clock, projectDir: '/other' });
    const otherRun = await other.createRun('a feature in the other project');

    return { ...context, other, otherRun };
  }

  it('lists every project the operator pointed the server at', async () => {
    const { server, run, otherRun } = await workspace();

    const projects = (await server.app.inject('/api/v1/projects')).json<ProjectView[]>();

    expect(projects.map((project) => project.id)).toEqual(['demo', 'other']);
    expect(projects.map((project) => project.currentRunId)).toEqual([run.runId, otherRun.runId]);
  });

  it('spans the workspace with no project named, and narrows with one', async () => {
    const { server } = await workspace();

    const all = (await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>();
    const scoped = (
      await server.app.inject('/api/v1/runs?projectId=other')
    ).json<RunSummaryView[]>();

    expect(new Set(all.map((entry) => entry.projectId))).toEqual(new Set(['demo', 'other']));
    expect(scoped.every((entry) => entry.projectId === 'other')).toBe(true);
  });

  it('never answers for a project id it did not issue', async () => {
    // The whole filesystem security model (§93): the browser names a project,
    // the registry resolves it, and there is no request shape that addresses a
    // directory the operator did not register.
    const { server } = await workspace();

    for (const url of [
      '/api/v1/runs?projectId=nowhere',
      '/api/v1/config?projectId=nowhere',
      '/api/v1/agents?projectId=nowhere',
      '/api/v1/runners/health?projectId=nowhere',
    ]) {
      expect((await server.app.inject(url)).statusCode, url).toBe(404);
    }
  });

  it('keeps one project’s events out of another’s stream', async () => {
    // Run ids repeat across projects — two repositories will both have an
    // AF-2026-001 — so a stream that ignored the project would tell one
    // dashboard about the other's work.
    const { server, other, otherRun } = await workspace();

    const received: string[] = [];
    server.bus.subscribe((event) => received.push(event.projectId));

    await other.appendEvent(otherRun.runId, 'task_started', {
      task: 'TASK-001',
      role: 'executor.normal',
    });
    await server.watcher.sweep({ publish: true });

    expect(received).toContain('other');
    expect(received).not.toContain('demo');
  });
});

describe('UI-23 — the role routing table', () => {
  it('describes every logical role, with its configured and resolved route', async () => {
    const { server } = await serve();

    const routes = (await server.app.inject('/api/v1/agents')).json<RoleRouteView[]>();

    // All nine of §82. A page that showed eight would leave somebody wondering
    // which one is missing and why.
    expect(routes.map((route) => route.role)).toEqual([
      'architect',
      'sdd',
      'planner',
      'planReviewer',
      'executor.trivial',
      'executor.normal',
      'executor.complex',
      'verification',
      'finalReviewer',
    ]);

    const planner = routes.find((route) => route.role === 'planner');
    expect(planner?.configured.runner).toBeTruthy();
    expect(planner?.resolved?.runner).toBe(planner?.configured.runner);
    // The prompts a role runs, which is what its runner must be able to support.
    expect(planner?.prompts).toEqual(['planning']);
    expect(planner?.requiresReadOnly).toBe(true);
  });

  it('takes an executor’s requirements from its prompt, not from a table', async () => {
    const { server } = await serve();

    const routes = (await server.app.inject('/api/v1/agents')).json<RoleRouteView[]>();
    const executor = routes.find((route) => route.role === 'executor.normal');

    // `implementation` declares `permissions: write`, so an executor is the one
    // role that must *not* be held to read-only. Derived from the front matter the
    // stage runner reads, so the two cannot disagree about what a role may do.
    expect(executor?.prompts).toEqual(['implementation']);
    expect(executor?.requiresReadOnly).toBe(false);
  });

  it('reports a role pointing at an unregistered runner without failing the rest', async () => {
    const { fs, server } = await serve();

    // One broken role is exactly when somebody opens this page. It must not be
    // the request that fails.
    fs.seed(
      '/home/.agent-flow/config.yaml',
      'roles:\n  planner:\n    runner: nowhere\n    effort: high\n',
    );

    const routes = (await server.app.inject('/api/v1/agents')).json<RoleRouteView[]>();
    const planner = routes.find((route) => route.role === 'planner');

    expect(planner?.error?.kind).toBe('unknown_runner');
    expect(planner?.resolved).toBeUndefined();
    // And the other eight still resolve.
    expect(routes.filter((route) => route.error === undefined)).toHaveLength(8);
  });

  it('says why a role has no fallback, rather than leaving it blank', async () => {
    const { fs, server } = await serve();

    fs.seed('/home/.agent-flow/config.yaml', 'fallback:\n  enabled: false\n');

    const routes = (await server.app.inject('/api/v1/agents')).json<RoleRouteView[]>();

    // Switched off everywhere, a role simply having none, and one configured that
    // cannot serve the role are three different pieces of news. `resolveFallback`
    // returns undefined for all three; this endpoint does not.
    expect(routes.every((route) => route.fallbackAbsent === 'disabled')).toBe(true);
    expect(routes.every((route) => route.fallback === undefined)).toBe(true);
  });

  it('makes no live call to a runner', async () => {
    const { server, fs } = await serve();
    const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' });

    // Resolution is arithmetic over configuration and capabilities. A page that
    // probed nine roles would spend quota nobody asked it to — which is exactly
    // why `doctor --deep` is a separate, explicit act.
    const isolated = await buildServer({
      fs,
      clock: new FixedClock(),
      processRunner,
      registry: registryOf([PROJECT]),
      globalConfigPath: '/home/.agent-flow/config.yaml',
      version: '0.1.0',
      host: '127.0.0.1',
      port: 4783,
      promptsDir: '/install/prompts',
      processHost: new FakeHost(),
      pollIntervalMs: 20,
    });

    await isolated.app.inject('/api/v1/agents');
    expect(processRunner.calls).toHaveLength(0);

    await isolated.close();
    void server;
  });
});

describe('UI-24 — the prompt viewer', () => {
  it('lists the prompts this installation ships, with their front matter', async () => {
    const { server } = await serve();

    const prompts = (await server.app.inject('/api/v1/prompts')).json<PromptView[]>();

    expect(prompts.map((prompt) => prompt.name)).toContain('planning');
    const planning = prompts.find((prompt) => prompt.name === 'planning');

    expect(planning).toMatchObject({
      source: 'prompts/planning.md',
      permissions: 'read-only',
      outputFormat: 'markdown',
      requiredVars: ['repositoryMap'],
      roles: ['planner'],
      stages: ['planning'],
    });
    // No version, because prompts declare none. The digest is the identity, and
    // it is a real one: it changes when the file does.
    expect(planning?.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('names the three roles that share the implementation prompt', async () => {
    const { server } = await serve();

    const prompts = (await server.app.inject('/api/v1/prompts')).json<PromptView[]>();
    const implementation = prompts.find((prompt) => prompt.name === 'implementation');

    expect(implementation?.roles).toEqual([
      'executor.trivial',
      'executor.normal',
      'executor.complex',
    ]);
    // Empty on purpose: it runs once per task, not as a pipeline stage.
    expect(implementation?.stages).toEqual([]);
  });

  it('serves one prompt’s content', async () => {
    const { server } = await serve();

    const prompt = (
      await server.app.inject('/api/v1/prompts/sdd')
    ).json<PromptContentView>();

    expect(prompt.content).toContain('# sdd');
    expect(prompt.truncated).toBe(false);
  });

  it('shows a prompt whose front matter will not parse, beside the reason', async () => {
    const { fs, server } = await serve();

    fs.seed('/install/prompts/planning.md', 'no front matter at all\n');

    const prompts = (await server.app.inject('/api/v1/prompts')).json<PromptView[]>();
    const planning = prompts.find((prompt) => prompt.name === 'planning');

    // Hiding it would make the one prompt that needs attention the one that
    // disappears.
    expect(planning?.error).toContain('front matter');
    expect(planning?.permissions).toBe('unknown');
  });

  it('refuses anything shaped like a path', async () => {
    const { server } = await serve();

    for (const attempt of ['../../etc/passwd', '/etc/passwd', '..%2f..%2fsecret', 'Config']) {
      const response = await server.app.inject(
        `/api/v1/prompts/${encodeURIComponent(attempt)}`,
      );
      expect(response.statusCode).toBe(400);
    }
  });

  it('404s a name that passes the pattern but is not one of ours', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/prompts/not-a-prompt');

    expect(response.statusCode).toBe(404);
  });
});

describe('UI-25 — analytics', () => {
  it('aggregates runs, tasks and telemetry over the history it read', async () => {
    const { server } = await serve();

    const analytics = (await server.app.inject('/api/v1/analytics')).json<AnalyticsView>();

    expect(analytics.scope).toMatchObject({
      projectIds: ['demo'],
      runsAvailable: 1,
      runsConsidered: 1,
      truncated: false,
    });
    expect(analytics.runsByProject).toEqual([
      { projectId: 'demo', total: 1, byStatus: { waiting_for_approval: 1 } },
    ]);
    expect(analytics.tasksByState).toEqual({ completed: 1, queued: 1 });

    // The one stage this run recorded, from the event log rather than from a
    // third file written for analytics' sake.
    expect(analytics.byStage.map((bucket) => bucket.key)).toEqual(['discovery']);
    expect(analytics.byRunner.map((bucket) => bucket.key)).toEqual(['claude']);
    expect(analytics.totals.entries).toBe(1);
  });

  it('agrees with the run’s own telemetry, because it is the same projection', async () => {
    const { server, run } = await serve();

    const single = (
      await server.app.inject(`/api/v1/runs/${run.runId}/telemetry`)
    ).json<{ summary: { durationMs: number; entries: number } }>();
    const analytics = (await server.app.inject('/api/v1/analytics')).json<AnalyticsView>();

    // One run in the history, so the aggregate and the run must be identical. If
    // they could differ, one of them would be a second source of truth.
    expect(analytics.totals.durationMs).toBe(single.summary.durationMs);
    expect(analytics.totals.entries).toBe(single.summary.entries);
  });

  it('aggregates context estimates separately from runner billing telemetry', async () => {
    const { server, store, run } = await serve();
    const recorder = new ContextTelemetryRecorder(store);
    recorder.record(run.runId, {
      stage: 'retrieval',
      source: 'repository_retrieval',
      provenance: 'mechanical_projection',
      candidatesBefore: 8,
      candidatesAfter: 3,
      filesAfter: 3,
      utilityCalls: 1,
      utilityFailures: 0,
      structuredOutputFailures: 0,
    });
    await Promise.resolve();

    const analytics = (await server.app.inject('/api/v1/analytics')).json<AnalyticsView>();

    expect(analytics.context).toMatchObject({
      basis: 'estimated_operational_not_billing',
      scope: { runsObserved: 1, observations: 1, eventLogsTruncated: 0 },
      aggregate: { candidatesBefore: 8, candidatesAfter: 3, utilityCalls: 1 },
    });
    expect(analytics.totals.entries).toBe(1);
  });

  it('exposes a truncated context scope without inventing zero observations', async () => {
    const { server, fs, run } = await serve();
    const legacy = `${JSON.stringify({
      at: '2026-08-09T20:00:00.000Z',
      type: 'legacy_event',
      detail: {},
    })}\n`;
    await fs.appendFile(
      `/repo/.agent-flow/runs/${run.runId}/events.jsonl`,
      legacy.repeat(300),
    );

    const single = (
      await server.app.inject(`/api/v1/runs/${run.runId}/telemetry`)
    ).json<{ context?: { scope: { observations: number; truncated: boolean }; aggregate?: unknown } }>();
    const analytics = (await server.app.inject('/api/v1/analytics')).json<AnalyticsView>();

    expect(single.context?.scope).toMatchObject({ observations: 0, truncated: true });
    expect(single.context).not.toHaveProperty('aggregate');
    expect(analytics.context?.scope).toMatchObject({
      runsObserved: 0,
      observations: 0,
      eventLogsTruncated: 1,
      truncated: true,
    });
    expect(analytics.context).not.toHaveProperty('aggregate');
  });

  it('reports the bound rather than applying it quietly', async () => {
    const { server, store } = await serve();

    await store.createRun('a second feature');
    await store.createRun('a third feature');

    const analytics = (
      await server.app.inject('/api/v1/analytics?limit=1')
    ).json<AnalyticsView>();

    // A chart describing one of three runs while looking like it describes all
    // three is a chart that lies about its own scope.
    expect(analytics.scope).toMatchObject({
      runsAvailable: 3,
      runsConsidered: 1,
      truncated: true,
    });
  });

  it('spans every project when none is named', async () => {
    const { server } = await serve({ projects: [PROJECT, OTHER] });

    const analytics = (await server.app.inject('/api/v1/analytics')).json<AnalyticsView>();

    expect(analytics.scope.projectIds).toEqual(['demo', 'other']);
    expect(analytics.runsByProject.map((entry) => entry.projectId)).toEqual(['demo', 'other']);
  });

  it('reports no monetary figure at any level', async () => {
    const { server } = await serve();

    const raw = (await server.app.inject('/api/v1/analytics')).body;

    // Agent Flow observes durations and counts. A price is a guess about somebody
    // else's contract, and this is the endpoint most tempted to make one.
    expect(raw).not.toMatch(/cost|price|usd|dollar|billing/i);
  });

  it('refuses a limit that is not one', async () => {
    const { server } = await serve();

    for (const attempt of ['0', '-3', 'lots', '99999']) {
      const response = await server.app.inject(`/api/v1/analytics?limit=${attempt}`);
      expect(response.statusCode).toBe(400);
    }
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

describe('UI-26 — the effective configuration', () => {
  it('reports every section, and where each value came from', async () => {
    const { fs, server } = await serve();

    fs.seed('/home/.agent-flow/config.yaml', 'parallelism:\n  maxTasks: 1\nretry:\n  maxAttempts: 3\n');

    const config = (await server.app.inject('/api/v1/config')).json<ConfigView>();

    expect(config.sections.map((section) => section.id)).toEqual([
      'general',
      'workspace',
      'runners',
      'models',
      'execution',
      'ui',
      'retention',
    ]);

    const execution = config.sections.find((section) => section.id === 'execution');
    const attempts = execution?.settings.find((entry) => entry.key === 'retry.maxAttempts');

    // The origin is the point: "3, from the global file" says which file to edit,
    // and "3" alone invites an edit to whichever one the reader opens first.
    expect(attempts).toMatchObject({ value: '3', origin: 'global' });
  });

  it('marks a value the project overrides as the project’s', async () => {
    const { fs, server } = await serve();

    fs.seed('/home/.agent-flow/config.yaml', 'retry:\n  maxAttempts: 3\n');
    fs.seed(
      '/repo/.agent-flow/config.yaml',
      `${PROJECT_CONFIG}retry:\n  maxAttempts: 5\n`,
    );

    const config = (await server.app.inject('/api/v1/config')).json<ConfigView>();
    const execution = config.sections.find((section) => section.id === 'execution');

    expect(execution?.settings.find((entry) => entry.key === 'retry.maxAttempts')).toMatchObject({
      value: '5',
      origin: 'project',
    });
  });

  it('falls back to default for a key no file mentions', async () => {
    const { server } = await serve();

    const config = (await server.app.inject('/api/v1/config')).json<ConfigView>();
    const execution = config.sections.find((section) => section.id === 'execution');

    expect(execution?.settings.find((entry) => entry.key === 'git.useWorktrees')?.origin).toBe(
      'default',
    );
  });

  it('says which sections the spec names and the config has no keys for', async () => {
    const { server } = await serve();

    const config = (await server.app.inject('/api/v1/config')).json<ConfigView>();

    // Models and Retention. Empty with a reason rather than empty with a
    // plausible-looking blank row — a settings page that showed a control for a
    // setting nothing reads is worse than one that says there is none.
    for (const id of ['models', 'retention']) {
      const section = config.sections.find((entry) => entry.id === id);
      expect(section?.settings).toEqual([]);
      expect(section?.note).toBeTruthy();
    }
  });

  it('reports the workspace depth, which decides what this server can serve (UI-29)', async () => {
    // UI used to be a third empty section saying the dashboard keeps its
    // preferences in the browser. `ui.workspaceDepth` decides how far
    // `agent-flow ui ~/wk` looks for projects — which is to say what exists at
    // all — and that belongs on a page about what is configured.
    const { server } = await serve();

    const config = (await server.app.inject('/api/v1/config')).json<ConfigView>();
    const ui = config.sections.find((entry) => entry.id === 'ui');

    expect(ui?.settings.map((setting) => setting.key)).toEqual(['ui.workspaceDepth']);
    expect(ui?.settings[0]).toMatchObject({ value: '2', origin: 'default' });
  });

  it('reports a broken config with the paths needed to fix it', async () => {
    const { fs, server } = await serve();

    fs.seed('/home/.agent-flow/config.yaml', 'runners: [this is not a mapping]\n');

    const config = (await server.app.inject('/api/v1/config')).json<ConfigView>();

    expect(config.configError).toBeTruthy();
    expect(config.sections).toEqual([]);
    // The sources come back anyway: they are what somebody needs in order to fix
    // it, so they arrive alongside the reason rather than instead of it.
    expect(config.sources.globalPath).toBe('/home/.agent-flow/config.yaml');
  });

  it('exposes no credential, environment variable or auth file', async () => {
    const { server } = await serve();

    const raw = (await server.app.inject('/api/v1/config')).body;

    expect(raw).not.toMatch(/auth\.json|credential|api[_-]?key|token|process\.env|secret/i);
  });

  it('has no write endpoint for configuration', async () => {
    // §86 lists PATCH /config. Writing a merged value back means deciding which of
    // three layers it belongs in, and a page that guessed would move a project's
    // override into the global file — changing every other project on the machine.
    const { server } = await serve();

    // Authenticated as the dashboard is, so this asserts what it says it asserts:
    // the route does not exist. An unauthenticated PATCH is refused a step earlier by
    // the request guard, which would make this pass for the wrong reason.
    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/v1/config',
      headers: WRITE_HEADERS,
    });

    expect(response.statusCode).toBe(404);
  });
});

/**
 * UI-27 — the write API.
 *
 * These are the tests that make "two adapters, one use case" checkable rather than
 * merely stated. Every one of them is about a refusal, a recomputation, or a shape
 * the browser is not allowed to send — because a write endpoint that happens to work
 * is not the same as one that cannot be talked into the wrong thing.
 */
describe('UI-27 — the write API', () => {
  /** A run whose plan has passed a review that names the right plan. */
  async function approvable(): Promise<Awaited<ReturnType<typeof serve>>> {
    const context = await serve();
    const hash = planHash(PlanSchema.parse(PLAN));

    await context.store.writeArtifact(
      context.run.runId,
      'planReview',
      JSON.stringify({
        verdict: 'PASS',
        findings: [],
        independence: 'cross-provider',
        reviewer: { runner: 'claude', model: 'a-model', reasoning: 'high' },
        planHash: hash,
      }),
    );

    return context;
  }

  describe('the approval gate', () => {
    it('describes the gate with the hash the server computed', async () => {
      const { server, run } = await approvable();

      const gate = (
        await server.app.inject(`/api/v1/runs/${run.runId}/approval`)
      ).json<ApprovalGateView>();

      expect(gate.canApprove).toBe(true);
      expect(gate.planHash).toMatch(/^[0-9a-f]{16}$/);
      expect(gate.taskCount).toBe(2);
      expect(gate.review).toMatchObject({ verdict: 'PASS', coversThisPlan: true });
      // No version fields: neither artifact declares one, so the SDD is identified
      // by a digest that says it is a digest.
      expect(gate.sddDigest).toMatch(/^[0-9a-f]{12}$/);
    });

    it('says a review of a different plan does not cover this one', async () => {
      const { server, store, run } = await approvable();

      await store.writeArtifact(
        run.runId,
        'planReview',
        JSON.stringify({
          verdict: 'PASS',
          findings: [],
          independence: 'cross-provider',
          reviewer: { runner: 'claude', model: 'a-model', reasoning: 'high' },
          planHash: 'deadbeefdeadbeef',
        }),
      );

      const gate = (
        await server.app.inject(`/api/v1/runs/${run.runId}/approval`)
      ).json<ApprovalGateView>();

      // A verdict about another document is not a verdict about this one (§17).
      expect(gate.canApprove).toBe(false);
      expect(gate.refusal).toMatchObject({ kind: 'review_stale', forcible: true });
      expect(gate.review?.coversThisPlan).toBe(false);
    });
  });

  describe('approve', () => {
    it('approves the plan on disk and binds the approval to its hash', async () => {
      const { server, store, run } = await approvable();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/approve`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const state = await store.loadRun(run.runId);
      expect(state.approved).toBe(true);
      expect(state.approvedPlanHash).toBe(planHash(PlanSchema.parse(PLAN)));
    });

    it('ignores a plan hash a client tries to supply', async () => {
      // The security property §90 turns on. A body carrying a hash must not be able
      // to get that hash credited with the approval — so the server recomputes and
      // the extra field is simply not part of the contract.
      const { server, store, run } = await approvable();

      await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/approve`,
        payload: { force: false, planHash: 'deadbeefdeadbeef' },
      });

      const state = await store.loadRun(run.runId);
      expect(state.approvedPlanHash).toBe(planHash(PlanSchema.parse(PLAN)));
      expect(state.approvedPlanHash).not.toBe('deadbeefdeadbeef');
    });

    it('refuses an unreviewed plan, and says the refusal is forcible', async () => {
      const { server, run } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/approve`,
        payload: {},
      });

      // 409: the request was well formed and the workflow said no.
      expect(response.statusCode).toBe(409);
      expect(response.json<ActionErrorView>()).toMatchObject({
        error: 'review_missing',
        forcible: true,
      });
      // What to do about it, which is what §95 asks a refusal to carry.
      expect(response.json<ActionErrorView>().action).toBeTruthy();
    });

    it('records a forced approval as a degradation rather than as a normal one', async () => {
      const { server, store, run } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/approve`,
        payload: { force: true },
      });

      expect(response.statusCode).toBe(200);
      const state = await store.loadRun(run.runId);
      // A gate opened over a missing review has to look different afterwards from
      // one that passed. `status --json` and the Definition of Done both read this.
      expect(state.degradations.map((entry) => entry.kind)).toContain('forced_approval');
    });

    it('leaks no stack trace when something inside fails', async () => {
      const { server, store, run } = await serve();

      // A plan that will not parse. The refusal names the plan; a Zod error with a
      // file path in it would be the wrong thing to hand a browser.
      await store.writeArtifact(run.runId, 'plan', '{ not json');

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/approve`,
        payload: {},
      });

      expect(response.body).not.toMatch(/at \w+ \(|node_modules|ZodError/);
      expect(response.json<ActionErrorView>().error).toBe('no_plan');
    });
  });

  describe('reject', () => {
    it('records the rejection and the reason', async () => {
      const { server, store, run } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/reject`,
        payload: { reason: 'the approach is wrong' },
      });

      expect(response.statusCode).toBe(200);
      expect((await store.loadRun(run.runId)).status).toBe('plan_rejected');
      const events = await store.readEvents(run.runId);
      expect(events.some((event) => event.type === 'run_rejected')).toBe(true);
    });

    it('refuses to reject the same run twice', async () => {
      const { server, run } = await serve();

      await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/reject`,
        payload: {},
      });
      const second = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/reject`,
        payload: {},
      });

      expect(second.statusCode).toBe(409);
      expect(second.json<ActionErrorView>().error).toBe('already_rejected');
    });

    it('refuses to reject a run that already completed', async () => {
      const { server, store, run } = await serve();

      await store.updateRun(run.runId, (state) => ({ ...state, status: 'completed' }));

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/reject`,
        payload: {},
      });

      // Nothing guarded the run's own status before, so this used to succeed and
      // record that a finished run's plan had been turned down.
      expect(response.statusCode).toBe(409);
      expect(response.json<ActionErrorView>().error).toBe('run_completed');
    });
  });

  describe('retry', () => {
    it('queues a failed task again', async () => {
      const { server, store, run } = await serve();

      // Through the legal path: §22 has no queued → failed, and StateStore enforces
      // that on every write. Seeding an illegal state would test a run that cannot
      // exist.
      await moveTask(store, run.runId, 'FIX-001', 'running');
      await moveTask(store, run.runId, 'FIX-001', 'failed', 1);

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const state = await store.loadRun(run.runId);
      expect(state.tasks.find((task) => task.id === 'FIX-001')?.state).toBe('queued');
    });

    it('refuses a BLOCKED task without a deliberate override', async () => {
      const { server, store, run } = await serve();

      await moveTask(store, run.runId, 'FIX-001', 'running');
      await moveTask(store, run.runId, 'FIX-001', 'blocked', 1);

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`,
        payload: {},
      });

      // BLOCKED means a decision is missing. Re-running the same prompt produces
      // the same gap, or a guess — which is worse (§20).
      expect(response.statusCode).toBe(409);
      expect(response.json<ActionErrorView>()).toMatchObject({
        error: 'task_blocked',
        forcible: true,
      });
    });

    it('404s a task that has never run', async () => {
      const { server, run } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/tasks/TASK-999/retry`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });

    it('rejects a task id that is not one before touching the filesystem', async () => {
      const { server, run } = await serve();

      for (const attempt of ['../../etc', 'TASK-1', 'rm -rf /']) {
        const response = await server.app.inject({
          method: 'POST',
          headers: WRITE_HEADERS,
          url: `/api/v1/runs/${run.runId}/tasks/${encodeURIComponent(attempt)}/retry`,
          payload: {},
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe('feature', () => {
    it('creates the run at once, and plans it as a job whose id the 202 carries', async () => {
      const { server, fs } = await serve();
      // Sequential mode for the fixture: the fake process runner answers every git
      // question with `1.0.0`, which worktree mode would rightly refuse as a base.
      fs.seed('/home/.agent-flow/config.yaml', 'git:\n  useWorktrees: false\n');

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: '/api/v1/runs',
        payload: { description: 'Add cancellation of a single occurrence' },
      });

      expect(response.statusCode).toBe(202);
      const job = response.json<ActionJobView>();
      expect(job.kind).toBe('plan');
      expect(job.runId).toMatch(/^AF-\d{4}-\d{3}$/);

      // The run exists before planning has spent anything, under the description given.
      const detail = await server.app.inject(`/api/v1/runs/${job.runId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json<RunDetailView>().feature).toBe('Add cancellation of a single occurrence');

      // Whatever planning did, it says so through the job — with a code and a sentence,
      // never a stack trace flattened into `no_run`. Against this fixture's minimal prompts
      // the pipeline refuses before a runner is called (the seeded `discovery` prompt
      // declares a variable the pipeline does not pass), and that refusal is the proof: it
      // arrived as `planning_refused` with the prompt loader's own sentence.
      const settled = await settleJob(server, job.id);
      expect(settled.status).toBe('failed');
      expect(settled.error).toMatchObject({ error: 'planning_refused' });
      expect(settled.error?.message).toMatch(/Prompt/);
      expect(settled.error?.action).toBeTruthy();
    });

    it('refuses a blank description before writing anything', async () => {
      const { server } = await serve();
      const before = (await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>().length;

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: '/api/v1/runs',
        payload: { description: '   ' },
      });

      expect(response.statusCode).toBe(400);
      expect((await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>()).toHaveLength(before);
    });

    it('names the project the way every read does, and knows none it was not pointed at', async () => {
      const { server } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: '/api/v1/runs?projectId=elsewhere',
        payload: { description: 'x' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('answers a preflight refusal with the CLI’s own sentence, and creates no run', async () => {
      const { server, fs } = await serve();
      // Worktree mode on (the default), against a repository the fake git cannot describe:
      // the same refusal `agent-flow feature` prints, before anything is spent.
      fs.seed('/home/.agent-flow/config.yaml', 'git:\n  useWorktrees: true\n');
      const before = (await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>().length;

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: '/api/v1/runs',
        payload: { description: 'Add cancellation' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json<ActionErrorView>().error).toBe('planning_refused');
      expect(response.json<ActionErrorView>().action).toBeTruthy();
      expect((await server.app.inject('/api/v1/runs')).json<RunSummaryView[]>()).toHaveLength(before);
    });
  });

  describe('review', () => {
    it('is a job, like start: 202 with a kind of review, and the outcome through the job', async () => {
      const { server, run } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/review`,
        payload: {},
      });

      // Verification and two reviewers take minutes. A handler that awaited them would
      // hold a socket past every timeout between the browser and this process.
      expect(response.statusCode).toBe(202);
      const started = response.json<ActionJobView>();
      expect(started).toMatchObject({ kind: 'review', runId: run.runId });

      // The fixture run is at the gate with nothing implemented, so the use case refuses —
      // and the refusal arrives as the job's ending, never as a 4xx on the request. Same
      // shape as `start`: 202 means "asked".
      const job = await settleJob(server, started.id);
      expect(['completed', 'failed']).toContain(job.status);
      if (job.status === 'failed') {
        expect(job.error?.message).toBeTruthy();
      }
    });

    it('refuses a malformed body before starting anything', async () => {
      const { server, run } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/review`,
        payload: { fix: 'yes' },
      });

      expect(response.statusCode).toBe(400);
      expect((await server.app.inject(`/api/v1/runs/${run.runId}/job`)).json()).toBeNull();
    });
  });

  describe('start and revise', () => {
    it('answers 202 with a job rather than holding the socket open', async () => {
      const { server, run } = await serve();

      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/start`,
        payload: {},
      });

      // Starting a run executes a plan. A handler that awaited it would hold a
      // socket past every timeout between the browser and this process.
      expect(response.statusCode).toBe(202);
      expect(response.json<ActionJobView>()).toMatchObject({ kind: 'start', runId: run.runId });
    });

    it('reports the gate refusal through the job, not through the response', async () => {
      const { server, run } = await serve();

      const started = (
        await server.app.inject({
          method: 'POST',
          headers: WRITE_HEADERS,
          url: `/api/v1/runs/${run.runId}/start`,
          payload: {},
        })
      ).json<ActionJobView>();

      // The gates live inside the use case, which is the only place they may live.
      // So the 202 means "asked", and the job says whether the workflow agreed.
      const job = await settleJob(server, started.id);
      expect(job.status).toBe('failed');
      expect(job.error?.error).toBe('approval_required');
      expect(job.error?.action).toBe(
        'Review and approve the current plan before starting.',
      );
    });

    it('refuses to run the same run twice at once', async () => {
      const { server, run } = await approvable();

      await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/approve`,
        payload: {},
      });

      // Two schedulers on one run would both move the same task to running and
      // spawn the same agent twice. A double-clicked button produces exactly that.
      const first = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/start`,
        payload: {},
      });
      const second = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/start`,
        payload: {},
      });

      expect(first.statusCode).toBe(202);
      // Either the first job is still in flight — 409 — or it finished before the
      // second arrived, which is a legitimate 202. What must never happen is two
      // jobs running at once, and `activeFor` is what guarantees that.
      if (second.statusCode === 409) {
        expect(second.json<ActionErrorView>().error).toBe('run_busy');
      } else {
        expect(second.statusCode).toBe(202);
      }
    });

    it('refuses a revision with no instruction', async () => {
      const { server, run } = await serve();

      for (const payload of [{}, { instruction: '' }, { instruction: '   ' }]) {
        const response = await server.app.inject({
          method: 'POST',
          headers: WRITE_HEADERS,
          url: `/api/v1/runs/${run.runId}/revise`,
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('refuses to act on a run that is not the active one', async () => {
      const { server, store, run } = await serve();

      const other = await store.createRun('a newer feature');
      expect(other.runId).not.toBe(run.runId);

      const started = (
        await server.app.inject({
          method: 'POST',
          headers: WRITE_HEADERS,
          url: `/api/v1/runs/${run.runId}/start`,
          payload: {},
        })
      ).json<ActionJobView>();

      // The CLI has always acted on the current run. Executing an older one would
      // write into a directory the rest of the tool has moved on from, and the
      // person clicking would have no way to tell.
      const job = await settleJob(server, started.id);
      expect(job.error?.error).toBe('not_current_run');
    });

    it('serves a job by id, and the active job for a run', async () => {
      const { server, run } = await serve();

      const started = (
        await server.app.inject({
          method: 'POST',
          headers: WRITE_HEADERS,
          url: `/api/v1/runs/${run.runId}/start`,
          payload: {},
        })
      ).json<ActionJobView>();

      const byId = await server.app.inject(`/api/v1/jobs/${started.id}`);
      expect(byId.statusCode).toBe(200);

      // Null rather than 404 once it finishes: "nothing is running" is the normal
      // answer, and a page that polled a 404 to learn it would log every time.
      await settleJob(server, started.id);
      const active = await server.app.inject(`/api/v1/runs/${run.runId}/job`);
      expect(active.statusCode).toBe(200);
      expect(active.json()).toBeNull();
    });

    it('rejects a job id that is not one', async () => {
      const { server } = await serve();

      for (const attempt of ['../../etc/passwd', 'job-x', '1']) {
        const response = await server.app.inject(`/api/v1/jobs/${encodeURIComponent(attempt)}`);
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe('what the write API refuses to have', () => {
    it('answers pause, resume and cancel through the same use cases the CLI calls', async () => {
      // This test used to assert all three were **absent**, and it was right to: the core
      // had semantics for none of them, and an endpoint that set a status field to satisfy
      // §86's list would have been a button that lied about what it did.
      //
      // They exist now (PRI-14, PRI-15), so what it asserts is the property that made
      // their absence correct — the browser reaches `app/run-actions.ts`, not a second
      // state machine. A route answering anything but a use case's own refusal would be
      // the parallel implementation §60 forbids.
      const { server, run } = await serve();

      // `pause` on a run at the approval gate: legal, and returns the use case's answer.
      const paused = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        url: `/api/v1/runs/${run.runId}/pause`,
        payload: {},
      });
      expect(paused.statusCode).toBe(200);

      // `resume` and `cancel` reach their own gates rather than a generic 404.
      for (const action of ['resume', 'cancel']) {
        const response = await server.app.inject({
          method: 'POST',
          headers: WRITE_HEADERS,
          url: `/api/v1/runs/${run.runId}/${action}`,
          payload: {},
        });
        expect([200, 202, 409], action).toContain(response.statusCode);
      }
    });

    it('accepts no path, command or runner executable in any write body', async () => {
      const { server, run } = await serve();

      // Every write body is validated by a Zod object whose fields are a boolean, a
      // sentence, or an id the server issued. These extras are not in any of them,
      // so they cannot reach a handler that might act on one.
      const hostile = {
        force: true,
        instruction: 'change it',
        path: '/etc/passwd',
        command: 'rm -rf /',
        runnerCommand: '/tmp/evil',
        cwd: '/',
        planHash: 'deadbeefdeadbeef',
      };

      for (const action of ['approve', 'reject', 'revise']) {
        const response = await server.app.inject({
          method: 'POST',
          headers: WRITE_HEADERS,
          url: `/api/v1/runs/${run.runId}/${action}`,
          payload: hostile,
        });
        // Whatever the workflow decides, none of the extras appear in the answer —
        // which is the only place they could have had an effect.
        expect(response.body).not.toMatch(/etc\/passwd|rm -rf|tmp\/evil/);
      }
    });
  });
});

/** One legal task transition, so a fixture cannot describe an impossible run. */
async function moveTask(
  store: StateStore,
  runId: string,
  taskId: string,
  state: TaskState,
  attempts?: number,
): Promise<void> {
  await store.updateRun(runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === taskId
        ? { ...task, state, ...(attempts === undefined ? {} : { attempts }) }
        : task,
    ),
  }));
}

/** Waits for a job to stop running. The work is real, so this polls the registry. */
async function settleJob(
  server: RunningServer,
  jobId: string,
): Promise<ActionJobView> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = (await server.app.inject(`/api/v1/jobs/${jobId}`)).json<ActionJobView>();
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} never finished`);
}

describe('AF-L01 — a run another process is executing', () => {
  /** A lock on disk, as a real holder would have left one. */
  async function holdLock(
    fs: InMemoryFileSystem,
    runId: string,
    holder: { pid: number; hostname: string; owner: string; operation: string },
  ): Promise<void> {
    fs.seed(
      `/repo/.agent-flow/runs/${runId}/execution.lock.1`,
      JSON.stringify({
        version: 1,
        generation: 1,
        runId,
        createdAt: '2026-08-10T19:00:00.000Z',
        ...holder,
      }),
    );
  }

  it('refuses start with a conflict rather than a 202 that fails later', async () => {
    const { fs, host, server, run } = await serve();

    // A CLI in a terminal, holding the run. The server's in-process guard knows
    // nothing about it — this is the risk the lock exists to close.
    host.spawn(31_337);
    await holdLock(fs, run.runId, {
      pid: 31_337,
      hostname: 'test-host',
      owner: 'cli',
      operation: 'run',
    });

    const response = await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/start`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ActionErrorView>()).toMatchObject({
      error: 'run_busy',
      action: 'Wait for the active execution to finish.',
    });
    // Enough to diagnose: which entry point has it, doing what, as which process.
    expect(response.json<ActionErrorView>().detail).toMatchObject({
      holder: { owner: 'cli', operation: 'run', pid: 31_337 },
      sameHost: true,
    });
  });

  it('refuses revise and retry the same way', async () => {
    const { fs, host, server, run } = await serve();

    host.spawn(31_337);
    await holdLock(fs, run.runId, {
      pid: 31_337,
      hostname: 'test-host',
      owner: 'cli',
      operation: 'run',
    });

    const revise = await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/revise`,
      payload: { instruction: 'split TASK-001' },
    });
    const retry = await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`,
      payload: {},
    });

    expect(revise.statusCode).toBe(409);
    expect(revise.json<ActionErrorView>().error).toBe('run_busy');

    // Retry goes through the use case rather than the pre-flight, and lands on the
    // same code — requeuing a task while the scheduler is executing it would have the
    // two fighting over one entry in `state.json`.
    expect(retry.statusCode).toBe(409);
    expect(retry.json<ActionErrorView>().error).toBe('run_busy');
  });

  it('never answers a conflict with a 500', async () => {
    const { fs, host, server, run } = await serve();

    host.spawn(31_337);
    await holdLock(fs, run.runId, {
      pid: 31_337,
      hostname: 'test-host',
      owner: 'cli',
      operation: 'run',
    });

    for (const request of [
      { url: `/api/v1/runs/${run.runId}/start`, payload: {} },
      { url: `/api/v1/runs/${run.runId}/revise`, payload: { instruction: 'change it' } },
      { url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`, payload: {} },
    ]) {
      const response = await server.app.inject({
        method: 'POST',
        headers: WRITE_HEADERS,
        ...request,
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toMatch(/at \w+ \(|node_modules/);
    }
  });

  it('will not judge a lock written by another machine', async () => {
    const { fs, server, run } = await serve();

    // The pid is not alive here, and that means nothing: it names a process on another
    // host. Overriding it is how a run gets executed twice, so it is treated as held.
    await holdLock(fs, run.runId, {
      pid: 999,
      hostname: 'somebody-elses-machine',
      owner: 'server',
      operation: 'run',
    });

    const response = await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/start`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ActionErrorView>().detail).toMatchObject({ sameHost: false });
  });

  it('proceeds once the holder is gone, and records the recovery', async () => {
    const { fs, server, store, run } = await serve();

    // A holder that died without releasing. No heartbeat has expired — the pid is the
    // liveness signal, and `FakeHost` reports this one as absent.
    await holdLock(fs, run.runId, {
      pid: 999,
      hostname: 'test-host',
      owner: 'cli',
      operation: 'run',
    });

    const response = await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`,
      payload: {},
    });

    // Refused for a different reason — FIX-001 has not run — which is the point: the
    // stale lock did not stand in the way.
    expect(response.json<ActionErrorView>().error).not.toBe('run_busy');

    const events = await store.readEvents(run.runId);
    expect(events.map((event) => event.type)).toContain('stale_execution_lock_recovered');
    expect(events.find((event) => event.type === 'stale_execution_lock_recovered')?.detail).
      toMatchObject({ pid: 999, owner: 'cli' });
  });

  it('records who held the lock and when they let go', async () => {
    const { server, store, run } = await serve();

    await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`,
      payload: {},
    });

    const types = (await store.readEvents(run.runId)).map((event) => event.type);

    // The audit trail: who executed this run, from where. There is no heartbeat, so
    // there is no polling event either — two lines per acquisition and no more.
    expect(types).toContain('execution_lock_acquired');
    expect(types).toContain('execution_lock_released');
    expect(types.filter((type) => type.startsWith('execution_lock')).length).toBe(2);
  });

  it('releases the lock even when the action is refused', async () => {
    const { fs, server, run } = await serve();

    // FIX-001 has not run, so retry refuses — and the lock must not be left behind by
    // a refusal. `withExecutionLock` releases in a `finally`.
    await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`,
      payload: {},
    });

    const entries = await fs.readDir(`/repo/.agent-flow/runs/${run.runId}`);
    expect(entries.filter((entry) => entry.startsWith('execution.lock'))).toEqual([]);
  });

  it('writes no lock state into state.json', async () => {
    const { server, store, run } = await serve();

    await server.app.inject({
      method: 'POST',
      headers: WRITE_HEADERS,
      url: `/api/v1/runs/${run.runId}/tasks/FIX-001/retry`,
      payload: {},
    });

    // The lock is coordination, not workflow state. `state.json` remains the source of
    // truth for what a run *is*, and deleting every lock file on a machine loses no
    // information about any run.
    const raw = JSON.stringify(await store.loadRun(run.runId));
    expect(raw).not.toMatch(/lock|pid|hostname/i);
  });
});

/**
 * M7-ACC-25 — the delivery projection reaches the API, and reaches it credential-free.
 *
 * The endpoint folds a file this machine already wrote. Asking "where did this run go"
 * must not require a token, and the server must never be the thing that spends one.
 */
describe('M7 — delivery', () => {
  it('answers with the projection, disabled by default', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/runs/AF-2026-001/delivery');

    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe('disabled');
  });

  it('404s an unknown run rather than inventing a delivery for it', async () => {
    const { server } = await serve();

    expect((await server.app.inject('/api/v1/runs/AF-2026-999/delivery')).statusCode).toBe(404);
  });

  it('reflects no token, because it never reads one', async () => {
    const { server } = await serve();

    const response = await server.app.inject('/api/v1/runs/AF-2026-001/delivery');

    expect(response.body).not.toMatch(/token|authorization|ghp_/i);
  });
});
