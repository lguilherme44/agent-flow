import { describe, it, expect } from 'vitest';
import { buildStageTimeline } from '../../src/core/stage-timeline.js';
import { RunEventSchema, RunStateSchema, type RunEvent } from '../../src/contracts/index.js';

const event = (type: string, detail: Record<string, unknown>): RunEvent =>
  RunEventSchema.parse({ at: '2026-08-10T20:00:10.000Z', type, detail });

const state = (overrides: Record<string, unknown> = {}) =>
  RunStateSchema.parse({
    runId: 'AF-2026-001',
    feature: 'f',
    stage: 'discovery',
    status: 'running',
    createdAt: '2026-08-10T20:00:00.000Z',
    updatedAt: '2026-08-10T20:00:00.000Z',
    ...overrides,
  });

const find = (views: ReturnType<typeof buildStageTimeline>, stage: string) =>
  views.find((view) => view.stage === stage);

describe('the pipeline is read out of the run, not stored on it', () => {
  it('has ten entries, because approval is one of them', () => {
    // `RUN_STAGES` has nine: nothing executes for approval, so it has no
    // events and can never appear in `state.stage`. Adding it to the state
    // machine to satisfy a display would be inventing a stage.
    //
    // Ten rather than nine since M6: `code-review` executes, once per task like
    // `implementation`, and it is the phase a person watching a run most expects to
    // see — leaving it out of the picture would hide what the milestone adds.
    expect(buildStageTimeline([], state())).toHaveLength(10);
  });

  it('marks a stage completed only when the log says it finished', () => {
    // `state.stage` is initialised to `discovery` before discovery runs and set
    // to `discovery` again when it finishes. Only the event distinguishes them.
    const before = find(buildStageTimeline([], state()), 'discovery');
    expect(before?.status).toBe('running');

    const after = find(
      buildStageTimeline([event('stage_completed', { stage: 'discovery' })], state()),
      'discovery',
    );
    expect(after?.status).toBe('completed');
  });

  it('carries the provenance the event recorded', () => {
    const views = buildStageTimeline(
      [
        event('stage_completed', {
          stage: 'planning',
          runner: 'codex',
          model: 'a-model',
          reasoning: 'high',
          attempts: 2,
          startedAt: '2026-08-10T20:00:00.000Z',
          finishedAt: '2026-08-10T20:00:08.000Z',
        }),
      ],
      state(),
    );

    expect(find(views, 'planning')).toMatchObject({
      status: 'completed',
      runner: 'codex',
      model: 'a-model',
      reasoning: 'high',
      attempts: 2,
      durationMs: 8_000,
    });
  });

  it('shows a failed stage as failed, with its code', () => {
    const views = buildStageTimeline(
      [event('stage_failed', { stage: 'sdd', errorCode: 'timeout', runner: 'claude' })],
      state(),
    );

    expect(find(views, 'sdd')).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  it('prefers the completion when a stage failed and was then rerun', () => {
    const views = buildStageTimeline(
      [
        event('stage_failed', { stage: 'sdd', errorCode: 'timeout' }),
        event('stage_completed', { stage: 'sdd', runner: 'claude' }),
      ],
      state(),
    );

    expect(find(views, 'sdd')?.status).toBe('completed');
  });

  it('leaves a stage nothing has reached as pending', () => {
    expect(find(buildStageTimeline([], state()), 'final-review')?.status).toBe('pending');
  });
});

describe('the approval entry reads the gate and only the gate', () => {
  it('waits while the run waits', () => {
    const views = buildStageTimeline([], state({ status: 'waiting_for_approval' }));
    expect(find(views, 'approval')?.status).toBe('waiting_approval');
  });

  it('completes when a person approved, with when', () => {
    const views = buildStageTimeline(
      [],
      state({
        status: 'approved',
        approved: true,
        approvedAt: '2026-08-10T20:05:00.000Z',
        approvedPlanHash: 'abc',
      }),
    );

    expect(find(views, 'approval')).toMatchObject({
      status: 'completed',
      finishedAt: '2026-08-10T20:05:00.000Z',
    });
  });

  it('reopens when a corrective round reopened it', () => {
    // The gate can be waiting more than once. Rendering "approved" because it
    // happened at some point would show a closed gate that is open.
    const views = buildStageTimeline(
      [],
      state({ status: 'waiting_for_approval', approved: false }),
    );

    expect(find(views, 'approval')?.status).toBe('waiting_approval');
  });

  it('fails when the plan was rejected', () => {
    const views = buildStageTimeline([], state({ status: 'plan_rejected' }));
    expect(find(views, 'approval')?.status).toBe('failed');
  });
});

describe('implementation is read from the tasks', () => {
  const withTasks = (tasks: { id: string; state: string }[]) =>
    state({ status: 'approved', approved: true, tasks });

  it('is pending before there are any', () => {
    expect(find(buildStageTimeline([], state()), 'implementation')?.status).toBe('pending');
  });

  it('runs while any task runs', () => {
    const views = buildStageTimeline(
      [],
      withTasks([
        { id: 'TASK-001', state: 'completed' },
        { id: 'TASK-002', state: 'running' },
      ]),
    );

    expect(find(views, 'implementation')?.status).toBe('running');
  });

  it('completes only when every task did', () => {
    const partial = buildStageTimeline(
      [],
      withTasks([
        { id: 'TASK-001', state: 'completed' },
        { id: 'TASK-002', state: 'queued' },
      ]),
    );
    // The guarantee this test exists for: partial progress never reads as done.
    expect(find(partial, 'implementation')?.status).not.toBe('completed');
    // And it is not `pending` either — that was the third instance of a state the
    // vocabulary could express being collapsed into "nothing here". One task
    // completed among ten queued drew like a stage that had not begun.
    expect(find(partial, 'implementation')?.status).toBe('running');

    const whole = buildStageTimeline(
      [],
      withTasks([
        { id: 'TASK-001', state: 'completed' },
        { id: 'TASK-002', state: 'completed' },
      ]),
    );
    expect(find(whole, 'implementation')?.status).toBe('completed');
  });

  it('fails on one failed task among many completed ones', () => {
    const views = buildStageTimeline(
      [],
      withTasks([
        { id: 'TASK-001', state: 'completed' },
        { id: 'TASK-002', state: 'failed' },
      ]),
    );

    expect(find(views, 'implementation')?.status).toBe('failed');
  });

  it('blocks on a task waiting for a person', () => {
    const views = buildStageTimeline([], withTasks([{ id: 'TASK-001', state: 'blocked' }]));
    expect(find(views, 'implementation')?.status).toBe('blocked');

    const review = buildStageTimeline(
      [],
      withTasks([{ id: 'TASK-001', state: 'review_required' }]),
    );
    expect(find(review, 'implementation')?.status).toBe('blocked');
  });
});

/**
 * A12 — the pipeline showed `pending` for stages that were reused from cache and
 * for the stage generating at that instant. Three states drawn as one, on the
 * screen an operator actually watches.
 */
describe('a reused stage is not a stage that never ran', () => {
  it('reports a cache hit as cached rather than pending', () => {
    const view = buildStageTimeline(
      [event('stage_reused', { stage: 'discovery', reason: 'discovery_cache_hit' })],
      state({ stage: 'sdd' }),
    );
    const discovery = view.find((entry) => entry.stage === 'discovery');
    expect(discovery?.status).toBe('cached');
    expect(discovery?.reuseReason).toBe('discovery_cache_hit');
  });

  it('gives a reused stage no duration, because nothing ran', () => {
    const view = buildStageTimeline(
      [event('stage_reused', { stage: 'discovery', reason: 'resumed_from_later_stage' })],
      state({ stage: 'sdd' }),
    );
    expect(view.find((entry) => entry.stage === 'discovery')?.durationMs).toBeUndefined();
  });

  it('prefers a real run over an earlier reuse of the same stage', () => {
    const view = buildStageTimeline(
      [
        event('stage_reused', { stage: 'sdd', reason: 'resumed_from_later_stage' }),
        event('stage_completed', { stage: 'sdd', runner: 'moe' }),
      ],
      state({ stage: 'planning' }),
    );
    expect(view.find((entry) => entry.stage === 'sdd')?.status).toBe('completed');
  });

  it('shows the stage the log is inside, even when state.stage lags behind it', () => {
    // Measured on AF-2026-002: `state.stage` read `architecture-impact` while the
    // event log was already inside `sdd`, and the pipeline drew `sdd` as pending
    // while it was generating.
    const view = buildStageTimeline(
      [
        event('stage_completed', { stage: 'architecture-impact', runner: 'claude' }),
        event('stage_started', { stage: 'sdd', runner: 'moe' }),
      ],
      state({ stage: 'architecture-impact' }),
    );
    expect(view.find((entry) => entry.stage === 'sdd')?.status).toBe('running');
    expect(view.find((entry) => entry.stage === 'sdd')?.runner).toBe('moe');
  });

  it('stops calling a stage running once it has finished', () => {
    const view = buildStageTimeline(
      [
        event('stage_started', { stage: 'sdd', runner: 'moe' }),
        event('stage_completed', { stage: 'sdd', runner: 'moe' }),
      ],
      state({ stage: 'sdd' }),
    );
    expect(view.find((entry) => entry.stage === 'sdd')?.status).toBe('completed');
  });

  it('does not call a started stage running once the run itself stopped', () => {
    const view = buildStageTimeline(
      [event('stage_started', { stage: 'sdd', runner: 'moe' })],
      state({ stage: 'sdd', status: 'failed' }),
    );
    expect(view.find((entry) => entry.stage === 'sdd')?.status).toBe('pending');
  });
});

/**
 * The same shape a third time: a state the vocabulary could express, collapsed
 * into "nothing here". Implementation with one task done and ten queued drew
 * identically to implementation that had not started — measured on AF-2026-002
 * right after TASK-001 completed.
 */
describe('implementation in progress is not implementation not started', () => {
  const withTasks = (...taskStates: string[]) =>
    buildStageTimeline(
      [],
      state({
        stage: 'implementation',
        status: 'approved',
        tasks: taskStates.map((s, i) => ({ id: `TASK-00${String(i + 1)}`, state: s, attempts: 0 })),
      }),
    ).find((entry) => entry.stage === 'implementation');

  it('reports progress once any task has moved off the queue', () => {
    expect(withTasks('completed', 'queued', 'queued')?.status).toBe('running');
  });

  it('still reports pending while every task is queued', () => {
    expect(withTasks('queued', 'queued')?.status).toBe('pending');
  });

  it('reports pending for a plan with no tasks at all', () => {
    expect(withTasks()?.status).toBe('pending');
  });

  it('keeps completed when every task landed', () => {
    expect(withTasks('completed', 'completed')?.status).toBe('completed');
  });

  it('lets a failure outrank progress', () => {
    expect(withTasks('completed', 'failed', 'queued')?.status).toBe('failed');
  });

  it('lets a running task outrank the derived progress', () => {
    expect(withTasks('completed', 'running', 'queued')?.status).toBe('running');
  });

  it('treats a ready task as progress, not as pending', () => {
    // `ready` means the graph unblocked it: the stage is under way.
    expect(withTasks('ready', 'queued')?.status).toBe('running');
  });
});
