import { describe, it, expect } from 'vitest';
import {
  FINDINGS_SECTION_BEGIN,
  FINDINGS_SECTION_END,
  MAX_FINDING_CHARS,
  MAX_FORWARDED_FINDINGS,
  anchorOf,
  renderReplanInput,
  sameReplanRequest,
  stripFindingsSections,
  type ReplanFinding,
} from '../../src/core/replan-input.js';

/**
 * D14. Measured on AF-2026-004: the cross-provider plan review wrote nine anchored
 * findings and neither `revise` nor `--from planning` forwarded one of them, so the
 * high-risk review loop replanned against the same gap and was refused for the same
 * reason three times. These tests are about the rendering only — the wiring is proved
 * at the use-case level in `test/app/replan-findings.test.ts`.
 */

const finding = (over: Partial<ReplanFinding> = {}): ReplanFinding => ({
  severity: 'high',
  type: 'correctness',
  description: 'The revision instruction is the only thing the planner receives.',
  suggestedAction: 'Forward the review findings too.',
  file: 'src/app/run-actions.ts',
  location: { line: 1717 },
  ...over,
});

describe('anchorOf', () => {
  it('names file and line when the reviewer gave both', () => {
    expect(anchorOf(finding())).toBe('src/app/run-actions.ts:1717');
  });

  it('names the range when the reviewer gave one', () => {
    expect(anchorOf(finding({ location: { line: 94, endLine: 136 } }))).toBe(
      'src/app/run-actions.ts:94-136',
    );
  });

  it('falls back to the file alone, and to nothing at all', () => {
    expect(anchorOf(finding({ location: undefined }))).toBe('src/app/run-actions.ts');
    expect(anchorOf(finding({ file: undefined, location: undefined }))).toBeUndefined();
  });
});

describe('a review that did not reject the plan contributes nothing', () => {
  it('renders no section when there is no review', () => {
    const rendered = renderReplanInput({ request: 'Add recurring bookings' });

    expect(rendered.text).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(rendered.findingsForwarded).toBe(0);
  });

  it('renders no section for a PASS review that still left notes', () => {
    // The guard is not a blanket paste: a passing review's observations are not a
    // reason to replan, and forwarding them would teach the planner that every
    // remark is a defect.
    const rendered = renderReplanInput({
      request: 'Add recurring bookings',
      review: { verdict: 'PASS', findings: [finding({ severity: 'info' })] },
    });

    expect(rendered.text).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(rendered.findingsForwarded).toBe(0);
  });

  it('renders no section for a FAIL review with no findings', () => {
    const rendered = renderReplanInput({
      request: 'Add recurring bookings',
      review: { verdict: 'FAIL', findings: [] },
    });

    expect(rendered.text).not.toContain(FINDINGS_SECTION_BEGIN);
    expect(rendered.findingsForwarded).toBe(0);
  });
});

describe('a rejected review reaches the planner whole', () => {
  const findings: ReplanFinding[] = [
    finding({
      severity: 'critical',
      type: 'correctness',
      file: 'src/app/run-actions.ts',
      location: { line: 1717 },
      description: 'Only the human instruction is forwarded.',
      suggestedAction: 'Forward the findings.',
    }),
    finding({
      severity: 'low',
      type: 'maintainability',
      file: 'src/app/plan-review-service.ts',
      location: { line: 94, endLine: 136 },
      description: 'The artifact is written twice.',
      suggestedAction: 'Extract the write.',
    }),
  ];

  it('lists every anchored finding with its severity, anchor and text', () => {
    const rendered = renderReplanInput({
      request: 'Add recurring bookings',
      review: { verdict: 'FAIL', findings },
    });

    expect(rendered.findingsForwarded).toBe(2);
    expect(rendered.findingsOmitted).toBe(0);
    expect(rendered.text).toContain(FINDINGS_SECTION_BEGIN);
    expect(rendered.text).toContain(FINDINGS_SECTION_END);

    for (const each of findings) {
      const anchor = anchorOf(each);
      expect(anchor).toBeDefined();
      expect(rendered.text).toContain(anchor as string);
      expect(rendered.text).toContain(each.description);
      expect(rendered.text).toContain(each.suggestedAction as string);
      expect(rendered.text).toContain(each.severity);
    }
  });

  it('keeps the original request and the human instruction', () => {
    const rendered = renderReplanInput({
      request: 'Add recurring bookings',
      instruction: 'split TASK-001',
      review: { verdict: 'FAIL', findings },
    });

    expect(rendered.text).toContain('Add recurring bookings');
    expect(rendered.text).toContain('Revision requested by the reviewer:\nsplit TASK-001');
    // The findings are the last thing the planner reads, after the instruction that
    // motivated the replan.
    expect(rendered.text.indexOf('split TASK-001')).toBeLessThan(
      rendered.text.indexOf(FINDINGS_SECTION_BEGIN),
    );
  });

  it('puts the worst first, so what the cap drops is what matters least', () => {
    const rendered = renderReplanInput({
      request: 'r',
      review: { verdict: 'FAIL', findings },
    });

    expect(rendered.text.indexOf('critical')).toBeLessThan(rendered.text.indexOf('maintainability'));
  });
});

describe('the section is bounded, and says so', () => {
  it('forwards at most the cap and counts what it dropped', () => {
    const many = Array.from({ length: MAX_FORWARDED_FINDINGS + 3 }, (_, index) =>
      finding({ severity: 'medium', file: `src/f${String(index)}.ts`, location: { line: index + 1 } }),
    );

    const rendered = renderReplanInput({ request: 'r', review: { verdict: 'FAIL', findings: many } });

    expect(rendered.findingsForwarded).toBe(MAX_FORWARDED_FINDINGS);
    expect(rendered.findingsOmitted).toBe(3);
    expect(rendered.text).toContain('3 further finding');
    expect(rendered.text).not.toContain(`src/f${String(MAX_FORWARDED_FINDINGS)}.ts`);
  });

  it('truncates a finding whose prose would swallow the request', () => {
    const long = 'x'.repeat(MAX_FINDING_CHARS * 3);
    const rendered = renderReplanInput({
      request: 'r',
      review: { verdict: 'FAIL', findings: [finding({ description: long })] },
    });

    expect(rendered.text).not.toContain(long);
    expect(rendered.text).toContain('x'.repeat(MAX_FINDING_CHARS - 1));
    expect(rendered.text).toContain('truncated');
  });
});

describe('the section does not compound across revisions', () => {
  it('is stripped from a request that already carries one', () => {
    // `revise` reads the `request` artifact, which the pipeline overwrites with
    // whatever it was last handed. Without this, revision three would carry the
    // findings of revisions one and two verbatim, and the cap would mean nothing.
    const first = renderReplanInput({
      request: 'Add recurring bookings',
      review: { verdict: 'FAIL', findings: [finding()] },
    });

    const second = renderReplanInput({
      request: first.text,
      review: { verdict: 'FAIL', findings: [finding({ file: 'src/other.ts', location: { line: 7 } })] },
    });

    expect(second.text.split(FINDINGS_SECTION_BEGIN)).toHaveLength(2);
    expect(second.text).toContain('src/other.ts:7');
    expect(second.text).toContain('Add recurring bookings');
  });

  it('leaves a request that carries no section untouched', () => {
    expect(stripFindingsSections('Add recurring bookings')).toBe('Add recurring bookings');
  });
});

describe('sameReplanRequest', () => {
  it('ignores whitespace and a section a previous replan left behind', () => {
    const stored = renderReplanInput({
      request: 'Add recurring bookings',
      review: { verdict: 'FAIL', findings: [finding()] },
    }).text;

    expect(sameReplanRequest('  Add recurring bookings\n', stored)).toBe(true);
  });

  it('says no to a request the operator changed, and to one that is missing', () => {
    expect(sameReplanRequest('Add recurring bookings AND invoicing', 'Add recurring bookings')).toBe(
      false,
    );
    expect(sameReplanRequest('Add recurring bookings', null)).toBe(false);
    expect(sameReplanRequest('Add recurring bookings', undefined)).toBe(false);
  });
});
