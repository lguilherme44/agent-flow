import { describe, it, expect } from 'vitest';
import { checkDefinitionOfDone } from '../../src/core/definition-of-done.js';

const done = {
  approved: true,
  taskStates: ['completed', 'completed'] as const,
  mechanicalVerification: 'PASS' as const,
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
      mechanicalVerification: 'FAIL',
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
      mechanicalVerification: 'FAIL',
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
      'no blocking review finding is open',
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

/**
 * AD-45 and C-11 (AR-04) — `NOT_RUN` is the third value the model lacked.
 *
 * The evidence run's `review` printed `Verification: PASS` directly beneath four
 * mechanical `✗` marks. Two different questions — "did the project's own commands pass"
 * and "does the implementation look right to a reviewer" — rendered under one label, with
 * opposite answers, and the operator reasonably concluded the tool was lying.
 *
 * The Definition of Done was in fact correct. The rendering was not, and the missing value
 * was `NOT_RUN`: an environment that could not answer the question is not a codebase that
 * answered "no".
 */
describe('mechanical verification is three-valued (AD-45, C-11)', () => {
  const base = {
    approved: true,
    taskStates: ['completed'] as const,
    finalReviewVerdict: 'PASS' as const,
  };

  it('is done when the commands passed', () => {
    expect(checkDefinitionOfDone({ ...base, mechanicalVerification: 'PASS' }).done).toBe(true);
  });

  it('is not done when the commands failed', () => {
    expect(checkDefinitionOfDone({ ...base, mechanicalVerification: 'FAIL' }).done).toBe(false);
  });

  it('is not done when the commands never ran', () => {
    expect(checkDefinitionOfDone({ ...base, mechanicalVerification: 'NOT_RUN' }).done).toBe(false);
  });

  it('cites environment readiness for NOT_RUN, not a regression', () => {
    // The distinction the evidence run collapsed. "Your build is broken" and "we could not
    // run your build" send a person to two different places.
    const check = checkDefinitionOfDone({ ...base, mechanicalVerification: 'NOT_RUN' });
    const condition = check.conditions.find((entry) => entry.name.includes('lint'));

    expect(condition?.detail).toMatch(/environment|not run|prepared/i);
  });

  it('does not cite the environment when the commands genuinely failed', () => {
    const check = checkDefinitionOfDone({ ...base, mechanicalVerification: 'FAIL' });
    const condition = check.conditions.find((entry) => entry.name.includes('lint'));

    expect(condition?.detail ?? '').not.toMatch(/environment/i);
  });

  it('suppresses the model verdict as a conclusion about the code when NOT_RUN', () => {
    // AD-45: both model verdicts were formed against an environment that could not answer,
    // so they are not conclusions about the code. The Definition of Done stops treating a
    // final-review PASS as evidence.
    const check = checkDefinitionOfDone({ ...base, mechanicalVerification: 'NOT_RUN' });
    const review = check.conditions.find((entry) => entry.name.includes('final review'));

    expect(review?.met).toBe(false);
    expect(review?.detail).toMatch(/environment|could not/i);
  });

  it('keeps the model verdict meaningful when the commands did run', () => {
    const check = checkDefinitionOfDone({ ...base, mechanicalVerification: 'FAIL' });
    const review = check.conditions.find((entry) => entry.name.includes('final review'));

    expect(review?.met).toBe(true);
  });
});

/**
 * §43: the final quality decision is every required gate passing, no blocking finding
 * open, the review approved and the Definition of Done satisfied. The first three lived
 * in `decideQuality`; this one did not know about findings at all, so a run whose reviewer
 * had raised a `critical` on integrated work would still be marked `completed`.
 */
describe('a blocking review finding is not done (§43, I-44)', () => {
  it('holds the run open while one is still open', () => {
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: [...done.taskStates],
      openBlockingFindings: ['FIND-0001'],
    });

    expect(result.done).toBe(false);
    expect(result.missing).toContain('no blocking review finding is open');
  });

  it('names them, because "not done" without the id sends nobody anywhere', () => {
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: [...done.taskStates],
      openBlockingFindings: ['FIND-0001', 'FIND-0004'],
    });

    expect(result.conditions.at(-1)?.detail).toBe('still open: FIND-0001, FIND-0004');
  });

  /**
   * Unlike the review verdict, which is suppressed when the commands could not run. That
   * suppression is about a *model's* conclusion formed against a broken environment; a
   * defect someone observed in the diff is a defect either way.
   */
  it('still blocks when the commands could not run', () => {
    const result = checkDefinitionOfDone({
      ...done,
      taskStates: [...done.taskStates],
      mechanicalVerification: 'NOT_RUN',
      openBlockingFindings: ['FIND-0001'],
    });

    expect(result.missing).toContain('no blocking review finding is open');
  });

  it('behaves exactly as before when no review raised one', () => {
    const result = checkDefinitionOfDone({ ...done, taskStates: [...done.taskStates] });

    expect(result.done).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

/**
 * FR-026, FR-027 — a gate the plan required that did not run is not done.
 *
 * The final review runs four standard commands; a `validationCommands` entry is run by the
 * tasks listing it or by nobody, and a `none` task runs nothing and is recorded passing.
 */
describe('every gate the plan lists ran and passed (FR-026, FR-027)', () => {
  const GATE = 'required gates ran and passed';
  const base = { ...done, taskStates: [...done.taskStates] };

  it('adds no condition when the plan lists no gate', () => {
    // The list a run with no gate reads is exactly the list it read before.
    for (const input of [base, { ...base, requiredGates: [] }]) {
      expect(checkDefinitionOfDone(input).conditions.map((c) => c.name)).toEqual([
        'SDD approved',
        'all tasks completed',
        'lint, tests and build passing',
        'final review PASS',
        'no blocking review finding is open',
      ]);
    }
  });

  it('is done, with the condition met and no detail, when every gate passed', () => {
    const result = checkDefinitionOfDone({
      ...base,
      requiredGates: [{ id: 'test-deck', verdict: 'PASS', tasks: ['TASK-001'] }],
    });

    expect(result.done).toBe(true);
    expect(result.conditions.at(-1)).toEqual({ name: GATE, met: true });
  });

  it('is not done with a NOT_RUN gate, and names the gate, the verdict, the task and the remedy', () => {
    const result = checkDefinitionOfDone({
      ...base,
      requiredGates: [
        { id: 'test', verdict: 'PASS', tasks: ['TASK-001'] },
        { id: 'test-deck', verdict: 'NOT_RUN', tasks: ['TASK-002'], reason: 'expectation_none' },
      ],
    });

    expect(result.done).toBe(false);
    expect(result.missing).toEqual([GATE]);

    const detail = result.conditions.find((c) => c.name === GATE)?.detail ?? '';
    expect(detail).toContain('test-deck NOT_RUN (TASK-002)');
    expect(detail).toContain("validationExpectation 'none'");
    expect(detail).toMatch(/list "test-deck" in a task's validation with validationExpectation 'pass' or 'fail'/);
    // Only the unmet gate is named: a passing one in the detail reads as a problem.
    expect(detail).not.toContain('test PASS');
  });

  it('says how to declare a gate the configuration no longer has', () => {
    const result = checkDefinitionOfDone({
      ...base,
      requiredGates: [
        { id: 'typecheck-deck', verdict: 'NOT_RUN', tasks: ['TASK-001'], reason: 'not_declared' },
      ],
    });

    const detail = result.conditions.find((c) => c.name === GATE)?.detail ?? '';
    expect(detail).toContain('no longer declared');
    expect(detail).toContain('validationCommands');
    expect(detail).toContain('"typecheck-deck: <command>"');
  });

  it('names a FAIL gate without telling the reader to make it run', () => {
    const result = checkDefinitionOfDone({
      ...base,
      requiredGates: [{ id: 'lint', verdict: 'FAIL', tasks: ['TASK-003'], reason: 'failed' }],
    });

    const detail = result.conditions.find((c) => c.name === GATE)?.detail ?? '';
    expect(result.done).toBe(false);
    expect(detail).toContain('lint FAIL (TASK-003)');
    expect(detail).toContain('not satisfied');
    expect(detail).not.toContain('to make it run');
  });

  it('lists every unmet gate, and prints a reason it does not know verbatim', () => {
    const result = checkDefinitionOfDone({
      ...base,
      requiredGates: [
        { id: 'lint', verdict: 'NOT_RUN', tasks: ['TASK-001'], reason: 'no_result' },
        { id: 'test', verdict: 'NOT_RUN', tasks: [], reason: 'something_newer' },
      ],
    });

    const detail = result.conditions.find((c) => c.name === GATE)?.detail ?? '';
    expect(detail).toContain('lint NOT_RUN (TASK-001): a completed task that lists it has no command result');
    expect(detail).toContain('; test NOT_RUN: something_newer');
  });
});
