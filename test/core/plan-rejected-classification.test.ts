import { describe, it, expect } from 'vitest';
import {
  classifyRunnerFailure,
  dispositionOf,
  failureClassDefinition,
  failureGroupOf,
} from '../../src/core/failure-classification.js';

/**
 * A plan that parses, satisfies the schema, and loses on a plan rule is not
 * malformed output — and calling it that costs the reader their first hypothesis.
 *
 * Measured on a real run: six coherent tasks, valid JSON against `PlanSchema`,
 * rejected because two of them were independent in the DAG and declared the same
 * file. The code said `malformed_runner_output`; the message right below it
 * explained a content problem.
 */
describe('plan_rejected_by_checks is its own failure class', () => {
  it('is defined, and refines invalid_output like malformed output does', () => {
    const entry = failureClassDefinition('plan_rejected_by_checks');
    expect(entry.refines).toBe('invalid_output');
    expect(failureGroupOf('plan_rejected_by_checks')).toBe('RUNNER');
  });

  it('requires a human, because retrying the same prompt reproduces the same plan', () => {
    expect(dispositionOf('plan_rejected_by_checks')).toBe('requires_human');
  });

  it('names revise as the action — the one case where it is the right tool', () => {
    expect(failureClassDefinition('plan_rejected_by_checks').humanAction).toContain('revise');
  });

  it('parts ways with malformed_runner_output exactly where it matters', () => {
    // Same refinement, opposite disposition: one is worth retrying, the other
    // needs an instruction.
    expect(failureClassDefinition('malformed_runner_output').refines).toBe('invalid_output');
    expect(dispositionOf('malformed_runner_output')).toBe('recoverable');
    expect(dispositionOf('plan_rejected_by_checks')).not.toBe(
      dispositionOf('malformed_runner_output'),
    );
  });

  it('is never inferred from a transport code alone', () => {
    // Nothing guesses this class: it is asserted by the pipeline, the only place
    // that knows the schema passed before the rule failed.
    expect(classifyRunnerFailure({ errorCode: 'invalid_output' }).failureClass).not.toBe(
      'plan_rejected_by_checks',
    );
  });
});
