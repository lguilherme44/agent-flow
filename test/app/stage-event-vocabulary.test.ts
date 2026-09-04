import { describe, it, expect } from 'vitest';
import { STAGE_EVENT_TYPES, type RunEvent } from '../../src/contracts/index.js';
import { stageRunnersOf } from '../../src/app/plan-review-service.js';
import { buildStageTimeline } from '../../src/core/stage-timeline.js';
import { RunStateSchema } from '../../src/contracts/index.js';

/**
 * `stage_completed` carried two facts — the runner answered, and the answer was
 * accepted — and they diverged on a real run: a schema-valid plan that `checkPlan`
 * turned down produced `stage_completed` and `stage_failed` for `planning` at the
 * same timestamp, with `status` showing `Task Planning ✓` on a FAILED run.
 *
 * The new event is **additive**, and this file is mostly about why it has to stay
 * that way. `stage_completed` has seven readers and one of them decides
 * correctness, not display.
 */
const event = (type: string, detail: Record<string, unknown>): RunEvent =>
  ({ at: '2026-09-04T00:00:00.000Z', type, detail }) as RunEvent;

const state = (over: Record<string, unknown> = {}) =>
  RunStateSchema.parse({
    runId: 'AF-2026-001',
    feature: 'f',
    stage: 'planning',
    status: 'running',
    approved: false,
    revisionCount: 0,
    degradations: [],
    tasks: [],
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...over,
  });

describe('the stage vocabulary names both facts', () => {
  it('declares output received and completion as separate spellings', () => {
    expect(STAGE_EVENT_TYPES).toContain('stage_output_received');
    expect(STAGE_EVENT_TYPES).toContain('stage_completed');
  });
});

describe('narrowing stage_completed would break independence, not a screen', () => {
  it('collects the planner even when the plan was later rejected', () => {
    // The chain: stageRunnersOf -> correctivePlanAuthors -> the set a corrective
    // plan review must be independent OF. A planning stage whose output was turned
    // down must stay in that set, or the runner that wrote the plan becomes
    // eligible to review it while the artifact claims independence.
    const events = [
      event('stage_output_received', { stage: 'planning', runner: 'moe' }),
      event('stage_completed', { stage: 'planning', runner: 'moe' }),
      event('stage_failed', { stage: 'planning', problems: ['two tasks, one file'] }),
    ];
    expect(stageRunnersOf(events, 'planning')).toContain('moe');
  });

  it('does not collect a runner from the received event alone', () => {
    // If it did, the additive event would silently become a second source of
    // truth for a correctness decision.
    const events = [event('stage_output_received', { stage: 'planning', runner: 'moe' })];
    expect(stageRunnersOf(events, 'planning')).toEqual([]);
  });
});

describe('the timeline ignores an event type it does not know', () => {
  it('is unchanged by the new event', () => {
    const withNew = buildStageTimeline(
      [
        event('stage_output_received', { stage: 'sdd', runner: 'moe' }),
        event('stage_completed', { stage: 'sdd', runner: 'moe' }),
      ],
      state(),
    );
    const without = buildStageTimeline(
      [event('stage_completed', { stage: 'sdd', runner: 'moe' })],
      state(),
    );
    expect(withNew.find((s) => s.stage === 'sdd')?.status).toBe(
      without.find((s) => s.stage === 'sdd')?.status,
    );
  });
});
