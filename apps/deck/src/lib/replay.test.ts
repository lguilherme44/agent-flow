import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@contracts/index.js';
import { buildTimeline, neighbour, stateAt } from './replay';

const T0 = Date.parse('2026-09-04T10:00:00.000Z');
const at = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1_000).toISOString();

function event(offsetSeconds: number, type: string, detail: Record<string, unknown> = {}): RunEvent {
  return { at: at(offsetSeconds), type, detail };
}

/**
 * The shape of a real log: a plan that failed its checks once, was revised, approved by a
 * person, then two tasks — one of which needed a second attempt.
 */
const LOG: RunEvent[] = [
  event(0, 'run_created', { feature: 'rectangle tool' }),
  event(1, 'stage_started', { stage: 'discovery', role: 'architect', runner: 'r1' }),
  event(60, 'stage_context_measured', { stage: 'discovery', totalBytes: 4044 }),
  event(120, 'stage_completed', { stage: 'discovery', runner: 'r1', startedAt: at(1), finishedAt: at(120) }),
  event(121, 'stage_started', { stage: 'planning', role: 'planner', runner: 'r1' }),
  event(300, 'stage_completed', { stage: 'planning', runner: 'r1' }),
  event(300, 'stage_failed', { stage: 'planning', problems: ['two tasks declare one file'] }),
  event(360, 'revision_requested', { instruction: 'split the file', attemptedRevision: 1 }),
  event(361, 'stage_started', { stage: 'planning', role: 'planner', runner: 'r1' }),
  event(500, 'stage_completed', { stage: 'planning', runner: 'r1' }),
  event(900, 'run_approved', { planHash: 'abc', taskCount: 2 }),
  event(901, 'task_assigned', { task: 'TASK-001', agentName: 'Backend' }),
  event(902, 'task_started', { task: 'TASK-001', role: 'executor.normal' }),
  event(903, 'task_started', { task: 'TASK-002', role: 'executor.normal' }),
  event(1_200, 'task_finished', { task: 'TASK-001', status: 'completed', runner: 'r1', validationPassed: true }),
  event(1_250, 'task_finished', { task: 'TASK-002', status: 'failed', runner: 'r1' }),
  event(1_251, 'recovery_started', { task: 'TASK-002', step: 'work_retry' }),
  event(1_252, 'task_requeued', { task: 'TASK-002' }),
  event(1_300, 'task_started', { task: 'TASK-002', role: 'executor.normal' }),
];

describe('buildTimeline', () => {
  const timeline = buildTimeline(LOG, T0 + 2_000_000);

  it('spans the log, from the first line to the last', () => {
    expect(timeline.start).toBe(T0);
    expect(timeline.end).toBe(T0 + 1_300_000);
  });

  it('draws a stage that ran twice as two bars, and keeps the refused answer refused', () => {
    const planning = timeline.stages.filter((span) => span.stage === 'planning');
    expect(planning).toHaveLength(2);
    // Completed and failed at the same instant: the runner answered, the answer was refused.
    expect(planning[0]).toMatchObject({ startedAt: T0 + 121_000, endedAt: T0 + 300_000, outcome: 'failed' });
    expect(planning[1]).toMatchObject({ startedAt: T0 + 361_000, endedAt: T0 + 500_000, outcome: 'completed' });
  });

  it('numbers attempts per task and carries the status the log wrote, verbatim', () => {
    const attempts = timeline.attempts.filter((span) => span.task === 'TASK-002');
    expect(attempts.map((span) => span.attempt)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ outcome: 'failed', endedAt: T0 + 1_250_000, runner: 'r1' });
    // Still open at the end of the log: no end, and `running` rather than a guess.
    expect(attempts[1]).toMatchObject({ outcome: 'running' });
    expect(attempts[1]?.endedAt).toBeUndefined();
  });

  it('lists tasks in the order the log first named them', () => {
    expect(timeline.tasks).toEqual(['TASK-001', 'TASK-002']);
  });

  it('keeps every other line as a marker, and drops only the per-stage noise', () => {
    const kinds = timeline.markers.map((marker) => marker.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('approved');
    expect(kinds).toContain('revision');
    expect(kinds).toContain('assigned');
    expect(kinds).toContain('recovery');
    expect(kinds).toContain('requeued');
    expect(timeline.markers.some((marker) => marker.event.type === 'stage_context_measured')).toBe(false);
  });

  it('turns an unknown event type into a marker rather than losing it', () => {
    const withStranger = buildTimeline([...LOG, event(1_400, 'something_new', { task: 'TASK-001' })], T0 + 2_000_000);
    const stranger = withStranger.markers.find((marker) => marker.event.type === 'something_new');
    expect(stranger).toMatchObject({ kind: 'other', task: 'TASK-001' });
  });

  it('draws a completion whose start the log never wrote from its own startedAt', () => {
    const orphan = buildTimeline(
      [event(0, 'run_created'), event(120, 'stage_completed', { stage: 'discovery', startedAt: at(5) })],
      T0 + 500_000,
    );
    expect(orphan.stages[0]).toMatchObject({ stage: 'discovery', startedAt: T0 + 5_000, endedAt: T0 + 120_000, outcome: 'completed' });
  });

  it('ends an attempt where the log says it was interrupted, in the log’s own word', () => {
    // Read off a real run: a retry started at 14:31, was interrupted at 14:40 by the
    // attempt limit, and a person forced a requeue four hours later. The first fold drew
    // one hatched bar from 14:31 to 18:28, which is a lie four hours long.
    const real = buildTimeline(
      [
        event(0, 'task_started', { task: 'TASK-002' }),
        event(900, 'task_finished', { task: 'TASK-002', status: 'failed' }),
        event(900, 'task_started', { task: 'TASK-002' }),
        event(1_450, 'task_interrupted', { task: 'TASK-002', attempts: 2, requeued: false }),
        event(15_000, 'task_requeued', { task: 'TASK-002', forced: true }),
        event(15_005, 'task_started', { task: 'TASK-002' }),
        event(15_140, 'task_finished', { task: 'TASK-002', status: 'completed' }),
      ],
      T0 + 20_000_000,
    );
    expect(real.attempts.map((span) => [span.attempt, span.outcome, span.endedAt])).toEqual([
      [1, 'failed', T0 + 900_000],
      [2, 'interrupted', T0 + 1_450_000],
      [3, 'completed', T0 + 15_140_000],
    ]);
    expect(stateAt(real, T0 + 2_000_000).tasks.get('TASK-002')).toMatchObject({ state: 'interrupted', attempt: 2 });
    expect(stateAt(real, T0 + 15_001_000).tasks.get('TASK-002')).toMatchObject({ state: 'queued', attempt: 2 });
  });

  it('closes an attempt a second start ran over as unknown, never as a verdict', () => {
    const crashed = buildTimeline(
      [event(0, 'task_started', { task: 'TASK-009' }), event(50, 'task_started', { task: 'TASK-009' })],
      T0 + 500_000,
    );
    expect(crashed.attempts[0]).toMatchObject({ attempt: 1, outcome: 'unknown', endedAt: T0 + 50_000 });
    expect(crashed.attempts[1]).toMatchObject({ attempt: 2, outcome: 'running' });
  });
});

describe('stateAt', () => {
  const timeline = buildTimeline(LOG, T0 + 2_000_000);

  it('says what the log said was true at that instant, and nothing later', () => {
    const during = stateAt(timeline, T0 + 1_000_000);
    expect(during.approved).toBe(true);
    expect(during.revision).toBe(1);
    expect(during.tasks.get('TASK-001')).toMatchObject({ state: 'running', attempt: 1, agent: 'Backend' });
    expect(during.tasks.get('TASK-002')).toMatchObject({ state: 'running', attempt: 1 });
    expect(during.stages.get('planning')).toBe('completed');
  });

  it('shows the failure, then the requeue, then the second attempt', () => {
    expect(stateAt(timeline, T0 + 1_250_000).tasks.get('TASK-002')).toMatchObject({ state: 'failed', attempt: 1 });
    expect(stateAt(timeline, T0 + 1_252_000).tasks.get('TASK-002')).toMatchObject({ state: 'queued', attempt: 1 });
    expect(stateAt(timeline, T0 + 1_300_000).tasks.get('TASK-002')).toMatchObject({ state: 'running', attempt: 2 });
  });

  it('before the approval, the plan was not approved — and the refused planning was failed', () => {
    const early = stateAt(timeline, T0 + 300_000);
    expect(early.approved).toBe(false);
    expect(early.stages.get('planning')).toBe('failed');
    expect(early.tasks.size).toBe(0);
  });

  it('counts how many lines it read, so the feed can agree with the playhead', () => {
    expect(stateAt(timeline, T0 + 120_000).seen).toBe(4);
    expect(stateAt(timeline, T0 - 1).seen).toBe(0);
  });
});

describe('neighbour', () => {
  const timeline = buildTimeline(LOG, T0 + 2_000_000);

  it('steps to the previous and next line, skipping nothing', () => {
    expect(neighbour(timeline, T0 + 121_000, -1)).toBe(T0 + 120_000);
    expect(neighbour(timeline, T0 + 121_000, 1)).toBe(T0 + 300_000);
    expect(neighbour(timeline, T0, -1)).toBeUndefined();
    expect(neighbour(timeline, T0 + 1_300_000, 1)).toBeUndefined();
  });
});
