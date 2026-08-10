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
    const next = applyFixes(plan(['TASK-001']), review([{}, {}]), { validation: ['test'] });

    expect(next.tasks.map((t) => t.id)).toEqual(['TASK-001', 'FIX-001', 'FIX-002']);
  });

  it('gives them something to validate against', () => {
    const next = applyFixes(plan(['TASK-001']), review([{}]), { validation: ['test', 'lint'] });
    const fix = next.tasks.find((t) => t.id === 'FIX-001');

    expect(fix?.validation).toEqual(['test', 'lint']);
  });

  it('leaves validation empty when the project configures none', () => {
    // Not invented. An id that does not resolve fails the task for the wrong
    // reason, which is worse than admitting there is nothing to run.
    const next = applyFixes(plan(['TASK-001']), review([{}]), { validation: [] });

    expect(next.tasks.find((t) => t.id === 'FIX-001')?.validation).toEqual([]);
  });

  it('does not renumber over fixes from an earlier round', () => {
    // A second review of a corrected plan produces FIX-002, not another
    // FIX-001 — otherwise the DAG has two tasks with one id.
    const next = applyFixes(plan(['TASK-001', 'FIX-001']), review([{}]), { validation: ['test'] });

    expect(next.tasks.map((t) => t.id)).toEqual(['TASK-001', 'FIX-001', 'FIX-002']);
  });

  it('ignores findings below the severity threshold', () => {
    const next = applyFixes(
      plan(['TASK-001']),
      review([{ severity: 'low' }, { severity: 'high' }]),
      { validation: ['test'] },
    );

    expect(next.tasks.map((t) => t.id)).toEqual(['TASK-001', 'FIX-001']);
  });

  it('returns the plan untouched when nothing is actionable', () => {
    const original = plan(['TASK-001']);
    const next = applyFixes(original, review([{ severity: 'low' }]), { validation: ['test'] });

    expect(next).toEqual(original);
  });

  it('keeps the original tasks exactly as they were', () => {
    // They already ran. Rewriting them would invalidate results on disk that
    // describe work actually done.
    const original = plan(['TASK-001']);
    const next = applyFixes(original, review([{}]), { validation: ['test'] });

    expect(next.tasks[0]).toEqual(original.tasks[0]);
  });

  it('produces a plan the schema still accepts', () => {
    const next = applyFixes(plan(['TASK-001']), review([{}]), { validation: ['test'] });

    expect(() => PlanSchema.parse(next)).not.toThrow();
  });
});
