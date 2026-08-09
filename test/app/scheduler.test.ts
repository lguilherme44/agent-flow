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
