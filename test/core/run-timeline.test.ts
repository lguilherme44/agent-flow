import { describe, it, expect } from 'vitest';
import { buildRunTimeline, type TimelineTaskResult } from '../../src/core/run-timeline.js';
import { RunEventSchema, type RunEvent } from '../../src/contracts/index.js';

/**
 * Where a run's wall clock went.
 *
 * The fixture is the shape of the run that asked for this: a planning check that repaired
 * itself, a person reading the plan for an hour, a revision, a provider's quota window that
 * the person restarted after, an approval, and a task that needed a second implementation
 * attempt. Every sum is asserted, because a decomposition is only useful if its parts add
 * up and land in the right bucket.
 */

const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const MIN = 60_000;
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

const event = (minutes: number, type: string, detail: Record<string, unknown> = {}): RunEvent =>
  RunEventSchema.parse({ at: at(minutes), type, detail });

const started = (minutes: number, stage: string) => event(minutes, 'stage_started', { stage });
const completed = (minutes: number, stage: string, from: number, costUsd: number) =>
  event(minutes, 'stage_completed', {
    stage,
    startedAt: at(from),
    finishedAt: at(minutes),
    repairs: 0,
    usage: { costUsd, outputTokens: 100 },
  });

const RUN: RunEvent[] = [
  event(0, 'run_created'),
  started(0, 'discovery'),
  completed(10, 'discovery', 0, 5),

  started(11, 'planning'),
  completed(16, 'planning', 11, 1),
  // The planning check's verdict on the execution that just closed, then its repair.
  event(16, 'stage_failed', { stage: 'planning', problems: ['FR-002 has no task'] }),
  event(16, 'planning_repair_requested', { repair: 1 }),
  started(17, 'planning'),
  completed(21, 'planning', 17, 1),
  started(22, 'plan-review'),
  completed(24, 'plan-review', 22, 0.5),

  // A person reads the plan for an hour and asks for a revision.
  event(84, 'revision_requested', { instruction: 'split TASK-001' }),
  event(84, 'operator_action', { action: 'revise' }),
  started(85, 'planning'),
  completed(90, 'planning', 85, 1),
  started(91, 'plan-review'),
  event(92, 'stage_failed', {
    stage: 'plan-review',
    errorCode: 'quota_exceeded',
    failureClass: 'runner_quota_exhausted',
    startedAt: at(91),
    finishedAt: at(92),
    usage: { costUsd: 0.25 },
  }),

  // Two hours later the person restarts it. The wait was the provider's, not theirs.
  event(212, 'operator_action', { action: 'resume' }),
  started(212, 'plan-review'),
  completed(214, 'plan-review', 212, 0.5),

  event(244, 'run_approved', { taskCount: 1 }),
  event(244, 'operator_action', { action: 'approve' }),

  event(245, 'task_started', { task: 'TASK-001', role: 'implementer' }),
  started(245, 'implementation'),
  event(245, 'stage_context_measured', { stage: 'implementation', task: 'TASK-001', attempt: 1 }),
  completed(255, 'implementation', 245, 2),
  event(258, 'task_finished', { task: 'TASK-001', status: 'failed' }),
  event(258, 'task_failure_classified', { task: 'TASK-001' }),
  event(258, 'recovery_started', { task: 'TASK-001' }),

  event(259, 'task_started', { task: 'TASK-001', role: 'implementer' }),
  started(259, 'implementation'),
  event(259, 'stage_context_measured', { stage: 'implementation', task: 'TASK-001', attempt: 2 }),
  completed(265, 'implementation', 259, 1.5),
  event(268, 'task_finished', { task: 'TASK-001', status: 'completed' }),

  started(270, 'final-review'),
  completed(275, 'final-review', 270, 0.75),
];

const RESULTS: TimelineTaskResult[] = [
  {
    task: 'TASK-001',
    finishedAt: at(268),
    validation: {
      commands: [
        { command: 'npx tsc --noEmit', durationMs: 60_000, exitCode: 0 },
        { command: 'npx vitest run', durationMs: 120_000, exitCode: 0 },
      ],
    },
  },
];

describe('the run timeline', () => {
  it('splits the wall clock into six parts that add up to it', () => {
    const timeline = buildRunTimeline(RUN, RESULTS);

    expect(timeline.wallMs).toBe(275 * MIN);
    // First executions: discovery 10, planning 5, plan-review 2, implementation 10, final-review 5.
    expect(timeline.modelMs).toBe(32 * MIN);
    // Planning ×2 (4 + 5), plan-review ×2 (1 + 2), the second implementation attempt (6).
    expect(timeline.reworkMs).toBe(18 * MIN);
    expect(timeline.validationMs).toBe(3 * MIN);
    // Reading the plan (24 → 85) and waiting to approve it (214 → 245).
    expect(timeline.waitingForHumanMs).toBe(92 * MIN);
    // The provider's window, even though a person ended it.
    expect(timeline.quotaWaitMs).toBe(120 * MIN);
    // The orchestrator's own minutes: between stages, the repair, the recovery.
    expect(timeline.otherMs).toBe(10 * MIN);

    const parts =
      timeline.modelMs +
      timeline.reworkMs +
      timeline.validationMs +
      timeline.waitingForHumanMs +
      timeline.quotaWaitMs +
      timeline.otherMs;
    expect(parts).toBe(timeline.wallMs);
  });

  it('draws segments that tile the wall clock with no gap and no overlap', () => {
    const { segments, startedAt, endedAt } = buildRunTimeline(RUN, RESULTS);

    expect(segments[0]?.from).toBe(startedAt);
    expect(segments.at(-1)?.to).toBe(endedAt);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.from).toBe(segments[i - 1]?.to);
    }
    expect(segments.find((segment) => segment.kind === 'quota')).toMatchObject({
      from: at(92),
      to: at(212),
      label: 'plan-review',
    });
    expect(segments.find((segment) => segment.kind === 'validation')).toMatchObject({
      from: at(265),
      to: at(268),
      label: 'TASK-001',
    });
  });

  it('prices first executions and rework apart, from what the runners reported', () => {
    const timeline = buildRunTimeline(RUN, RESULTS);

    expect(timeline.costUsd).toBeCloseTo(13.5);
    expect(timeline.reworkCostUsd).toBeCloseTo(4.25);
    expect(timeline.modelCostUsd).toBeCloseTo(9.25);
  });

  it('counts each stage once per execution, not once per verdict', () => {
    const { stages } = buildRunTimeline(RUN, RESULTS);
    const row = (stage: string) => stages.find((entry) => entry.stage === stage);

    // Three executions: the check's `stage_failed` after the first is not a fourth.
    expect(row('planning')).toMatchObject({ attempts: 3, modelMs: 14 * MIN, costUsd: 3 });
    expect(row('plan-review')).toMatchObject({ attempts: 3, modelMs: 5 * MIN });
    expect(row('plan-review')?.costUsd).toBeCloseTo(1.25);
    expect(row('implementation')).toMatchObject({ attempts: 2, modelMs: 16 * MIN, costUsd: 3.5 });
  });

  it('breaks validation down per task and per command', () => {
    const { tasks } = buildRunTimeline(RUN, RESULTS);

    expect(tasks).toEqual([
      {
        task: 'TASK-001',
        attempts: 2,
        modelMs: 16 * MIN,
        costUsd: 3.5,
        validationMs: 180_000,
        commands: RESULTS[0]?.validation.commands,
      },
    ]);
  });

  it('counts a gate still open at now as the person’s time', () => {
    const waiting = RUN.slice(0, RUN.findIndex((entry) => entry.type === 'revision_requested'));

    const timeline = buildRunTimeline(waiting, [], at(54));

    expect(timeline.wallMs).toBe(54 * MIN);
    expect(timeline.waitingForHumanMs).toBe(30 * MIN);
    expect(timeline.segments.at(-1)).toMatchObject({ kind: 'human', label: 'approval' });
  });

  it('counts the minutes after a task blocked as the person’s, before anyone acts', () => {
    const blocked = [
      event(0, 'task_started', { task: 'TASK-002' }),
      started(0, 'implementation'),
      completed(5, 'implementation', 0, 1),
      event(5, 'task_finished', { task: 'TASK-002', status: 'blocked' }),
    ];

    const timeline = buildRunTimeline(blocked, [], at(25));

    expect(timeline.waitingForHumanMs).toBe(20 * MIN);
    expect(timeline.segments.at(-1)?.label).toBe('TASK-002 blocked');
  });

  it('says nothing about money when no runner reported any', () => {
    const silent = [started(0, 'discovery'), event(3, 'stage_completed', { stage: 'discovery' })];

    const timeline = buildRunTimeline(silent, []);

    expect(timeline).not.toHaveProperty('costUsd');
    expect(timeline.stages[0]).not.toHaveProperty('costUsd');
    expect(timeline.modelMs).toBe(3 * MIN);
  });

  it('returns zeros for a run with no events', () => {
    expect(buildRunTimeline([], []).wallMs).toBe(0);
  });
});

describe('the run timeline, per task and at a stop', () => {
  it('counts one code review per task as first executions, not rework', () => {
    const review = (minute: number, task: string) => [
      started(minute, 'code-review'),
      event(minute, 'stage_context_measured', { stage: 'code-review', task }),
      completed(minute + 2, 'code-review', minute, 0.5),
    ];
    const run = [
      event(0, 'task_started', { task: 'TASK-001' }),
      started(0, 'implementation'),
      event(0, 'stage_context_measured', { stage: 'implementation', task: 'TASK-001' }),
      completed(5, 'implementation', 0, 1),
      event(5, 'task_finished', { task: 'TASK-001', status: 'completed' }),
      ...review(5, 'TASK-001'),
      event(7, 'task_started', { task: 'TASK-002' }),
      started(7, 'implementation'),
      event(7, 'stage_context_measured', { stage: 'implementation', task: 'TASK-002' }),
      completed(12, 'implementation', 7, 1),
      event(12, 'task_finished', { task: 'TASK-002', status: 'completed' }),
      ...review(12, 'TASK-002'),
    ];

    const timeline = buildRunTimeline(run, []);

    expect(timeline.reworkMs).toBe(0);
    expect(timeline.reworkCostUsd).toBe(0);
    expect(timeline.modelMs).toBe(14 * MIN);
    expect(timeline.stages.find((row) => row.stage === 'code-review')?.attempts).toBe(2);
  });

  it('gives each parallel task its own execution even when the measurements cross', () => {
    const run = [
      event(0, 'task_started', { task: 'TASK-A' }),
      event(0, 'task_started', { task: 'TASK-B' }),
      started(0, 'implementation'),
      started(1, 'implementation'),
      // B's measurement is logged first.
      event(1, 'stage_context_measured', { stage: 'implementation', task: 'TASK-B' }),
      event(1, 'stage_context_measured', { stage: 'implementation', task: 'TASK-A' }),
      completed(6, 'implementation', 1, 1),
      completed(10, 'implementation', 0, 2),
    ];

    const { tasks, reworkMs } = buildRunTimeline(run, []);

    expect(reworkMs).toBe(0);
    expect(tasks.find((row) => row.task === 'TASK-A')).toMatchObject({ attempts: 1, modelMs: 10 * MIN, costUsd: 2 });
    expect(tasks.find((row) => row.task === 'TASK-B')).toMatchObject({ attempts: 1, modelMs: 5 * MIN, costUsd: 1 });
  });

  it('reads an exhausted recovery as the person’s time, though recovery started first', () => {
    const run = [
      event(0, 'task_started', { task: 'TASK-001' }),
      started(0, 'implementation'),
      completed(10, 'implementation', 0, 1),
      event(10, 'task_finished', { task: 'TASK-001', status: 'failed' }),
      event(10, 'task_failure_classified', { task: 'TASK-001' }),
      event(10, 'recovery_started', { task: 'TASK-001' }),
      event(10, 'recovery_exhausted', { task: 'TASK-001', humanAction: 'Inspect this failure and decide' }),
    ];

    const timeline = buildRunTimeline(run, [], at(130));

    expect(timeline.waitingForHumanMs).toBe(120 * MIN);
    expect(timeline.otherMs).toBe(0);
    expect(timeline.segments.at(-1)?.label).toBe('recovery_exhausted');
  });

  it('holds a paused run on the person until it is resumed, though the pause was logged mid-stage', () => {
    const run = [
      started(0, 'sdd'),
      event(2, 'run_paused'),
      completed(5, 'sdd', 0, 1),
    ];

    const paused = buildRunTimeline(run, [], at(65));
    expect(paused.waitingForHumanMs).toBe(60 * MIN);
    expect(paused.segments.at(-1)?.label).toBe('run_paused');

    // Resumed: the minutes before the resume were still the person's, the ones after are not.
    const resumed = buildRunTimeline(
      [...run, event(65, 'run_resumed'), event(65, 'operator_action', { action: 'resume' }), event(66, 'workspace_prepared'), started(67, 'planning'), completed(70, 'planning', 67, 1), started(71, 'plan-review')],
      [],
    );
    expect(resumed.waitingForHumanMs).toBe(60 * MIN);
    expect(resumed.otherMs).toBe(3 * MIN);
  });
});
