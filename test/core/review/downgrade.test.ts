import { describe, it, expect } from 'vitest';
import {
  downgradeFinding,
  downgradeFindings,
  hasFailureEvidence,
  isDocumentationPath,
} from '../../../src/core/review/downgrade.js';
import { blockingFindings } from '../../../src/core/review/decision.js';
import { QualityConfigSchema, type Finding } from '../../../src/contracts/index.js';

/**
 * What a finding is allowed to block.
 *
 * `decision.ts` refuses to take a reviewer's `approve` as a gate. This is the other half: a
 * review that blocks for nothing costs as much as one that waves work through, and the Smart
 * Place kit measured two ways of doing it — a `high` naming no reproducible failure, and a
 * `high` about prose.
 */

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: 'high',
  type: 'correctness',
  description: 'something is wrong',
  suggestedAction: 'fix it',
  evidence: [],
  ...over,
});

describe('what a finding may block', () => {
  it('keeps a high that names a file and a line', () => {
    const result = downgradeFinding(finding({ file: 'src/a.ts', location: { line: 42 } }));

    expect(result.downgraded).toBeUndefined();
    expect(result.finding.severity).toBe('high');
  });

  it('downgrades a high whose only support is a file, with no line', () => {
    // A file says where to look, not what goes wrong.
    const result = downgradeFinding(finding({ file: 'src/a.ts' }));

    expect(result.downgraded).toBe('no-evidence');
    expect(result.finding.severity).toBe('medium');
  });

  it('accepts a path:line citation written in the description', () => {
    const result = downgradeFinding(finding({ description: 'breaks at src/a.ts:42 on retry' }));

    expect(result.downgraded).toBeUndefined();
  });

  it('does not read a version or a clock as a citation', () => {
    // `v1.2:3` and `10.30:00` are not file references: the extension must start with a letter.
    expect(hasFailureEvidence(finding({ description: 'since v1.2:3, at 10.30:00' }))).toBe(false);
  });

  it('downgrades a high about documentation', () => {
    const result = downgradeFinding(finding({ file: 'docs/roadmap.md', location: { line: 3 } }));

    expect(result.downgraded).toBe('documentation');
    expect(result.finding.severity).toBe('medium');
  });

  it('does NOT treat a prompt as documentation', () => {
    // The prompts are product code here: an agent reads them and acts on them. Reading every
    // `.md` as prose would make a review of a prompt change unable to fail.
    expect(isDocumentationPath('prompts/implementation.md')).toBe(false);
    expect(isDocumentationPath('AGENTS.md')).toBe(false);
    expect(isDocumentationPath('docs/roadmap.md')).toBe(true);
    expect(isDocumentationPath('README.md')).toBe(true);
  });

  it('keeps a finding about the plan when the plan is what is under review', () => {
    // Audit 22/10/2026 in the kit: a high citing plan.json line 14, with a real failure, came
    // out downgraded as documentation and the plan passed.
    const about = finding({ file: '.agent-flow/runs/AF-1/plan.json', location: { line: 14 } });

    expect(downgradeFinding(about, 'high', 'plan').downgraded).toBeUndefined();
    expect(downgradeFinding(about, 'high', 'code').downgraded).toBe('documentation');
  });

  it('leaves a finding that names no file alone', () => {
    // Guessing "prose" from the wording would be a second model's opinion, not a fact.
    const result = downgradeFinding(finding({ description: 'breaks at src/a.ts:9' }));

    expect(result.downgraded).toBeUndefined();
  });

  it('applies the evidence rule at a medium threshold too', () => {
    // Applied to critical/high alone, a review at a medium threshold let an unproven high
    // through while an unproven medium blocked.
    const unproven = finding({ severity: 'medium' });

    expect(downgradeFinding(unproven, 'medium').downgraded).toBe('no-evidence');
    expect(downgradeFinding(unproven, 'high').downgraded).toBeUndefined();
  });

  it('keeps downgraded findings, and separates only what still blocks', () => {
    const { all, blocking } = downgradeFindings([
      finding({ file: 'src/a.ts', location: { line: 1 } }),
      finding({ file: 'docs/x.md', location: { line: 1 } }),
      finding({ severity: 'low' }),
    ]);

    expect(all).toHaveLength(3);
    expect(blocking).toHaveLength(1);
  });

  it('ignores a mark the reviewer set on itself', () => {
    // The mark is ours: a reviewer that pre-marked its own finding marked nothing.
    const result = downgradeFinding(finding({ file: 'src/a.ts', location: { line: 7 } }));

    expect(result.downgraded).toBeUndefined();
  });
});

describe('the rules reaching the gate that uses them', () => {
  const held = (over: Partial<Finding> = {}) => ({
    finding: { ...finding(over), id: 'F-001' as const },
    reviewId: 'R-1',
    taskId: 'TASK-001',
    round: 1,
    status: 'open' as const,
  });

  it('is OFF by default: what blocked before still blocks', () => {
    // Turning the rules on changes what holds a change in every existing run, so it is an
    // operator's decision, not a new default. A finding that stops being blocking is one a
    // person stops being asked about.
    const quality = QualityConfigSchema.parse({});

    expect(blockingFindings([held()], quality)).toHaveLength(1);
  });

  it('when ON, an unsupported high stops holding the change', () => {
    const quality = QualityConfigSchema.parse({ downgradeUnsupportedFindings: true });

    expect(blockingFindings([held()], quality)).toHaveLength(0);
  });

  it('when ON, a high with a file and a line still blocks', () => {
    const quality = QualityConfigSchema.parse({ downgradeUnsupportedFindings: true });
    const supported = held({ file: 'src/a.ts', location: { line: 12 } });

    expect(blockingFindings([supported], quality)).toHaveLength(1);
  });

  it('a verified finding never blocks, either way', () => {
    const quality = QualityConfigSchema.parse({ downgradeUnsupportedFindings: true });
    const verified = { ...held({ file: 'src/a.ts', location: { line: 12 } }), status: 'verified' as const };

    expect(blockingFindings([verified], quality)).toHaveLength(0);
  });
});
