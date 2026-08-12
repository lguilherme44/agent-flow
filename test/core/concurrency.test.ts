import { describe, it, expect } from 'vitest';
import {
  MAX_ISOLATED_TASK_CONCURRENCY,
  MAX_SUPPORTED_TASK_CONCURRENCY,
  resolveTaskConcurrency,
} from '../../src/core/concurrency.js';

/**
 * M2-00.3 — what a configured `parallelism.maxTasks` is allowed to become.
 *
 * The distinction this module exists for: configuration records *intent*, and the
 * runtime has to answer a narrower question — how many tasks can execute at once
 * without two of them writing to the same working tree. Without isolation the
 * honest answer is one, whatever the file says.
 *
 * M2-01 adds the second half: the ceiling now depends on a mode the resolver is
 * *handed*. Having the capability is not the same as using it — no production
 * caller passes `'worktree'` yet (M2-11), and `test/architecture.test.ts` is what
 * keeps that true.
 */

describe('the effective concurrency is never more than the product can isolate', () => {
  it('passes one through untouched', () => {
    const decision = resolveTaskConcurrency(1);

    expect(decision.effective).toBe(1);
    expect(decision.requested).toBe(1);
    expect(decision.clamped).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  it('clamps anything above the supported ceiling', () => {
    const decision = resolveTaskConcurrency(4);

    expect(decision.requested).toBe(4);
    expect(decision.effective).toBe(1);
    expect(decision.clamped).toBe(true);
  });

  it('says why, in words a person can act on', () => {
    // "clamped: true" on its own answers nothing. The question a user asks is
    // "why is Agent Flow running one task at a time when I asked for four", and
    // the answer has to name the missing capability rather than the flag.
    const reason = resolveTaskConcurrency(4).reason ?? '';

    expect(reason).toMatch(/isolat/i);
    expect(reason).toMatch(/4/);
  });

  it('never returns less than one, whatever arrives', () => {
    // The schema already refuses zero and negatives; a resolver that returned
    // zero would deadlock the scheduler rather than fail, so it does not.
    expect(resolveTaskConcurrency(0).effective).toBe(1);
    expect(resolveTaskConcurrency(-3).effective).toBe(1);
  });

  it('states the ceiling as a named constant, so raising it is one edit', () => {
    // The sequential ceiling is one and stays one: it describes tasks sharing a
    // working tree, and no milestone makes that safe. What MVP 2 adds is a
    // *second* ceiling for a mode where they do not share one.
    expect(MAX_SUPPORTED_TASK_CONCURRENCY).toBe(1);
  });
});

describe('an isolated run is resolved against its own ceiling (§4.4)', () => {
  it('states the isolated ceiling as a named constant too', () => {
    expect(MAX_ISOLATED_TASK_CONCURRENCY).toBe(8);
  });

  it('honours what was asked for, up to eight', () => {
    for (const [requested, expected] of [
      [1, 1],
      [2, 2],
      [4, 4],
      [8, 8],
    ] as const) {
      const decision = resolveTaskConcurrency(requested, 'worktree');

      expect(decision.effective, `requested ${String(requested)}`).toBe(expected);
      expect(decision.clamped).toBe(false);
      expect(decision.reason).toBeUndefined();
    }
  });

  it('clamps above eight, and says why in terms of what each task costs', () => {
    const decision = resolveTaskConcurrency(16, 'worktree');

    expect(decision.requested).toBe(16);
    expect(decision.effective).toBe(8);
    expect(decision.clamped).toBe(true);
    // The reason has to name the resource, not the number: "8" alone reads as an
    // arbitrary limit, and the next person raises it without knowing what it buys.
    expect(decision.reason).toMatch(/16/);
    expect(decision.reason).toMatch(/8/);
    expect(decision.reason).toMatch(/checkout|install|agent process/i);
  });

  it('still refuses to return less than one', () => {
    expect(resolveTaskConcurrency(0, 'worktree').effective).toBe(1);
    expect(resolveTaskConcurrency(-3, 'worktree').effective).toBe(1);
    expect(resolveTaskConcurrency(Number.NaN, 'worktree').effective).toBe(1);
    expect(resolveTaskConcurrency(Number.POSITIVE_INFINITY, 'worktree').effective).toBe(1);
  });
});

describe('the mode is handed in, and the default is the safe one', () => {
  it('resolves the sequential ceiling when nobody says otherwise', () => {
    // Every existing caller passes one argument. Granting parallelism has to be
    // something a caller *says*, never something it forgets to deny — so the
    // defaulted call and the explicit `'none'` call are the same answer.
    expect(resolveTaskConcurrency(4).effective).toBe(1);

    // §26.2 asks for the full grid; this is its sequential row.
    for (const requested of [1, 2, 4, 16]) {
      expect(resolveTaskConcurrency(requested, 'none').effective, String(requested)).toBe(1);
    }
  });

  it('gives the two modes different reasons for the same request', () => {
    // `maxTasks: 4` is clamped in one mode and honoured in the other, and a run
    // reduced to one deserves to be told which of the two happened to it.
    const sequential = resolveTaskConcurrency(4, 'none');
    const isolated = resolveTaskConcurrency(16, 'worktree');

    expect(sequential.reason).toMatch(/isolation does not\s+exist yet|share one working tree/);
    expect(isolated.reason).not.toMatch(/does not\s+exist yet/);
  });

  it('normalises a fractional request the same way in both modes', () => {
    expect(resolveTaskConcurrency(2.9, 'worktree').effective).toBe(2);
    expect(resolveTaskConcurrency(2.9, 'none').effective).toBe(1);
  });
});
