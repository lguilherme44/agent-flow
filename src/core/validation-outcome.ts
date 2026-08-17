import type { FailureClass, Task, TaskState } from '../contracts/index.js';

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
  /** The taxonomy's name for this outcome, when it is not a success (AD-36). */
  readonly failureClass?: FailureClass;
}

export interface ValidationOutcome {
  readonly passed: boolean;
  readonly ran: number;
  /**
   * Whether this attempt's mechanical diff is non-empty (C-14).
   *
   * `undefined` means unknowable rather than empty: a sequential run captures no validated
   * tree, so there is nothing to compare. Refusing on an unknown would fail every RED task
   * in sequential mode on the strength of a measurement nobody took.
   */
  readonly changed?: boolean;
}

export function judgeValidation(
  expectation: Task['validationExpectation'],
  outcome: ValidationOutcome,
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
          failureClass: 'validation_unsatisfied',
        };
  }

  // expectation === 'fail': the task is done when the check does not pass.
  if (outcome.passed) {
    return {
      state: 'review_required',
      // The failure mode a naive implementation would call success.
      note:
        'validation was expected to fail and passed — either the test asserts ' +
        'nothing, or the behaviour it describes already exists',
      failureClass: 'validation_unsatisfied',
    };
  }

  // **A red suite is a fact about the repository; "this task reddened it" is a claim**
  // (C-14). The evidence run credited a task for a suite the task before it had already
  // broken: it changed nothing, ran the failing commands, and was recorded satisfied.
  // Only a non-empty diff can support the claim, so an attempt that wrote nothing does not
  // get to borrow somebody else's failure.
  if (outcome.changed === false) {
    return {
      state: 'review_required',
      note:
        'validation failed as expected, but this attempt changed nothing — a suite that ' +
        'was already failing is not evidence that this task made it fail',
      failureClass: 'acceptance_evidence_missing',
    };
  }

  return { state: 'completed' };
}
