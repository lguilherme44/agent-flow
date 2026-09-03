import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import type {
  ControlSnapshotView,
  TaskSummaryView,
  TeamView,
  WorkspaceView,
} from '../../src/contracts/index.js';

/**
 * The snapshot, and the claim that makes it safe to have (M8 §7).
 *
 * It is a *second read path* over facts that already have one, which is the shape of defect
 * this milestone exists to remove — so the tests that matter most are the ones asserting it
 * composes rather than reimplements. `snapshot.cards[].task` has to be byte-identical to
 * what `/tasks` serves, and its delivery has to be what `/delivery` serves, because the
 * first time they differ the operator is reading two answers to one question.
 */

const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };
const IDLE = { id: 'idle', name: 'idle', path: '/idle' };

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
      description: 'Domain types.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile.'],
      validation: ['test'],
    },
    {
      id: 'TASK-002',
      title: 'Use the types',
      description: 'Wire them in.',
      complexity: 'normal',
      risk: 'low',
      dependencies: ['TASK-001'],
      requirements: ['FR-002'],
      acceptanceCriteria: ['It compiles.'],
      validation: ['test'],
    },
    {
      id: 'TASK-003',
      title: 'Render them',
      description: 'A screen.',
      complexity: 'normal',
      risk: 'high',
      dependencies: ['TASK-002'],
      requirements: ['FR-003'],
      acceptanceCriteria: ['It renders.'],
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
  options: {
    tasks?: { id: string; state: string; attempts?: number; blockReason?: string }[];
    status?: string;
    projects?: { id: string; name: string; path: string }[];
  } = {},
) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  fs.seed('/idle/.agent-flow/config.yaml', PROJECT_CONFIG);

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('weekly recurrence');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));

  const tasks = options.tasks ?? [
    { id: 'TASK-001', state: 'completed', attempts: 1 },
    { id: 'TASK-002', state: 'running', attempts: 1 },
    { id: 'TASK-003', state: 'queued', attempts: 0 },
  ];

  await store.updateRun(run.runId, (state) => ({
    ...state,
    stage: 'implementation',
    status: (options.status ?? 'running') as typeof state.status,
    approved: true,
    tasks: tasks.map((task) => ({
      id: task.id,
      state: task.state as never,
      attempts: task.attempts ?? 0,
      infrastructureFailures: 0,
      ...(task.blockReason === undefined ? {} : { blockReason: task.blockReason as never }),
    })),
  }));

  running = await buildServer({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    registry: registryOf(options.projects ?? [PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    processHost: new FakeHost(),
    pollIntervalMs: 20,
  });

  return { fs, clock, store, run, server: running };
}

const snapshotOf = async (
  server: RunningServer,
  runId: string,
): Promise<ControlSnapshotView> => {
  const response = await server.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/control` });
  expect(response.statusCode).toBe(200);
  return response.json<ControlSnapshotView>();
};

describe('M8-ACC-17 — the board and the endpoints share one task truth', () => {
  it('serves the same task objects `/tasks` serves', async () => {
    const { server, run } = await serve();

    const [snapshot, tasks] = await Promise.all([
      snapshotOf(server, run.runId),
      server.app
        .inject({ method: 'GET', url: `/api/v1/runs/${run.runId}/tasks` })
        .then((response) => response.json<TaskSummaryView[]>()),
    ]);

    // Byte-identical, not merely consistent. A snapshot that shaped its own task views
    // would be a second projection, and it would drift on the first field somebody added
    // to one and not the other.
    expect(snapshot.cards.map((card) => card.task)).toEqual(tasks);
  });

  it('carries the same delivery `/delivery` carries', async () => {
    const { server, run } = await serve();

    const snapshot = await snapshotOf(server, run.runId);
    const delivery = await server.app
      .inject({ method: 'GET', url: `/api/v1/runs/${run.runId}/delivery` })
      .then((response) => response.json());

    expect(snapshot.delivery).toEqual(delivery);
  });

  it('carries the runtime projection the run detail carries', async () => {
    const { server, run } = await serve();

    const snapshot = await snapshotOf(server, run.runId);
    const detail = await server.app
      .inject({ method: 'GET', url: `/api/v1/runs/${run.runId}` })
      .then((response) => response.json<{ runtime: unknown }>());

    expect(snapshot.run.runtime).toEqual(detail.runtime);
  });
});

describe('M8-ACC-21 — a hundred cards is one request', () => {
  it('answers a whole board from a single call', async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      id: `TASK-${String(index + 1).padStart(3, '0')}`,
      state: index % 3 === 0 ? 'completed' : 'queued',
      attempts: 1,
    }));

    const { server, run } = await serve({ tasks: many });
    const snapshot = await snapshotOf(server, run.runId);

    // The three planned tasks plus the ninety-seven the state knows about that the plan
    // does not — a shape the reader keeps visible rather than hiding.
    expect(snapshot.cards.length).toBeGreaterThanOrEqual(100);
    expect(snapshot.lanes.reduce((sum, lane) => sum + lane.count, 0)).toBe(snapshot.cards.length);
  });
});

describe('the lanes and the reasons an operator reads', () => {
  it('places a running task, a blocked dependent and a completed one', async () => {
    const { server, run } = await serve();
    const snapshot = await snapshotOf(server, run.runId);

    const lane = (id: string) => snapshot.cards.find((card) => card.task.id === id)?.lane;

    expect(lane('TASK-001')).toBe('done');
    expect(lane('TASK-002')).toBe('in_progress');
    // TASK-003 depends on TASK-002, which is still running, so it is not ready.
    expect(lane('TASK-003')).toBe('backlog');
  });

  it('names what a backlog card is waiting on', async () => {
    const { server, run } = await serve();
    const snapshot = await snapshotOf(server, run.runId);

    const card = snapshot.cards.find((entry) => entry.task.id === 'TASK-003');
    expect(card?.reason.cause).toBe('dependency');
    expect(card?.reason.text).toContain('TASK-002');
    // Unmet only: TASK-001 completed, and naming it would send somebody to the wrong task.
    expect(card?.reason.waitsFor).toEqual(['TASK-002']);
  });

  it('moves a task to READY once its dependency completes', async () => {
    const { server, run } = await serve({
      tasks: [
        { id: 'TASK-001', state: 'completed', attempts: 1 },
        { id: 'TASK-002', state: 'completed', attempts: 1 },
        { id: 'TASK-003', state: 'queued', attempts: 0 },
      ],
    });

    const snapshot = await snapshotOf(server, run.runId);
    const card = snapshot.cards.find((entry) => entry.task.id === 'TASK-003');

    // Readiness comes from the effective state the reader already resolves, not from a
    // second traversal here — the server is forbidden from importing `core/dag`.
    expect(card?.lane).toBe('ready');
    expect(card?.reason.cause).toBe('none');
  });
});

describe('the attention queue reaches the browser from facts', () => {
  it('raises a failed task and a plan waiting at the gate', async () => {
    const { server, run } = await serve({
      status: 'waiting_for_approval',
      tasks: [
        { id: 'TASK-001', state: 'failed', attempts: 2 },
        { id: 'TASK-002', state: 'queued' },
        { id: 'TASK-003', state: 'queued' },
      ],
    });

    const snapshot = await snapshotOf(server, run.runId);
    const kinds = snapshot.attention.map((item) => item.kind);

    expect(kinds).toContain('approval_required');
    expect(kinds).toContain('task_failed');
    // P1 before P2: a person is the blocker, and the failure waits behind the decision.
    expect(snapshot.attention[0]?.kind).toBe('approval_required');
  });

  it('marks the card an item is scoped to', async () => {
    const { server, run } = await serve({
      tasks: [
        { id: 'TASK-001', state: 'failed', attempts: 1 },
        { id: 'TASK-002', state: 'queued' },
        { id: 'TASK-003', state: 'queued' },
      ],
    });

    const snapshot = await snapshotOf(server, run.runId);
    const card = snapshot.cards.find((entry) => entry.task.id === 'TASK-001');

    expect(card?.attention).toBe('P2');
  });

  it('says nothing about a run doing exactly what it should', async () => {
    const { server, run } = await serve();
    const snapshot = await snapshotOf(server, run.runId);

    // Progress is not attention. This run has a task running and two waiting on it.
    expect(snapshot.attention).toEqual([]);
  });
});

describe('the snapshot names its own instant', () => {
  it('stamps every read', async () => {
    const { server, run, clock } = await serve();
    const snapshot = await snapshotOf(server, run.runId);

    // The browser accepts a snapshot only when this is not older than the one on screen —
    // without it a late event repaints a completed card back to `running`, which is a lie
    // with a timestamp on it.
    expect(snapshot.observedAt).toBe(clock.now());
  });

  it('404s a run that does not exist rather than serving an empty board', async () => {
    const { server } = await serve();

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/runs/AF-2026-999/control',
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('M8 §37 — the workspace answers which project wants you', () => {
  it('reports the active run, and charges an idle project nothing', async () => {
    const { server } = await serve({ projects: [PROJECT, IDLE] });

    const response = await server.app.inject({ method: 'GET', url: '/api/v1/workspace' });
    expect(response.statusCode).toBe(200);

    const workspace = response.json<WorkspaceView>();
    expect(workspace.projects.map((project) => project.projectId)).toEqual(['demo', 'idle']);

    const demo = workspace.projects.find((project) => project.projectId === 'demo');
    expect(demo?.runId).toBeDefined();
    expect(demo?.taskCount).toBe(3);
    expect(demo?.runtime).toBe('implementing');

    // An idle project reports zero without reading a run: a project with nothing current
    // has nothing anybody must do about it, and paying four file reads each to say so is
    // what makes a fifty-project workspace take seconds.
    const idle = workspace.projects.find((project) => project.projectId === 'idle');
    expect(idle?.runId).toBeUndefined();
    expect(idle?.attentionCount).toBe(0);
  });

  it('carries the top priority rather than a colour', async () => {
    const { server } = await serve({
      status: 'waiting_for_approval',
      tasks: [
        { id: 'TASK-001', state: 'failed', attempts: 1 },
        { id: 'TASK-002', state: 'queued' },
        { id: 'TASK-003', state: 'queued' },
      ],
    });

    const workspace = await server.app
      .inject({ method: 'GET', url: '/api/v1/workspace' })
      .then((response) => response.json<WorkspaceView>());

    const demo = workspace.projects[0];
    expect(demo?.attentionCount).toBeGreaterThan(0);
    expect(demo?.topPriority).toBe('P1');
    // Three, not one: a failure poisons everything downstream of it, and `blockedByFailure`
    // marks those `blocked` so they stop reading as "not started yet". The count is the
    // board's, and the board is right — what distinguishes them is the reason on the card.
    expect(demo?.blockedCount).toBe(3);
  });

  it('omits team load for a project with no team configured', async () => {
    const { server } = await serve();

    const workspace = await server.app
      .inject({ method: 'GET', url: '/api/v1/workspace' })
      .then((response) => response.json<WorkspaceView>());

    // Absent rather than `0/0`. A run with no team has no load, and rendering zero would
    // invite somebody to wonder which agent is idle.
    expect(workspace.projects[0]?.teamLoad).toBeUndefined();
  });
});

describe('team load is derived, never stored (M8-A14)', () => {
  it('counts running assignments rather than a flag', async () => {
    const { server, run } = await serve();
    const snapshot = await snapshotOf(server, run.runId);

    const team = await server.app
      .inject({ method: 'GET', url: `/api/v1/runs/${run.runId}/team` })
      .then((response) => response.json<TeamView>());

    expect(snapshot.team.configured).toBe(team.configured);
    for (const member of snapshot.team.members) {
      const source = team.members.find((candidate) => candidate.id === member.id);
      expect(member.running).toBe(source?.assigned.length);
      expect(member.capacity).toBe(source?.maxConcurrentTasks);
    }
  });
});
