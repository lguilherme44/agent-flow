import type { ReviewResult } from '@contracts/index.js';

export type ReviewFreshnessStatus =
  | 'current'
  | 'stale'
  | 'unverifiable'
  | 'intermediate_diagnostic';

export interface ReviewFreshnessAssessment {
  readonly status: ReviewFreshnessStatus;
  readonly label: string;
  readonly tone: 'success' | 'warning' | 'info' | 'faint';
  readonly explanation: string;
  readonly isPlanCurrent?: boolean | undefined;
  readonly isIntegrationHeadCurrent?: boolean | undefined;
}

export interface AssessReviewFreshnessParams {
  readonly review:
    | (Partial<ReviewResult> & {
        readonly integrationHead?: string | undefined;
        readonly reviewedHead?: string | undefined;
        readonly isIntermediate?: boolean | undefined;
      })
    | undefined;
  readonly currentPlanHash?: string | undefined;
  /** Legacy alias for currentPlanHash */
  readonly approvedPlanHash?: string | undefined;
  readonly currentIntegrationHead?: string | undefined;
  readonly reviewedIntegrationHead?: string | undefined;
  readonly isIntermediate?: boolean | undefined;
  readonly stage?: string | undefined;
}

/**
 * Assesses review artifact freshness based on exact mechanical evidence:
 * - exact reviewed integration HEAD vs current integration HEAD
 * - reviewed planHash vs current approvedPlanHash
 * - intermediate diagnostic flag
 *
 * Never determines code-review freshness from stage names, timestamps, or plan hashes alone.
 */
export function assessReviewFreshness(
  params: AssessReviewFreshnessParams,
): ReviewFreshnessAssessment {
  const { review, isIntermediate } = params;
  const currentPlanHash = params.currentPlanHash ?? params.approvedPlanHash;

  if (isIntermediate || review?.isIntermediate) {
    return {
      status: 'intermediate_diagnostic',
      label: 'Diagnostic',
      tone: 'info',
      explanation: 'Artifact is an intermediate diagnostic and is not an authoritative final review.',
    };
  }

  if (!review) {
    return {
      status: 'unverifiable',
      label: 'Pending Review',
      tone: 'faint',
      explanation: 'No review artifact has been generated yet.',
    };
  }

  const reviewedHead =
    params.reviewedIntegrationHead ?? review.integrationHead ?? review.reviewedHead;
  const currentHead = params.currentIntegrationHead;

  // Case 1: Both integration heads are known
  if (reviewedHead && currentHead) {
    if (reviewedHead !== currentHead) {
      return {
        status: 'stale',
        label: 'Stale (Code Changed)',
        tone: 'warning',
        explanation: `Reviewed integration HEAD (${reviewedHead.slice(0, 8)}) does not match current integration HEAD (${currentHead.slice(0, 8)}).`,
        isIntegrationHeadCurrent: false,
      };
    }

    // Heads match: check if plan hash also exists and changed
    if (review.planHash && currentPlanHash && review.planHash !== currentPlanHash) {
      return {
        status: 'stale',
        label: 'Stale (Plan Changed)',
        tone: 'warning',
        explanation: `Reviewed plan hash (${review.planHash.slice(0, 8)}) does not match current plan hash (${currentPlanHash.slice(0, 8)}).`,
        isPlanCurrent: false,
        isIntegrationHeadCurrent: true,
      };
    }

    return {
      status: 'current',
      label: 'Current',
      tone: 'success',
      explanation: `Review was executed against exact integration HEAD (${currentHead.slice(0, 8)}).`,
      isPlanCurrent: true,
      isIntegrationHeadCurrent: true,
    };
  }

  // Case 2: Current integration HEAD exists, but review lacks recorded reviewed HEAD
  if (currentHead && !reviewedHead) {
    if (review.planHash && currentPlanHash && review.planHash !== currentPlanHash) {
      return {
        status: 'stale',
        label: 'Stale (Plan Changed)',
        tone: 'warning',
        explanation: `Reviewed plan hash (${review.planHash.slice(0, 8)}) does not match current plan hash (${currentPlanHash.slice(0, 8)}).`,
        isPlanCurrent: false,
        isIntegrationHeadCurrent: false,
      };
    }

    return {
      status: 'unverifiable',
      label: 'Unverifiable / Pending',
      tone: 'warning',
      explanation: `Current integration HEAD is ${currentHead.slice(0, 8)}, but review artifact lacks recorded integration HEAD evidence.`,
      isPlanCurrent: review.planHash && currentPlanHash ? review.planHash === currentPlanHash : undefined,
      isIntegrationHeadCurrent: false,
    };
  }

  // Case 3: Plan-only review (e.g. plan-review stage where no integration tree exists yet)
  if (review.planHash && currentPlanHash) {
    if (review.planHash === currentPlanHash) {
      return {
        status: 'current',
        label: 'Current (Plan Match)',
        tone: 'success',
        explanation: 'Review is verified against current approved plan hash.',
        isPlanCurrent: true,
      };
    } else {
      return {
        status: 'stale',
        label: 'Stale (Plan Changed)',
        tone: 'warning',
        explanation: `Reviewed plan hash (${review.planHash.slice(0, 8)}) does not match current plan hash (${currentPlanHash.slice(0, 8)}).`,
        isPlanCurrent: false,
      };
    }
  }

  return {
    status: 'unverifiable',
    label: 'Unverifiable',
    tone: 'faint',
    explanation: 'Review artifact lacks verifiable integration HEAD or plan hash provenance.',
  };
}
