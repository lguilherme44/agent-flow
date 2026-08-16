import type { ReviewResult } from '@contracts/index.js';

export type ReviewFreshnessStatus =
  | 'current'
  | 'stale'
  | 'pending_head_review'
  | 'intermediate_diagnostic';

export interface ReviewFreshnessAssessment {
  readonly status: ReviewFreshnessStatus;
  readonly label: string;
  readonly tone: 'success' | 'warning' | 'info' | 'faint';
  readonly explanation: string;
}

/**
 * Assesses review artifact freshness based on exact deterministic facts:
 * - review.planHash vs approvedPlanHash
 * - review.verdict
 * - review.independence
 */
export function assessReviewFreshness(params: {
  readonly review: Partial<ReviewResult> | undefined;
  readonly approvedPlanHash: string | undefined;
  readonly stage?: string;
}): ReviewFreshnessAssessment {
  const { review, approvedPlanHash, stage } = params;

  if (!review) {
    return {
      status: 'pending_head_review',
      label: 'Pending Review',
      tone: 'warning',
      explanation: 'No review artifact has been generated for this stage yet.',
    };
  }

  // If the review has a recorded planHash and an approved plan hash exists
  if (review.planHash && approvedPlanHash) {
    if (review.planHash === approvedPlanHash) {
      return {
        status: 'current',
        label: 'Current',
        tone: 'success',
        explanation: 'Review is verified against the current approved plan hash.',
      };
    } else {
      return {
        status: 'stale',
        label: 'Stale (Plan Changed)',
        tone: 'warning',
        explanation: `Review was evaluated on plan hash ${review.planHash.slice(0, 8)}, but approved plan is ${approvedPlanHash.slice(0, 8)}.`,
      };
    }
  }

  if (stage === 'verification' || stage === 'final-review') {
    return {
      status: 'current',
      label: 'Current Head',
      tone: 'success',
      explanation: 'Review was executed on integration head.',
    };
  }

  return {
    status: 'intermediate_diagnostic',
    label: 'Diagnostic',
    tone: 'info',
    explanation: 'Intermediate review artifact recorded during execution.',
  };
}
