import type { Plan, ReviewResult, Task } from '../contracts/index.js';
import { applyFixes } from '../core/corrective-plan.js';
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
}

export type CorrectiveRound =
  | { readonly outcome: 'nothing_actionable' }
  /** The corrected plan failed the checks a plan must pass before review. */
  | { readonly outcome: 'invalid_plan'; readonly problems: string[] }
  | {
      readonly outcome: 'applied';
      readonly plan: Plan;
      readonly added: Task[];
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
  const problems = checkPlan(next, options.sdd, options.validation);
  if (problems.length > 0) {
    await store.appendEvent(runId, 'corrective_plan_rejected', { problems });
    return { outcome: 'invalid_plan', problems };
  }

  await store.writeArtifact(runId, 'plan', `${JSON.stringify(next, null, 2)}\n`);

  // Approval is cleared *before* the review runs, not after. A crash in between
  // must not leave a run approved for a plan nobody approved — the failure mode
  // the hash exists to prevent, reintroduced by ordering.
  await store.updateRun(runId, (current) => ({
    ...current,
    approved: false,
    approvedAt: undefined,
    approvedPlanHash: undefined,
    status: 'running',
  }));

  await store.appendEvent(runId, 'corrective_plan_created', {
    added: added.map((task) => task.id),
    origin: options.origin,
  });

  const service = new PlanReviewService({
    store,
    stageRunner: options.stageRunner,
    providerOf: options.providerOf,
  });

  const review = await service.review({
    runId,
    plan: next,
    sdd: options.sdd,
    architectureImpact: options.architectureImpact,
    authors: await correctivePlanAuthors(options),
  });

  await store.updateRun(runId, (current) => ({
    ...current,
    status: review.verdict === 'PASS' ? 'waiting_for_approval' : 'plan_rejected',
  }));

  return { outcome: 'applied', plan: next, added, review };
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
