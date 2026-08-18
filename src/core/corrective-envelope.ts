import { outsideScope } from './acceptance.js';

/**
 * What an approval already authorised (AD-46, C-18, I-25).
 *
 * `runCorrectiveRound` cleared `approved` unconditionally, and the reason was sound: a
 * human approved a set of tasks, and a corrective round is a different set. AD-46's claim
 * is that **"different set" is measurable**. A fix that touches only files this run has
 * already changed, cites only requirements the SDD already declares, adds no contract and
 * declares no new validation id is not a different agreement — it is the same agreement,
 * executed correctly.
 *
 * Four properties make moving this gate safe, and all four are structural rather than
 * procedural:
 *
 * - the envelope is **mechanical** and cannot be argued into — no model is consulted here,
 *   and §5's `Authority` column says none may be;
 * - it can only ever **narrow** what a human already approved, never widen it;
 * - it is **bounded** by the corrective-round budget;
 * - every evaluation is **persisted**, so a run can always show why it did not ask.
 *
 * **A corrective task may never grant a permission and may never change a Git safety
 * rule.** Neither is expressible as a task in the first place — permissions come from a
 * runner's own configuration and Git safety lives in the adapter — and conditions 1 and 3
 * keep a task from reaching the files where either is declared.
 */

/** Which condition refused. Named, because an escalation has to say what to look at. */
export type EnvelopeCondition = 'contract' | 'files' | 'requirements' | 'validation';

export interface EnvelopeVerdict {
  readonly id: string;
  readonly inside: boolean;
  /** Present only when `inside` is false. */
  readonly failed?: EnvelopeCondition;
  /** What was outside, named. */
  readonly detail?: string;
  /** Why this verdict, in one sentence. Persisted either way (C-18). */
  readonly reason: string;
}

export interface EnvelopeContext {
  /** Every path this run has already changed, from the integration diff. */
  readonly touchedFiles: readonly string[];
  /** Requirement ids the approved SDD declares. */
  readonly declaredRequirements: readonly string[];
  /** Validation ids the project configuration defines. */
  readonly declaredValidationIds: readonly string[];
  /** Path prefixes that hold contracts. A new file under one is a new agreement. */
  readonly contractPaths: readonly string[];
}

export interface CorrectiveCandidate {
  readonly id: string;
  readonly files: readonly string[];
  readonly requirements: readonly string[];
  readonly validation: readonly string[];
}

/**
 * One corrective task against the envelope.
 *
 * Conditions are evaluated **most-structural first** and the first failure is the one
 * reported: a contract addition is a bigger fact than a stray file, and an escalation that
 * listed four reasons would leave a person deciding which one mattered.
 */
export function evaluateEnvelope(
  task: CorrectiveCandidate,
  context: EnvelopeContext,
): EnvelopeVerdict {
  // 3. No *new* file under a contract path. Editing one the run already changed is inside
  //    the same agreement; adding one changes the shape everything else agrees on.
  const newContract = task.files.filter(
    (file) =>
      context.contractPaths.some((prefix) => normalise(file).startsWith(normalise(prefix))) &&
      !context.touchedFiles.map(normalise).includes(normalise(file)),
  );
  if (newContract.length > 0) {
    return refuse(task.id, 'contract', newContract, 'introduces a contract file this run has not touched');
  }

  // 1. Files ⊆ what this run has already changed. Segment-aware through the same helper
  //    the scope assertion uses, so "inside" means one thing in both places.
  const strayFiles = outsideScope(task.files, context.touchedFiles);
  if (strayFiles.length > 0) {
    return refuse(task.id, 'files', strayFiles, 'would change a file this run has not touched');
  }

  // 2. Requirements ⊆ what the approved SDD declares.
  const strayRequirements = task.requirements.filter(
    (id) => !context.declaredRequirements.includes(id),
  );
  if (strayRequirements.length > 0) {
    return refuse(
      task.id,
      'requirements',
      strayRequirements,
      'cites a requirement the approved SDD does not declare',
    );
  }

  // 4. No new validation id. A new id is a new claim about how the work is judged, and the
  //    registry it would have to resolve against is human-authored configuration.
  const strayValidation = task.validation.filter(
    (id) => !context.declaredValidationIds.includes(id),
  );
  if (strayValidation.length > 0) {
    return refuse(
      task.id,
      'validation',
      strayValidation,
      'declares a validation id the project does not define',
    );
  }

  return {
    id: task.id,
    inside: true,
    reason:
      `inside the envelope: every file it declares was already touched by this run, ` +
      `every requirement it cites is declared by the approved SDD, it adds no contract ` +
      `and no validation id`,
  };
}

export interface RoundBudget {
  readonly correctiveRoundsUsed: number;
  readonly maxCorrectiveRounds: number;
}

export interface RoundVerdict {
  /** True only when the round may execute with no new human gate. */
  readonly mayProceed: boolean;
  /** True when the approval must be cleared and the round wait for a person. */
  readonly clearsApproval: boolean;
  /** True when the corrective budget, not the envelope, is what stopped it. */
  readonly exhausted: boolean;
  /** Every task's verdict, in order — persisted whichever way each one went (C-18). */
  readonly evaluations: readonly EnvelopeVerdict[];
  /** The first task that fell outside, when one did. */
  readonly outside?: EnvelopeVerdict;
  readonly reason: string;
  /** The one action, when a person is needed (AR §3.6). */
  readonly humanAction?: string;
}

/**
 * The round as a whole (C-18).
 *
 * **Any task outside puts the entire round back through approval**, not just that task:
 * the tasks were generated together against one set of findings, and executing the
 * inside-ones while a person considers the rest would be executing half an agreement.
 *
 * An empty round never proceeds. "Every task is inside" is vacuously true of an empty set,
 * which is precisely the shape that quietly turns a guard into a bypass.
 */
export function evaluateRound(
  tasks: readonly CorrectiveCandidate[],
  context: EnvelopeContext,
  budget: RoundBudget,
): RoundVerdict {
  const evaluations = tasks.map((task) => evaluateEnvelope(task, context));

  if (budget.correctiveRoundsUsed >= budget.maxCorrectiveRounds) {
    return {
      mayProceed: false,
      clearsApproval: true,
      exhausted: true,
      evaluations,
      reason:
        `the corrective budget is spent: ${String(budget.correctiveRoundsUsed)} of ` +
        `${String(budget.maxCorrectiveRounds)} rounds used`,
      humanAction:
        'Read the findings this round would have acted on, then decide whether the run is worth another',
    };
  }

  if (tasks.length === 0) {
    return {
      mayProceed: false,
      clearsApproval: false,
      exhausted: false,
      evaluations,
      reason: 'the round produced no corrective tasks, so there is nothing to authorise',
    };
  }

  const outside = evaluations.find((verdict) => !verdict.inside);
  if (outside !== undefined) {
    return {
      mayProceed: false,
      clearsApproval: true,
      exhausted: false,
      evaluations,
      outside,
      reason:
        `${outside.id} is outside what this approval covers — it ${outside.reason} ` +
        `(${outside.detail ?? 'no detail'})`,
      humanAction: `Review ${outside.id} and approve the corrected plan if it is what you want`,
    };
  }

  return {
    mayProceed: true,
    clearsApproval: false,
    exhausted: false,
    evaluations,
    reason:
      `all ${String(tasks.length)} corrective task(s) are inside the envelope this ` +
      `approval already covers, and the corrective budget holds`,
  };
}

function refuse(
  id: string,
  failed: EnvelopeCondition,
  offending: readonly string[],
  what: string,
): EnvelopeVerdict {
  return {
    id,
    inside: false,
    failed,
    detail: offending.join(', '),
    reason: `${what}: ${offending.join(', ')}`,
  };
}

function normalise(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}
