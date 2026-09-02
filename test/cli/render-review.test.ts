import { describe, it, expect } from 'vitest';
import { renderReview } from '../../src/cli/render/review.js';
import type { ReviewView } from '../../src/contracts/index.js';

/**
 * The terminal's view of a review (§27, M6-ACC-21).
 *
 * It had no test. The dashboard's rendering is covered by component tests and four
 * screenshots; the CLI — which is how this product is actually operated — was covered by
 * nothing, so "don't hide blocking information" was a comment rather than a claim.
 */

const EMPTY: ReviewView = {
  reviewed: false,
  threads: [],
  gates: [],
  unsatisfiedGates: [],
  totals: {
    reviews: 0,
    tasksReviewed: 0,
    findings: 0,
    openFindings: 0,
    verifiedFindings: 0,
    disputes: 0,
    staleReviews: 0,
  },
};

function view(overrides: Partial<ReviewView> = {}): ReviewView {
  return {
    ...EMPTY,
    reviewed: true,
    threads: [
      {
        taskId: 'TASK-003',
        status: 'changes_requested',
        freshness: 'current',
        reviewerName: 'Reviewer',
        independence: 3,
        rounds: 1,
        reviewedTree: 'a'.repeat(40),
        findings: [],
        decision: { approved: false, conditions: [], blockedBy: [] },
      },
    ],
    totals: { ...EMPTY.totals, reviews: 1, tasksReviewed: 1 },
    ...overrides,
  };
}

describe('renderReview', () => {
  it('says nothing at all when no change was reviewed', () => {
    // Most runs have no reviewer. A "Review:" heading with nothing under it is a section
    // that teaches people to skip the block.
    expect(renderReview(EMPTY)).toBeUndefined();
  });

  it('names the reviewer and its independence beside the verdict', () => {
    const out = renderReview(view()) ?? '';

    expect(out).toContain('TASK-003 changes requested');
    expect(out).toContain('Reviewer (independence 3)');
  });

  it('marks a stale review in words, not by omission', () => {
    const stale = view({
      threads: [{ ...view().threads[0]!, freshness: 'stale' }],
    });

    expect(renderReview(stale) ?? '').toContain('STALE');
  });

  it('never lets a required gate that did not run pass unmentioned', () => {
    // I-45 at the surface a person actually reads.
    const out =
      renderReview(
        view({
          gates: [
            { gateId: 'security', category: 'security', required: true, status: 'not_run' },
          ],
        }),
      ) ?? '';

    expect(out).toContain('1 required gate(s) unsatisfied');
    expect(out).toContain('security not run');
  });

  it('shows the gates that passed too, so evidence is not invisible', () => {
    // It used to print only failures, so a reader could see that `security` did not run
    // and not that `lint` and `test` did — half the answer to "is this any good".
    const out =
      renderReview(
        view({
          gates: [
            { gateId: 'lint', category: 'lint', required: true, status: 'passed', exitCode: 0 },
            { gateId: 'test', category: 'unit', required: true, status: 'passed', exitCode: 0 },
          ],
        }),
      ) ?? '';

    expect(out).toContain('gates: lint passed · test passed');
  });

  it('keeps the warning above the evidence', () => {
    const out =
      renderReview(
        view({
          gates: [
            { gateId: 'lint', category: 'lint', required: true, status: 'passed', exitCode: 0 },
            { gateId: 'security', category: 'security', required: true, status: 'not_run' },
          ],
        }),
      ) ?? '';

    expect(out.indexOf('unsatisfied')).toBeLessThan(out.indexOf('gates:'));
  });

  it('bounds the gate line rather than pushing the warning off a short terminal', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      gateId: `gate-${String(i)}`,
      category: 'custom' as const,
      required: false,
      status: 'passed' as const,
      exitCode: 0,
    }));

    expect(renderReview(view({ gates: many })) ?? '').toContain('+3 more');
  });

  it('counts what is open and what is verified', () => {
    const out =
      renderReview(
        view({ totals: { ...EMPTY.totals, reviews: 2, tasksReviewed: 2, findings: 5, openFindings: 3, verifiedFindings: 2 } }),
      ) ?? '';

    expect(out).toContain('2 review(s) over 2 task(s), 5 finding(s) — 3 open, 2 verified');
  });
});
