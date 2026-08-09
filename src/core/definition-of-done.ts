import type { TaskState } from '../contracts/index.js';

/**
 * Definition of Done (§42).
 *
 * Evaluated as code, never as an opinion. The spec is blunt about why: "do not
 * consider only: agent said completed". Every condition here is a fact someone
 * can check — a task state, an exit code, a recorded verdict — so a feature
 * cannot be declared finished because the last thing to speak was confident.
 */

export interface DoneInput {
  readonly approved: boolean;
  readonly taskStates: readonly TaskState[];
  readonly verificationPassed: boolean;
  readonly finalReviewVerdict: 'PASS' | 'FAIL' | null;
}

export interface DoneCheck {
  readonly done: boolean;
  /** Each condition and whether it holds, in the order the spec lists them. */
  readonly conditions: Array<{ name: string; met: boolean; detail?: string }>;
  /** Just the unmet ones, for a terse message. */
  readonly missing: string[];
}

export function checkDefinitionOfDone(input: DoneInput): DoneCheck {
  const incomplete = input.taskStates.filter((state) => state !== 'completed');

  const conditions = [
    {
      name: 'SDD approved',
      met: input.approved,
    },
    {
      name: 'all tasks completed',
      met: input.taskStates.length > 0 && incomplete.length === 0,
      ...(incomplete.length > 0
        ? { detail: `${String(incomplete.length)} task(s) not completed` }
        : input.taskStates.length === 0
          ? { detail: 'no tasks were run' }
          : {}),
    },
    {
      name: 'lint, tests and build passing',
      met: input.verificationPassed,
    },
    {
      name: 'final review PASS',
      met: input.finalReviewVerdict === 'PASS',
      ...(input.finalReviewVerdict === null ? { detail: 'no final review has run' } : {}),
    },
  ];

  const missing = conditions.filter((condition) => !condition.met).map((c) => c.name);

  return { done: missing.length === 0, conditions, missing };
}
