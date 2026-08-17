import { describe, it, expect } from 'vitest';
import { judgeValidation } from '../../src/core/validation-outcome.js';
import { TaskSchema } from '../../src/contracts/index.js';

/**
 * V-04 regression.
 *
 * Was a defect: a task was judged by exit code alone. Test-first development has
 * a step where a green suite is the failure — the task that writes the RED tests
 * is done correctly when they fail — and the old rule sent exactly that task to
 * review. A real plan hit this after three reviews had asked for test-first work
 * and none noticed the contradiction.
 */

const ran = (passed: boolean, count = 1) => ({ passed, ran: count });

describe('the ordinary case', () => {
  it('completes when the commands passed as expected', () => {
    expect(judgeValidation('pass', ran(true)).state).toBe('completed');
  });

  it('sends an unexpected failure to review', () => {
    const judgement = judgeValidation('pass', ran(false));
    expect(judgement.state).toBe('review_required');
    expect(judgement.note).toContain('failed');
  });
});

describe('a task whose validation is expected to fail', () => {
  it('completes when the commands fail, which is the point', () => {
    expect(judgeValidation('fail', ran(false)).state).toBe('completed');
  });

  it('sends a RED task that went green to review', () => {
    // The case a naive implementation calls success: "expected fail, did not
    // fail — fine". It is not fine. Either the test asserts nothing, or the
    // behaviour already exists, and both are worth a person's attention.
    const judgement = judgeValidation('fail', ran(true));

    expect(judgement.state).toBe('review_required');
    expect(judgement.note).toMatch(/asserts nothing|already exists/i);
  });

  it('is not a way to silence a check', () => {
    // Both directions are reported. `fail` narrows what "correct" means; it
    // does not stop anyone looking.
    expect(judgeValidation('fail', ran(true)).note).toBeDefined();
    expect(judgeValidation('pass', ran(false)).note).toBeDefined();
  });
});

describe('a task that declares no validation', () => {
  it('completes without judging anything', () => {
    expect(judgeValidation('none', ran(false)).state).toBe('completed');
    expect(judgeValidation('none', ran(true)).state).toBe('completed');
  });

  it('completes when nothing actually ran, whatever was expected', () => {
    // An empty command list cannot fail, so `fail` must not turn "there was
    // nothing to run" into a problem.
    expect(judgeValidation('fail', ran(false, 0)).state).toBe('completed');
    expect(judgeValidation('pass', ran(false, 0)).state).toBe('completed');
  });
});

describe('the full truth table', () => {
  const cases: Array<[Parameters<typeof judgeValidation>[0], boolean, string]> = [
    ['pass', true, 'completed'],
    ['pass', false, 'review_required'],
    ['fail', true, 'review_required'],
    ['fail', false, 'completed'],
    ['none', true, 'completed'],
    ['none', false, 'completed'],
  ];

  for (const [expectation, passed, state] of cases) {
    it(`${expectation} + ${passed ? 'passed' : 'failed'} → ${state}`, () => {
      expect(judgeValidation(expectation, ran(passed)).state).toBe(state);
    });
  }
});

// Regression suite — was `[DEFECT] AF-R05` in test/reanalysis.repro.test.ts.
// The judgement above is only as good as the plan it judges. A task could
// declare `validationExpectation: 'fail'` with no validation ids at all: an
// expectation with nothing that could ever falsify it, which then read as
// satisfied. A test-first task that never wrote a test passed its own gate.
describe('a contradictory expectation is rejected by the contract', () => {
  const base = {
    id: 'TASK-001',
    title: 'Write the failing tests',
    description: 'Implements FR-001.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: ['a.ts'] },
    acceptanceCriteria: ['it fails'],
  };

  it('refuses to expect a failure with nothing to run', () => {
    expect(() =>
      TaskSchema.parse({ ...base, validation: [], validationExpectation: 'fail' }),
    ).toThrow(/at least one validation id/);
  });

  it('accepts the same expectation once something can fail', () => {
    const task = TaskSchema.parse({
      ...base,
      validation: ['unit'],
      validationExpectation: 'fail',
    });

    expect(task.validationExpectation).toBe('fail');
  });

  it('leaves the other expectations alone', () => {
    // `none` with no ids, and the default `pass`, are both coherent and stay
    // valid: the rule is about a claim that cannot be tested, not about tidiness.
    expect(
      TaskSchema.parse({ ...base, validation: [], validationExpectation: 'none' })
        .validationExpectation,
    ).toBe('none');
    expect(TaskSchema.parse({ ...base, validation: [] }).validationExpectation).toBe('pass');
  });
});

/**
 * C-14 (AR-05a) — a RED task must prove it wrote something.
 *
 * D-2 from the evidence run. `judgeValidation` saw only `{passed, ran}`, so a task whose
 * expectation was `fail` was credited the moment the suite failed — and the suite was
 * already failing, reddened by the task before it. TASK-002 changed nothing, ran a suite
 * somebody else had broken, and was recorded satisfied.
 *
 * "The suite is red" is a fact about the repository. "This task made it red" is the claim
 * being judged, and only a non-empty diff can support it.
 */
describe('a RED task is not satisfied by inaction (C-14)', () => {
  it('is satisfied when the suite fails and the task wrote something', () => {
    expect(
      judgeValidation('fail', { passed: false, ran: 1, changed: true }).state,
    ).toBe('completed');
  });

  it('is not satisfied when the suite fails and the task wrote nothing', () => {
    const judgement = judgeValidation('fail', { passed: false, ran: 1, changed: false });

    expect(judgement.state).toBe('review_required');
    expect(judgement.note).toMatch(/nothing|no change|empty/i);
  });

  it('names the failure class the taxonomy has for it', () => {
    expect(judgeValidation('fail', { passed: false, ran: 1, changed: false }).failureClass).toBe(
      'acceptance_evidence_missing',
    );
  });

  it('still refuses a RED task whose suite went green, whatever it wrote', () => {
    // The pre-existing asymmetry, untouched: a RED task that passes means the test
    // asserts nothing or the behaviour already existed.
    expect(judgeValidation('fail', { passed: true, ran: 1, changed: true }).state).toBe(
      'review_required',
    );
  });

  it('leaves a GREEN task’s judgement exactly as it was', () => {
    // AR-05a sharpens the `fail` branch. The `pass` branch is about whether commands
    // passed, and an empty diff there is caught by AD-38's assertion instead — one rule,
    // one place.
    expect(judgeValidation('pass', { passed: true, ran: 1, changed: false }).state).toBe(
      'completed',
    );
    expect(judgeValidation('pass', { passed: false, ran: 1, changed: true }).state).toBe(
      'review_required',
    );
  });

  it('treats an unknown diff as no evidence against the task', () => {
    // A sequential run captures no tree, so `changed` is unknowable. Refusing there would
    // fail every RED task on the strength of a measurement nobody took.
    expect(judgeValidation('fail', { passed: false, ran: 1 }).state).toBe('completed');
  });

  it('says nothing about a task that ran no validation', () => {
    expect(judgeValidation('fail', { passed: false, ran: 0, changed: false }).state).toBe(
      'completed',
    );
  });
});
