import { describe, it, expect } from 'vitest';
import { PlanSchema } from '../../src/contracts/index.js';
import { repairCorrectivePlan } from '../../src/core/corrective-plan-repair.js';

/**
 * AD-47 / C-16 — a corrective plan repairs itself against mechanical constraints.
 *
 * `runCorrectiveRound` was one-shot: `checkPlan` fails → `invalid_plan`, and the operator
 * writes the revision. AD-42 exists to stop generating the plans that failed in the
 * evidence run — same file, no dependency, wrong complexity — and this loop exists for the
 * residue, because "AD-42 is complete" is not a claim worth betting a stuck run on.
 *
 * **The repairs are a closed set, and that is the decision, not an implementation detail.**
 * Adding an overlap-derived dependency, correcting complexity, dropping a duplicate
 * finding, and replacing an unresolvable validation id with the project's defaults. Each is
 * mechanical and each is reversible by reading the plan. A model-authored repair is
 * explicitly out of scope: answering a model's objection with a model's rewrite lets the
 * system talk itself past its own gate.
 */

const task = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: id,
  description: 'Work.',
  complexity: 'normal',
  risk: 'low',
  dependencies: [],
  requirements: ['FR-001'],
  acceptanceCriteria: ['Done.'],
  validation: [],
  ...overrides,
});

const plan = (tasks: Record<string, unknown>[]) =>
  PlanSchema.parse({ feature: 'f', tasks });

describe('the closed repair set (AD-47)', () => {
  it('adds the dependency two contending tasks were missing', () => {
    // C-17's pair, repaired instead of reported. Two mutually independent tasks declaring
    // the same file would be dispatched together and fight over it.
    const invalid = plan([
      task('FIX-001', { files: { likely: ['test/cli/cli.test.ts'] } }),
      task('FIX-002', { files: { likely: ['test/cli/cli.test.ts'] } }),
    ]);

    const repaired = repairCorrectivePlan(invalid, { correctiveIds: ['FIX-001', 'FIX-002'] });

    expect(repaired.applied).toContain('overlap_dependency');
    const second = repaired.plan.tasks.find((entry) => entry.id === 'FIX-002');
    expect(second?.dependencies).toEqual(['FIX-001']);
  });

  it('replaces a validation id the project does not define', () => {
    const invalid = plan([task('FIX-001', { validation: ['recurrence'] })]);

    const repaired = repairCorrectivePlan(invalid, {
      correctiveIds: ['FIX-001'],
      validation: { ids: ['test', 'lint'], defaults: ['test'] },
    });

    expect(repaired.applied).toContain('validation_id');
    expect(repaired.plan.tasks[0]?.validation).toEqual(['test']);
  });

  it('drops a fix that duplicates another fix outright', () => {
    // A duplicate finding produces two tasks that would both edit the same thing for the
    // same reason, and the second one merges into a tree the first already changed.
    const invalid = plan([
      task('FIX-001', { title: 'Fix the default', files: { likely: ['src/a.ts'] } }),
      task('FIX-002', { title: 'Fix the default', files: { likely: ['src/a.ts'] } }),
    ]);

    const repaired = repairCorrectivePlan(invalid, { correctiveIds: ['FIX-001', 'FIX-002'] });

    expect(repaired.applied).toContain('duplicate_finding');
    expect(repaired.plan.tasks.map((entry) => entry.id)).toEqual(['FIX-001']);
  });

  it('corrects a complexity that does not match the work', () => {
    // AD-42's category error, repaired where it survived: severity measures how much a
    // defect matters, complexity how much work it is. A one-file test edit is trivial
    // however critical the finding.
    const invalid = plan([
      task('FIX-001', { complexity: 'complex', files: { likely: ['test/a.test.ts'] } }),
    ]);

    const repaired = repairCorrectivePlan(invalid, { correctiveIds: ['FIX-001'] });

    expect(repaired.applied).toContain('complexity');
    expect(repaired.plan.tasks[0]?.complexity).toBe('trivial');
  });
});

describe('what the repair refuses to touch', () => {
  it('never reorders or edits a task that already ran', () => {
    // Its result is on disk and describes work that happened. The repair set is closed to
    // corrective tasks precisely so a repair cannot rewrite history.
    const invalid = plan([
      task('TASK-001', { complexity: 'complex', files: { likely: ['test/a.test.ts'] } }),
      task('FIX-001', { files: { likely: ['test/a.test.ts'] } }),
    ]);

    const repaired = repairCorrectivePlan(invalid, { correctiveIds: ['FIX-001'] });

    expect(repaired.plan.tasks[0]).toEqual(invalid.tasks[0]);
  });

  it('returns the plan untouched, and says so, when nothing mechanical applies', () => {
    // The signal the caller needs in order to stop. A repair loop that reports progress
    // without making any is the loop C-22 exists to terminate.
    const valid = plan([task('FIX-001', { files: { likely: ['src/a.ts'] } })]);

    const repaired = repairCorrectivePlan(valid, { correctiveIds: ['FIX-001'] });

    expect(repaired.applied).toEqual([]);
    expect(repaired.plan).toEqual(valid);
  });

  it('produces a plan the schema still accepts', () => {
    const invalid = plan([
      task('FIX-001', { files: { likely: ['src/a.ts'] } }),
      task('FIX-002', { files: { likely: ['src/a.ts'] } }),
    ]);

    const repaired = repairCorrectivePlan(invalid, { correctiveIds: ['FIX-001', 'FIX-002'] });

    expect(() => PlanSchema.parse(repaired.plan)).not.toThrow();
  });

  it('never invents a validation id when the project defines none', () => {
    // "Not invented" beats "plausible": an id that does not resolve fails the task for the
    // wrong reason, which is worse than admitting there is nothing to run.
    const invalid = plan([task('FIX-001', { validation: ['recurrence'] })]);

    const repaired = repairCorrectivePlan(invalid, {
      correctiveIds: ['FIX-001'],
      validation: { ids: [], defaults: [] },
    });

    expect(repaired.plan.tasks[0]?.validation).toEqual([]);
  });
});
