import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { StateStore } from '../../src/app/state-store.js';
import { TaskWorkspaces } from '../../src/app/task-workspaces.js';
import { runPaths } from '../../src/app/paths.js';
import {
  PlanSchema,
  TaskResultSchema,
  type EffectiveConfig,
  type Task,
  type TaskResult,
} from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

const PROJECT = '/repo';

const task = (id: string, dependencies: string[] = []) => ({
  id,
  title: `Task ${id}`,
  description: 'Work.',
  complexity: 'normal',
  risk: 'low',
  dependencies,
  requirements: ['FR-001'],
  acceptanceCriteria: ['Done.'],
  validation: [],
});

const result = (taskId: string, status: string): TaskResult =>
  TaskResultSchema.parse({
    task: taskId,
    status,
    runner: 'fake',
    reasoning: 'medium',
    startedAt: '2026-08-09T20:00:00.000Z',
    finishedAt: '2026-08-09T20:00:01.000Z',
    validation: { passed: status === 'completed', commands: [] },
  });

/** Executor stub that records order and replays scripted outcomes. */
function fakeExecutor(outcomes: Record<string, string> = {}) {
  const executed: string[] = [];
  let concurrent = 0;
  let peakConcurrency = 0;

  const executor = {
    execute: async (t: Task) => {
      executed.push(t.id);
      concurrent += 1;
      peakConcurrency = Math.max(peakConcurrency, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return result(t.id, outcomes[t.id] ?? 'completed');
    },
  } as unknown as TaskExecutor;

  return { executor, executed, peak: () => peakConcurrency };
}

async function harness() {
  const fs = new InMemoryFileSystem();
  const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
  const run = await store.createRun('f');
  return { fs, store, run };
}

describe('dependency order', () => {
  it('runs a dependency before its dependent', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-002', ['TASK-001']), task('TASK-001')],
    });

    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');
    expect(executed).toEqual(['TASK-001', 'TASK-002']);
  });

  it('respects a diamond', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        task('TASK-001'),
        task('TASK-002', ['TASK-001']),
        task('TASK-003', ['TASK-001']),
        task('TASK-004', ['TASK-002', 'TASK-003']),
      ],
    });

    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(executed[0]).toBe('TASK-001');
    expect(executed.at(-1)).toBe('TASK-004');
    expect(executed).toHaveLength(4);
  });

  it('completes every task on the happy path', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001'), task('TASK-002')] });
    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(outcome.complete).toBe(true);
    expect(outcome.results).toHaveLength(2);
  });
});

describe('concurrency (AD-05)', () => {
  it('runs one task at a time by default', async () => {
    const { store, run } = await harness();
    const { executor, peak } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002'), task('TASK-003')],
    });

    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');
    expect(peak()).toBe(1);
  });

  it('runs independent tasks in parallel when the limit is raised — no code change', async () => {
    // The MVP 2 proof: the scheduler is already written for N, and this is about
    // the scheduler alone. Nothing in production hands it a number above one —
    // `core/concurrency.ts` decides that, and until task workspaces are isolated
    // it answers one however the configuration is written. See
    // test/app/effective-concurrency.test.ts, which is where that is proved.
    const { store, run } = await harness();
    const { executor, peak } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002'), task('TASK-003')],
    });

    await new Scheduler({ store, executor, maxConcurrency: 3 }).run(plan, run.runId, 'SDD');
    expect(peak()).toBeGreaterThan(1);
  });

  it('never runs a dependent alongside its dependency, whatever the limit', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001']), task('TASK-003', ['TASK-002'])],
    });

    await new Scheduler({ store, executor, maxConcurrency: 5 }).run(plan, run.runId, 'SDD');
    expect(executed).toEqual(['TASK-001', 'TASK-002', 'TASK-003']);
  });
});

describe('stopping on failure', () => {
  it('halts rather than pressing on with an unrelated branch', async () => {
    // Continuing produces a half-built feature whose state is harder to reason
    // about than a clean stop.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor({ 'TASK-001': 'failed' });

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001']), task('TASK-003')],
    });

    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(outcome.complete).toBe(false);
    expect(outcome.haltedBy).toContain('TASK-001');
    expect(executed).toEqual(['TASK-001']);
  });

  it('marks everything downstream of a failure as blocked', async () => {
    // Otherwise those tasks sit in `queued`, which reads as "not started yet"
    // when it actually means "will never start".
    const { store, run } = await harness();
    const { executor } = fakeExecutor({ 'TASK-001': 'failed' });

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001']), task('TASK-003', ['TASK-002'])],
    });

    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(outcome.blocked).toEqual(['TASK-002', 'TASK-003']);
    expect(outcome.states['TASK-002']).toBe('blocked');
  });

  it('halts on a BLOCKED task without retrying it (§23)', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor({ 'TASK-001': 'blocked' });

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001'), task('TASK-002')] });
    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(executed).toEqual(['TASK-001']);
    expect(outcome.haltedBy).toContain('blocked');
  });

  it('halts on review_required, which is not a retry either (§55)', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor({ 'TASK-001': 'review_required' });

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(outcome.complete).toBe(false);
    expect(outcome.states['TASK-001']).toBe('review_required');
  });
});

describe('blocked dependency recovery (provenance)', () => {
  it('releases a dependency-blocked dependent when its dependency recovers, without --force', async () => {
    // The recovery defect being fixed: TASK-002 was marked blocked because its
    // dependency failed, then stayed blocked across every later `run` even after
    // TASK-001 completed — only `retry --force` reopened it. A dependency-block
    // means the task *never ran* and *never ran for a reason that still
    // applies*; when the dependency is complete, the holder is gone.
    const { store, run } = await harness();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    // First pass: TASK-001 fails, so TASK-002 is marked blocked without running.
    const failed = fakeExecutor({ 'TASK-001': 'failed' });
    const first = await new Scheduler({ store, executor: failed.executor }).run(
      plan,
      run.runId,
      'SDD',
    );
    expect(first.blocked).toEqual(['TASK-002']);
    await expect(store.loadRun(run.runId)).resolves.toMatchObject({
      tasks: [
        { id: 'TASK-001', state: 'failed' },
        { id: 'TASK-002', state: 'blocked', blockReason: 'dependency' },
      ],
    });

    // Resume exactly the way the CLI replays it: the operator retried TASK-001
    // (now queued on disk), TASK-002 still blocked from the first pass.
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === 'TASK-001' ? { ...task, state: 'queued', blockReason: undefined } : task,
      ),
    }));

    const { executor, executed } = fakeExecutor();
    const second = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'queued', 'TASK-002': 'blocked' },
      {},
      { 'TASK-002': 'dependency' },
    );

    expect(executed).toEqual(['TASK-001', 'TASK-002']);
    expect(second.complete).toBe(true);
    expect(second.released).toEqual(['TASK-002']);
    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.find((entry) => entry.id === 'TASK-002')).toMatchObject({
      state: 'completed',
      attempts: 1,
    });
  });

  it('recovers a multi-hop block in one invocation, holding C until B truly completes', async () => {
    // A fails → B blocked (dependency) → C blocked (dependency). On resume B is
    // released the moment A is done, and C the moment B is done. Releasing C at
    // the same time as B would let it run against a queue that has not produced
    // B's work yet.
    const { store, run } = await harness();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        task('TASK-001'),
        task('TASK-002', ['TASK-001']),
        task('TASK-003', ['TASK-002']),
      ],
    });

    const failed = fakeExecutor({ 'TASK-001': 'failed' });
    await new Scheduler({ store, executor: failed.executor }).run(plan, run.runId, 'SDD');

    // The CLI's `retry TASK-001` writes `queued` to disk before the next `run`.
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === 'TASK-001' ? { ...task, state: 'queued', blockReason: undefined } : task,
      ),
    }));

    const { executor, executed } = fakeExecutor();
    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'queued', 'TASK-002': 'blocked', 'TASK-003': 'blocked' },
      {},
      { 'TASK-002': 'dependency', 'TASK-003': 'dependency' },
    );

    expect(executed).toEqual(['TASK-001', 'TASK-002', 'TASK-003']);
    expect(outcome.complete).toBe(true);
    expect(outcome.released).toEqual(['TASK-002', 'TASK-003']);
    for (const entry of (await store.loadRun(run.runId)).tasks) {
      if (entry.id === 'TASK-001') {
        expect(entry.attempts).toBe(2);
      } else {
        expect(entry).toMatchObject({ state: 'completed', attempts: 1, infrastructureFailures: 0 });
      }
    }
  });

  it('does not release a dependent while its dependency is still failed', async () => {
    const { store, run } = await harness();
    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    const { executor, executed } = fakeExecutor();
    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'failed', 'TASK-002': 'blocked' },
      {},
      { 'TASK-002': 'dependency' },
    );

    expect(executed).toEqual([]);
    expect(outcome.states['TASK-002']).toBe('blocked');
    expect(outcome.released).toEqual([]);
  });

  it('does not release a dependency-blocked task whose dependency fails again mid-recovery', async () => {
    const { store, run } = await harness();
    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        task('TASK-001'),
        task('TASK-002', ['TASK-001']),
        task('TASK-003', ['TASK-002']),
      ],
    });

    const failed = fakeExecutor({ 'TASK-001': 'failed' });
    await new Scheduler({ store, executor: failed.executor }).run(plan, run.runId, 'SDD');

    // `retry TASK-001` before the resume, as the CLI would.
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === 'TASK-001' ? { ...task, state: 'queued', blockReason: undefined } : task,
      ),
    }));

    const { executor, executed } = fakeExecutor({ 'TASK-002': 'failed' });
    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'queued', 'TASK-002': 'blocked', 'TASK-003': 'blocked' },
      {},
      { 'TASK-002': 'dependency', 'TASK-003': 'dependency' },
    );

    // TASK-002 releases after TASK-001, then fails again — so TASK-003 stays
    // blocked behind a dependency that is failed, not completed.
    expect(executed).toEqual(['TASK-001', 'TASK-002']);
    expect(outcome.states['TASK-002']).toBe('failed');
    expect(outcome.states['TASK-003']).toBe('blocked');
    expect(outcome.released).toEqual(['TASK-002']);
  });

  it('never auto-releases an agent-BLOCKED task (§23)', async () => {
    // The other half of the provenance split: a task whose *own* agent answered
    // BLOCKED must not be reopened by the same recovery that releases a
    // dependency-derived block — retrying it silently would retry the guess §23
    // exists to prevent.
    const { store, run } = await harness();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });

    const blocked = fakeExecutor({ 'TASK-001': 'blocked' });
    const first = await new Scheduler({ store, executor: blocked.executor }).run(
      plan,
      run.runId,
      'SDD',
    );
    expect(first.haltedBy).toContain('blocked');
    await expect(store.loadRun(run.runId)).resolves.toMatchObject({
      tasks: [{ id: 'TASK-001', state: 'blocked', blockReason: 'agent' }],
    });

    const { executor, executed } = fakeExecutor();
    const second = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'blocked' },
      {},
      { 'TASK-001': 'agent' },
    );

    expect(executed).toEqual([]);
    expect(second.states['TASK-001']).toBe('blocked');
    expect(second.released).toEqual([]);
  });

  it('treats a blocked task with no recorded reason as agent-blocked (fail-closed)', async () => {
    // State written before this provenance existed has no `blockReason` on disk.
    // Absence is evidence of nothing, so such a task is held rather than guessed
    // at — never auto-released, force-gated, exactly like an agent-BLOCKED one.
    const { store, run } = await harness();
    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    const { executor, executed } = fakeExecutor();
    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'queued', 'TASK-002': 'blocked' },
      {},
      {},
    );

    expect(executed).toEqual(['TASK-001']);
    expect(outcome.states['TASK-002']).toBe('blocked');
    expect(outcome.released).toEqual([]);
  });
});

describe('resume', () => {
  it('does not re-run tasks already completed', async () => {
    // Closing the terminal mid-run is normal; paying twice for finished work
    // is not.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'completed',
    });

    expect(executed).toEqual(['TASK-002']);
  });

  it('does not silently re-run a task that failed', async () => {
    // Resuming must not become an automatic retry loop. §23 makes retry
    // explicit and bounded, so the scheduler leaves a failure alone and the
    // `retry` command is what resets the state.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'failed',
    });

    expect(executed).toEqual([]);
    expect(outcome.complete).toBe(false);
  });

  it('runs a task that was explicitly reset to queued', async () => {
    // What `retry` does: put the task back in the queue, then resume.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'queued',
    });

    expect(executed).toEqual(['TASK-001']);
  });
});

describe('persistence', () => {
  it('records task state after each batch, not only at the end', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor({ 'TASK-002': 'failed' });

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    const state = await store.loadRun(run.runId);
    expect(state.tasks.find((t) => t.id === 'TASK-001')?.state).toBe('completed');
    expect(state.tasks.find((t) => t.id === 'TASK-002')?.state).toBe('failed');
  });

  it('counts attempts so a retry limit can be enforced', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    const state = await store.loadRun(run.runId);
    expect(state.tasks[0]?.attempts).toBeGreaterThanOrEqual(1);
  });
});

// M2-00.2. `attempts` used to be derived from `state === 'running'` at the moment
// `persist` happened, which made it a count of *persistences that caught a task
// in flight* rather than a count of dispatches. The two agree only because a
// batch is a barrier: every task in it has left `running` by the next write. The
// counter now moves where the decision is made, so it stays a count of attempts
// whatever the dispatch shape becomes.
describe('an attempt is counted when the task is dispatched', () => {
  const attemptsOf = async (
    store: StateStore,
    runId: string,
    id: string,
  ): Promise<number | undefined> =>
    (await store.loadRun(runId)).tasks.find((task) => task.id === id)?.attempts;

  it('moves from 0 to 1 on the first dispatch', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(await attemptsOf(store, run.runId, 'TASK-001')).toBe(1);
  });

  it('does not move when the run is persisted while the task is still running', async () => {
    // The property the old derivation could not give. A write that happens for
    // some other reason — another task finishing, a degradation being recorded —
    // must not spend one of the task's attempts.
    const { store, run } = await harness();

    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    }));

    let persistedMidFlight = 0;

    const executor = {
      execute: async (t: Task) => {
        // Anything at all writing to the run while this task is in flight.
        await store.updateRun(run.runId, (state) => ({ ...state, stage: 'implementation' }));
        persistedMidFlight += 1;
        return result(t.id, 'completed');
      },
    } as unknown as TaskExecutor;

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'queued',
    });

    expect(persistedMidFlight).toBe(1);
    // One dispatch happened in this invocation, on top of the attempt already
    // recorded. Two, not three.
    expect(await attemptsOf(store, run.runId, 'TASK-001')).toBe(2);
  });

  it('does not spend a second attempt when a persisted state still says running', async () => {
    // The seam the old derivation got wrong, driven directly.
    //
    // `persist` recomputed `attempts` for every task whose state it was about to
    // write, incrementing wherever it saw `running`. Under the batch barrier no
    // production path reaches that — every task in a batch has left `running` by
    // the time the batch is written — so the fault was latent rather than live.
    // It stops being latent the moment dispatch overlaps a write, which is the
    // shape any rolling dispatch has.
    //
    // This is one dispatch. Whatever else is persisted about the task, it must
    // stay one attempt.
    const { store, run } = await harness();

    const executor = {
      execute: async (t: Task) => result(t.id, 'running'),
    } as unknown as TaskExecutor;

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(await attemptsOf(store, run.runId, 'TASK-001')).toBe(1);
  });

  it('leaves the count alone once the task has finished', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001'), task('TASK-002')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    // TASK-001 finished in the first wave and TASK-002 in the second, so the
    // run was persisted several times after TASK-001 was already done.
    expect(await attemptsOf(store, run.runId, 'TASK-001')).toBe(1);
    expect(await attemptsOf(store, run.runId, 'TASK-002')).toBe(1);
  });

  it('spends a second attempt on a task recovered from a dead process', async () => {
    // The attempt the crashed process spent still counts — that is what bounds
    // recovery — and the redispatch spends the next one.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    }));

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({ store, executor, maxAttempts: 3 }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'running' },
    );

    expect(outcome.recovered).toEqual(['TASK-001']);
    expect(executed).toEqual(['TASK-001']);
    expect(await attemptsOf(store, run.runId, 'TASK-001')).toBe(2);
  });

  it('counts exactly one attempt per task in a batch', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001'), task('TASK-002')] });
    await new Scheduler({ store, executor, maxConcurrency: 2 }).run(plan, run.runId, 'SDD');

    expect(await attemptsOf(store, run.runId, 'TASK-001')).toBe(1);
    expect(await attemptsOf(store, run.runId, 'TASK-002')).toBe(1);
  });

  it('does not spend an attempt on a task that was never dispatched', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      {},
      { only: new Set(['TASK-001']) },
    );

    expect(await attemptsOf(store, run.runId, 'TASK-001')).toBe(1);
    expect(await attemptsOf(store, run.runId, 'TASK-002')).toBe(0);
  });
});

describe('progress reporting', () => {
  it('reports each task starting and finishing', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const started: string[] = [];
    const finished: string[] = [];

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({
      store,
      executor,
      onTaskStart: (id) => started.push(id),
      onTaskFinish: (r) => finished.push(r.task),
    }).run(plan, run.runId, 'SDD');

    expect(started).toEqual(['TASK-001']);
    expect(finished).toEqual(['TASK-001']);
  });
});

describe('an interrupted task is recoverable (V-03 regression)', () => {
  // Was a defect: the scheduler persists `running` before invoking an agent, so
  // a process killed in between left a task looking in-flight forever.
  // `readyTasks` admits only `queued` and `ready`, so the orphan could never be
  // scheduled again — the run made no further progress while reporting no
  // failure at all.
  //
  // `interrupted` is a state of its own rather than `failed`, because nothing
  // failed: the machine stopped. Collapsing the two would make the audit trail
  // lie about what happened.

  it('requeues a task left behind by a dead process', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'running',
    });

    expect(outcome.recovered).toEqual(['TASK-001']);
    expect(executed).toEqual(['TASK-001']);
    expect(outcome.complete).toBe(true);
  });

  it('records the recovery, so a silent restart is not indistinguishable from never stopping', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'running',
    });

    const events = await store.readEvents(run.runId);
    const recovery = events.find((event) => event.type === 'task_interrupted');

    expect(recovery?.detail['task']).toBe('TASK-001');
    expect(recovery?.detail['requeued']).toBe(true);
  });

  it('leaves work that was already finished alone', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'completed',
      'TASK-002': 'running',
    });

    expect(executed).toEqual(['TASK-002']);
  });

  it('stops requeueing once the attempt limit is reached (§23)', async () => {
    // The bound that keeps recovery from becoming an unbounded retry loop. The
    // attempt counter moved when the attempt began, so a task that keeps dying
    // eventually needs a person rather than another try.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 2, infrastructureFailures: 0 }],
    }));

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({ store, executor, maxAttempts: 2 }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'running' },
    );

    expect(executed).toEqual([]);
    expect(outcome.states['TASK-001']).toBe('interrupted');
    expect(outcome.recovered).toEqual([]);
  });

  it('says why it gave up', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 5, infrastructureFailures: 0 }],
    }));

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor, maxAttempts: 2 }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'running',
    });

    const events = await store.readEvents(run.runId);
    const recovery = events.find((event) => event.type === 'task_interrupted');

    expect(recovery?.detail['requeued']).toBe(false);
    expect(String(recovery?.detail['reason'])).toContain('attempt limit');
  });

  it('does nothing when no task was interrupted', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(outcome.recovered).toEqual([]);
    const events = await store.readEvents(run.runId);
    expect(events.map((event) => event.type)).not.toContain('task_interrupted');
  });
});

// Regression suite — was `[DEFECT] AF-R03` in test/reanalysis.repro.test.ts.
// `complete` used to mean "every task in the plan finished", so running one
// task successfully reported failure and exited non-zero. A script driving a
// plan one task at a time could never make progress.
describe('a run is judged against what it was asked to do', () => {
  it('is complete when the only requested task finished', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002'), task('TASK-003')],
    });

    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      {},
      { only: new Set(['TASK-002']) },
    );

    expect(outcome.states['TASK-002']).toBe('completed');
    expect(outcome.complete).toBe(true);
  });

  it('does not call the plan complete when other tasks are still queued', async () => {
    // The two answers must not collapse into one: the invocation succeeded and
    // the plan is unfinished, and only the second gates review.
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002')],
    });

    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      {},
      { only: new Set(['TASK-001']) },
    );

    expect(outcome.complete).toBe(true);
    expect(outcome.planComplete).toBe(false);
  });

  it('is not complete when the requested task itself failed', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor({ 'TASK-002': 'failed' });

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002')],
    });

    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      {},
      { only: new Set(['TASK-002']) },
    );

    expect(outcome.complete).toBe(false);
  });

  it('is not complete when the requested task never became ready', async () => {
    // Narrowing the set of tasks allowed to start does not waive dependencies.
    // Nothing ran, so nothing succeeded — however small the request was.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    const outcome = await new Scheduler({ store, executor }).run(
      plan,
      run.runId,
      'SDD',
      {},
      { only: new Set(['TASK-002']) },
    );

    expect(executed).toEqual([]);
    expect(outcome.complete).toBe(false);
  });

  it('still means the whole plan when nothing was narrowed', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002')],
    });

    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(outcome.complete).toBe(true);
    expect(outcome.planComplete).toBe(true);
  });
});

// AF-R06. The §22 machine is enforced by the store now, and enforcement is only
// worth anything on a run whose tasks are already on disk — which is every real
// run, and was no test until this one.
describe('recovery obeys the state machine on a persisted run', () => {
  it('moves an orphan through interrupted rather than straight back to queued', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });

    // What a killed process leaves behind: persisted, not merely passed in.
    await store.updateRun(run.runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'running',
    });

    expect(outcome.recovered).toEqual(['TASK-001']);
    expect(executed).toEqual(['TASK-001']);
    expect(outcome.states['TASK-001']).toBe('completed');
  });

  it('leaves an orphan past its attempt limit interrupted', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });

    await store.updateRun(run.runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 3, infrastructureFailures: 0 }],
    }));

    const outcome = await new Scheduler({ store, executor, maxAttempts: 3 }).run(
      plan,
      run.runId,
      'SDD',
      { 'TASK-001': 'running' },
    );

    expect(executed).toEqual([]);
    expect(outcome.states['TASK-001']).toBe('interrupted');
  });
});

describe('workspace preparation, per dispatched attempt (M2-04 §8)', () => {
  // The ordering M2-00.2 fixed and this milestone must not disturb: the attempt
  // is spent by the dispatch, *then* the workspace is prepared, *then* the agent
  // runs. A refusal therefore costs an attempt and produces no agent call.

  /** A `TaskWorkspaces` stand-in that answers without touching Git. */
  function workspaces(answer: 'ok' | { phase: 'checkout' | 'setup'; changes: string[] }) {
    const asked: { taskId: string; attempt: number }[] = [];
    const service = {
      prepare: async (request: { taskId: string; attempt: number }) => {
        asked.push({ taskId: request.taskId, attempt: request.attempt });
        if (answer === 'ok') {
          return {
            ok: true as const,
            workspace: {
              path: '/tmp/workspace',
              attempt: request.attempt,
              isolation: {
                base: 'a'.repeat(40),
                branch: `agent-flow/AF-2026-001-0f3a91c4bd27e615/${request.taskId}/attempt-1`,
                relativePath: `repo-x/AF-2026-001-0f3a91c4bd27e615/${request.taskId}/attempt-1`,
              },
            },
          };
        }
        return {
          ok: false as const,
          failure: {
            code: 'task_workspace_preparation_failed' as const,
            phase: answer.phase,
            changes: answer.changes,
            detail: 'the install command changed files that are tracked or not ignored',
            at: '2026-01-01T00:00:00.000Z',
          },
        };
      },
    };
    return { service, asked };
  }

  it('prepares after the attempt is spent and before the agent runs', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();
    const prepared = workspaces('ok');

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const scheduler = new Scheduler({
      store,
      executor,
      workspaces: prepared.service as never,
    });

    await scheduler.run(plan, run.runId, 'SDD');

    // The attempt the workspace was asked for is the one the dispatch spent.
    expect(prepared.asked).toEqual([{ taskId: 'TASK-001', attempt: 1 }]);
    expect(executed).toEqual(['TASK-001']);
    expect((await store.loadRun(run.runId)).tasks[0]?.attempts).toBe(1);
  });

  it('records the workspace without an absolute path', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const prepared = workspaces('ok');

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor, workspaces: prepared.service as never }).run(
      plan,
      run.runId,
      'SDD',
    );

    const created = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'task_workspace_created',
    );
    expect(created).toBeDefined();
    expect(created?.detail['branch']).toContain('TASK-001/attempt-1');
    // §21.3: no filesystem path in an event, ever.
    expect(JSON.stringify(created?.detail)).not.toContain('/tmp/workspace');
  });

  it('fails the task without invoking the agent when preparation refuses', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();
    const prepared = workspaces({ phase: 'setup', changes: ['package-lock.json'] });

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      workspaces: prepared.service as never,
    }).run(plan, run.runId, 'SDD');

    // The agent is not invoked, which is the point of §8.3: an agent that starts
    // in a dirty workspace produces a validated tree containing changes nobody
    // attributed to the task.
    expect(executed).toEqual([]);

    const state = await store.loadRun(run.runId);
    expect(state.tasks[0]?.state).toBe('failed');
    // Spent: the counter moved at dispatch and a refusal does not give it back.
    expect(state.tasks[0]?.attempts).toBe(1);

    // The halt reason names the task and the phase, so a person is not left
    // reading "not all tasks completed" with nothing to act on.
    expect(outcome.haltedBy).toContain('TASK-001');
    expect(outcome.haltedBy).toContain('setup');

    const failure = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'task_workspace_preparation_failed',
    );
    expect(failure?.detail['phase']).toBe('setup');
    expect(failure?.detail['changes']).toEqual(['package-lock.json']);
  });

  it('invents no TaskResult for an attempt that never executed', async () => {
    // `TaskResult` records *what ran* — the runner, the model, the reasoning
    // level, the validation it went through. A refused workspace ran nothing, so
    // every one of those fields would have to be made up, and the artifact
    // everything downstream reads as evidence would be carrying a fiction.
    //
    // Two tasks in one wave, one refused and one executed, because "no
    // `result.json` was written" is worth nothing on its own: a fake executor
    // writes none either, so the assertion would be green against a scheduler
    // that fabricated results and a test bench that could not tell. The sibling
    // is the positive control — it writes one the same way `TaskExecutor` does,
    // through the same `runPaths`, so the absence next to it means something.
    const { store, run, fs } = await harness();
    const finished: TaskResult[] = [];
    const executed: string[] = [];

    const resultPath = (taskId: string): string =>
      runPaths(PROJECT, run.runId).taskResult(taskId);

    const executor = {
      execute: async (t: Task) => {
        executed.push(t.id);
        const produced = result(t.id, 'completed');
        await fs.mkdirp(`${PROJECT}/.agent-flow/runs/${run.runId}/tasks/${t.id}`);
        await fs.writeFileAtomic(resultPath(t.id), JSON.stringify(produced));
        return produced;
      },
    } as unknown as TaskExecutor;

    const refused = { phase: 'setup' as const, changes: ['package-lock.json'] };
    const service = {
      prepare: async (request: { taskId: string; attempt: number }) =>
        request.taskId === 'TASK-001'
          ? {
              ok: false as const,
              failure: {
                code: 'task_workspace_preparation_failed' as const,
                ...refused,
                detail: 'the install command changed files that are tracked or not ignored',
                at: '2026-01-01T00:00:00.000Z',
              },
            }
          : {
              ok: true as const,
              workspace: { path: '/tmp/workspace', attempt: request.attempt },
            },
    };

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002')],
    });
    const outcome = await new Scheduler({
      store,
      executor,
      workspaces: service as never,
      maxConcurrency: 2,
      onTaskFinish: (entry) => finished.push(entry),
    }).run(plan, run.runId, 'SDD');

    // The refused task: no agent, no result anywhere.
    expect(executed).not.toContain('TASK-001');
    expect(outcome.results.map((entry) => entry.task)).toEqual(['TASK-002']);
    expect(finished.map((entry) => entry.task)).toEqual(['TASK-002']);
    expect(await store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
    expect(await fs.exists(resultPath('TASK-001'))).toBe(false);

    // The control: the same wave, the same bench, and a result really does appear
    // when something really did run.
    expect(executed).toContain('TASK-002');
    expect(await fs.exists(resultPath('TASK-002'))).toBe(true);
    expect((await store.readTaskResult(run.runId, 'TASK-002'))?.task).toBe('TASK-002');

    // And the state machine still moved: the record is the task state plus the
    // event, not a synthesised result.
    const state = await store.loadRun(run.runId);
    expect(state.tasks.find((entry) => entry.id === 'TASK-001')?.state).toBe('failed');
    expect(outcome.complete).toBe(false);
    expect(outcome.planComplete).toBe(false);
    // §9.2: the wave completed before the run halted, so the sibling's work was
    // not thrown away because a peer was refused.
    expect(state.tasks.find((entry) => entry.id === 'TASK-002')?.state).toBe('completed');
    expect(outcome.haltedBy).toContain('TASK-001');
  });

  it('reports a checkout refusal as its own phase', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();
    const prepared = workspaces({ phase: 'checkout', changes: ['content.txt'] });

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      workspaces: prepared.service as never,
    }).run(plan, run.runId, 'SDD');

    expect(executed).toEqual([]);
    expect(outcome.haltedBy).toContain('checkout');
    const failure = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'task_workspace_preparation_failed',
    );
    expect(failure?.detail['phase']).toBe('checkout');
  });

  it('writes exactly the four keys Appendix B specifies, and no more', async () => {
    // A closed shape, asserted by key set rather than by presence. `detail` lived
    // here once and read as harmless; it carried the install command's output,
    // which names the absolute directory it ran in. The general rule is worth
    // more than the specific fix: a field the Appendix does not describe has no
    // business in a persisted event, whatever it happens to contain today.
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const prepared = workspaces({ phase: 'setup', changes: ['package-lock.json'] });

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor, workspaces: prepared.service as never }).run(
      plan,
      run.runId,
      'SDD',
    );

    const failure = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'task_workspace_preparation_failed',
    );
    expect(failure).toBeDefined();
    expect(Object.keys(failure?.detail ?? {}).sort()).toEqual([
      'attempt',
      'changes',
      'phase',
      'task',
    ]);

    // And the sibling event, for the same reason.
    const okPrepared = workspaces('ok');
    const second = await harness();
    await new Scheduler({
      store: second.store,
      executor,
      workspaces: okPrepared.service as never,
    }).run(plan, second.run.runId, 'SDD');

    const created = (await second.store.readEvents(second.run.runId)).find(
      (event) => event.type === 'task_workspace_created',
    );
    expect(Object.keys(created?.detail ?? {}).sort()).toEqual([
      'attempt',
      'base',
      'branch',
      'task',
    ]);
  });

  it('runs unchanged when no workspace service is wired', async () => {
    // Every caller predating M2-04, and every sequential run.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD');

    expect(executed).toEqual(['TASK-001']);
  });
});

describe('a validated attempt is not a completed task (M2-06 §14.4, I-3)', () => {
  // The invariant the whole milestone turns on. The executor still returns a
  // `TaskResult` whose status is `completed` — that is `judgeValidation`'s verdict
  // on one local execution (I-4) — and in worktree mode the scheduler must not
  // treat it as an outcome. A task is completed when its marker is merged, and
  // releasing a dependent any earlier builds it against a branch that does not
  // contain the work it depends on.

  /** An Integrator stand-in that records what it was asked and answers scripted. */
  function integrator(
    answers: Record<string, 'integrated' | 'refused'> = {},
    preparation: 'ready' | 'sequential' | 'refused' = 'ready',
  ) {
    const waves: { task: string; attempt: number }[][] = [];
    const workspace = { path: '/worktrees/integration', branch: 'agent-flow/k/integration', head: 'b'.repeat(40) };
    let bases = 0;

    const service = {
      prepare: async () =>
        preparation === 'ready'
          ? { kind: 'ready' as const, workspace }
          : preparation === 'sequential'
            ? { kind: 'sequential' as const }
            : {
                kind: 'refused' as const,
                refusal: { code: 'git_run_key_collision' as const, detail: 'somebody else’s refs' },
              },

      waveBase: async () => {
        bases += 1;
        return 'b'.repeat(40);
      },

      integrate: async (request: {
        attempts: readonly { task: string; attempt: number; result: TaskResult }[];
      }) => {
        waves.push(request.attempts.map(({ task, attempt }) => ({ task, attempt })));

        const outcomes = request.attempts.map((entry) =>
          (answers[entry.task] ?? 'integrated') === 'integrated'
            ? {
                kind: 'integrated' as const,
                task: entry.task,
                state: 'completed' as const,
                result: entry.result,
              }
            : {
                kind: 'refused' as const,
                task: entry.task,
                state: 'review_required' as const,
                refusal: {
                  code: 'integration_conflict' as const,
                  detail: `${entry.task} conflicts`,
                },
              },
        );

        const refused = outcomes.find((outcome) => outcome.kind === 'refused');
        return {
          outcomes,
          ...(refused === undefined
            ? {}
            : { haltedBy: `${refused.task} could not be integrated: integration_conflict` }),
        };
      },
    };

    return { service, waves, wavesOfBases: () => bases };
  }

  /** A workspace service that hands back an isolated workspace and records its base. */
  function isolatedWorkspaces() {
    const bases: string[] = [];
    const service = {
      prepare: async (request: { taskId: string; attempt: number; base?: string }) => {
        bases.push(request.base ?? '(none)');
        return {
          ok: true as const,
          workspace: {
            path: `/worktrees/${request.taskId}`,
            attempt: request.attempt,
            isolation: {
              base: request.base ?? '',
              branch: `agent-flow/k/${request.taskId}/attempt-${String(request.attempt)}`,
              relativePath: `repo/k/${request.taskId}/attempt-${String(request.attempt)}`,
            },
          },
        };
      },
    };
    return { service, bases };
  }

  it('completes a task only after the Integrator says the merge happened', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const integration = integrator();
    const workspaces = isolatedWorkspaces();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      workspaces: workspaces.service as never,
      integrator: integration.service as never,
    }).run(plan, run.runId, 'SDD');

    // The attempt reached the Integrator, and the state came back from it.
    expect(integration.waves).toEqual([[{ task: 'TASK-001', attempt: 1 }]]);
    expect(outcome.states['TASK-001']).toBe('completed');
    expect((await store.loadRun(run.runId)).tasks[0]?.state).toBe('completed');
  });

  /** A reviewer that records what it was asked to review. */
  function recordingReviewer() {
    const reviewed: { task: string; tree: string | undefined }[] = [];
    return {
      reviewed,
      service: {
        review: async (_runId: string, task: Task, result: TaskResult) => {
          reviewed.push({ task: task.id, tree: result.integration?.mergeCommit });
        },
      },
    };
  }

  it('reviews each change after it integrates, and not before (M6-03)', async () => {
    // **The wiring, asserted rather than assumed.** The service's own tests cover what a
    // review does; this covers that one happens — and the first version of this code
    // passed every one of those while the scheduler called nothing.
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const integration = integrator();
    const workspaces = isolatedWorkspaces();
    const reviewer = recordingReviewer();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001'), task('TASK-002')] });
    await new Scheduler({
      store,
      executor,
      maxConcurrency: 2,
      workspaces: workspaces.service as never,
      integrator: integration.service as never,
      reviewer: reviewer.service,
    }).run(plan, run.runId, 'SDD');

    expect(reviewer.reviewed.map((entry) => entry.task).sort()).toEqual(['TASK-001', 'TASK-002']);
  });

  it('does not review a task the merge refused', async () => {
    // A change that is not on the branch is not a change anybody can review — I-41 says
    // a review names the tree it read, and a refused merge produced none.
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const integration = integrator({ 'TASK-001': 'refused' });
    const workspaces = isolatedWorkspaces();
    const reviewer = recordingReviewer();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({
      store,
      executor,
      workspaces: workspaces.service as never,
      integrator: integration.service as never,
      reviewer: reviewer.service,
    }).run(plan, run.runId, 'SDD');

    expect(reviewer.reviewed).toEqual([]);
  });

  it('runs exactly as before when no reviewer is wired', async () => {
    // Every configuration written before M6, and every team with nobody who reviews.
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const integration = integrator();
    const workspaces = isolatedWorkspaces();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      workspaces: workspaces.service as never,
      integrator: integration.service as never,
    }).run(plan, run.runId, 'SDD');

    expect(outcome.states['TASK-001']).toBe('completed');
  });

  it('leaves an unintegrated task out of completed, and halts', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const integration = integrator({ 'TASK-001': 'refused' });
    const workspaces = isolatedWorkspaces();

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      workspaces: workspaces.service as never,
      integrator: integration.service as never,
    }).run(plan, run.runId, 'SDD');

    expect(outcome.states['TASK-001']).toBe('review_required');
    expect(outcome.haltedBy).toContain('integration_conflict');
    expect((await store.loadRun(run.runId)).tasks[0]?.state).toBe('review_required');
  });

  it('releases no dependent before its dependency was merged', async () => {
    // The failure this exists to prevent is silent: a dependent's worktree cut
    // from a branch that does not hold its dependency's work builds against code
    // that is not there, and nothing notices for three more tasks.
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();
    const workspaces = isolatedWorkspaces();

    const dispatchedBeforeMerge: string[][] = [];
    const integration = integrator();
    const watching = {
      ...integration.service,
      integrate: async (request: Parameters<typeof integration.service.integrate>[0]) => {
        dispatchedBeforeMerge.push([...executed]);
        return integration.service.integrate(request);
      },
    };

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    await new Scheduler({
      store,
      executor,
      workspaces: workspaces.service as never,
      integrator: watching as never,
    }).run(plan, run.runId, 'SDD');

    // Two waves, and at the moment the first integration began only the first
    // task had been dispatched at all.
    expect(dispatchedBeforeMerge).toEqual([['TASK-001'], ['TASK-001', 'TASK-002']]);
    expect(executed).toEqual(['TASK-001', 'TASK-002']);
  });

  it('cuts each wave from the base the Integrator reports, once per wave', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const integration = integrator();
    const workspaces = isolatedWorkspaces();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });

    await new Scheduler({
      store,
      executor,
      workspaces: workspaces.service as never,
      integrator: integration.service as never,
    }).run(plan, run.runId, 'SDD');

    expect(workspaces.bases).toEqual(['b'.repeat(40), 'b'.repeat(40)]);
    // Read once per wave, not once per task: every task in a wave is cut from
    // one commit (§9.1 step 1).
    expect(integration.wavesOfBases()).toBe(2);
  });

  it('dispatches nothing when the namespace cannot be prepared', async () => {
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();
    const integration = integrator({}, 'refused');

    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      integrator: integration.service as never,
    }).run(plan, run.runId, 'SDD');

    expect(executed).toEqual([]);
    expect(outcome.haltedBy).toContain('git_run_key_collision');
    expect(outcome.complete).toBe(false);
  });

  it('behaves exactly as before for a run the Integrator calls sequential', async () => {
    // §25.1. The Integrator is wired unconditionally and answers `sequential` for
    // a run whose `isolationMode` is not `worktree`, so the mode is a property of
    // the run rather than of the wiring (I-13).
    const { store, run } = await harness();
    const { executor, executed } = fakeExecutor();
    const integration = integrator({}, 'sequential');

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002', ['TASK-001'])],
    });
    const outcome = await new Scheduler({
      store,
      executor,
      integrator: integration.service as never,
    }).run(plan, run.runId, 'SDD');

    expect(executed).toEqual(['TASK-001', 'TASK-002']);
    expect(outcome.states['TASK-001']).toBe('completed');
    expect(outcome.planComplete).toBe(true);
    // Nothing was offered for integration, because there is nothing to integrate.
    expect(integration.waves).toEqual([]);
  });

  it('integrates a satisfied sibling even when a peer failed (§9.2)', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor({ 'TASK-001': 'failed' });
    const integration = integrator();
    const workspaces = isolatedWorkspaces();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002')],
    });
    const outcome = await new Scheduler({
      store,
      executor,
      workspaces: workspaces.service as never,
      integrator: integration.service as never,
      maxConcurrency: 2,
    }).run(plan, run.runId, 'SDD');

    // B's work was already paid for and already validated. Discarding it because
    // A failed would make the outcome depend on which task finished first.
    expect(integration.waves).toEqual([[{ task: 'TASK-002', attempt: 1 }]]);
    expect(outcome.states['TASK-002']).toBe('completed');
    expect(outcome.states['TASK-001']).toBe('failed');
    expect(outcome.haltedBy).toContain('TASK-001');
  });
});

describe('what a refused workspace writes to disk (§7.2, §21.3)', () => {
  // The two halves of this guarantee are tested separately — preparation produces
  // a path-free refusal, and the scheduler copies its fields into an event — and
  // separately is not enough. The claim is about `events.jsonl`, so this is the
  // real scheduler, the real `TaskWorkspaces`, real Git and a real install that
  // rewrites a tracked file, with the assertion made against what was persisted.

  let repo: TempRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  it('names no absolute path anywhere in the run record', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('package-lock.json', '{"lockfileVersion":3}\n');
    const base = repo.commitAll('a lockfile');

    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    // Through `createRun`, because it is the only writer of these three (I-13).
    const run = await store.createRun('f', (runId) => ({
      isolationMode: 'worktree' as const,
      planningBase: base,
      gitRunKey: `${runId}-0f3a91c4bd27e615`,
    }));

    const workspaces = new TaskWorkspaces({
      workspaces: repo.workspaces,
      fs: new NodeFileSystem(),
      host: new FakeHost(1000, 'test-host', [1000], repo.home),
      projectDir: repo.dir,
      processRunner: new NodeProcessRunner(),
      config: {
        global: {},
        // `pwd` on stdout as well, so a leak has two routes to take.
        project: { commands: { install: 'pwd && echo rewritten > package-lock.json' } },
      } as unknown as EffectiveConfig,
      clock: new FixedClock(),
    });

    const { executor, executed } = fakeExecutor();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [task('TASK-001')] });
    await new Scheduler({ store, executor, workspaces }).run(plan, run.runId, 'SDD');

    expect(executed).toEqual([]);

    const events = await store.readEvents(run.runId);
    const refusal = events.find((event) => event.type === 'task_workspace_preparation_failed');
    expect(refusal).toBeDefined();
    expect(refusal?.detail['phase']).toBe('setup');
    // Repository-relative and bounded, against a real `git status` (§8.3).
    expect(refusal?.detail['changes']).toEqual(['package-lock.json']);
    // The closed shape, asserted here too rather than only against the fake: this
    // is the path that actually runs Git and a real install, and it is the one a
    // fifth key would slip back in through.
    expect(Object.keys(refusal?.detail ?? {}).sort()).toEqual([
      'attempt',
      'changes',
      'phase',
      'task',
    ]);

    // Nothing executed, so there is nothing to have produced a result.
    expect(await store.readTaskResult(run.runId, 'TASK-001')).toBeNull();

    // Retained and still locked (§7.4). The `--force` removal the `doctor` probe
    // uses is deliberately not reachable from here: this worktree is the only
    // remaining copy of what the checkout and the install produced, and it is the
    // evidence explaining the refusal. Reclaiming it is M2-09's.
    const listed = repo.userGit(['worktree', 'list', '--porcelain']);
    const record = listed.split('\n\n').find((block) => block.includes('TASK-001')) ?? '';
    expect(record).not.toBe('');
    expect(record).toContain('locked agent-flow');
    // The attempt branch survives too, at the base it was cut from.
    expect(repo.userGit(['rev-parse', `agent-flow/${run.runId}-0f3a91c4bd27e615/TASK-001/attempt-1`]).trim()).toBe(base);

    // The whole record, not just the one event: the state file is written by the
    // same dispatch and a leak there would be just as durable.
    const persisted = JSON.stringify(events) + JSON.stringify(await store.loadRun(run.runId));
    for (const absolute of [repo.dir, repo.home, repo.worktreeRoot]) {
      expect(persisted, `an absolute path reached the run record: ${absolute}`).not.toContain(
        absolute,
      );
    }
    // A control: the assertion above is worthless if the paths were never
    // plausible strings to find. The install genuinely printed one.
    expect(repo.worktreeRoot.startsWith('/')).toBe(true);
  });
});

/**
 * AD-43 layer 2 and C-17 (AR-06) — no wave contains two tasks that fight over a file.
 *
 * `checkPlan` reports the hazard at planning time; this is the enforcement, and the two
 * answer different questions. Layer 1 rejects a plan that is wrong on paper. This protects
 * a plan that is *right* on paper but whose tasks became ready together anyway — a retry
 * reorders readiness, and two tasks the plan kept apart can arrive in one pass.
 */
/**
 * A team narrows the same wave further (M5-07, §29–§33).
 *
 * **The scheduler is unchanged in what it decides.** These tests exist to prove that the
 * constraint reaches the loop and is recorded, not to re-test the constraint itself —
 * `test/core/team/waves.test.ts` owns the rules. What is proved here is the wiring: a
 * deferral costs one wave, both tasks still run, and the audit trail says why.
 */
describe('a wave a team narrowed (M5-07)', () => {
  const withFiles = (id: string, files: string[]) => ({
    ...task(id),
    files: { likely: files },
  });

  /** Defers anything that would join a wave already holding something. */
  const oneAtATime =
    (reason: 'capacity' | 'ownership') =>
    (candidate: Task, inWave: readonly Task[]) =>
      inWave.length === 0
        ? undefined
        : {
            reason,
            detail: `${candidate.id} waits`,
            ...(reason === 'ownership'
              ? { waitsFor: inWave[0]?.id ?? '', patterns: ['src/db/**'] }
              : { agents: ['solo'] }),
          };

  it('runs both tasks, one wave apart, when capacity holds one back', async () => {
    // Narrowing delays; it never drops work. The same property AD-43 has for overlap.
    const { store, run } = await harness();
    const { executor, peak } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [withFiles('TASK-001', ['src/a.ts']), withFiles('TASK-002', ['src/b.ts'])],
    });

    await new Scheduler({
      store,
      executor,
      maxConcurrency: 3,
      waveAdmission: oneAtATime('capacity'),
    }).run(plan, run.runId, 'SDD');

    expect((await store.loadRun(run.runId)).tasks.map((entry) => entry.state)).toEqual([
      'completed',
      'completed',
    ]);
    expect(peak()).toBe(1);
  });

  it('records the members that were full', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [withFiles('TASK-001', ['src/a.ts']), withFiles('TASK-002', ['src/b.ts'])],
    });

    await new Scheduler({
      store,
      executor,
      maxConcurrency: 3,
      waveAdmission: oneAtATime('capacity'),
    }).run(plan, run.runId, 'SDD');

    const deferred = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'wave_deferred_for_capacity',
    );

    expect(deferred?.detail).toMatchObject({ task: 'TASK-002', agents: ['solo'] });
  });

  it('records the contended area and what the task waits behind', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [withFiles('TASK-001', ['src/db/a.sql']), withFiles('TASK-002', ['src/db/b.sql'])],
    });

    await new Scheduler({
      store,
      executor,
      maxConcurrency: 3,
      waveAdmission: oneAtATime('ownership'),
    }).run(plan, run.runId, 'SDD');

    const deferred = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'wave_deferred_for_ownership',
    );

    expect(deferred?.detail).toMatchObject({
      task: 'TASK-002',
      waitsFor: 'TASK-001',
      patterns: ['src/db/**'],
    });
  });

  it('is never asked about a task file overlap already held back', async () => {
    // Overlap is unconditional and comes first, so the reason recorded for an
    // overlapping pair stays the one AD-43 gives. A team cannot relabel it.
    const { store, run } = await harness();
    const { executor } = fakeExecutor();
    const asked: { candidate: string; inWave: string[] }[] = [];

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [withFiles('TASK-001', ['src/same.ts']), withFiles('TASK-002', ['src/same.ts'])],
    });

    await new Scheduler({
      store,
      executor,
      maxConcurrency: 3,
      waveAdmission: (candidate: Task, inWave: readonly Task[]) => {
        asked.push({ candidate: candidate.id, inWave: inWave.map((held) => held.id) });
        return undefined;
      },
    }).run(plan, run.runId, 'SDD');

    const types = (await store.readEvents(run.runId)).map((event) => event.type);
    expect(types).toContain('wave_serialised_for_overlap');
    expect(types).not.toContain('wave_deferred_for_ownership');

    // TASK-002 is asked in the *next* wave, alone — never alongside the task it
    // overlaps, because overlap refused that pairing before the team was consulted.
    expect(asked).toEqual([
      { candidate: 'TASK-001', inWave: [] },
      { candidate: 'TASK-002', inWave: [] },
    ]);
  });

  it('changes nothing when none is wired', async () => {
    // Every configuration written before M5, and the reason `waveAdmission` is optional.
    const { store, run } = await harness();
    const { executor, peak } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        withFiles('TASK-001', ['src/a.ts']),
        withFiles('TASK-002', ['src/b.ts']),
        withFiles('TASK-003', ['src/c.ts']),
      ],
    });

    await new Scheduler({ store, executor, maxConcurrency: 3 }).run(plan, run.runId, 'SDD');
    expect(peak()).toBeGreaterThan(1);
  });
});

describe('a wave never contends for a file (AD-43, C-17)', () => {
  const withFiles = (id: string, files: string[], dependencies: string[] = []) => ({
    ...task(id, dependencies),
    files: { likely: files },
  });

  it('serialises two overlapping tasks that are ready together', async () => {
    const { store, run } = await harness();
    const { executor, peak } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        withFiles('TASK-001', ['test/cli/cli.test.ts']),
        withFiles('TASK-002', ['test/cli/cli.test.ts']),
      ],
    });

    await new Scheduler({ store, executor, maxConcurrency: 3 }).run(plan, run.runId, 'SDD');

    // Both ran — serialisation delays, it never drops work.
    expect((await store.loadRun(run.runId)).tasks.map((entry) => entry.state)).toEqual([
      'completed',
      'completed',
    ]);
    expect(peak()).toBe(1);
  });

  it('records why, naming both tasks and the shared path', async () => {
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        withFiles('TASK-001', ['src/shared.ts']),
        withFiles('TASK-002', ['src/shared.ts']),
      ],
    });

    await new Scheduler({ store, executor, maxConcurrency: 3 }).run(plan, run.runId, 'SDD');

    const events = await store.readEvents(run.runId);
    const serialised = events.find((event) => event.type === 'wave_serialised_for_overlap');

    expect(serialised?.detail).toMatchObject({ task: 'TASK-002', waitsFor: 'TASK-001' });
    expect(serialised?.detail?.['paths']).toEqual(['src/shared.ts']);
  });

  it('still parallelises tasks that declare different files', async () => {
    // The control. A guard that serialised everything would be indistinguishable from
    // having no parallelism at all, and would pass the test above.
    const { store, run } = await harness();
    const { executor, peak } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        withFiles('TASK-001', ['src/a.ts']),
        withFiles('TASK-002', ['src/b.ts']),
        withFiles('TASK-003', ['src/c.ts']),
      ],
    });

    await new Scheduler({ store, executor, maxConcurrency: 3 }).run(plan, run.runId, 'SDD');
    expect(peak()).toBeGreaterThan(1);
  });

  it('still parallelises tasks that declare no files at all', async () => {
    // An empty `files.likely` is "the plan did not say", not "this task touches
    // everything". Reading it as the latter would serialise every plan that omits the
    // field — which is most of them.
    const { store, run } = await harness();
    const { executor, peak } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task('TASK-001'), task('TASK-002'), task('TASK-003')],
    });

    await new Scheduler({ store, executor, maxConcurrency: 3 }).run(plan, run.runId, 'SDD');
    expect(peak()).toBeGreaterThan(1);
  });

  it('injects no dependency into the plan it was given', async () => {
    // The approved plan is a document a human read. Serialisation is a scheduling
    // decision; rewriting the plan would change what they approved.
    const { store, run } = await harness();
    const { executor } = fakeExecutor();

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [withFiles('TASK-001', ['src/x.ts']), withFiles('TASK-002', ['src/x.ts'])],
    });

    await new Scheduler({ store, executor, maxConcurrency: 3 }).run(plan, run.runId, 'SDD');

    expect(plan.tasks[1]?.dependencies).toEqual([]);
  });
});

/**
 * AR-03 — a recoverable failure recovers itself.
 *
 * `requeue` wrote `state: 'queued'` and nothing else, so a retry re-read the same task
 * description that had already failed. The system held the failing command, its exit code,
 * its stderr and the acceptance criteria, and asked the operator to explain the failure to
 * the next attempt by hand — eleven of the evidence run's sixteen manual operations
 * happened after approval, and none of them was a decision.
 */
describe('automatic retry (AR-03, C-08)', () => {
  const RECOVERY = {
    enabled: true,
    maxEnvironmentRepairs: 2,
    maxIdenticalFailures: 2,
    maxModelCallsPerTask: 4,
    maxCorrectiveRounds: 2,
    maxCorrectivePlanRepairs: 2,
    maxVerificationCycles: 3,
    maxAutonomousModelCalls: 24,
    maxPacketBytes: 8192,
    maxRawExcerptBytes: 2048,
    maxDiffStatLines: 40,
  } as const;

  /** Fails the first time with a classified validation failure, then succeeds. */
  function flakyExecutor() {
    const attempts: string[] = [];

    const executor = {
      execute: async (t: Task) => {
        attempts.push(t.id);
        const first = attempts.filter((id) => id === t.id).length === 1;
        await Promise.resolve();

        return TaskResultSchema.parse({
          task: t.id,
          status: first ? 'review_required' : 'completed',
          runner: 'fake',
          reasoning: 'medium',
          startedAt: '2026-08-09T20:00:00.000Z',
          finishedAt: '2026-08-09T20:00:01.000Z',
          ...(first ? { failureClass: 'validation_unsatisfied' } : {}),
          validation: {
            passed: !first,
            commands: first
              ? [
                  {
                    id: 'test',
                    command: 'npm test',
                    exitCode: 1,
                    durationMs: 10,
                    stdout: '',
                    stderr: 'Expected 2, received 3',
                  },
                ]
              : [],
          },
        });
      },
    } as unknown as TaskExecutor;

    return { executor, attempts };
  }

  const withCriteria = (id: string) => ({
    ...task(id),
    acceptanceCriteria: ['The suite passes.'],
    validation: ['test'],
  });

  it('requeues a recoverable failure and finishes without a human', async () => {
    const { store, run } = await harness();
    const { executor, attempts } = flakyExecutor();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });

    const outcome = await new Scheduler({
      store,
      executor,
      recoveryConfig: RECOVERY,
      maxAttempts: 3,
    }).run(plan, run.runId, 'SDD');

    expect(attempts).toEqual(['TASK-001', 'TASK-001']);
    expect(outcome.complete).toBe(true);
    expect(outcome.haltedBy).toBeUndefined();
  });

  it('does nothing at all when recovery is disabled', async () => {
    // The kill switch, and an acceptance criterion: `recovery.enabled: false` restores the
    // previous behaviour exactly. It ships false.
    const { store, run } = await harness();
    const { executor, attempts } = flakyExecutor();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });

    const outcome = await new Scheduler({
      store,
      executor,
      recoveryConfig: { ...RECOVERY, enabled: false },
      maxAttempts: 3,
    }).run(plan, run.runId, 'SDD');

    expect(attempts).toEqual(['TASK-001']);
    expect(outcome.haltedBy).toContain('TASK-001');
  });

  it('behaves identically when no recovery config is wired at all', async () => {
    const { store, run } = await harness();
    const { executor, attempts } = flakyExecutor();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });

    await new Scheduler({ store, executor, maxAttempts: 3 }).run(plan, run.runId, 'SDD');

    expect(attempts).toEqual(['TASK-001']);
  });

  it('records the decision, the packet and the step', async () => {
    const { store, run } = await harness();
    const { executor } = flakyExecutor();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });

    await new Scheduler({ store, executor, recoveryConfig: RECOVERY, maxAttempts: 3 }).run(
      plan,
      run.runId,
      'SDD',
    );

    const types = (await store.readEvents(run.runId)).map((event) => event.type);
    expect(types).toContain('recovery_started');
    expect(types).toContain('failure_context_built');
    expect(types).toContain('recovery_step_completed');
  });

  it('persists what the retry was told, beside the attempt it informs', async () => {
    // AD-40: "persisted next to the attempt it informs, so a run can always show what a
    // retry was told". Without it, "why did the second attempt do that" is answerable only
    // by re-deriving a packet from artifacts that may since have changed.
    const { fs, store, run } = await harness();
    const { executor } = flakyExecutor();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });

    await new Scheduler({
      store,
      executor,
      recoveryConfig: RECOVERY,
      maxAttempts: 3,
      fs,
      projectDir: PROJECT,
    }).run(plan, run.runId, 'SDD');

    const path = runPaths(PROJECT, run.runId).attemptContext('TASK-001', 2);
    const packet = JSON.parse(await fs.readFile(path)) as Record<string, unknown>;

    expect(packet['failureClass']).toBe('validation_unsatisfied');
    expect(JSON.stringify(packet['failedChecks'])).toContain('npm test');
    expect(JSON.stringify(packet['failedChecks'])).toContain('Expected 2, received 3');
    expect(packet['acceptanceCriteria']).toEqual(['The suite passes.']);
  });

  it('never retries a class the taxonomy says needs a person', async () => {
    // `agent_blocked` means a decision is missing, and having attempts left does not
    // conjure one. The class outranks the budget, always.
    const { store, run } = await harness();

    const executor = {
      execute: async (t: Task) =>
        TaskResultSchema.parse({
          task: t.id,
          status: 'blocked',
          runner: 'fake',
          reasoning: 'medium',
          startedAt: '2026-08-09T20:00:00.000Z',
          finishedAt: '2026-08-09T20:00:01.000Z',
          failureClass: 'agent_blocked',
          validation: { passed: false, commands: [] },
        }),
    } as unknown as TaskExecutor;

    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      recoveryConfig: RECOVERY,
      maxAttempts: 3,
    }).run(plan, run.runId, 'SDD');

    expect(outcome.haltedBy).toContain('TASK-001');

    const exhausted = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'recovery_exhausted',
    );
    // AR §3.6: an escalation always names one specific human action.
    expect(String(exhausted?.detail?.['humanAction'] ?? '')).not.toHaveLength(0);
  });

  it('stops when the attempt budget runs out, naming the budget', async () => {
    const { store, run } = await harness();

    const executor = {
      execute: async (t: Task) =>
        TaskResultSchema.parse({
          task: t.id,
          status: 'review_required',
          runner: 'fake',
          reasoning: 'medium',
          startedAt: '2026-08-09T20:00:00.000Z',
          finishedAt: '2026-08-09T20:00:01.000Z',
          failureClass: 'validation_unsatisfied',
          validation: { passed: false, commands: [] },
        }),
    } as unknown as TaskExecutor;

    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });
    const outcome = await new Scheduler({
      store,
      executor,
      recoveryConfig: RECOVERY,
      maxAttempts: 2,
    }).run(plan, run.runId, 'SDD');

    // Bounded: it stops rather than looping (C-22).
    expect(outcome.haltedBy).toBeDefined();

    const exhausted = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'recovery_exhausted',
    );
    expect(exhausted?.detail?.['budget']).toBeDefined();
  });

  it('records the counters and the evidence the escalation is built from (C-22)', async () => {
    // C-22 asks the projection to carry counts and redacted evidence, and the projection
    // invents neither. If the event does not record them at the moment the decision is
    // taken they are gone: the counters move on, and the failing result is not kept.
    const { store, run } = await harness();

    const executor = {
      execute: async (t: Task) =>
        TaskResultSchema.parse({
          task: t.id,
          status: 'review_required',
          runner: 'fake',
          reasoning: 'medium',
          startedAt: '2026-08-09T20:00:00.000Z',
          finishedAt: '2026-08-09T20:00:01.000Z',
          failureClass: 'validation_unsatisfied',
          validation: {
            passed: false,
            commands: [
              {
                command: 'npm test',
                exitCode: 1,
                durationMs: 10,
                stdout: '',
                stderr: 'AssertionError: expected 2, got 3',
                truncated: false,
              },
            ],
          },
        }),
    } as unknown as TaskExecutor;

    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });
    await new Scheduler({ store, executor, recoveryConfig: RECOVERY, maxAttempts: 2 }).run(
      plan,
      run.runId,
      'SDD',
    );

    const exhausted = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'recovery_exhausted',
    );

    expect(exhausted?.detail?.['counts']).toMatchObject({ attempts: expect.any(Number) });

    // The failing command, named — this is what makes the escalation actionable rather
    // than a status. Redacted and bounded: never the raw runner transcript (I-21).
    const evidence = exhausted?.detail?.['evidence'];
    expect(Array.isArray(evidence)).toBe(true);
    expect((evidence as string[]).join('\n')).toContain('npm test');
  });

  it('terminates rather than looping on a failure that never changes', async () => {
    // `maxIdenticalFailures` is the anti-thrash rule: a loop producing the same failure
    // twice has learned nothing, whatever the other budgets allow.
    const { store, run } = await harness();
    let calls = 0;

    const executor = {
      execute: async (t: Task) => {
        calls += 1;
        if (calls > 20) throw new Error('the recovery loop did not terminate');
        return TaskResultSchema.parse({
          task: t.id,
          status: 'review_required',
          runner: 'fake',
          reasoning: 'medium',
          startedAt: '2026-08-09T20:00:00.000Z',
          finishedAt: '2026-08-09T20:00:01.000Z',
          failureClass: 'validation_unsatisfied',
          validation: { passed: false, commands: [] },
        });
      },
    } as unknown as TaskExecutor;

    const plan = PlanSchema.parse({ feature: 'f', tasks: [withCriteria('TASK-001')] });
    await new Scheduler({ store, executor, recoveryConfig: RECOVERY, maxAttempts: 10 }).run(
      plan,
      run.runId,
      'SDD',
    );

    expect(calls).toBeLessThan(20);
  });
});
