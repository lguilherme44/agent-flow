import { describe, it, expect } from 'vitest';
import { checkDefinitionOfDone } from '../../src/core/definition-of-done.js';

const done = {
  approved: true,
  taskStates: ['completed', 'completed'] as const,
  verificationPassed: true,
  finalReviewVerdict: 'PASS' as const,
};

describe('checkDefinitionOfDone (§42)', () => {
  it('is done only when every condition holds', () => {
    const result = checkDefinitionOfDone({ ...done, taskStates: [...done.taskStates] });
    expect(result.done).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('is not done without approval', () => {
    const result = checkDefinitionOfDone({ ...done, approved: false, taskStates: [...done.taskStates] });
    expect(result.done).toBe(false);
    expect(result.missing).toContain('SDD approved');
  });

  it('is not done while a task is unfinished', () => {
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: ['completed', 'review_required'],
    });

    expect(result.done).toBe(false);
    expect(result.missing).toContain('all tasks completed');
  });

  it('is not done when the commands failed', () => {
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: [...done.taskStates],
      verificationPassed: false,
    });
    expect(result.missing).toContain('lint, tests and build passing');
  });

  it('is not done when the final review failed', () => {
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: [...done.taskStates],
      finalReviewVerdict: 'FAIL',
    });
    expect(result.missing).toContain('final review PASS');
  });

  it('is not done when no final review has run at all', () => {
    // "Nobody looked" is not the same as "it passed".
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: [...done.taskStates],
      finalReviewVerdict: null,
    });

    expect(result.done).toBe(false);
    expect(result.conditions.find((c) => c.name === 'final review PASS')?.detail).toMatch(
      /no final review/i,
    );
  });

  it('is not done when there were no tasks to run', () => {
    // An empty plan trivially has no incomplete tasks. That must not read as
    // success — it means nothing was built.
    const result = checkDefinitionOfDone({ ...done, taskStates: [] });

    expect(result.done).toBe(false);
    expect(result.conditions.find((c) => c.name === 'all tasks completed')?.detail).toMatch(
      /no tasks/i,
    );
  });

  it('reports every unmet condition, not just the first', () => {
    const result = checkDefinitionOfDone({
      approved: false,
      taskStates: ['failed'],
      verificationPassed: false,
      finalReviewVerdict: 'FAIL',
    });

    expect(result.missing).toHaveLength(4);
  });

  it('lists the conditions in the order the spec states them', () => {
    const result = checkDefinitionOfDone({ ...done, taskStates: [...done.taskStates] });
    expect(result.conditions.map((c) => c.name)).toEqual([
      'SDD approved',
      'all tasks completed',
      'lint, tests and build passing',
      'final review PASS',
    ]);
  });

  it('says how many tasks are outstanding', () => {
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: ['completed', 'failed', 'blocked'],
    });
    expect(result.conditions[1]?.detail).toContain('2');
  });
});
