import type { TaskState } from '../contracts/index.js';
import { declareValidationRemedy } from './validation-registry.js';

/**
 * Definition of Done (§42).
 *
 * Evaluated as code, never as an opinion. The spec is blunt about why: "do not
 * consider only: agent said completed". Every condition here is a fact someone
 * can check — a task state, an exit code, a recorded verdict — so a feature
 * cannot be declared finished because the last thing to speak was confident.
 */

/**
 * What the project's own commands said (AD-45).
 *
 * **Three values, and the third is the one that was missing.** `NOT_RUN` means the
 * commands could not be run at all — an unprepared workspace, a failed install — and it is
 * not the same news as `FAIL`. The evidence run collapsed them: four `exit 127`s from a
 * tree nobody had installed into were read as a verdict on the code, and rendered beneath
 * a headline saying `PASS`.
 */
export type MechanicalVerification = 'PASS' | 'FAIL' | 'NOT_RUN';

export interface DoneInput {
  readonly approved: boolean;
  readonly taskStates: readonly TaskState[];
  readonly mechanicalVerification: MechanicalVerification;
  readonly finalReviewVerdict: 'PASS' | 'FAIL' | null;
  /**
   * Blocking code-review findings still open, by id (§43, I-44).
   *
   * **A run could be `completed` with one of these open.** The run-level review is a single
   * verdict about the whole tree; M6's per-task reviews are separate statements, and this
   * check knew nothing about them — so a reviewer could raise a `critical` on integrated
   * work and the Definition of Done would still say done, because the four conditions it
   * knew about all held.
   *
   * Not suppressed when the commands could not run, unlike the review verdict above. That
   * suppression exists because a model's verdict formed against a broken environment is
   * not a conclusion about the code; a defect someone *observed in the diff* is one either
   * way.
   *
   * Absent means none, which is exactly how every pre-M6 run behaves.
   */
  readonly openBlockingFindings?: readonly string[];
  /**
   * Every gate the plan's tasks list in `validation`, with its verdict (FR-025, FR-026).
   *
   * **The final review runs four standard commands and nothing else,** so a
   * `validationCommands` entry the plan required was run by the tasks listing it or by
   * nobody — and a task whose expectation is `none` runs nothing and is still recorded as
   * passing. Without this the run could say FEATURE COMPLETE over a gate that never ran.
   *
   * Computed by `judgeRequiredGates`. Absent or empty adds no condition, so a plan that
   * lists no gate is judged exactly as before.
   */
  readonly requiredGates?: readonly RequiredGateVerdict[];
}

/** One required gate as the Definition of Done reads it; the shape `judgeRequiredGates` returns. */
export interface RequiredGateVerdict {
  readonly id: string;
  readonly verdict: MechanicalVerification;
  readonly tasks: readonly string[];
  readonly reason?: string;
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
      met: input.mechanicalVerification === 'PASS',
      // The distinction the evidence run collapsed. "Your build is broken" and "we could
      // not run your build" send a person to two different places, and only one of them is
      // a statement about the code.
      ...(input.mechanicalVerification === 'NOT_RUN'
        ? {
            detail:
              'the verification commands did not run — the workspace was not prepared, ' +
              'so this is environment readiness rather than a regression',
          }
        : {}),
    },
    {
      name: 'final review PASS',
      // **Suppressed when the commands could not run** (AD-45). Both model verdicts were
      // formed against an environment that could not answer the question, so neither is a
      // conclusion about the code — and letting a PASS here stand would be exactly the
      // "degraded reads as passing" path the security model forbids.
      met: input.mechanicalVerification !== 'NOT_RUN' && input.finalReviewVerdict === 'PASS',
      ...(input.mechanicalVerification === 'NOT_RUN'
        ? { detail: 'not counted: the review could not have been a conclusion about the code' }
        : input.finalReviewVerdict === null
          ? { detail: 'no final review has run' }
          : {}),
    },
    {
      name: 'no blocking review finding is open',
      met: (input.openBlockingFindings ?? []).length === 0,
      ...((input.openBlockingFindings ?? []).length > 0
        ? {
            detail: `still open: ${(input.openBlockingFindings ?? []).join(', ')}`,
          }
        : {}),
    },
    ...requiredGatesCondition(input.requiredGates ?? []),
  ];

  const missing = conditions.filter((condition) => !condition.met).map((c) => c.name);

  return { done: missing.length === 0, conditions, missing };
}

/**
 * The condition, present only when the plan lists at least one gate (FR-026).
 *
 * Absent rather than trivially met otherwise: the conditions list of a run with no gate is
 * byte-for-byte what it was, which is what every existing reader of it was written against.
 */
function requiredGatesCondition(
  gates: readonly RequiredGateVerdict[],
): Array<{ name: string; met: boolean; detail?: string }> {
  if (gates.length === 0) return [];

  const unmet = gates.filter((gate) => gate.verdict !== 'PASS');
  return [
    {
      name: 'required gates ran and passed',
      met: unmet.length === 0,
      ...(unmet.length > 0 ? { detail: unmet.map(describeUnmetGate).join('; ') } : {}),
    },
  ];
}

/**
 * What each reason means, in the words the detail uses (FR-027).
 *
 * The remedy is the point. "test-deck NOT_RUN" sends nobody anywhere; saying which task
 * held it back and what would make it run does.
 */
const GATE_REASONS: Readonly<Record<string, string>> = {
  not_declared: 'the id is no longer declared in the configuration',
  expectation_none: "a task that lists it has validationExpectation 'none', so it never ran",
  no_result: 'a completed task that lists it has no command result for it',
  no_completed_task: 'no completed task lists it',
  failed: 'its tasks ran it and the validation judgement was not satisfied',
};

function describeUnmetGate(gate: RequiredGateVerdict): string {
  const tasks = gate.tasks.length > 0 ? ` (${gate.tasks.join(', ')})` : '';
  const reason =
    gate.reason === undefined ? '' : `: ${GATE_REASONS[gate.reason] ?? gate.reason}`;
  const remedies = [
    ...(gate.reason === 'not_declared' ? [declareValidationRemedy(gate.id)] : []),
    ...(gate.verdict === 'NOT_RUN'
      ? [
          `to make it run, list "${gate.id}" in a task's validation with ` +
            `validationExpectation 'pass' or 'fail'`,
        ]
      : []),
  ];
  const remedy = remedies.length > 0 ? ` — ${remedies.join('; ')}` : '';
  return `${gate.id} ${gate.verdict}${tasks}${reason}${remedy}`;
}
