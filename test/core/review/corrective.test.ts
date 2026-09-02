import { describe, it, expect } from 'vitest';
import { correctiveSelection, correctiveLinks } from '../../../src/core/review/corrective.js';
import { applyFixes } from '../../../src/core/corrective-plan.js';
import { PlanSchema, QualityConfigSchema, TaskSchema, type Task } from '../../../src/contracts/index.js';
import type { ProjectedFinding } from '../../../src/core/review/findings.js';

/**
 * Findings becoming work (M6-05, M6-ACC-10, M6-ACC-11).
 *
 * **No second corrective generator.** `core/corrective-plan.ts` has turned findings into
 * tasks that re-enter the pipeline since MVP 3 — routed, isolated, validated, integrated
 * like any other. M6 adds a trigger, not a mechanism, so these tests drive the *existing*
 * generator with the new selection and assert the tasks it produces are ordinary ones.
 *
 * The link is the part that is new and the part that matters: a corrective task carries
 * the id of the finding it addresses, which is what lets `fixed` be a fact rather than a
 * claim.
 */

function finding(
  overrides: Partial<ProjectedFinding['finding']> = {},
  status: ProjectedFinding['status'] = 'open',
): ProjectedFinding {
  return {
    finding: {
      id: 'FIND-0001',
      severity: 'high',
      type: 'correctness',
      description: 'the retry re-sends a consumed body',
      suggestedAction: 'buffer the body before the first attempt',
      file: 'src/server/routes.ts',
      evidence: [],
      ...overrides,
    },
    reviewId: 'REV-0001',
    taskId: 'TASK-003',
    round: 1,
    status,
  };
}

const QUALITY = QualityConfigSchema.parse({});

function select(findings: ProjectedFinding[]) {
  return correctiveSelection({ findings, quality: QUALITY, reviewer: 'reviewer' });
}

const PLAN = PlanSchema.parse({
  feature: 'f',
  tasks: [
    TaskSchema.parse({
      id: 'TASK-003',
      title: 'Wire the endpoint',
      description: 'Some work.',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['It compiles.'],
      validation: ['test'],
    }),
  ],
});

describe('which findings become work', () => {
  it('selects a blocking finding nobody has acted on', () => {
    expect(select([finding()])?.findings).toHaveLength(1);
  });

  it('selects one the implementer merely acknowledged', () => {
    // An acknowledgement is an answer, not a fix (§25). The work is still to do.
    expect(select([finding({}, 'acknowledged')])?.findings).toHaveLength(1);
  });

  it('selects one under dispute, because a dispute is not a resolution', () => {
    expect(select([finding({}, 'disputed')])?.findings).toHaveLength(1);
  });

  it('leaves alone one that already has corrective work', () => {
    expect(select([finding({}, 'fixed')])).toBeUndefined();
  });

  it('leaves alone one that has been verified', () => {
    expect(select([finding({}, 'verified')])).toBeUndefined();
  });

  it('leaves alone low and info, which are worth reading and not worth a task', () => {
    expect(select([finding({ severity: 'low' }), finding({ severity: 'info' })])).toBeUndefined();
  });

  it('answers with nothing when there is nothing to do, which is the common case', () => {
    expect(select([])).toBeUndefined();
  });

  it('follows the operator on medium', () => {
    const medium = [finding({ severity: 'medium' })];

    expect(correctiveSelection({ findings: medium, quality: QUALITY, reviewer: 'r' })).toBeDefined();
    expect(
      correctiveSelection({
        findings: medium,
        quality: QualityConfigSchema.parse({ blockOnMedium: false }),
        reviewer: 'r',
      }),
    ).toBeUndefined();
  });
});

describe('M6-ACC-10, 11 — the corrective task is an ordinary task', () => {
  function corrected(): Task[] {
    const selection = select([finding()]);
    const next = applyFixes(PLAN, selection!.review, {
      validation: ['test'],
      origin: 'code-review',
    });
    return next.tasks.slice(PLAN.tasks.length);
  }

  it('is added to the plan, so it goes through the scheduler like everything else', () => {
    expect(corrected()).toHaveLength(1);
  });

  it('carries validation, so a fix is not exempt from the commands', () => {
    // The generator this replaced emitted an empty list, so a fix for a review finding
    // ran no validation at all — the one outcome this workflow exists to prevent.
    expect(corrected()[0]?.validation).toEqual(['test']);
  });

  it('names the file the finding named, so ownership and overlap can see it', () => {
    // Which means the assignment policy routes it by area and the wave constraint knows
    // what it touches — the two things M6-ACC-10 and 11 are actually about.
    expect(corrected()[0]?.files.likely).toEqual(['src/server/routes.ts']);
  });

  it('takes its acceptance criterion from what the reviewer said would fix it', () => {
    expect(corrected()[0]?.acceptanceCriteria).toEqual([
      'buffer the body before the first attempt',
    ]);
  });

  it('records where it came from, including the review stage', () => {
    expect(corrected()[0]?.correctiveFor?.stage).toBe('code-review');
  });
});

describe('the link that makes fixed a fact', () => {
  it('carries the finding id onto the corrective task', () => {
    const selection = select([finding()]);
    const next = applyFixes(PLAN, selection!.review, { validation: ['test'], origin: 'code-review' });
    const added = next.tasks.slice(PLAN.tasks.length);

    expect(correctiveLinks(added)).toEqual([{ task: added[0]!.id, finding: 'FIND-0001' }]);
  });

  it('joins by id rather than by description, because two findings can share prose', () => {
    const two = [
      finding({ id: 'FIND-0001', description: 'the retry is wrong' }),
      finding({ id: 'FIND-0002', description: 'the retry is wrong', severity: 'critical' }),
    ];
    const selection = select(two);
    const next = applyFixes(PLAN, selection!.review, { validation: ['test'], origin: 'code-review' });
    const links = correctiveLinks(next.tasks.slice(PLAN.tasks.length));

    expect(links.map((link) => link.finding)).toEqual(['FIND-0001', 'FIND-0002']);
    expect(new Set(links.map((link) => link.task)).size).toBe(2);
  });

  it('links nothing for a run-level review, whose findings have no id', () => {
    const next = applyFixes(
      PLAN,
      {
        verdict: 'FAIL',
        independence: 'cross-provider',
        reviewer: { runner: 'claude', reasoning: 'high' },
        findings: [
          {
            severity: 'high',
            type: 'missing_test',
            description: 'x',
            suggestedAction: 'y',
            evidence: [],
          },
        ],
        adjudications: [],
        residualRisks: [],
      },
      { validation: ['test'], origin: 'final-review' },
    );

    expect(correctiveLinks(next.tasks.slice(PLAN.tasks.length))).toEqual([]);
  });
});
