import { describe, it, expect } from 'vitest';
import { reviewFreshnessBadge } from './review-freshness';

/**
 * How a review's freshness reads, once the server has decided what it is.
 *
 * **This file used to test the decision, and the decision is not here any more.**
 * `assessReviewFreshness` compared a review's `integrationHead` and `planHash` against the
 * run's — in the browser, from whichever of those it happened to have been handed. M6 §59
 * names review freshness among the things a surface must never derive, and the failure it
 * names is exactly the one that shape allows: handed one field and not the other, a stale
 * verdict rendered as current.
 *
 * What is left to test is presentation: a status the server computed, turned into words.
 */

describe('the badge says what the server decided', () => {
  it('reads a current review as current, and says why that matters', () => {
    const badge = reviewFreshnessBadge('current');

    expect(badge?.tone).toBe('success');
    expect(badge?.explanation).toContain('integrated now');
  });

  it('reads a stale review as a warning, and says the verdict satisfies no gate', () => {
    const badge = reviewFreshnessBadge('stale');

    expect(badge?.tone).toBe('warning');
    expect(badge?.explanation).toContain('no longer what would ship');
  });

  it('keeps unverifiable apart from stale, in tone and in words', () => {
    // Absence of a measurement is not a negative measurement — the same distinction
    // `not_run` draws for a quality gate, for the same reason.
    const badge = reviewFreshnessBadge('unverifiable');

    expect(badge?.tone).toBe('muted');
    expect(badge?.explanation).toContain('not the same as stale');
  });

  it('shows nothing when the server decided nothing', () => {
    expect(reviewFreshnessBadge(undefined)).toBeUndefined();
  });
});
