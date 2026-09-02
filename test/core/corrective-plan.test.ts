import { describe, it, expect } from 'vitest';
import {
  PlanSchema,
  ReviewResultSchema,
  type ReviewFinding,
  type ReviewResult,
} from '../../src/contracts/index.js';
import { applyFixes } from '../../src/core/corrective-plan.js';

const plan = (ids: string[]) =>
  PlanSchema.parse({
    feature: 'f',
    tasks: ids.map((id) => ({
      id,
      title: 'Do it',
      description: 'Implements FR-001.',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['It works.'],
      validation: ['test'],
    })),
  });

const review = (findings: Array<Record<string, unknown>>) =>
  ReviewResultSchema.parse({
    verdict: 'FAIL',
    independence: 'cross-provider',
    reviewer: { runner: 'codex', reasoning: 'very_high' },
    findings: findings.map((f) => ({
      severity: 'medium',
      type: 'coverage',
      description: 'The default is never exercised by any test.',
      suggestedAction: 'Add a test that omits the argument.',
      ...f,
    })),
  });

/**
 * §29 says corrective tasks re-enter the same pipeline — routed, executed and
 * verified like any other task. `findingsToTasks` produced them and nothing
 * consumed them, so the loop existed on paper only. Closing it turned up a
 * defect in the generator itself: the tasks it produced carried
 * `validation: []`, meaning a fix for a review finding would have run no
 * validation at all. A correction nobody checks is the one thing this workflow
 * exists to prevent.
 */
describe('corrective tasks enter the plan like any other', () => {
  it('appends a task per actionable finding', () => {
    const next = applyFixes(plan(['TASK-001']), review([{}, {}]), { validation: ['test'], origin: 'final-review' });

    expect(next.tasks.map((t) => t.id)).toEqual(['TASK-001', 'FIX-001', 'FIX-002']);
  });

  it('gives them something to validate against', () => {
    const next = applyFixes(plan(['TASK-001']), review([{}]), { validation: ['test', 'lint'], origin: 'final-review' });
    const fix = next.tasks.find((t) => t.id === 'FIX-001');

    expect(fix?.validation).toEqual(['test', 'lint']);
  });

  it('leaves validation empty when the project configures none', () => {
    // Not invented. An id that does not resolve fails the task for the wrong
    // reason, which is worse than admitting there is nothing to run.
    const next = applyFixes(plan(['TASK-001']), review([{}]), { validation: [], origin: 'final-review' });

    expect(next.tasks.find((t) => t.id === 'FIX-001')?.validation).toEqual([]);
  });

  it('does not renumber over fixes from an earlier round', () => {
    // A second review of a corrected plan produces FIX-002, not another
    // FIX-001 — otherwise the DAG has two tasks with one id.
    const next = applyFixes(plan(['TASK-001', 'FIX-001']), review([{}]), { validation: ['test'], origin: 'final-review' });

    expect(next.tasks.map((t) => t.id)).toEqual(['TASK-001', 'FIX-001', 'FIX-002']);
  });

  it('ignores findings below the severity threshold', () => {
    const next = applyFixes(
      plan(['TASK-001']),
      review([{ severity: 'low' }, { severity: 'high' }]),
      { validation: ['test'], origin: 'final-review' },
    );

    expect(next.tasks.map((t) => t.id)).toEqual(['TASK-001', 'FIX-001']);
  });

  it('returns the plan untouched when nothing is actionable', () => {
    const original = plan(['TASK-001']);
    const next = applyFixes(original, review([{ severity: 'low' }]), { validation: ['test'], origin: 'final-review' });

    expect(next).toEqual(original);
  });

  it('keeps the original tasks exactly as they were', () => {
    // They already ran. Rewriting them would invalidate results on disk that
    // describe work actually done.
    const original = plan(['TASK-001']);
    const next = applyFixes(original, review([{}]), { validation: ['test'], origin: 'final-review' });

    expect(next.tasks[0]).toEqual(original.tasks[0]);
  });

  it('produces a plan the schema still accepts', () => {
    const next = applyFixes(plan(['TASK-001']), review([{}]), { validation: ['test'], origin: 'final-review' });

    expect(() => PlanSchema.parse(next)).not.toThrow();
  });
});

/**
 * AF-H03. The generator filled `requirements` with `FR-001` whenever a finding
 * named no requirement, because the schema demanded one. Most findings name
 * none — `out_of_scope`, `missing_test`, `security`, `architectural_deviation`
 * are about the shape of the work, not about a numbered requirement — so the
 * common case produced a citation nobody wrote, and coverage checking then
 * counted it as real work against FR-001.
 *
 * Traceability is not optional; inventing it is. The origin of a corrective task
 * is now its own field, and `requirements` says only what the finding said.
 */
describe('a corrective task traces to its finding, not to an invented requirement', () => {
  it('keeps a requirement the finding actually named', () => {
    const next = applyFixes(
      plan(['TASK-001']),
      review([{ requirement: 'FR-002', type: 'missing_test' }]),
      { validation: ['test'], origin: 'final-review' },
    );
    const fix = next.tasks.find((t) => t.id === 'FIX-001');

    expect(fix?.requirements).toEqual(['FR-002']);
    expect(fix?.correctiveFor?.requirement).toBe('FR-002');
  });

  it('leaves the requirement empty when the finding named none', () => {
    const next = applyFixes(plan(['TASK-001']), review([{ type: 'out_of_scope' }]), {
      validation: ['test'],
      origin: 'final-review',
    });
    const fix = next.tasks.find((t) => t.id === 'FIX-001');

    expect(fix?.requirements).toEqual([]);
    expect(fix?.correctiveFor?.requirement).toBeUndefined();
  });

  it('records the finding it answers, so the task is still traceable', () => {
    const next = applyFixes(
      plan(['TASK-001']),
      review([{ type: 'security', severity: 'critical', file: 'src/auth.ts' }]),
      { validation: ['test'], origin: 'final-review' },
    );
    const fix = next.tasks.find((t) => t.id === 'FIX-001');

    expect(fix?.correctiveFor).toMatchObject({
      stage: 'final-review',
      findingType: 'security',
      severity: 'critical',
      file: 'src/auth.ts',
    });
    expect(fix?.correctiveFor?.description).toContain('default');
  });

  it('carries the review it came from, not a default', () => {
    const next = applyFixes(plan(['TASK-001']), review([{}]), {
      validation: ['test'],
      origin: 'verification',
    });

    expect(next.tasks.find((t) => t.id === 'FIX-001')?.correctiveFor?.stage).toBe('verification');
  });

  it('leaves planned tasks bound to a requirement', () => {
    // The exception is for corrective tasks only. A planned task with no
    // requirement is the hole coverage checking exists to close.
    expect(() =>
      PlanSchema.parse({
        feature: 'f',
        tasks: [
          {
            id: 'TASK-001',
            title: 'Do it',
            description: 'Something.',
            complexity: 'normal',
            risk: 'low',
            requirements: [],
            acceptanceCriteria: ['It works.'],
          },
        ],
      }),
    ).toThrow(/requirement/i);
  });
});

/**
 * AD-42 (AR-06) — the two defects the evidence run's corrective round produced.
 *
 * `applyFixes` hardcoded `dependencies: []` and mapped `severity: high|critical` to
 * `complexity: complex`. FIX-001 and FIX-002 both targeted `test/cli/cli.test.ts` with no
 * dependency between them — same wave, same file, guaranteed conflict — and all three
 * fixes were classified `complex` because all three findings were `high`.
 */
describe('corrective tasks are ordered and sized from the work (AD-42, C-16)', () => {
  const finding = (overrides: Record<string, unknown> = {}) => ({
    type: 'correctness' as const,
    severity: 'high' as const,
    description: 'A defect worth fixing.',
    suggestedAction: 'Fix it.',
    ...overrides,
  });

  const planOf = () =>
    PlanSchema.parse({
      feature: 'f',
      tasks: [
        {
          id: 'TASK-001',
          title: 'One',
          description: 'Do one.',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          acceptanceCriteria: ['Done.'],
          validation: [],
        },
      ],
    });

  const fixesOf = (review: Parameters<typeof applyFixes>[1]) =>
    applyFixes(planOf(), review, { origin: 'final-review', validation: ['test'] }).tasks.filter(
      (task) => task.id.startsWith('FIX-'),
    );

  it('orders two fixes that target the same file', () => {
    const fixes = fixesOf({
      verdict: 'FAIL',
      summary: 's',
      findings: [
        finding({ file: 'test/cli/cli.test.ts', description: 'first' }),
        finding({ file: 'test/cli/cli.test.ts', description: 'second' }),
      ],
    } as never);

    expect(fixes[0]?.dependencies).toEqual([]);
    expect(fixes[1]?.dependencies).toEqual([fixes[0]?.id]);
  });

  it('leaves fixes on different files parallel', () => {
    const fixes = fixesOf({
      verdict: 'FAIL',
      summary: 's',
      findings: [finding({ file: 'src/a.ts' }), finding({ file: 'src/b.ts' })],
    } as never);

    expect(fixes.every((fix) => fix.dependencies.length === 0)).toBe(true);
  });

  it('sizes a one-file test fix as trivial, whatever the severity', () => {
    // The category error: severity measures how much a defect matters, complexity how
    // much work it is. Using one for the other put the highest-effort model on a one-line
    // test edit.
    const fixes = fixesOf({
      verdict: 'FAIL',
      summary: 's',
      findings: [finding({ severity: 'critical', file: 'test/cli/cli.test.ts' })],
    } as never);

    expect(fixes[0]?.complexity).toBe('trivial');
    // Risk still follows severity, and correctly: a critical defect is risky to touch
    // however small the edit.
    expect(fixes[0]?.risk).toBe('high');
  });

  it('sizes an unlocated finding as complex, because it has to be found first', () => {
    const fixes = fixesOf({
      verdict: 'FAIL',
      summary: 's',
      findings: [finding({ severity: 'medium' })],
    } as never);

    expect(fixes[0]?.complexity).toBe('complex');
  });

  it('sizes an ordinary source fix as normal', () => {
    const fixes = fixesOf({
      verdict: 'FAIL',
      summary: 's',
      findings: [finding({ file: 'src/app/thing.ts' })],
    } as never);

    expect(fixes[0]?.complexity).toBe('normal');
  });

  it('keeps the file the finding named, which the ordering pass once deleted', () => {
    // **The regression this test exists for.** Deriving the dependencies spread each task
    // through the overlap helper under a flattened `files` key and stripped that key on
    // the way back, which deleted the real `files: { likely }` object — so every generated
    // fix declared no files at all.
    //
    // Silent, because the plan still parsed and the ordering was still correct. What broke
    // was everything downstream that asks a corrective task which files it will touch: the
    // AD-46 envelope reads it to decide whether an approval already covers the round, the
    // AD-38 scope assertion judges the diff against it, and `checkPlan`'s overlap guard
    // compares it between tasks. All three quietly saw an empty set and agreed.
    const fixes = fixesOf({
      verdict: 'FAIL',
      summary: 's',
      findings: [finding({ file: 'src/never-touched.ts' })],
    } as never);

    expect(fixes[0]?.files.likely).toEqual(['src/never-touched.ts']);
  });

  it('never orders a new fix against a task that already ran', () => {
    // An existing task's result is on disk and describes work that happened. Adding an
    // edge to it would reorder something finished.
    const fixes = fixesOf({
      verdict: 'FAIL',
      summary: 's',
      findings: [finding({ file: 'src/a.ts' })],
    } as never);

    expect(fixes[0]?.dependencies).not.toContain('TASK-001');
  });
});

/**
 * `review --fix` on a run that halted.
 *
 * The ordering used to be derived among the new tasks only, on the premise that an
 * existing task has already run. The live M6 dogfood falsified it: two tasks exhausted
 * their attempts, the run stopped with three tasks unfinished, and the four generated
 * fixes declared the same files as tasks still waiting to execute. `checkPlan` refused the
 * whole plan for file contention and the corrective round produced nothing — which is the
 * failure AD-42 exists to prevent, one level up from where it was being prevented.
 */
describe('a fix is ordered against the plan it joins, not only against its siblings', () => {
  const planWith = (entries: Array<{ id: string; files: string[] }>) =>
    PlanSchema.parse({
      feature: 'f',
      tasks: entries.map(({ id, files }) => ({
        id,
        title: 'Do it',
        description: 'Implements FR-001.',
        complexity: 'normal',
        risk: 'low',
        dependencies: [],
        requirements: ['FR-001'],
        files: { likely: files },
        acceptanceCriteria: ['It works.'],
        validation: ['test'],
      })),
    });

  it('depends on the existing task it would contend with', () => {
    const next = applyFixes(
      planWith([{ id: 'TASK-001', files: ['src/badge.js'] }]),
      review([{ file: 'src/badge.js' }]),
      { validation: ['test'], origin: 'final-review' },
    );

    expect(next.tasks.at(-1)?.dependencies).toContain('TASK-001');
  });

  it('leaves a fix that shares nothing free to run in the first wave', () => {
    const next = applyFixes(
      planWith([{ id: 'TASK-001', files: ['src/badge.js'] }]),
      review([{ file: 'src/index.js' }]),
      { validation: ['test'], origin: 'final-review' },
    );

    expect(next.tasks.at(-1)?.dependencies).toEqual([]);
  });

  /** Never the reverse: work already in the plan is not reordered behind a correction. */
  it('adds no edge to the existing task', () => {
    const next = applyFixes(
      planWith([{ id: 'TASK-001', files: ['src/badge.js'] }]),
      review([{ file: 'src/badge.js' }]),
      { validation: ['test'], origin: 'final-review' },
    );

    expect(next.tasks[0]?.dependencies).toEqual([]);
  });

  it('still orders the fixes among themselves', () => {
    const next = applyFixes(
      planWith([{ id: 'TASK-001', files: ['src/other.js'] }]),
      review([{ file: 'src/badge.js' }, { file: 'src/badge.js' }]),
      { validation: ['test'], origin: 'final-review' },
    );

    expect(next.tasks.at(-1)?.dependencies).toContain('FIX-001');
  });
});

/**
 * Both live M6 corrective rounds were rejected by the plan review over this, in two
 * different repositories:
 *
 * > TASK-001 deliberately leaves the suite RED (its own expectation is `fail`). So FIX-001
 * > becomes eligible the moment TASK-001 finishes and in that window `npm run test` cannot
 * > pass. The task only works by accident. A parallel scheduler produces a false failure
 * > and burns retry attempts on a task whose content is correct.
 *
 * A correction stands where the work it corrects stood.
 */
describe('a fix inherits the cycle position of the task it corrects', () => {
  /**
   * Built rather than parsed: `ReviewResultSchema` describes a *proposed* finding, which
   * has no id, so parsing strips the field the map is keyed on. Production never
   * round-trips these — `correctiveSelection` hands the generator `ReviewFinding`s
   * straight off the projection.
   */
  const withId = (id: string): ReviewResult => {
    const findings: ReviewFinding[] = [
      {
        id: id as ReviewFinding['id'],
        severity: 'high',
        type: 'correctness',
        description: 'The assertion cannot fail.',
        suggestedAction: 'Assert on the value, not on the string.',
        file: 'test/a.test.js',
        evidence: [],
      },
    ];

    return {
      verdict: 'FAIL',
      independence: 'cross-provider',
      reviewer: { runner: 'reviewer', reasoning: 'high' },
      findings,
      adjudications: [],
      residualRisks: [],
    };
  };

  it('expects a red suite when the corrected task did', () => {
    const next = applyFixes(plan(['TASK-001']), withId('FIND-0001'), {
      validation: ['test'],
      origin: 'code-review',
      expectationFor: new Map([['FIND-0001', 'fail' as const]]),
    });

    expect(next.tasks.at(-1)?.validationExpectation).toBe('fail');
  });

  it('keeps `pass` for a finding nobody mapped', () => {
    const next = applyFixes(plan(['TASK-001']), withId('FIND-0002'), {
      validation: ['test'],
      origin: 'code-review',
      expectationFor: new Map([['FIND-0001', 'fail' as const]]),
    });

    expect(next.tasks.at(-1)?.validationExpectation).toBe('pass');
  });

  it('keeps `pass` for a run-level finding, which carries no id', () => {
    const next = applyFixes(plan(['TASK-001']), review([{ file: 'src/a.js' }]), {
      validation: ['test'],
      origin: 'final-review',
    });

    expect(next.tasks.at(-1)?.validationExpectation).toBe('pass');
  });
});
