import { describe, it, expect } from 'vitest';
import { PlanSchema, ReviewResultSchema } from '../../src/contracts/index.js';
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
