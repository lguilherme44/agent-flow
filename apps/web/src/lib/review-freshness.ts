/**
 * How a review's freshness *reads*, once the server has decided what it is.
 *
 * **The decision is not here any more** (M6 §59). This module used to hold
 * `assessReviewFreshness`, which compared a review's `integrationHead` and `planHash`
 * against the run's — in the browser, from whichever of those fields it happened to have
 * been handed. That is a surface deriving review freshness by its own rules, which is the
 * shape §59 forbids and the shape that let a stale verdict render as current whenever one
 * field arrived and the other did not.
 *
 * What is left is presentation: a status the server computed, turned into the words and
 * the tone a badge shows. That split is the rule — the server decides, the browser draws.
 */

export type ReviewFreshnessStatus = 'current' | 'stale' | 'unverifiable';

export interface ReviewFreshnessBadge {
  readonly label: string;
  readonly tone: 'success' | 'warning' | 'muted';
  readonly explanation: string;
}

const BADGES: Record<ReviewFreshnessStatus, ReviewFreshnessBadge> = {
  current: {
    label: 'review current',
    tone: 'success',
    explanation:
      'The reviewer read the commit that is integrated now. The verdict describes the code in hand.',
  },
  stale: {
    label: 'review stale',
    tone: 'warning',
    explanation:
      'The integration branch moved after this review. The verdict describes a commit that is no longer what would ship, and it satisfies no gate until somebody reads the current one.',
  },
  unverifiable: {
    label: 'freshness unknown',
    tone: 'muted',
    explanation:
      'Either the review or the run recorded no commit, so there is nothing to compare. This is not the same as stale: nobody measured it.',
  },
};

/** The badge for a status the server decided, or nothing when it decided none. */
export function reviewFreshnessBadge(
  status: ReviewFreshnessStatus | undefined,
): ReviewFreshnessBadge | undefined {
  return status === undefined ? undefined : BADGES[status];
}
