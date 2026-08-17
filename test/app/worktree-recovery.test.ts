import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { StateStore } from '../../src/app/state-store.js';
import { WorktreeRecovery, type RunRecovery } from '../../src/app/worktree-recovery.js';
import { buildDag } from '../../src/core/dag.js';
import { PlanSchema, TaskResultSchema, type Task, type TaskResult } from '../../src/contracts/index.js';
import type { GitWorkspaces } from '../../src/adapters/git/git-workspaces.js';
import type {
  IntegrationWorkspace,
  RecoveryIntegrator,
  WaveIntegrationRequest,
  WaveIntegrationOutcome,
} from '../../src/app/integrator.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';

/**
 * What recovery decides, and in what order, without a repository.
 *
 * The windows themselves are proved against real Git in
 * `worktree-recovery.integration.test.ts` — a claim about what `commit-tree` or
 * `merge-base` does can only be proved there. What is worth proving here is the
 * *control flow*: which tasks are looked at, in what order, how many times the
 * interrupted-merge check runs, and where the loop stops. Those are decisions
 * this module makes, and a real repository would only make them slower to observe.
 */

const PROJECT = '/repo';
const WORKSPACE: IntegrationWorkspace = {
  path: '/home/.agent-flow/worktrees/repo-0f3a91c4bd27/AF-2026-001-0f3a91c4bd27e615/integration',
  branch: 'agent-flow/AF-2026-001-0f3a91c4bd27e615/integration',
  head: 'a'.repeat(40),
};

async function isolatedRun(tasks: readonly { id: string; state: string; attempts: number }[]) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('f', (runId) => ({
    isolationMode: 'worktree' as const,
    planningBase: 'b'.repeat(40),
    gitRunKey: `${runId}-0f3a91c4bd27e615`,
  }));

  await store.updateRun(run.runId, (current) => ({
    ...current,
    tasks: tasks.map((entry) => ({
      id: entry.id,
      state: entry.state as 'running',
      attempts: entry.attempts,
      // AD-37's second counter. Supplied here rather than by every caller: this helper
      // owns the shape, and a test about recovery has nothing to say about it.
      infrastructureFailures: 0,
    })),
  }));

  return { fs, clock, store, runId: run.runId };
}

/**
 * A `GitWorkspaces` that answers nothing.
 *
 * Every method throws, so a test that reaches Git fails loudly rather than
 * quietly agreeing with whatever a stub returned. Only the methods a case
 * genuinely needs are supplied.
 */
function noGit(overrides: Partial<Record<keyof GitWorkspaces, unknown>> = {}): GitWorkspaces {
  return new Proxy({} as GitWorkspaces, {
    get(_subject, property) {
      if (property in overrides) return overrides[property as keyof GitWorkspaces];
      return () => {
        throw new Error(`recovery reached Git through ${String(property)}`);
      };
    },
  });
}

function fakeIntegrator(
  outcome: (request: WaveIntegrationRequest) => WaveIntegrationOutcome,
  clearance: { ok: true; aborted: boolean } | { ok: false; refusal: { code: never; detail: string } } = {
    ok: true,
    aborted: false,
  },
): RecoveryIntegrator & { readonly seen: string[]; readonly clearances: number } {
  const seen: string[] = [];
  let clearances = 0;

  return {
    get seen() {
      return seen;
    },
    get clearances() {
      return clearances;
    },
    integrate: async (request) => {
      for (const attempt of request.attempts) seen.push(attempt.task);
      return outcome(request);
    },
    clearInterruptedMerge: async () => {
      clearances += 1;
      return clearance as never;
    },
  };
}

describe('which tasks recovery looks at', () => {
  it('looks at nothing that is not running, and reaches Git for none of them', async () => {
    const { store } = await isolatedRun([
      { id: 'TASK-001', state: 'queued', attempts: 0 },
      { id: 'TASK-002', state: 'completed', attempts: 1 },
      { id: 'TASK-003', state: 'failed', attempts: 1 },
      { id: 'TASK-004', state: 'blocked', attempts: 1 },
      { id: 'TASK-005', state: 'review_required', attempts: 1 },
    ]);
    const runId = (await store.loadCurrentRun())?.runId ?? '';
    const integrator = fakeIntegrator(() => ({ outcomes: [] }));

    // `noGit()` with no overrides: any Git call at all is a thrown error, so this
    // asserts the skip happens *before* the repository is consulted rather than
    // after it answers.
    const recovery = new WorktreeRecovery({
      workspaces: noGit(),
      fs: new InMemoryFileSystem(),
      host: new FakeHost(1000, 'h', [1000], '/home'),
      projectDir: PROJECT,
      store,
      clock: new FixedClock(),
      integrator,
    });

    const outcome = await recovery.recoverRun({
      runId,
      workspace: WORKSPACE,
      dag: buildDag(
        ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004', 'TASK-005'].map((id) => ({
          id,
          dependencies: [],
        })),
      ),
      states: {
        'TASK-001': 'queued',
        'TASK-002': 'completed',
        'TASK-003': 'failed',
        'TASK-004': 'blocked',
        'TASK-005': 'review_required',
      },
    });

    expect(outcome.outcomes).toEqual([]);
    expect(outcome.haltedBy).toBeUndefined();
    expect(integrator.seen).toEqual([]);
  });

  it('asks about an interrupted merge exactly once, whatever the task count', async () => {
    // `MERGE_HEAD` is a property of the integration worktree, not of a task. Asking
    // per task would be N reads of one fact — and would make the window
    // unattributable, because the second read would find the merge already gone.
    const { store } = await isolatedRun([
      { id: 'TASK-001', state: 'running', attempts: 0 },
      { id: 'TASK-002', state: 'running', attempts: 0 },
      { id: 'TASK-003', state: 'running', attempts: 0 },
    ]);
    const runId = (await store.loadCurrentRun())?.runId ?? '';
    const integrator = fakeIntegrator(() => ({ outcomes: [] }));

    const recovery = new WorktreeRecovery({
      workspaces: noGit(),
      fs: new InMemoryFileSystem(),
      host: new FakeHost(1000, 'h', [1000], '/home'),
      projectDir: PROJECT,
      store,
      clock: new FixedClock(),
      integrator,
    });

    const outcome = await recovery.recoverRun({
      runId,
      workspace: WORKSPACE,
      dag: buildDag(['TASK-001', 'TASK-002', 'TASK-003'].map((id) => ({ id, dependencies: [] }))),
      states: { 'TASK-001': 'running', 'TASK-002': 'running', 'TASK-003': 'running' },
    });

    expect(integrator.clearances).toBe(1);
    // Attempt 0 for each: no attempt was dispatched, so no artifact is named and
    // Git is never reached — which is why `noGit()` does not fire.
    expect(outcome.outcomes.map((entry) => entry.kind)).toEqual([
      'requeue',
      'requeue',
      'requeue',
    ]);
  });

  it('visits tasks in the plan’s topological order, not the state map’s', async () => {
    const { store } = await isolatedRun([
      { id: 'TASK-003', state: 'running', attempts: 0 },
      { id: 'TASK-001', state: 'running', attempts: 0 },
      { id: 'TASK-002', state: 'running', attempts: 0 },
    ]);
    const runId = (await store.loadCurrentRun())?.runId ?? '';

    const recovery = new WorktreeRecovery({
      workspaces: noGit(),
      fs: new InMemoryFileSystem(),
      host: new FakeHost(1000, 'h', [1000], '/home'),
      projectDir: PROJECT,
      store,
      clock: new FixedClock(),
      integrator: fakeIntegrator(() => ({ outcomes: [] })),
    });

    const outcome = await recovery.recoverRun({
      runId,
      workspace: WORKSPACE,
      dag: buildDag([
        { id: 'TASK-003', dependencies: ['TASK-002'] },
        { id: 'TASK-002', dependencies: ['TASK-001'] },
        { id: 'TASK-001', dependencies: [] },
      ]),
      // Deliberately in the wrong order, so "the order they were listed in" and
      // "the plan's order" cannot be the same accident.
      states: { 'TASK-003': 'running', 'TASK-002': 'running', 'TASK-001': 'running' },
    });

    expect(outcome.outcomes.map((entry) => entry.task)).toEqual([
      'TASK-001',
      'TASK-002',
      'TASK-003',
    ]);
  });

  it('halts before looking at any task when the merge cannot be cleared', async () => {
    const { store } = await isolatedRun([{ id: 'TASK-001', state: 'running', attempts: 1 }]);
    const runId = (await store.loadCurrentRun())?.runId ?? '';
    const integrator = fakeIntegrator(() => ({ outcomes: [] }), {
      ok: false,
      refusal: {
        code: 'integration_worktree_unavailable' as never,
        detail: 'the abort was refused',
      },
    });

    const recovery = new WorktreeRecovery({
      workspaces: noGit(),
      fs: new InMemoryFileSystem(),
      host: new FakeHost(1000, 'h', [1000], '/home'),
      projectDir: PROJECT,
      store,
      clock: new FixedClock(),
      integrator,
    });

    const outcome = await recovery.recoverRun({
      runId,
      workspace: WORKSPACE,
      dag: buildDag([{ id: 'TASK-001', dependencies: [] }]),
      states: { 'TASK-001': 'running' },
    });

    expect(outcome.haltedBy).toContain('integration_worktree_unavailable');
    expect(outcome.outcomes).toEqual([]);
    expect(integrator.seen).toEqual([]);
  });

  it('halts when the run has no Git namespace, rather than composing a ref from nothing', async () => {
    // Unreachable behind §6.3 check 7, and named anyway: the alternative is a ref
    // name with `undefined` in it reaching Git.
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('f');
    await store.updateRun(run.runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    const integrator = fakeIntegrator(() => ({ outcomes: [] }));
    const recovery = new WorktreeRecovery({
      workspaces: noGit(),
      fs,
      host: new FakeHost(1000, 'h', [1000], '/home'),
      projectDir: PROJECT,
      store,
      clock: new FixedClock(),
      integrator,
    });

    const outcome = await recovery.recoverRun({
      runId: run.runId,
      workspace: WORKSPACE,
      dag: buildDag([{ id: 'TASK-001', dependencies: [] }]),
      states: { 'TASK-001': 'running' },
    });

    expect(outcome.haltedBy).toContain('no Git namespace');
    expect(integrator.clearances, 'nothing was touched at all').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The scheduler's ordering, which is the invariant of this milestone
// ---------------------------------------------------------------------------

describe('the scheduler runs the Git half before the state half', () => {
  /** A recovery stub that records what the run state said when it was called. */
  function recordingRecovery(
    store: StateStore,
    onCall: (states: readonly string[]) => void,
  ): RunRecovery {
    return {
      recoverRun: async (request) => {
        const state = await store.loadRun(request.runId);
        onCall(state.tasks.map((task) => `${task.id}:${task.state}`));
        return { outcomes: [] };
      },
    };
  }

  it('sees the task still running, not already demoted to interrupted', async () => {
    // **The ordering is the invariant, not a preference.** `running → completed` is
    // a legal transition and `interrupted → completed` is not, so a Git half that
    // ran after the demotion could never finish a durable attempt — it would throw
    // away validated, merged work and run the agent again.
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('f');
    await store.updateRun(run.runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    const observed: string[][] = [];
    const scheduler = new Scheduler({
      store,
      // `failed`, so the redispatch that follows the demotion never reaches the
      // integration phase — this test is about what recovery *saw*, and a
      // satisfied attempt would need the whole workspace service wired to be
      // integrated honestly.
      executor: {
        execute: async (task: Task): Promise<TaskResult> =>
          TaskResultSchema.parse({
            task: task.id,
            status: 'failed',
            runner: 'fake',
            reasoning: 'medium',
            startedAt: '2026-08-09T19:59:00.000Z',
            finishedAt: '2026-08-09T20:00:00.000Z',
            validation: { passed: false, commands: [] },
          }),
      } as unknown as TaskExecutor,
      integrator: {
        prepare: async () => ({ kind: 'ready', workspace: WORKSPACE }),
        waveBase: async () => 'c'.repeat(40),
        integrate: async () => ({ outcomes: [] }),
      },
      recovery: recordingRecovery(store, (states) => observed.push([...states])),
      maxAttempts: 3,
    });

    await scheduler.run(
      PlanSchema.parse({
        feature: 'f',
        tasks: [
          {
            id: 'TASK-001',
            title: 'T',
            description: 'W.',
            complexity: 'normal',
            risk: 'low',
            dependencies: [],
            requirements: ['FR-001'],
            acceptanceCriteria: ['Done.'],
            validation: [],
          },
        ],
      }),
      run.runId,
      'SDD',
      { 'TASK-001': 'running' },
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(['TASK-001:running']);
  });

  it('writes nothing when recovery found nothing', async () => {
    // A pass that observed nothing writes nothing — the same rule §6.4 applies to
    // a precondition refusal. It also keeps a resume from restating its own opening
    // view of the world over what is on disk.
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('f');
    await store.updateRun(run.runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'completed' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    const before = JSON.stringify(await store.loadRun(run.runId));

    const scheduler = new Scheduler({
      store,
      executor: { execute: async () => undefined } as unknown as TaskExecutor,
      integrator: {
        prepare: async () => ({ kind: 'ready', workspace: WORKSPACE }),
        waveBase: async () => 'c'.repeat(40),
        integrate: async () => ({ outcomes: [] }),
      },
      recovery: { recoverRun: async () => ({ outcomes: [] }) },
    });

    await scheduler.run(
      PlanSchema.parse({
        feature: 'f',
        tasks: [
          {
            id: 'TASK-001',
            title: 'T',
            description: 'W.',
            complexity: 'normal',
            risk: 'low',
            dependencies: [],
            requirements: ['FR-001'],
            acceptanceCriteria: ['Done.'],
            validation: [],
          },
        ],
      }),
      run.runId,
      'SDD',
      { 'TASK-001': 'completed' },
    );

    // `updatedAt` moves on any write, so an unchanged document is proof of none.
    expect(JSON.stringify(await store.loadRun(run.runId))).toBe(before);
  });

  it('halts before dispatching anything when recovery refuses', async () => {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('f');
    await store.updateRun(run.runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    const executed: string[] = [];
    const scheduler = new Scheduler({
      store,
      executor: {
        execute: async (task: Task) => {
          executed.push(task.id);
          throw new Error('recovery refused and a task was dispatched anyway');
        },
      } as unknown as TaskExecutor,
      integrator: {
        prepare: async () => ({ kind: 'ready', workspace: WORKSPACE }),
        waveBase: async () => 'c'.repeat(40),
        integrate: async () => ({ outcomes: [] }),
      },
      recovery: {
        recoverRun: async () => ({
          outcomes: [
            {
              kind: 'refused' as const,
              task: 'TASK-001',
              attempt: 1,
              window: 11 as const,
              state: 'review_required' as const,
              refusal: { code: 'attempt_marker_mismatch' as const, detail: 'the tree disagrees' },
            },
          ],
          haltedBy: 'TASK-001 could not be recovered: attempt_marker_mismatch — the tree disagrees',
        }),
      },
    });

    const outcome = await scheduler.run(
      PlanSchema.parse({
        feature: 'f',
        tasks: [
          {
            id: 'TASK-001',
            title: 'T',
            description: 'W.',
            complexity: 'normal',
            risk: 'low',
            dependencies: [],
            requirements: ['FR-001'],
            acceptanceCriteria: ['Done.'],
            validation: [],
          },
        ],
      }),
      run.runId,
      'SDD',
      { 'TASK-001': 'running' },
    );

    expect(executed).toEqual([]);
    expect(outcome.haltedBy).toContain('attempt_marker_mismatch');
    expect(outcome.complete).toBe(false);
    // The state the refusal names is persisted, so a person sees it on the run.
    expect((await store.loadRun(run.runId)).tasks[0]?.state).toBe('review_required');
  });
});
