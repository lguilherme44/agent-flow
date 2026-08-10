import type { Task, TaskState } from '../contracts/index.js';

/**
 * Judges a validation run against what the task expected of it.
 *
 * Pulled out of the executor and made pure because the interesting cases are
 * the asymmetric ones, and they are easy to get subtly wrong: a RED task that
 * goes green is a problem, not a success, and the obvious implementation reads
 * "expected fail, did not fail — fine, carry on".
 *
 * Nothing here decides whether a *command* was right to fail. `fail` means the
 * validation as a whole was expected not to pass; it does not distinguish a new
 * test failing (intended) from a lint error (not). That limitation is real and
 * accepted: telling them apart would mean per-command expectations, and a task
 * whose lint is broken will be caught by the verification stage anyway.
 */

export interface ValidationJudgement {
  readonly state: Extract<TaskState, 'completed' | 'review_required'>;
  /** Present when the outcome needs a person to look at it. */
  readonly note?: string;
}

export function judgeValidation(
  expectation: Task['validationExpectation'],
  outcome: { readonly passed: boolean; readonly ran: number },
): ValidationJudgement {
  if (expectation === 'none' || outcome.ran === 0) {
    return { state: 'completed' };
  }

  if (expectation === 'pass') {
    return outcome.passed
      ? { state: 'completed' }
      : {
          state: 'review_required',
          note: 'validation failed',
        };
  }

  // expectation === 'fail': the task is done when the check does not pass.
  return outcome.passed
    ? {
        state: 'review_required',
        // The failure mode a naive implementation would call success.
        note:
          'validation was expected to fail and passed — either the test asserts ' +
          'nothing, or the behaviour it describes already exists',
      }
    : { state: 'completed' };
}
