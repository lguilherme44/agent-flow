import { describe, it, expect } from 'vitest';
import { projectQualityGates, unsatisfiedRequired } from '../../../src/core/review/gates.js';
import { decideQuality, blockingFindings, latestReview } from '../../../src/core/review/decision.js';
import { buildValidationRegistry } from '../../../src/core/validation-registry.js';
import {
  ProjectConfigSchema,
  QualityConfigSchema,
  ReviewRecordSchema,
  type CommandResult,
  type ProjectConfig,
  type ReviewRecord,
} from '../../../src/contracts/index.js';
import type { ProjectedFinding } from '../../../src/core/review/findings.js';

/**
 * What the commands said, and whether that is enough (M6-07, M6-08).
 *
 * **The rule these enforce is that a model's opinion is not a gate** (I-44). A reviewer
 * may approve and a required gate that did not run still blocks — which is the same
 * lesson this product already learned at run granularity, when four `exit 127`s from a
 * tree nobody had installed into were rendered beneath a headline saying PASS.
 */

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

const PROJECT: ProjectConfig = ProjectConfigSchema.parse({
  project: { name: 'x', type: 'node' },
  commands: { test: 'npm test', lint: 'npm run lint', typecheck: 'npm run typecheck' },
  validationCommands: { e2e: 'npm run test:e2e' },
});

const REGISTRY = buildValidationRegistry(PROJECT);

function ran(command: string, exitCode = 0): CommandResult {
  return { command, exitCode, durationMs: 100, stdout: '', stderr: '', truncated: false };
}

function gates(
  quality: Record<string, unknown>,
  results: CommandResult[],
  changedFiles: string[] = ['src/a.ts'],
) {
  return projectQualityGates({
    quality: QualityConfigSchema.parse(quality),
    registry: REGISTRY,
    ran: results,
    changedFiles,
  });
}

describe('a gate is what a command did', () => {
  it('passes when the command exited zero', () => {
    const [gate] = gates({ gates: { test: { category: 'unit', required: true } } }, [ran('npm test')]);

    expect(gate?.status).toBe('passed');
    expect(gate?.exitCode).toBe(0);
    expect(gate?.required).toBe(true);
  });

  it('fails when it did not', () => {
    const [gate] = gates({ gates: { test: { required: true } } }, [ran('npm test', 1)]);

    expect(gate?.status).toBe('failed');
    expect(gate?.exitCode).toBe(1);
  });

  it('is not_run when the command was never executed', () => {
    const [gate] = gates({ gates: { test: { required: true } } }, []);

    expect(gate?.status).toBe('not_run');
    expect(gate?.exitCode).toBeUndefined();
  });

  it('is not_run when a gate is declared and no command defines it', () => {
    // A required gate nobody wired up is a hole, and silence would hide it.
    const [gate] = gates({ gates: { security: { required: true } } }, []);

    expect(gate?.status).toBe('not_run');
    expect(gate?.detail).toContain('no command is configured');
  });
});

describe('M6-ACC-18 — NOT_RUN is never PASS', () => {
  it('keeps the three apart', () => {
    const projected = gates(
      { gates: { test: { required: true }, lint: { required: true }, e2e: { required: true } } },
      [ran('npm test'), ran('npm run lint', 2)],
    );

    const byId = Object.fromEntries(projected.map((gate) => [gate.gateId, gate.status]));
    expect(byId).toEqual({ e2e: 'not_run', lint: 'failed', test: 'passed' });
  });

  it('blocks on a required gate that did not run, exactly as on one that failed', () => {
    const notRun = gates({ gates: { e2e: { required: true } } }, []);
    const failed = gates({ gates: { test: { required: true } } }, [ran('npm test', 1)]);

    expect(unsatisfiedRequired(notRun)).toHaveLength(1);
    expect(unsatisfiedRequired(failed)).toHaveLength(1);
  });

  it('does not block on an advisory gate that did not run', () => {
    expect(unsatisfiedRequired(gates({ gates: { e2e: { required: false } } }, []))).toEqual([]);
  });
});

describe('applicability is mechanical (§40)', () => {
  it('skips a gate whose area this change does not touch', () => {
    const [gate] = gates(
      { gates: { e2e: { required: true, appliesTo: ['apps/web/**'] } } },
      [],
      ['src/server/a.ts'],
    );

    expect(gate?.status).toBe('not_applicable');
  });

  it('applies it when the change does touch the area', () => {
    const [gate] = gates(
      { gates: { e2e: { required: true, appliesTo: ['apps/web/**'] } } },
      [ran('npm run test:e2e')],
      ['apps/web/page.vue'],
    );

    expect(gate?.status).toBe('passed');
  });

  it('never lets not_applicable block', () => {
    const projected = gates(
      { gates: { e2e: { required: true, appliesTo: ['apps/web/**'] } } },
      [],
      ['src/server/a.ts'],
    );

    expect(unsatisfiedRequired(projected)).toEqual([]);
  });

  it('applies always when no area is named', () => {
    const [gate] = gates({ gates: { test: { required: true } } }, [], ['anything.ts']);
    expect(gate?.status).toBe('not_run');
  });

  it('does not let a sibling directory satisfy an area', () => {
    // The same segment-aware matcher the ownership map uses. Two path matchers would be
    // two answers about one path, and the day they disagree a required gate stops
    // applying.
    const [gate] = gates(
      { gates: { e2e: { required: true, appliesTo: ['apps/web'] } } },
      [],
      ['apps/webhooks/a.ts'],
    );

    expect(gate?.status).toBe('not_applicable');
  });
});

describe('a command nobody declared is still evidence', () => {
  it('is reported, advisory', () => {
    const projected = gates({ gates: {} }, [ran('npm test')]);

    expect(projected).toHaveLength(1);
    expect(projected[0]?.required).toBe(false);
    expect(projected[0]?.gateId).toBe('test');
  });

  it('is not reported twice when it is also declared', () => {
    expect(gates({ gates: { test: { required: true } } }, [ran('npm test')])).toHaveLength(1);
  });
});

/* ─── The decision ─────────────────────────────────────────────────────────── */

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return ReviewRecordSchema.parse({
    id: 'REV-0001',
    runId: 'AF-2026-001',
    taskId: 'TASK-003',
    round: 1,
    reviewer: 'reviewer',
    author: 'backend',
    independence: 3,
    reviewedTree: TREE_A,
    verdict: 'approve',
    findings: [],
    createdAt: '2026-09-02T12:00:00.000Z',
    ...overrides,
  });
}

function finding(
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical',
  status: ProjectedFinding['status'] = 'open',
): ProjectedFinding {
  return {
    finding: {
      id: 'FIND-0001',
      severity,
      type: 'correctness',
      description: 'x',
      suggestedAction: 'y',
      evidence: [],
    },
    reviewId: 'REV-0001',
    taskId: 'TASK-003',
    round: 1,
    status,
  };
}

function decide(input: Partial<Parameters<typeof decideQuality>[0]> = {}) {
  return decideQuality({
    reviews: [review()],
    findings: [],
    gates: gates({ gates: { test: { required: true } } }, [ran('npm test')]),
    quality: QualityConfigSchema.parse({}),
    integratedTree: TREE_A,
    ...input,
  });
}

describe('the final quality decision (§43)', () => {
  it('approves when every condition holds', () => {
    const decision = decide();

    expect(decision.approved).toBe(true);
    expect(decision.blockedBy).toEqual([]);
  });

  it('refuses when a required gate did not pass', () => {
    const decision = decide({ gates: gates({ gates: { test: { required: true } } }, []) });

    expect(decision.approved).toBe(false);
    expect(decision.blockedBy).toContain('every required quality gate passed');
  });

  it('refuses when there is no review at all', () => {
    const decision = decide({ reviews: [] });

    expect(decision.approved).toBe(false);
    expect(decision.conditions.find((c) => c.name === 'the review approves')?.detail).toContain(
      'no review',
    );
  });

  it('refuses when the reviewer asked for changes', () => {
    const decision = decide({ reviews: [review({ verdict: 'changes_requested' })] });

    expect(decision.approved).toBe(false);
  });

  it('names every unmet condition rather than the first', () => {
    const decision = decide({
      reviews: [review({ verdict: 'blocked' })],
      gates: gates({ gates: { test: { required: true } } }, [ran('npm test', 1)]),
      findings: [finding('critical')],
    });

    expect(decision.blockedBy).toHaveLength(3);
  });
});

describe('M6-ACC-06, 07 — which findings block', () => {
  it('blocks on critical and high', () => {
    expect(decide({ findings: [finding('critical')] }).approved).toBe(false);
    expect(decide({ findings: [finding('high')] }).approved).toBe(false);
  });

  it('blocks on medium by default, and not when the operator says otherwise', () => {
    expect(decide({ findings: [finding('medium')] }).approved).toBe(false);
    expect(
      decide({
        findings: [finding('medium')],
        quality: QualityConfigSchema.parse({ blockOnMedium: false }),
      }).approved,
    ).toBe(true);
  });

  it('never blocks on low or info', () => {
    expect(decide({ findings: [finding('low'), finding('info')] }).approved).toBe(true);
  });

  it('stops blocking once the finding is verified', () => {
    expect(decide({ findings: [finding('critical', 'verified')] }).approved).toBe(true);
  });

  it('still blocks while the finding is only fixed', () => {
    // Fixed means corrective work integrated; verified means somebody read the result.
    // Between the two is a change nobody has looked at.
    expect(decide({ findings: [finding('critical', 'fixed')] }).approved).toBe(false);
  });

  it('still blocks on a finding the implementer merely acknowledged', () => {
    expect(decide({ findings: [finding('high', 'acknowledged')] }).approved).toBe(false);
  });

  it('counts them without the decision, for a caller that wants the list', () => {
    const blocking = blockingFindings(
      [finding('critical'), finding('low'), finding('high', 'verified')],
      QualityConfigSchema.parse({}),
    );

    expect(blocking).toHaveLength(1);
  });
});

describe('M6-ACC-13, 14 — a stale review satisfies nothing', () => {
  it('refuses when the review read a different tree from the one integrated', () => {
    const decision = decide({ integratedTree: TREE_B });

    expect(decision.approved).toBe(false);
    expect(decision.blockedBy).toContain('the review read the tree that is integrated');
  });

  it('says which tree it read and which is integrated', () => {
    const decision = decide({ integratedTree: TREE_B });
    const condition = decision.conditions.find((c) => c.name.includes('tree that is integrated'));

    expect(condition?.detail).toContain(TREE_A.slice(0, 8));
    expect(condition?.detail).toContain(TREE_B.slice(0, 8));
  });

  it('accepts a re-review that read the current tree', () => {
    const decision = decide({
      reviews: [review({ verdict: 'changes_requested' }), review({ id: 'REV-0002', round: 2, reviewedTree: TREE_B })],
      integratedTree: TREE_B,
    });

    expect(decision.approved).toBe(true);
  });

  it('does not call a sequential run stale, because it has no tree to compare', () => {
    const { reviewedTree, ...sequential } = review();
    void reviewedTree;
    const decision = decide({ reviews: [ReviewRecordSchema.parse(sequential)], integratedTree: undefined });

    expect(decision.approved).toBe(true);
  });
});

describe('the review that counts is the latest round', () => {
  it('takes the highest round, not the last written', () => {
    const first = review({ id: 'REV-0001', round: 1, verdict: 'approve' });
    const second = review({ id: 'REV-0002', round: 2, verdict: 'blocked' });

    expect(latestReview([second, first])?.id).toBe('REV-0002');
  });

  it('is nothing when there are none', () => {
    expect(latestReview([])).toBeUndefined();
  });
});
