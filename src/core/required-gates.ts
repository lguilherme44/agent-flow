import type { Task, TaskState } from '../contracts/index.js';
import type { MechanicalVerification } from './definition-of-done.js';
import { judgeValidation } from './validation-outcome.js';

/**
 * Which gates a plan requires, and whether each one ran and passed (FR-025 to FR-029).
 *
 * **A run could report FEATURE COMPLETE with a gate its plan required that never ran.** The
 * final review runs only `lint · typecheck · test · build`, so a `validationCommands` entry
 * is run by the tasks that list it or by nobody; and a task whose expectation is `none`
 * records `{ passed: true, commands: [] }`, which `judgeValidation` reads as completed. A
 * gate listed only by such a task was never executed, and nothing between the plan and the
 * Definition of Done noticed.
 *
 * Pure: the plan's tasks, what each completed task's `result.json` recorded, and what the
 * registry still declares, in; one verdict per gate, out.
 */

/** Why a gate is not `PASS` (FR-027). English, as every Definition of Done detail is. */
export type RequiredGateReason =
  | 'not_declared'
  | 'expectation_none'
  | 'no_result'
  | 'no_completed_task'
  | 'failed';

/** A task of the current plan, corrective tasks included, with the state it is in. */
export interface GateTask {
  readonly id: string;
  readonly state: TaskState;
  readonly validation: readonly string[];
  readonly validationExpectation: Task['validationExpectation'];
}

/** What a completed task's `result.json` recorded of its validation run. */
export interface GateEvidence {
  readonly passed: boolean;
  readonly expectation: Task['validationExpectation'];
  /** Only the count and the positions matter here; ids map to results by position. */
  readonly commands: readonly unknown[];
}

export interface RequiredGate {
  readonly id: string;
  readonly verdict: MechanicalVerification;
  /**
   * The tasks the verdict is about: every task listing the gate when it passed or when the
   * reason concerns them all, otherwise only the ones responsible — a person told
   * "TASK-001, TASK-004, TASK-007" when one of them is the problem has three places to look.
   */
  readonly tasks: readonly string[];
  readonly reason?: RequiredGateReason;
}

/**
 * One verdict per gate in the union of every task's `validation`, ids sorted (FR-025).
 *
 * `requiredEvidence` adds no gate: nothing runs it, so a gate taken from it would be
 * `NOT_RUN` forever. The plan check refuses such an id instead (FR-024).
 *
 * **Judged per task, not per command** (FR-029). A task's validation is judged as a whole —
 * a RED task expecting `fail` is satisfied when the list as a whole did not pass — so its
 * one failing `test` satisfies the `lint` and `typecheck` it also lists. Judging each exit
 * code would call that RED task's intended failure a failed `test` gate; the operator chose
 * the existing judgement over a second, per-command one.
 */
export function judgeRequiredGates(
  tasks: readonly GateTask[],
  results: ReadonlyMap<string, GateEvidence>,
  has: (id: string) => boolean,
): RequiredGate[] {
  const ids = [...new Set(tasks.flatMap((task) => task.validation))].sort();

  return ids.map((id) => {
    const listing = tasks.filter((task) => task.validation.includes(id));
    const all = listing.map((task) => task.id);

    // A gate the configuration no longer declares cannot have run under this configuration,
    // whatever an older `result.json` says — the command behind the id is gone.
    if (!has(id)) return notRun(id, all, 'not_declared');

    // Any listing task, completed or not: a `none` task never runs its validation, so it
    // will not produce the evidence however long the run waits.
    const none = listing.filter((task) => task.validationExpectation === 'none');
    if (none.length > 0) return notRun(id, none.map((task) => task.id), 'expectation_none');

    // A task not yet completed is the "all tasks completed" condition's business; here it
    // neither passes nor blocks a gate, since its evidence does not exist yet.
    const completed = listing.filter((task) => task.state === 'completed');
    if (completed.length === 0) return notRun(id, all, 'no_completed_task');

    // FR-028: executed when the result holds an entry at the gate's position. A missing
    // `result.json` and one shorter than `validation` are the same fact — no entry.
    const executed: Array<{ task: string; evidence: GateEvidence }> = [];
    const unexecuted: string[] = [];
    for (const task of completed) {
      const evidence = results.get(task.id);
      if (evidence !== undefined && evidence.commands[task.validation.indexOf(id)] !== undefined) {
        executed.push({ task: task.id, evidence });
      } else {
        unexecuted.push(task.id);
      }
    }
    if (unexecuted.length > 0) return notRun(id, unexecuted, 'no_result');

    // The recorded expectation and count, as the executor judged the task when it ran — so
    // an operator-accepted task whose validation was not satisfied makes its gates FAIL.
    const unsatisfied = executed.filter(
      ({ evidence }) =>
        judgeValidation(evidence.expectation, {
          passed: evidence.passed,
          ran: evidence.commands.length,
        }).state !== 'completed',
    );
    if (unsatisfied.length > 0) {
      return { id, verdict: 'FAIL', tasks: unsatisfied.map(({ task }) => task), reason: 'failed' };
    }

    return { id, verdict: 'PASS', tasks: completed.map((task) => task.id) };
  });
}

function notRun(id: string, tasks: readonly string[], reason: RequiredGateReason): RequiredGate {
  return { id, verdict: 'NOT_RUN', tasks, reason };
}
