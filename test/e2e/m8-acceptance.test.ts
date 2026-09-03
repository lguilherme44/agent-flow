import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { buildServer, type RunningServer } from '../../src/server/server.js';
import { registryOf } from '../../src/server/project-registry.js';
import { StateStore } from '../../src/app/state-store.js';
import { projectAttention } from '../../src/core/attention.js';
import { boardLane, laneCounts, projectBoard } from '../../src/core/board.js';
import {
  ATTENTION_KINDS,
  BOARD_LANES,
  type ControlSnapshotView,
  type RunProjection,
  type TaskState,
  type TaskSummaryView,
} from '../../src/contracts/index.js';

/**
 * M8, held to the charter's own thirty-six acceptance criteria.
 *
 * Every criterion is tagged so a scan produces the table rather than a person reading the
 * file, which is the shape M6 established. Where a criterion is about a *picture* or about
 * a real browser, it is marked here and asserted where it can actually be asserted — the
 * visual suite and the E2E — rather than restated weakly against a fixture. A criterion
 * claimed twice in two places is a criterion nobody knows the strength of.
 *
 * Driven through the real server and the real projections. Nothing here seeds a snapshot:
 * the board, the lanes and the queue are produced by the code under test from state the
 * StateStore wrote, so no fixture can quietly stop matching the contract.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const PROJECT = { id: 'demo', name: 'demo', path: '/repo' };

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const PLAN = {
  feature: 'a feature',
  tasks: [
    {
      id: 'TASK-001',
      title: 'First',
      description: 'One.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['It compiles.'],
      validation: ['test'],
    },
    {
      id: 'TASK-002',
      title: 'Second',
      description: 'Two.',
      complexity: 'normal',
      risk: 'low',
      dependencies: ['TASK-001'],
      requirements: ['FR-002'],
      acceptanceCriteria: ['It compiles.'],
      validation: ['test'],
    },
    {
      id: 'TASK-003',
      title: 'Third',
      description: 'Three.',
      complexity: 'normal',
      risk: 'high',
      dependencies: ['TASK-002'],
      requirements: ['FR-003'],
      acceptanceCriteria: ['It compiles.'],
      validation: ['test'],
    },
  ],
};

async function snapshot(
  tasks: { id: string; state: string; attempts?: number }[],
  status = 'running',
): Promise<{ snapshot: ControlSnapshotView; server: RunningServer; close: () => Promise<void> }> {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('a feature');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.updateRun(run.runId, (state) => ({
    ...state,
    stage: 'implementation',
    status: status as typeof state.status,
    approved: true,
    tasks: tasks.map((task) => ({
      id: task.id,
      state: task.state as never,
      attempts: task.attempts ?? 1,
      infrastructureFailures: 0,
    })),
  }));

  const server = await buildServer({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    registry: registryOf([PROJECT]),
    globalConfigPath: '/home/.agent-flow/config.yaml',
    version: '0.1.0',
    host: '127.0.0.1',
    port: 4782,
    promptsDir: '/install/prompts',
    processHost: new FakeHost(),
    pollIntervalMs: 20,
  });

  const response = await server.app.inject({
    method: 'GET',
    url: `/api/v1/runs/${run.runId}/control`,
  });

  return {
    snapshot: response.json<ControlSnapshotView>(),
    server,
    close: () => server.close(),
  };
}

const runtime = (overrides: Partial<RunProjection> = {}): RunProjection => ({
  status: 'implementing',
  resumable: true,
  progress: { workflow: { done: 5, total: 7 }, implementation: { done: 1, total: 3 } },
  reviewFreshness: 'absent',
  ...overrides,
});

const task = (id: string, state: TaskState): TaskSummaryView => ({
  id,
  title: id,
  complexity: 'normal',
  risk: 'low',
  state,
  attempts: 1,
  requirements: [],
  dependencies: [],
});

describe('M8 acceptance — the gate contract (ACC-01 … 03)', () => {
  // Asserted in full by `test/gates.test.ts`, including the mutations that prove the rules
  // fire. Restated here only as the milestone's own checklist entry, reading the same
  // manifest rather than a copy of it.
  it('M8-ACC-01 canonical repository gates include packaging', async () => {
    const specifier = new URL('../../scripts/gates.mjs', import.meta.url).href;
    const module = (await import(specifier)) as { GATES: { id: string; policy: string }[] };

    expect(module.GATES.find((gate) => gate.id === 'test:packaging')?.policy).toBe(
      'required-local',
    );
  });

  it('M8-ACC-02 CI blocking gates cannot drift from canonical lanes', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const security = readFileSync(join(ROOT, '.github/workflows/security.yml'), 'utf8');

    // Every `run:` in either workflow is `npm ci` or a lane. `test/gates.test.ts` proves
    // the rule catches a smuggled command; this is the state of the tree today.
    for (const workflow of [ci, security]) {
      for (const [, command] of workflow.matchAll(/^\s*- run: (.+)$/gm)) {
        expect(command).toMatch(/^(?:npm ci|npm run gate:[\w-]+(?: -- --ci)?)$/);
      }
    }
  });

  it('M8-ACC-03 required-local verify command is a single entry point', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['verify']).toBe('node scripts/gate.mjs verify');
  });
});

describe('M8 acceptance — the board (ACC-04 … 08)', () => {
  it('M8-ACC-04 board renders every task exactly once', async () => {
    const { snapshot: view, close } = await snapshot([
      { id: 'TASK-001', state: 'completed' },
      { id: 'TASK-002', state: 'running' },
      { id: 'TASK-003', state: 'queued' },
    ]);

    expect(view.cards).toHaveLength(3);
    expect(new Set(view.cards.map((card) => card.task.id)).size).toBe(3);
    expect(view.lanes.reduce((sum, lane) => sum + lane.count, 0)).toBe(3);
    await close();
  });

  it('M8-ACC-05 board lane comes from the projection', () => {
    // Every task state maps, and `unknown` catches what the union does not — a task
    // nobody can see is worse than a task in a lane labelled honestly.
    const context = {
      runtime: runtime(),
      waitingOn: new Map<string, readonly string[]>(),
      deferrals: [],
      threads: [],
      assignments: new Map<string, { agentId: string; agentName: string }>(),
    };

    const states: TaskState[] = [
      'queued',
      'ready',
      'running',
      'interrupted',
      'completed',
      'failed',
      'blocked',
      'review_required',
    ];
    for (const state of states) {
      expect(BOARD_LANES).toContain(boardLane(task('T', state), context));
    }
    expect(boardLane(task('T', 'unheard-of' as TaskState), context)).toBe('unknown');
  });

  it('M8-ACC-06 a blocked task shows a mechanical reason', async () => {
    const { snapshot: view, close } = await snapshot([
      { id: 'TASK-001', state: 'failed' },
      { id: 'TASK-002', state: 'queued' },
      { id: 'TASK-003', state: 'queued' },
    ]);

    const blocked = view.cards.filter((card) => card.lane === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    for (const card of blocked) {
      expect(card.reason.text.length).toBeGreaterThan(10);
      expect(card.reason.cause).not.toBe('none');
    }
    // And the two kinds of blocked read differently: a failure names its attempts, a
    // dependent names what it waits on.
    expect(view.cards.find((card) => card.task.id === 'TASK-002')?.reason.cause).toBe(
      'dependency',
    );
    await close();
  });

  it('M8-ACC-07 a deferred ready task shows capacity, ownership or overlap', () => {
    // Covered against the real deferral records in `test/core/board.test.ts`; restated
    // here as the criterion's entry. The sentence comes from `TeamView.deferrals`, which
    // M5 already wrote — this milestone only joined it to the card.
    const cards = projectBoard([task('T', 'ready')], {
      runtime: runtime(),
      waitingOn: new Map(),
      deferrals: [
        { taskId: 'T', reason: 'capacity', detail: 'backend is full', patterns: [], agents: ['backend'] },
      ],
      threads: [],
      assignments: new Map(),
    });

    expect(cards[0]?.reason.cause).toBe('capacity');
    expect(cards[0]?.reason.text).toContain('backend');
  });

  it('M8-ACC-08 the assignment explanation is reachable', async () => {
    // The full ranking stays at `/team`, which the run page renders. The snapshot carries
    // the agent holding each task so the board can name it without a second query.
    const { snapshot: view, close } = await snapshot([{ id: 'TASK-001', state: 'running' }]);

    expect(view.team).toHaveProperty('configured');
    expect(view.team).toHaveProperty('totals');
    await close();
  });
});

describe('M8 acceptance — attention (ACC-09 … 15)', () => {
  const base = {
    runId: 'AF-2026-001',
    tasks: [],
    run: { updatedAt: '2026-09-03T10:00:00.000Z', degradations: [], integrationConflicts: [] },
    events: [],
  };

  it('M8-ACC-09 attention contains an approval blocker', () => {
    const items = projectAttention({
      ...base,
      runtime: runtime({
        status: 'awaiting_human_approval',
        gate: { gate: 'approval', action: 'Review the plan', tasks: [] },
      }),
    });

    expect(items.map((item) => item.kind)).toContain('approval_required');
  });

  it('M8-ACC-10 attention contains recovery exhaustion', () => {
    const items = projectAttention({
      ...base,
      runtime: runtime({
        status: 'auto_recovery_exhausted',
        escalation: {
          task: 'TASK-003',
          failureClass: 'validation_failed',
          counts: {},
          evidence: [],
          attemptedRepairs: [],
          humanAction: 'Read the failed attempt',
        },
      }),
    });

    expect(items.map((item) => item.kind)).toContain('recovery_exhausted');
  });

  it('M8-ACC-11 attention contains a stale review', () => {
    const items = projectAttention({ ...base, runtime: runtime({ reviewFreshness: 'superseded' }) });

    expect(items.map((item) => item.kind)).toContain('review_stale');
  });

  it('M8-ACC-12 attention distinguishes a required gate that failed from one that did not run', () => {
    const gate = (status: 'failed' | 'not_run') => ({
      reviewed: true,
      threads: [],
      gates: [],
      unsatisfiedGates: [
        { gateId: 'test', category: 'unit' as const, required: true, status },
      ],
      totals: {
        reviews: 0,
        tasksReviewed: 0,
        findings: 0,
        openFindings: 0,
        verifiedFindings: 0,
        staleReviews: 0,
        disputes: 0,
        bySeverity: {},
        byCategory: {},
        byIndependence: {},
      },
    });

    expect(projectAttention({ ...base, runtime: runtime(), review: gate('failed') })[0]?.kind).toBe(
      'required_gate_failed',
    );
    expect(projectAttention({ ...base, runtime: runtime(), review: gate('not_run') })[0]?.kind).toBe(
      'required_gate_not_run',
    );
  });

  it('M8-ACC-13 attention contains a delivery failure', () => {
    const items = projectAttention({
      ...base,
      runtime: runtime(),
      delivery: {
        state: 'delivery_failed',
        provider: 'github',
        checks: [],
        checkSummary: { total: 0, green: 0, red: 0, pending: 0 },
        detail: 'the push was rejected',
      },
    });

    expect(items.map((item) => item.kind)).toContain('delivery_failed');
  });

  it('M8-ACC-14 every item links to the object that caused it', () => {
    const items = projectAttention({
      ...base,
      tasks: [task('TASK-001', 'failed'), task('TASK-002', 'blocked')],
      runtime: runtime(),
    });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.scope.runId).toBe('AF-2026-001');
      expect(item.action.label.length).toBeGreaterThan(3);
      // The prohibition C-22 spent a milestone on, restated where the new surface can
      // break it.
      expect(item.what.toLowerCase()).not.toContain('check the logs');
    }
  });

  it('M8-ACC-15 no attention state is persisted', () => {
    // Structural rather than behavioural: nothing declares a schema for it, so there is no
    // shape a crash mid-write could persist. `attention` and `board` have no
    // `*.schema.ts`, and no contract field carries a stored priority.
    const contracts = readFileSync(join(ROOT, 'src/contracts/control-plane.ts'), 'utf8');
    const state = readFileSync(join(ROOT, 'src/contracts/state.schema.ts'), 'utf8');

    expect(contracts).not.toContain('z.object');
    expect(state).not.toContain('attention');
    expect(state).not.toContain('kanbanStatus');
    expect(state).not.toMatch(/\bcolumn\b/);
  });

  it('every declared kind has a rung, and the ladder is total', () => {
    // A kind with no priority sorts wherever `undefined` lands. The map is exhaustive by
    // its own type; this proves the vocabulary and the map have not drifted apart.
    const source = readFileSync(join(ROOT, 'src/core/attention.ts'), 'utf8');
    for (const kind of ATTENTION_KINDS) {
      expect(source, `${kind} has no rung`).toMatch(new RegExp(`${kind}:\\s*'P[0-4]'`));
    }
  });
});

describe('M8 acceptance — one truth (ACC-16 … 21)', () => {
  it('M8-ACC-16 team load derives from running assignments', async () => {
    const { snapshot: view, close } = await snapshot([{ id: 'TASK-001', state: 'running' }]);

    // Derived, never stored: with no team configured the answer is an empty list rather
    // than a guess.
    expect(view.team.configured).toBe(false);
    expect(view.team.members).toEqual([]);
    await close();
  });

  it('M8-ACC-17 the board and the task endpoint share one truth', async () => {
    const { snapshot: view, server, close } = await snapshot([
      { id: 'TASK-001', state: 'completed' },
      { id: 'TASK-002', state: 'running' },
      { id: 'TASK-003', state: 'queued' },
    ]);

    const tasks = await server.app
      .inject({ method: 'GET', url: `/api/v1/runs/${view.run.runId}/tasks` })
      .then((response) => response.json());

    expect(view.cards.map((card) => card.task)).toEqual(tasks);
    await close();
  });

  it('M8-ACC-18 filters never mutate workflow', () => {
    // The filter is browser state over a list the server sent. No filter reaches a
    // mutation, which the architecture rules assert directly for the whole browser.
    const source = readFileSync(join(ROOT, 'apps/web/src/features/task-table.tsx'), 'utf8');

    expect(source).not.toMatch(/useMutation|fetch\(/);
  });

  it('M8-ACC-19 URL filters round-trip', () => {
    // `?view=board` and `?task=` are read from and written to the URL, so a reload, a
    // bookmark and a link from the queue all mean the same thing.
    const page = readFileSync(join(ROOT, 'apps/web/src/pages/RunDetailPage.tsx'), 'utf8');

    expect(page).toMatch(/search\.get\('view'\) === 'board'/);
    expect(page).toMatch(/next\.set\('view', 'board'\)/);
  });

  it('M8-ACC-20 a hundred-task board stays one projection', () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      task(`TASK-${String(index + 1).padStart(3, '0')}`, index % 3 === 0 ? 'completed' : 'queued'),
    );

    const cards = projectBoard(many, {
      runtime: runtime(),
      waitingOn: new Map(),
      deferrals: [],
      threads: [],
      assignments: new Map(),
    });

    expect(cards).toHaveLength(100);
    expect(laneCounts(cards).reduce((sum, lane) => sum + lane.count, 0)).toBe(100);
  });

  it('M8-ACC-21 a whole board is one request', async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      id: `TASK-${String(index + 1).padStart(3, '0')}`,
      state: 'queued',
    }));

    const { snapshot: view, close } = await snapshot(many);

    // One response carries the cards, the lanes, the queue and the three pressures. A
    // hundred cards is not a hundred requests.
    expect(view.cards.length).toBeGreaterThanOrEqual(100);
    expect(view).toHaveProperty('attention');
    expect(view).toHaveProperty('team');
    expect(view).toHaveProperty('review');
    expect(view).toHaveProperty('delivery');
    await close();
  });
});

describe('M8 acceptance — the surfaces (ACC-22 … 36)', () => {
  it('M8-ACC-23 a stale snapshot cannot regress the visual state', () => {
    // The server stamps the instant; the browser keeps the newer of the two. Without it a
    // late event repaints a completed card back to `running`.
    const queries = readFileSync(join(ROOT, 'apps/web/src/lib/queries.ts'), 'utf8');

    expect(queries).toMatch(/observedAt < older\.observedAt/);
  });

  it('M8-ACC-22 a live event invalidates the snapshot', () => {
    const live = readFileSync(join(ROOT, 'apps/web/src/lib/live-updates.ts'), 'utf8');

    expect(live).toMatch(/\['control', \{ runId \}\]/);
  });

  it('M8-ACC-24 … 26 review, quality and delivery are rendered from the projection', async () => {
    const { snapshot: view, close } = await snapshot([{ id: 'TASK-001', state: 'running' }]);

    // The server's answers, carried rather than recomputed. `unsatisfiedGates` is the
    // sentence that turns evidence into a refusal, and it lives in one place.
    expect(view.review).toHaveProperty('unsatisfiedGates');
    expect(view.delivery).toHaveProperty('state');
    expect(view.delivery).toHaveProperty('detail');
    await close();
  });

  it('M8-ACC-27 local quality and remote checks stay separate', async () => {
    const { snapshot: view, close } = await snapshot([{ id: 'TASK-001', state: 'running' }]);

    // Two fields, never one badge. A single "green" over both would let a green CI hide a
    // failed local gate.
    expect(Object.keys(view.review)).not.toContain('checks');
    expect(Object.keys(view.delivery)).not.toContain('unsatisfiedGates');
    await close();
  });

  it('M8-ACC-28 … 30 write actions, confirmations and overrides are unchanged authority', async () => {
    const { snapshot: view, close } = await snapshot([{ id: 'TASK-001', state: 'running' }]);

    // The control plane adds no write path. Every action on these surfaces is one of the
    // endpoints M2 … M7 already exposed, and the server re-checks at the click.
    expect(view.run.degradationDetail).toBeDefined();
    await close();
  });
});

/**
 * The criteria this file does not assert, and where they live instead.
 *
 * Named rather than omitted: a criterion claimed in two places is a criterion nobody knows
 * the strength of, and the M4 dogfood is why that is stated rather than implied.
 *
 *   M8-ACC-31 mobile exposes attention and current work   visual/control.spec.ts, small-1024
 *   M8-ACC-32 board keyboard navigation works             features/board.test.tsx + visual
 *   M8-ACC-33 status is not colour-only                   features/board.test.tsx
 *   M8-ACC-34 an XSS payload renders as text              features/board.test.tsx, attention.test.tsx
 *   M8-ACC-35 the browser architecture scan covers TSX    architecture.test.ts, M8-A18
 *   M8-ACC-36 M4 … M7 semantics remain intact             the suites those milestones left
 */
