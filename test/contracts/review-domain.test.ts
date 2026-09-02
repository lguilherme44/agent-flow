import { describe, it, expect } from 'vitest';
import {
  FINDING_SEVERITIES,
  FindingSchema,
  GlobalConfigSchema,
  QualityConfigSchema,
  QualityGateResultSchema,
  ReviewFindingSchema,
  ReviewRecordSchema,
  ReviewResultSchema,
  severityAtLeast,
} from '../../src/contracts/index.js';

/**
 * The review domain's contracts (M6-01).
 *
 * Two properties carry most of the weight. **A model cannot give a finding an identity**,
 * because the shape it may return has no id in it — the same defence `ProposedMessage`
 * uses against a forged sender, and the same reason: a field a model can fill is a field
 * a model can forge. And **every artifact written before M6 still parses**, because
 * `info` joined the bottom of an ordered list rather than the middle of an unordered one.
 */

const RECORD = {
  id: 'REV-0001',
  runId: 'AF-2026-001',
  taskId: 'TASK-003',
  round: 1,
  reviewer: 'reviewer',
  author: 'backend',
  independence: 3,
  reviewedTree: 'a'.repeat(40),
  verdict: 'changes_requested',
  scope: ['src/server/routes.ts'],
  findings: [
    {
      id: 'FIND-0001',
      severity: 'high',
      type: 'correctness',
      description: 'the retry re-sends the body after the stream was consumed',
      suggestedAction: 'buffer the body before the first attempt',
      file: 'src/server/routes.ts',
      location: { line: 42 },
      evidence: [{ kind: 'file', id: 'src/server/routes.ts' }],
    },
  ],
  createdAt: '2026-09-02T12:00:00.000Z',
};

describe('severity is ordered, and the order is the contract', () => {
  it('puts info at the bottom so every existing comparison keeps its meaning', () => {
    // `corrective-plan.ts` compares by index to decide what is actionable. Inserting
    // `info` anywhere but the bottom would have silently changed what `medium` means.
    expect([...FINDING_SEVERITIES]).toEqual(['info', 'low', 'medium', 'high', 'critical']);
  });

  it('compares by rank rather than by name', () => {
    expect(severityAtLeast('critical', 'medium')).toBe(true);
    expect(severityAtLeast('medium', 'medium')).toBe(true);
    expect(severityAtLeast('low', 'medium')).toBe(false);
    expect(severityAtLeast('info', 'low')).toBe(false);
  });

  it('still reads a review written before info existed', () => {
    const legacy = ReviewResultSchema.parse({
      verdict: 'FAIL',
      independence: 'cross-provider',
      reviewer: { runner: 'claude', reasoning: 'high' },
      findings: [
        {
          severity: 'medium',
          type: 'missing_test',
          description: 'no test covers the empty case',
          suggestedAction: 'add one',
        },
      ],
    });

    expect(legacy.findings[0]?.severity).toBe('medium');
    // The fields M6 added default rather than being required, so nothing old fails.
    expect(legacy.findings[0]?.evidence).toEqual([]);
  });
});

describe('a model cannot give a finding an identity', () => {
  it('strips an id a reviewer tried to supply', () => {
    // §16, and the same defence I-28 uses for a sender. Zod discards unknown keys, so the
    // forgery is gone before anything reads it — no check to remember, none to forget.
    const proposed = FindingSchema.parse({
      severity: 'high',
      type: 'correctness',
      description: 'x',
      suggestedAction: 'y',
      id: 'FIND-9999',
    });

    expect(JSON.stringify(proposed)).not.toContain('FIND-9999');
  });

  it('requires one on the persisted shape', () => {
    expect(() =>
      ReviewFindingSchema.parse({
        severity: 'high',
        type: 'correctness',
        description: 'x',
        suggestedAction: 'y',
      }),
    ).toThrow();
  });

  it('refuses an id that is not the shape Agent Flow allocates', () => {
    expect(() => ReviewFindingSchema.parse({ ...RECORD.findings[0], id: 'whatever' })).toThrow();
  });
});

describe('a finding cites through the reference union that owns path safety', () => {
  it('accepts a repository-relative file reference', () => {
    const parsed = FindingSchema.parse({
      severity: 'low',
      type: 'maintainability',
      description: 'x',
      suggestedAction: 'y',
      evidence: [{ kind: 'file', id: 'src/a.ts' }],
    });

    expect(parsed.evidence).toHaveLength(1);
  });

  it('refuses a citation that steps outside the repository', () => {
    for (const hostile of ['../../etc/passwd', '/etc/passwd', 'src/%2e%2e/a.ts']) {
      expect(
        () =>
          FindingSchema.parse({
            severity: 'low',
            type: 'security',
            description: 'x',
            suggestedAction: 'y',
            evidence: [{ kind: 'file', id: hostile }],
          }),
        hostile,
      ).toThrow();
    }
  });

  it('bounds how much one finding may cite', () => {
    expect(() =>
      FindingSchema.parse({
        severity: 'low',
        type: 'maintainability',
        description: 'x',
        suggestedAction: 'y',
        evidence: Array.from({ length: 17 }, () => ({ kind: 'file', id: 'src/a.ts' })),
      }),
    ).toThrow();
  });
});

describe('a review record is a statement about one tree', () => {
  it('carries the commit the reviewer read', () => {
    const parsed = ReviewRecordSchema.parse(RECORD);
    expect(parsed.reviewedTree).toBe('a'.repeat(40));
  });

  it('refuses anything that is not a commit', () => {
    expect(() => ReviewRecordSchema.parse({ ...RECORD, reviewedTree: 'HEAD' })).toThrow();
    expect(() => ReviewRecordSchema.parse({ ...RECORD, reviewedTree: 'today' })).toThrow();
  });

  it('allows none, because a sequential run has no commit to name', () => {
    const { reviewedTree, ...sequential } = RECORD;
    void reviewedTree;
    expect(ReviewRecordSchema.parse(sequential).reviewedTree).toBeUndefined();
  });

  it('takes the author from the caller, not from the review', () => {
    // I-42: who wrote the code comes from the assignment. A record that let the review
    // name its own author would let a reviewer claim it reviewed somebody else's work.
    expect(ReviewRecordSchema.parse(RECORD).author).toBe('backend');
    expect(() => ReviewRecordSchema.parse({ ...RECORD, author: undefined })).toThrow();
  });

  it('bounds how many findings one review may carry', () => {
    expect(() =>
      ReviewRecordSchema.parse({
        ...RECORD,
        findings: Array.from({ length: 65 }, (_, index) => ({
          ...RECORD.findings[0],
          id: `FIND-${String(index + 1).padStart(4, '0')}`,
        })),
      }),
    ).toThrow();
  });
});

describe('quality gates are metadata beside the registry', () => {
  it('defaults a gate to advisory and custom', () => {
    const parsed = QualityConfigSchema.parse({ gates: { anything: {} } });

    expect(parsed.gates['anything']?.required).toBe(false);
    expect(parsed.gates['anything']?.category).toBe('custom');
  });

  it('carries required and applicability as a person wrote them', () => {
    const parsed = QualityConfigSchema.parse({
      gates: {
        typecheck: { category: 'typecheck', required: true },
        visual: { category: 'visual', required: true, appliesTo: ['apps/web/**'] },
      },
    });

    expect(parsed.gates['typecheck']?.required).toBe(true);
    expect(parsed.gates['visual']?.appliesTo).toEqual(['apps/web/**']);
  });

  it('blocks on medium unless an operator says otherwise', () => {
    expect(QualityConfigSchema.parse({}).blockOnMedium).toBe(true);
    expect(QualityConfigSchema.parse({ blockOnMedium: false }).blockOnMedium).toBe(false);
  });

  it('keeps not_run distinct from failed and from passed', () => {
    // I-45. Absence of evidence is reported as absence, per gate.
    const notRun = QualityGateResultSchema.parse({
      gateId: 'e2e',
      category: 'e2e',
      required: true,
      status: 'not_run',
      detail: 'the workspace was never prepared',
    });

    expect(notRun.status).toBe('not_run');
    expect(notRun.exitCode).toBeUndefined();
  });
});

describe('a configuration written before M6 parses unchanged', () => {
  const legacy = {
    runners: { claude: { type: 'claude-code-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
  };

  it('gets an empty gate map and the shipped budgets', () => {
    const parsed = GlobalConfigSchema.parse(legacy);

    expect(parsed.quality.gates).toEqual({});
    expect(parsed.review.maxRounds).toBe(3);
    expect(parsed.review.maxCorrectionRounds).toBe(2);
    expect(parsed.review.maxDisputeRounds).toBe(1);
  });

  it('has no review switch, because the team already says who reviews', () => {
    // A second way to say the same thing is two things that eventually disagree.
    expect(JSON.stringify(GlobalConfigSchema.parse(legacy).review)).not.toContain('enabled');
  });
});
