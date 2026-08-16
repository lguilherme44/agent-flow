import { describe, it, expect } from 'vitest';
import { assessReviewFreshness } from './review-freshness';

describe('assessReviewFreshness', () => {
  it('returns pending_head_review when review is undefined', () => {
    const res = assessReviewFreshness({
      review: undefined,
      approvedPlanHash: 'abc12345',
    });
    expect(res.status).toBe('pending_head_review');
    expect(res.tone).toBe('warning');
  });

  it('returns current when review planHash matches approved plan hash', () => {
    const res = assessReviewFreshness({
      review: { planHash: 'hash-abc-123' },
      approvedPlanHash: 'hash-abc-123',
    });
    expect(res.status).toBe('current');
    expect(res.tone).toBe('success');
    expect(res.label).toBe('Current');
  });

  it('returns stale when review planHash differs from approved plan hash', () => {
    const res = assessReviewFreshness({
      review: { planHash: 'old-plan-hash-111' },
      approvedPlanHash: 'new-approved-plan-222',
    });
    expect(res.status).toBe('stale');
    expect(res.tone).toBe('warning');
    expect(res.label).toContain('Stale');
  });

  it('returns current head for verification stage without planHash', () => {
    const res = assessReviewFreshness({
      review: { verdict: 'PASS' },
      approvedPlanHash: undefined,
      stage: 'verification',
    });
    expect(res.status).toBe('current');
    expect(res.tone).toBe('success');
  });
});
