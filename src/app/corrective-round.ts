import { recordCorrectiveRound } from './autonomy-budget.js';
import { repairCorrectivePlan } from '../core/corrective-plan-repair.js';
import { decideCorrectivePlanRepair } from '../core/recovery-policy.js';
import type { RecoveryConfig } from '../contracts/index.js';
import type { Plan, ReviewResult, Task } from '../contracts/index.js';
import { applyFixes } from '../core/corrective-plan.js';
import {
  evaluateRound,
  type EnvelopeContext,
  type RoundBudget,
  type RoundVerdict,
} from '../core/corrective-envelope.js';
import type { ProviderOf } from '../core/independence.js';
import type { ValidationRegistry } from '../core/validation-registry.js';
import { PlanReviewService, stageRunnersOf } from './plan-review-service.js';
import { checkPlan } from './stages/planning-checks.js';
import type { StageRunner } from './stage-runner.js';
import type { StateStore } from './state-store.js';

export interface CorrectiveRoundOptions {
  readonly store: StateStore;
  readonly stageRunner: StageRunner;
  readonly providerOf: ProviderOf;
  readonly runId: string;
  readonly plan: Plan;
  /** The review whose findings become work. */
  readonly finalReview: ReviewResult;
  /** Which review produced them — carried onto every corrective task. */
  readonly origin: 'verification' | 'final-review';
  readonly sdd: string;
  readonly architectureImpact: string;
  readonly validation: ValidationRegistry;
  /**
   * AD-47's budget, as configuration rather than a number.
   *
   * The whole `recovery` block, because `decideCorrectivePlanRepair` is the table that owns
   * this decision and it takes the config. Passing a bare count would put the comparison
   * here as well as there, and the copy that drifted would be the one deciding whether a
   * machine keeps rewriting a plan. Absent restores the one-shot behaviour exactly.
   */
  readonly recovery?: RecoveryConfig;
  /**
   * What this approval already covers (AD-46). Absent means "reopen approval", which is
   * the behaviour every caller had before AR-05b — a caller that cannot compute the
   * envelope must not be given the benefit of it.
   */
  readonly envelope?: {
    readonly context: EnvelopeContext;
    readonly budget: RoundBudget;
  };
}

export type CorrectiveRound =
  | { readonly outcome: 'nothing_actionable' }
  /** The corrected plan failed the checks a plan must pass before review. */
  | { readonly outcome: 'invalid_plan'; readonly problems: string[] }
  | {
      readonly outcome: 'applied';
      readonly plan: Plan;
      readonly added: Task[];
      /** Whether the approval survived, and why (C-18). */
      readonly envelope?: RoundVerdict;
      readonly review: ReviewResult;
    };

/**
 * Turns findings into a corrected plan, and takes that plan through the gate.
 *
 * The half that was missing is the second one. Appending FIX tasks changes the
 * plan, which changes its hash, which correctly invalidates the approval — and
 * left the run holding a plan review that described the *previous* document. The
 * gate then refused, and the documented way forward was `approve --force`.
 *
 * `--force` records a guarantee deliberately abandoned. Requiring it on every
 * corrective round meant the ordinary path through the workflow was one where
 * the review gate did not hold, and the run said so in its own degradations.
 *
 * So the corrected plan is reviewed like any other plan, by the same service the
 * planning pipeline uses. Nothing about independence, provenance, hashing or
 * artifact persistence is duplicated here.
 */
export async function runCorrectiveRound(
  options: CorrectiveRoundOptions,
): Promise<CorrectiveRound> {
  const { store, runId, plan } = options;

  const next = applyFixes(plan, options.finalReview, {
    validation: options.validation.ids,
    origin: options.origin,
  });

  const added = next.tasks.slice(plan.tasks.length);
  if (added.length === 0) return { outcome: 'nothing_actionable' };

  // The same mechanical checks a freshly planned document must pass. A
  // corrective plan that fails them is a defect in the generator, and shipping
  // it to a reviewer would spend a call to be told so.
  //
  // **Repaired rather than surrendered** (AD-47, C-16). This used to be one-shot: `checkPlan`
  // fails, the round returns `invalid_plan`, and a person writes the revision. AD-42 exists
  // to stop generating the plans that failed in the evidence run, and this loop exists for
  // the residue — "AD-42 is complete" is not a claim worth betting a stuck run on. The
  // repairs are a closed mechanical set, every one of them legible in the resulting plan,
  // and a model never authors one.
  const repaired = await repairUntilValid(next, added, options);
  if (repaired.problems.length > 0) {
    await store.appendEvent(runId, 'corrective_plan_rejected', {
      problems: repaired.problems,
      repairsAttempted: repaired.attempts,
    });
    return { outcome: 'invalid_plan', problems: repaired.problems };
  }

  const accepted = repaired.plan;
  await store.writeArtifact(runId, 'plan', `${JSON.stringify(accepted, null, 2)}\n`);

  // **Does this approval already cover these fixes?** (AD-46, C-18, I-25)
  //
  // This used to clear `approved` unconditionally, for a sound reason: a human approved a
  // set of tasks and this is a different set. AD-46's claim is that "different set" is
  // measurable — a fix touching only files this run already changed, citing only
  // requirements the SDD already declares, adding no contract and no validation id is the
  // same agreement executed correctly.
  //
  // Evaluated *before* anything is cleared, so a run whose corrective work falls outside
  // behaves exactly as it did. The envelope only ever narrows what a person approved, and
  // every verdict is persisted so the run can always show why it did not ask.
  const envelope =
    options.envelope === undefined
      ? undefined
      : evaluateRound(
          added.map((task) => ({
            id: task.id,
            files: task.files.likely,
            requirements: task.requirements,
            validation: task.validation,
          })),
          options.envelope.context,
          options.envelope.budget,
        );

  await store.appendEvent(runId, 'corrective_envelope_evaluated', {
    origin: options.origin,
    ...(envelope === undefined
      ? { evaluated: false, reason: 'no envelope was supplied, so approval is reopened' }
      : {
          evaluated: true,
          mayProceed: envelope.mayProceed,
          exhausted: envelope.exhausted,
          reason: envelope.reason,
          tasks: envelope.evaluations.map((verdict) => ({
            id: verdict.id,
            inside: verdict.inside,
            ...(verdict.failed === undefined ? {} : { failed: verdict.failed }),
            reason: verdict.reason,
          })),
        }),
  });

  // Approval is cleared *before* the review runs, not after. A crash in between
  // must not leave a run approved for a plan nobody approved — the failure mode
  // the hash exists to prevent, reintroduced by ordering.
  //
  // Kept only for a round the envelope did not clear. I-25: no corrective round proceeds
  // without human approval unless every one of its tasks is inside and the budget holds.
  if (envelope?.mayProceed !== true) {
    await store.updateRun(runId, (current) => ({
      ...current,
      approved: false,
      approvedAt: undefined,
      approvedPlanHash: undefined,
      status: 'running',
    }));
  }

  // The counter `evaluateRound` reads to bound the next round. It was read and never
  // written, so every round compared 0 against `maxCorrectiveRounds` and a plan could
  // produce corrective rounds indefinitely (C-22).
  await recordCorrectiveRound(store, runId);

  await store.appendEvent(runId, 'corrective_plan_created', {
    added: added.map((task) => task.id),
    origin: options.origin,
    approvalKept: envelope?.mayProceed === true,
  });

  const service = new PlanReviewService({
    store,
    stageRunner: options.stageRunner,
    providerOf: options.providerOf,
  });

  const review = await service.review({
    runId,
    plan: accepted,
    sdd: options.sdd,
    architectureImpact: options.architectureImpact,
    authors: await correctivePlanAuthors(options),
  });

  // A round the envelope cleared is already approved, so it goes back to running rather
  // than to a gate: sending it to `waiting_for_approval` would ask for the approval this
  // milestone just proved it already has. A rejected plan still stops, whatever the
  // envelope said — the reviewer's objection is semantic, and I-25 does not overrule it.
  await store.updateRun(runId, (current) => ({
    ...current,
    status:
      review.verdict === 'PASS'
        ? envelope?.mayProceed === true
          ? 'running'
          : 'waiting_for_approval'
        : 'plan_rejected',
  }));

  return {
    outcome: 'applied',
    plan: accepted,
    added,
    ...(envelope === undefined ? {} : { envelope }),
    review,
  };
}

/**
 * Who wrote the document now under review.
 *
 * A corrective plan has two authors. The original tasks came from the planner;
 * the FIX tasks are a transcription of findings written by the reviewer that
 * produced them. A plan review run by that reviewer's provider would be judging
 * conclusions it reached itself — a fresh context, but not an independent one —
 * and the artifact must not claim otherwise.
 *
 * The planner is read from the event log, where it is recorded as the runner
 * that actually executed the planning stage.
 */
async function correctivePlanAuthors(options: CorrectiveRoundOptions): Promise<string[]> {
  const events = await options.store.readEvents(options.runId);
  const planners = stageRunnersOf(events, 'planning');

  return [...new Set([...planners, options.finalReview.reviewer.runner])];
}

/**
 * Repair and re-validate, up to `maxCorrectivePlanRepairs` (AD-47).
 *
 * Terminates on three conditions, and every one of them is checked: the plan validates, the
 * repair produced nothing new, or the budget is spent. The middle one matters most — a
 * repair loop that reports progress without making any is exactly the loop C-22 exists to
 * terminate, and "the plan still fails and nothing changed" is the signal that says so.
 */
async function repairUntilValid(
  plan: Plan,
  added: readonly Task[],
  options: CorrectiveRoundOptions,
): Promise<{ plan: Plan; problems: string[]; attempts: number }> {
  const correctiveIds = added.map((task) => task.id);
  const recovery = options.recovery;

  let current = plan;
  let problems = checkPlan(current, options.sdd, options.validation);
  let attempts = 0;

  while (
    problems.length > 0 &&
    recovery !== undefined &&
    decideCorrectivePlanRepair({ repairsUsed: attempts, config: recovery })
      .mayProceedAutomatically
  ) {
    const repaired = repairCorrectivePlan(current, {
      correctiveIds,
      validation: {
        ids: options.validation.ids,
        // The project's own default set, never an invented id. A validation id that does
        // not resolve fails the task for the wrong reason.
        defaults: options.validation.ids.filter((id) => id === 'test'),
      },
    });

    // Nothing mechanical applied. Another pass would produce the identical plan and the
    // identical problems, which is a loop rather than a repair.
    if (repaired.applied.length === 0) break;

    attempts += 1;
    current = repaired.plan;
    problems = checkPlan(current, options.sdd, options.validation);

    await options.store.appendEvent(options.runId, 'corrective_plan_repaired', {
      attempt: attempts,
      applied: repaired.applied,
      remaining: problems.length,
    });
  }

  return { plan: current, problems, attempts };
}
