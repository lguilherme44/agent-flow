import { describe, it, expect } from 'vitest';
import { judgeValidation } from '../../src/core/validation-outcome.js';

/**
 * V-04 regression.
 *
 * Was a defect: a task was judged by exit code alone. Test-first development has
 * a step where a green suite is the failure — the task that writes the RED tests
 * is done correctly when they fail — and the old rule sent exactly that task to
 * review. A real plan hit this after three reviews had asked for test-first work
 * and none noticed the contradiction.
 */

const ran = (passed: boolean, count = 1) => ({ passed, ran: count });

describe('the ordinary case', () => {
  it('completes when the commands passed as expected', () => {
    expect(judgeValidation('pass', ran(true)).state).toBe('completed');
  });

  it('sends an unexpected failure to review', () => {
    const judgement = judgeValidation('pass', ran(false));
    expect(judgement.state).toBe('review_required');
    expect(judgement.note).toContain('failed');
  });
});

describe('a task whose validation is expected to fail', () => {
  it('completes when the commands fail, which is the point', () => {
    expect(judgeValidation('fail', ran(false)).state).toBe('completed');
  });

  it('sends a RED task that went green to review', () => {
    // The case a naive implementation calls success: "expected fail, did not
    // fail — fine". It is not fine. Either the test asserts nothing, or the
    // behaviour already exists, and both are worth a person's attention.
    const judgement = judgeValidation('fail', ran(true));

    expect(judgement.state).toBe('review_required');
    expect(judgement.note).toMatch(/asserts nothing|already exists/i);
  });

  it('is not a way to silence a check', () => {
    // Both directions are reported. `fail` narrows what "correct" means; it
    // does not stop anyone looking.
    expect(judgeValidation('fail', ran(true)).note).toBeDefined();
    expect(judgeValidation('pass', ran(false)).note).toBeDefined();
  });
});

describe('a task that declares no validation', () => {
  it('completes without judging anything', () => {
    expect(judgeValidation('none', ran(false)).state).toBe('completed');
    expect(judgeValidation('none', ran(true)).state).toBe('completed');
  });

  it('completes when nothing actually ran, whatever was expected', () => {
    // An empty command list cannot fail, so `fail` must not turn "there was
    // nothing to run" into a problem.
    expect(judgeValidation('fail', ran(false, 0)).state).toBe('completed');
    expect(judgeValidation('pass', ran(false, 0)).state).toBe('completed');
  });
});

describe('the full truth table', () => {
  const cases: Array<[Parameters<typeof judgeValidation>[0], boolean, string]> = [
    ['pass', true, 'completed'],
    ['pass', false, 'review_required'],
    ['fail', true, 'review_required'],
    ['fail', false, 'completed'],
    ['none', true, 'completed'],
    ['none', false, 'completed'],
  ];

  for (const [expectation, passed, state] of cases) {
    it(`${expectation} + ${passed ? 'passed' : 'failed'} → ${state}`, () => {
      expect(judgeValidation(expectation, ran(passed)).state).toBe(state);
    });
  }
});
