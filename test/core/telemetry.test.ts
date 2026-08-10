import { describe, it, expect } from 'vitest';
import { TelemetryEntrySchema, type TelemetryEntry } from '../../src/contracts/index.js';
import { durationBetween, groupBy, summariseTelemetry } from '../../src/core/telemetry.js';

const entry = (overrides: Record<string, unknown> = {}): TelemetryEntry =>
  TelemetryEntrySchema.parse({
    runId: 'AF-2026-001',
    kind: 'stage',
    stage: 'planning',
    role: 'planner',
    runner: 'codex',
    model: 'a-model',
    reasoning: 'high',
    startedAt: '2026-08-10T20:00:00.000Z',
    finishedAt: '2026-08-10T20:00:10.000Z',
    durationMs: 10_000,
    status: 'completed',
    ...overrides,
  });

describe('summariseTelemetry', () => {
  it('totals what a run actually spent in time and attempts', () => {
    const summary = summariseTelemetry([
      entry({ durationMs: 1_000, attempts: 1 }),
      entry({ durationMs: 2_500, attempts: 3 }),
    ]);

    expect(summary.entries).toBe(2);
    expect(summary.durationMs).toBe(3_500);
    // Attempts count invocations; retries count the ones beyond the first.
    expect(summary.retries).toBe(2);
  });

  it('counts a fallback wherever it happened', () => {
    const summary = summariseTelemetry([
      entry(),
      entry({ runner: 'claude', fallback: { from: 'codex', errorCode: 'quota_exceeded' } }),
    ]);

    expect(summary.fallbacks).toBe(1);
    expect(summary.byRunner['claude']?.fallbacks).toBe(1);
    expect(summary.byRunner['codex']?.fallbacks).toBe(0);
  });

  it('counts anything that did not complete as a failure', () => {
    const summary = summariseTelemetry([
      entry(),
      entry({ status: 'failed', errorCode: 'timeout' }),
      entry({ status: 'review_required' }),
    ]);

    expect(summary.failures).toBe(2);
  });

  it('counts effort that had to be clamped (R-15)', () => {
    const summary = summariseTelemetry([entry(), entry({ reasoningClamped: true })]);
    expect(summary.reasoningClamped).toBe(1);
  });

  it('breaks the same total down by runner, model, role and stage', () => {
    const summary = summariseTelemetry([
      entry({ runner: 'codex', model: 'm1', role: 'planner', stage: 'planning', durationMs: 100 }),
      entry({
        runner: 'claude',
        model: 'm2',
        role: 'planReviewer',
        stage: 'plan-review',
        durationMs: 400,
      }),
    ]);

    expect(summary.byRunner['codex']?.durationMs).toBe(100);
    expect(summary.byModel['m2']?.count).toBe(1);
    expect(summary.byRole['planReviewer']?.durationMs).toBe(400);
    expect(summary.byStage['planning']?.count).toBe(1);
  });

  it('is empty rather than undefined for a run that did nothing', () => {
    const summary = summariseTelemetry([]);

    expect(summary.entries).toBe(0);
    expect(summary.durationMs).toBe(0);
    expect(summary.byRunner).toEqual({});
  });
});

describe('groupBy leaves out what it was not told', () => {
  it('omits entries whose key is absent instead of inventing one', () => {
    // A runner that reported no model has not said it uses "unknown". Filing it
    // under a placeholder would report a model that does not exist.
    const buckets = groupBy([entry({ model: undefined }), entry({ model: 'm1' })], (e) => e.model);

    expect(Object.keys(buckets)).toEqual(['m1']);
    expect(buckets['m1']?.count).toBe(1);
  });
});

describe('durationBetween', () => {
  it('measures the interval', () => {
    expect(durationBetween('2026-08-10T20:00:00.000Z', '2026-08-10T20:00:05.000Z')).toBe(5_000);
  });

  it('never returns a negative duration', () => {
    // A clock that went backwards would otherwise poison every sum it lands in.
    expect(durationBetween('2026-08-10T20:00:05.000Z', '2026-08-10T20:00:00.000Z')).toBe(0);
  });

  it('returns zero for something that is not a timestamp', () => {
    expect(durationBetween('not a date', '2026-08-10T20:00:00.000Z')).toBe(0);
  });
});
