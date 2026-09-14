import { describe, it, expect } from 'vitest';
import { isTerminal, stalledRun } from '../../src/core/run-liveness.js';

/**
 * A run that says it is working while nothing is.
 *
 * Measured, on a real repository: a warm-up's discovery started against a 900 s budget,
 * and twenty minutes later `state.json` still said `running` with no `stage_failed`, no
 * stage log, and no `agent-flow` process alive on the machine. The product had every
 * number it needed to say so and compared none of them — the same shape as the timeout
 * that recorded neither its duration nor its budget.
 */
describe('stalledRun', () => {
  const base = { status: 'running' as const, budgetSeconds: 900, nowMs: 2_000_000 };

  it('says nothing while the stage is still inside its budget', () => {
    // 900 s budget, 800 s of silence. A slow stage is not a dead one.
    expect(stalledRun({ ...base, updatedAtMs: base.nowMs - 800_000 })).toBeUndefined();
  });

  it('says nothing inside the grace that follows the timeout', () => {
    // The process runner sends SIGTERM at the deadline and SIGKILL after a grace, and the
    // orchestrator still has to write what happened. 910 s is past the budget and not yet
    // past the allowance — accusing here would call a normal kill a death.
    expect(stalledRun({ ...base, updatedAtMs: base.nowMs - 910_000 })).toBeUndefined();
  });

  it('reports the run once the budget and the grace are both gone', () => {
    const stalled = stalledRun({ ...base, updatedAtMs: base.nowMs - 1_210_000 });

    expect(stalled).toMatchObject({ idleMs: 1_210_000, deadlineMs: 960_000 });
  });

  it('measures against the stage budget, not a fixed number', () => {
    // Positive control for the test above: the verdict has to move with the budget, or it
    // is a hard-coded timeout wearing a parameter's name. The same silence that is a stall
    // at 900 s is unremarkable at 2700 s.
    const idle = { ...base, updatedAtMs: base.nowMs - 1_210_000 };

    expect(stalledRun(idle)).toBeDefined();
    expect(stalledRun({ ...idle, budgetSeconds: 2700 })).toBeUndefined();
  });

  it('never accuses a terminal run', () => {
    // A completed run is silent forever, and that is what completion is.
    const ancient = { ...base, updatedAtMs: 0 };

    expect(stalledRun({ ...ancient, status: 'completed' })).toBeUndefined();
    expect(stalledRun({ ...ancient, status: 'failed' })).toBeUndefined();
    expect(stalledRun({ ...ancient, status: 'cancelled' })).toBeUndefined();
  });

  it('stays quiet rather than inventing a deadline from an unknown budget', () => {
    // Zero reaches here from a stage whose role is chosen per task, and from a
    // configuration that would not parse. Both are "we do not know", and a run must not be
    // called dead because something else could not be read.
    const ancient = { ...base, updatedAtMs: 0 };

    expect(stalledRun({ ...ancient, budgetSeconds: 0 })).toBeUndefined();
    expect(stalledRun({ ...ancient, budgetSeconds: -1 })).toBeUndefined();
  });

  it('does not tip on the deadline itself', () => {
    expect(stalledRun({ ...base, updatedAtMs: base.nowMs - 960_000 })).toBeUndefined();
    expect(stalledRun({ ...base, updatedAtMs: base.nowMs - 960_001 })).toBeDefined();
  });
});

describe('isTerminal', () => {
  it('counts every status that ends a run', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    // The one this codebase forgot. `state.schema.ts` calls it "the one terminal outcome
    // that is neither completed nor failed", and the gate that used the complement read it
    // as ongoing — so cancelling a run did not release `init`.
    expect(isTerminal('cancelled')).toBe(true);
  });

  it('counts none of the statuses that do not', () => {
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('waiting_for_approval')).toBe(false);
    expect(isTerminal('plan_rejected')).toBe(false);
    expect(isTerminal('approved')).toBe(false);
  });
});
