import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { StateStore } from '../../src/app/state-store.js';
import { PlanSchema, TaskResultSchema, type Task, type TaskResult } from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';

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
    // The MVP 2 proof: the scheduler is already written for N. Raising the
    // number is the whole change, plus worktrees so parallel tasks do not write
    // to the same tree.
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
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 2 }],
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
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 5 }],
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
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 1 }],
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
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 3 }],
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
