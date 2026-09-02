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
    expect(find(partial, 'implementation')?.status).toBe('pending');

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
