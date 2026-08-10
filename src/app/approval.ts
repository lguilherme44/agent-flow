import { createHash } from 'node:crypto';
import type { Plan, ReviewResult, RunState } from '../contracts/index.js';
import type { StateStore } from './state-store.js';

/**
 * Identity of a specific plan.
 *
 * Approval is granted to *this* plan, not to the run. Without a hash, a revise
 * after approval would leave the gate satisfied for something the human never
 * read — which is precisely the failure the gate exists to prevent (§17).
 */
export function planHash(plan: Plan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
}

export type ApprovalRefusal =
  | { kind: 'no_run' }
  | { kind: 'no_plan' }
  | { kind: 'review_missing' }
  /** A review exists, but it names a different plan. */
  | { kind: 'review_stale'; review: ReviewResult }
  /** A review exists and does not say which plan it judged. */
  | { kind: 'review_unverifiable'; review: ReviewResult }
  | { kind: 'review_failed'; review: ReviewResult }
  | { kind: 'already_approved' };

/** Refusals `--force` may override. Every one of them is about the review. */
export const FORCIBLE_REFUSALS: ReadonlySet<ApprovalRefusal['kind']> = new Set([
  'review_missing',
  'review_stale',
  'review_unverifiable',
  'review_failed',
]);

export interface ApprovalCheck {
  readonly allowed: boolean;
  readonly refusal?: ApprovalRefusal;
  /** Present whenever the human should be told something before confirming. */
  readonly warnings: string[];
}

/**
 * Whether approval may proceed, and what the person should know first.
 *
 * `--force` can override a failed review, but never silently: the caller records
 * the override as an event so the decision is attributable afterwards.
 */
export function checkApproval(
  state: RunState | null,
  plan: Plan | null,
  review: ReviewResult | null,
): ApprovalCheck {
  const warnings: string[] = [];

  if (state === null) return { allowed: false, refusal: { kind: 'no_run' }, warnings };
  if (plan === null) return { allowed: false, refusal: { kind: 'no_plan' }, warnings };

  if (state.approved) {
    return { allowed: false, refusal: { kind: 'already_approved' }, warnings };
  }

  // A degraded run is still approvable — but the person approving should know
  // what was lost before they sign off, not discover it in a post-mortem (R-16).
  for (const degradation of state.degradations) {
    warnings.push(`${degradation.reason} — ${degradation.impact}`);
  }

  // A verdict about a different document is not a verdict about this one.
  // `review --fix` appends corrective tasks, and the previous plan review then
  // refused the corrected plan while quoting the very finding a FIX task had
  // been created to resolve.
  //
  // An *absent* hash used to mean "covers whatever it is shown", as a courtesy
  // to reviews written before the field existed. That courtesy is a fabricated
  // relationship: nothing connects such a review to the plan in hand, and the
  // one case it silently permits is precisely the one worth catching. Unverifiable
  // is now its own refusal — forceable, like every other review refusal, but
  // never automatic.
  if (review === null) {
    return { allowed: false, refusal: { kind: 'review_missing' }, warnings };
  }

  if (review.planHash === undefined) {
    return { allowed: false, refusal: { kind: 'review_unverifiable', review }, warnings };
  }

  if (review.planHash !== planHash(plan)) {
    return { allowed: false, refusal: { kind: 'review_stale', review }, warnings };
  }

  if (review.independence === 'same-provider-fresh-context') {
    warnings.push(
      'the plan review was same-provider: it does not protect against an assumption ' +
        'repeated from planning',
    );
  }

  if (review.verdict === 'FAIL') {
    return { allowed: false, refusal: { kind: 'review_failed', review }, warnings };
  }

  return { allowed: true, warnings };
}

/** Records approval against a specific plan. */
export async function approveRun(
  store: StateStore,
  runId: string,
  plan: Plan,
  options: { forced?: boolean } = {},
): Promise<RunState> {
  const hash = planHash(plan);

  // Recorded, not left undefined. The moment a human opened the gate is the
  // one fact an audit trail cannot reconstruct from anything else.
  const approvedAt = store.now();

  const state = await store.updateRun(runId, (current) => ({
    ...current,
    approved: true,
    approvedAt,
    approvedPlanHash: hash,
    status: 'approved',
  }));

  await store.appendEvent(runId, 'run_approved', {
    planHash: hash,
    taskCount: plan.tasks.length,
    forced: options.forced === true,
    approvedAt,
  });

  if (options.forced === true) {
    // The event above is the audit trail; this is what anyone actually reads.
    // `--force` promised to record the override and did — into a log that
    // `status` and the Definition of Done never open, so an approval that
    // overruled a failed review looked identical to one that passed it.
    return store.recordDegradation(runId, {
      kind: 'forced_approval',
      reason: 'the plan was approved with --force, over a failed or missing review',
      impact:
        'the review gate did not hold for this run: whatever the reviewer objected to ' +
        'was accepted by a person rather than resolved',
    });
  }

  return state;
}

/**
 * Whether an approval still applies to the plan on disk.
 *
 * Checked before execution: if the plan changed after approval, the gate was
 * satisfied for a different document and has to be satisfied again.
 */
export function approvalCoversPlan(state: RunState, plan: Plan): boolean {
  return state.approved && state.approvedPlanHash === planHash(plan);
}
