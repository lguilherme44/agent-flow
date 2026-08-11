import { describe, it, expect } from 'vitest';
import {
  MAX_SUPPORTED_TASK_CONCURRENCY,
  resolveTaskConcurrency,
} from '../../src/core/concurrency.js';

/**
 * M2-00.3 — what a configured `parallelism.maxTasks` is allowed to become.
 *
 * The distinction this module exists for: configuration records *intent*, and the
 * runtime has to answer a narrower question — how many tasks can execute at once
 * without two of them writing to the same working tree. Until task workspaces are
 * isolated the honest answer is one, whatever the file says.
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
    // The point of the constant is that M2-01 changes this and nothing else has
    // to be found. It is one today because no isolation exists yet.
    expect(MAX_SUPPORTED_TASK_CONCURRENCY).toBe(1);
  });
});
