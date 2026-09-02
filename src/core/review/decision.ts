import { severityAtLeast } from '../../contracts/index.js';
import type {
  FindingSeverity,
  QualityConfig,
  QualityGateResult,
  ReviewRecord,
} from '../../contracts/index.js';
import type { ProjectedFinding } from './findings.js';
import { unsatisfiedRequired } from './gates.js';

/**
 * Whether this change may proceed (M6-08, §43, I-44).
 *
 * **A reviewer's `approve` is a proposal; this is the decision.** The distinction is the
 * milestone: a model may say the code is fine, QA may say it looks good, and neither
 * passes a gate. What passes a gate is a command Agent Flow executed and an exit code it
 * read.
 *
 * Four conditions, and each is a fact rather than an opinion:
 *
 * ```text
 * every required gate for this change   passed
 * no open finding of blocking severity
 * the latest review                     approve
 * that review read                      the tree now integrated
 * ```
 *
 * The fourth is the one that is easy to leave out and expensive to leave out. A review
 * that approved a tree which has since changed has approved something that no longer
 * exists (I-41), and a gate that accepted it would be approving work nobody looked at.
 *
 * Pure: facts in, a verdict and its reasons out. Nothing here runs a command or reads a
 * file — it weighs what other things already recorded.
 */

export interface QualityDecisionInput {
  readonly reviews: readonly ReviewRecord[];
  readonly findings: readonly ProjectedFinding[];
  readonly gates: readonly QualityGateResult[];
  readonly quality: QualityConfig;
  /** The commit this change is integrated as. Absent in sequential mode. */
  readonly integratedTree?: string;
}

export interface QualityDecision {
  readonly approved: boolean;
  /** Each condition and whether it holds, in the order they are listed above. */
  readonly conditions: readonly { name: string; met: boolean; detail?: string }[];
  /** Just the unmet ones, for a terse line. */
  readonly blockedBy: readonly string[];
}

export function decideQuality(input: QualityDecisionInput): QualityDecision {
  const latest = latestReview(input.reviews);
  const failing = unsatisfiedRequired(input.gates);
  const blocking = blockingFindings(input.findings, input.quality);

  const stale =
    latest !== undefined &&
    input.integratedTree !== undefined &&
    latest.reviewedTree !== undefined &&
    latest.reviewedTree !== input.integratedTree;

  const conditions = [
    {
      name: 'every required quality gate passed',
      met: failing.length === 0,
      ...(failing.length === 0
        ? {}
        : {
            detail: failing
              .map((gate) => `${gate.gateId} ${gate.status.replace('_', ' ')}`)
              .join(', '),
          }),
    },
    {
      name: 'no blocking finding is open',
      met: blocking.length === 0,
      ...(blocking.length === 0
        ? {}
        : {
            detail: blocking
              .map((held) => `${held.finding.id} ${held.finding.severity} (${held.status})`)
              .join(', '),
          }),
    },
    {
      name: 'the review approves',
      met: latest?.verdict === 'approve',
      ...(latest === undefined
        ? { detail: 'no review has been recorded for this change' }
        : latest.verdict === 'approve'
          ? {}
          : { detail: `the latest review says ${latest.verdict}` }),
    },
    {
      name: 'the review read the tree that is integrated',
      met: !stale,
      // Identity, never a timestamp: a review written after a change can still have read
      // what came before it.
      ...(stale
        ? {
            detail:
              `${latest?.id ?? 'the review'} read ${short(latest?.reviewedTree)} and ` +
              `${short(input.integratedTree)} is integrated — it is stale`,
          }
        : {}),
    },
  ];

  return {
    approved: conditions.every((condition) => condition.met),
    conditions,
    blockedBy: conditions.filter((condition) => !condition.met).map((condition) => condition.name),
  };
}

/**
 * The findings that stop this change (§44).
 *
 * `critical` and `high` always. `medium` when the operator says so, which it does by
 * default. `low` and `info` never.
 *
 * **A `verified` finding does not block, and a `fixed` one does.** Fixed means corrective
 * work integrated; verified means somebody looked at the result. Between the two there is
 * a change nobody has read, and reading it is what the re-review is for.
 */
export function blockingFindings(
  findings: readonly ProjectedFinding[],
  quality: QualityConfig,
): ProjectedFinding[] {
  const threshold: FindingSeverity = quality.blockOnMedium ? 'medium' : 'high';

  return findings.filter(
    (held) =>
      held.status !== 'verified' && severityAtLeast(held.finding.severity, threshold),
  );
}

/**
 * The review that counts: the highest round recorded for this change.
 *
 * By round rather than by position, because the log is append-only and a re-review is a
 * new record — and by round rather than by timestamp, for the reason freshness is:
 * a clock is not an ordering anybody can rely on.
 */
export function latestReview(reviews: readonly ReviewRecord[]): ReviewRecord | undefined {
  return reviews.reduce<ReviewRecord | undefined>(
    (best, review) => (best === undefined || review.round > best.round ? review : best),
    undefined,
  );
}

function short(tree: string | undefined): string {
  return tree === undefined ? 'nothing' : tree.slice(0, 8);
}
