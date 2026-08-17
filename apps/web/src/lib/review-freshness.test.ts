import { describe, it, expect } from 'vitest';
import { assessReviewFreshness } from './review-freshness';

describe('assessReviewFreshness', () => {
  it('returns Current when reviewed integration head matches current integration head', () => {
    const res = assessReviewFreshness({
      review: {
        verdict: 'PASS',
        integrationHead: 'c06e3e7d73f7ca33986f539c01855aee039e37e4',
      },
      currentIntegrationHead: 'c06e3e7d73f7ca33986f539c01855aee039e37e4',
    });
    expect(res.status).toBe('current');
    expect(res.tone).toBe('success');
    expect(res.label).toBe('Current');
  });

  it('returns Stale when integration head has changed', () => {
    const res = assessReviewFreshness({
      review: {
        verdict: 'PASS',
        integrationHead: '1111111111111111111111111111111111111111',
      },
      currentIntegrationHead: '2222222222222222222222222222222222222222',
    });
    expect(res.status).toBe('stale');
    expect(res.tone).toBe('warning');
    expect(res.label).toBe('Stale (Code Changed)');
  });

  it('returns Unverifiable / Pending when current integration head exists but review lacks reviewed head', () => {
    const res = assessReviewFreshness({
      review: {
        verdict: 'PASS',
      },
      currentIntegrationHead: 'c06e3e7d73f7ca33986f539c01855aee039e37e4',
    });
    expect(res.status).toBe('unverifiable');
    expect(res.tone).toBe('warning');
    expect(res.label).toBe('Unverifiable / Pending');
  });

  it('returns Stale when plan hash is the same but integration head changed', () => {
    const res = assessReviewFreshness({
      review: {
        verdict: 'PASS',
        planHash: 'planhash123456',
        integrationHead: '1111111111111111111111111111111111111111',
      },
      currentPlanHash: 'planhash123456',
      currentIntegrationHead: '2222222222222222222222222222222222222222',
    });
    expect(res.status).toBe('stale');
    expect(res.label).toBe('Stale (Code Changed)');
  });

  it('never marks Current from stage name alone when head evidence is absent', () => {
    const res = assessReviewFreshness({
      review: {
        verdict: 'PASS',
      },
      stage: 'final-review',
      currentIntegrationHead: 'c06e3e7d73f7ca33986f539c01855aee039e37e4',
    });
    expect(res.status).not.toBe('current');
    expect(res.status).toBe('unverifiable');
  });

  it('marks intermediate review as Diagnostic', () => {
    const res = assessReviewFreshness({
      review: {
        verdict: 'PASS',
        isIntermediate: true,
      },
      currentIntegrationHead: 'c06e3e7d73f7ca33986f539c01855aee039e37e4',
    });
    expect(res.status).toBe('intermediate_diagnostic');
    expect(res.label).toBe('Diagnostic');
    expect(res.tone).toBe('info');
  });
});
