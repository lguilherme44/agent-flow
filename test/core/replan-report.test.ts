import { describe, it, expect } from 'vitest';
import {
  REPLAN_WITHHELD_REASONS,
  describeReplanReport,
  lastReplanReport,
  type ReplanWithheldReason,
} from '../../src/core/replan-report.js';
import type { RunEvent } from '../../src/contracts/index.js';

/**
 * D14. `status` renders; this decides. Which of two events is the later one and which
 * sentence a reason deserves are judgements, and a judgement that can only be exercised
 * through a terminal is one nobody exercises.
 */
const event = (type: string, detail: Record<string, unknown>): RunEvent =>
  ({ at: '2026-09-18T00:00:00.000Z', type, detail }) as RunEvent;

describe('lastReplanReport', () => {
  it('says nothing about a run where no replan happened', () => {
    expect(lastReplanReport([])).toBeUndefined();
    expect(lastReplanReport([event('stage_completed', { stage: 'planning' })])).toBeUndefined();
  });

  it('reads a forwarding from the --from planning event', () => {
    expect(
      lastReplanReport([event('replan_findings_forwarded', { from: 'planning', findingsForwarded: 9 })]),
    ).toEqual({ kind: 'forwarded', findings: 9 });
  });

  it('reads a forwarding from revise, which writes no second event', () => {
    // The asymmetry worth guarding: `revise` records its count inside
    // `revision_requested`. A projection that read only the two `replan_findings_*`
    // events would report "did not receive" for a refused revise and nothing at all for
    // one that worked — a screen that can only deliver bad news.
    expect(
      lastReplanReport([
        event('revision_requested', { instruction: 'split TASK-002', findingsForwarded: 2 }),
      ]),
    ).toEqual({ kind: 'forwarded', findings: 2 });
  });

  it('ignores a revision that forwarded nothing', () => {
    expect(
      lastReplanReport([event('revision_requested', { instruction: 'x', findingsForwarded: 0 })]),
    ).toBeUndefined();
  });

  it('reads a withholding with its reason', () => {
    expect(
      lastReplanReport([event('replan_findings_withheld', { reason: 'stale_review', findings: 9 })]),
    ).toEqual({ kind: 'withheld', findings: 9, reason: 'stale_review' });
  });

  it('answers about the replan in hand, not the first one', () => {
    // A run replans more than once, and the question is always about the latest attempt.
    const report = lastReplanReport([
      event('replan_findings_forwarded', { findingsForwarded: 9 }),
      event('replan_findings_withheld', { reason: 'request_changed', findings: 9 }),
    ]);
    expect(report).toEqual({ kind: 'withheld', findings: 9, reason: 'request_changed' });

    const other = lastReplanReport([
      event('replan_findings_withheld', { reason: 'request_changed', findings: 9 }),
      event('revision_requested', { findingsForwarded: 4 }),
    ]);
    expect(other).toEqual({ kind: 'forwarded', findings: 4 });
  });

  it('ignores a reason it has no sentence for, and a count that is not one', () => {
    // A raw identifier reaching the operator is exactly what the phrasing exists to
    // prevent, so an unknown value is dropped rather than passed through.
    expect(
      lastReplanReport([event('replan_findings_withheld', { reason: 'because', findings: 9 })]),
    ).toBeUndefined();
    expect(
      lastReplanReport([event('replan_findings_withheld', { reason: 'stale_review', findings: 0 })]),
    ).toBeUndefined();
    expect(
      lastReplanReport([event('replan_findings_forwarded', { findingsForwarded: 'nine' })]),
    ).toBeUndefined();
  });
});

describe('describeReplanReport', () => {
  it('says the planner got them, and how many', () => {
    expect(describeReplanReport({ kind: 'forwarded', findings: 9 })).toBe(
      'Last replan received 9 finding(s) from the previous plan review.',
    );
  });

  it('gives every reason a sentence that names the count and the reason', () => {
    for (const reason of REPLAN_WITHHELD_REASONS) {
      const line = describeReplanReport({ kind: 'withheld', findings: 9, reason });

      expect(line).toContain('did not receive the 9 finding(s)');
      // The machine-readable reason travels with the prose, so an operator searching the
      // log for what they read on screen finds it.
      expect(line).toContain(reason);
    }
  });

  it('ends every withholding with something to do', () => {
    // POSITIVE CONTROL for the whole point of the line. A sentence that names a failure
    // and no remedy is a quieter version of the silence this closes — delete the action
    // clauses and this fails while every assertion above still passes.
    const actions: Record<ReplanWithheldReason, string> = {
      stale_review: '--from planning',
      unverifiable_review: '--from planning',
      request_changed: 'agent-flow revise',
      stage_before_planning: '--from planning',
    };

    for (const reason of REPLAN_WITHHELD_REASONS) {
      expect(describeReplanReport({ kind: 'withheld', findings: 9, reason })).toContain(
        actions[reason],
      );
    }
  });

  it('is one line', () => {
    for (const reason of REPLAN_WITHHELD_REASONS) {
      expect(describeReplanReport({ kind: 'withheld', findings: 9, reason })).not.toContain('\n');
    }
    expect(describeReplanReport({ kind: 'forwarded', findings: 1 })).not.toContain('\n');
  });
});
