import { describe, it, expect } from 'vitest';
import {
  FAILURE_CLASSES,
  RUNNER_ERROR_CODES,
  FALLBACK_TRIGGERS,
  type FailureClass,
} from '../../src/contracts/index.js';
import {
  FAILURE_CLASS_DEFINITIONS,
  classesRefining,
  consumesAttempt,
  defaultClassForRunnerError,
  dispositionOf,
  failureClassDefinition,
  failureGroupOf,
  refinedRunnerErrorCode,
} from '../../src/core/failure-classification.js';

/**
 * The taxonomy as a table, held to AR §3 and AR §5.
 *
 * Most of these are *totality* assertions rather than behaviour, and that is the point: a
 * lookup table's failure mode is not a wrong answer, it is a missing row — and a missing
 * row surfaces months later as a class with no recovery policy, defaulted around by
 * whichever caller noticed first.
 */

describe('the table is total and single-valued (AR-00 acceptance)', () => {
  it('defines exactly one row per declared class', () => {
    const defined = FAILURE_CLASS_DEFINITIONS.map((entry) => entry.failureClass);

    expect([...defined].sort()).toEqual([...FAILURE_CLASSES].sort());
    expect(new Set(defined).size).toBe(defined.length);
  });

  it('maps every class to at most one runner error code', () => {
    // Single-valued from class → code. The reverse is deliberately one-to-many: that is
    // what "refinement" means, and it is how AR-02 will know which candidates a raw
    // output has to be told apart between.
    for (const failureClass of FAILURE_CLASSES) {
      const code = refinedRunnerErrorCode(failureClass);
      if (code !== undefined) {
        expect(RUNNER_ERROR_CODES).toContain(code);
      }
    }
  });

  it('leaves RUNNER_ERROR_CODES untouched, and does not duplicate it', () => {
    // AD-36's compatibility clause. `FALLBACK_TRIGGERS` is a subset of the runner codes at
    // the schema level, so growing that enum would change fallback reasoning as a side
    // effect — which is why the refinement lives above it instead.
    expect([...RUNNER_ERROR_CODES]).toEqual([
      'quota_exceeded',
      'auth_required',
      'runner_unavailable',
      'timeout',
      'execution_failed',
      'invalid_output',
      'blocked',
    ]);

    for (const trigger of FALLBACK_TRIGGERS) {
      expect(RUNNER_ERROR_CODES).toContain(trigger);
    }

    // And no class *is* a runner code under another name, except where the spec says the
    // two coincide. `runner_unavailable` is the one deliberate overlap: AR §3.1 gives it
    // the same spelling because it refines itself at the preflight level.
    const shared = FAILURE_CLASSES.filter((name) =>
      (RUNNER_ERROR_CODES as readonly string[]).includes(name),
    );
    expect(shared).toEqual(['runner_unavailable']);
  });

  it('gives every class a group, and every group at least one class', () => {
    const groups = new Set(FAILURE_CLASSES.map((failureClass) => failureGroupOf(failureClass)));
    expect([...groups].sort()).toEqual([
      'INTEGRATION',
      'PRE_EXECUTION',
      'REVIEW',
      'RUNNER',
      'TASK',
    ]);
  });

  it('throws on a class the table does not know', () => {
    // Rather than returning undefined and letting a caller default around it: reaching
    // this branch means the enum and the table have diverged, which is a programming
    // error to surface immediately.
    expect(() => failureClassDefinition('not_a_class' as FailureClass)).toThrow(
      /no definition for failure class/,
    );
  });
});

describe('I-22 — a PRE_EXECUTION failure never consumes a work attempt', () => {
  it('holds for every class in the group, without exception', () => {
    // The invariant, asserted over the group rather than over a list somebody maintains.
    // This is what makes `retry --force` unnecessary for an environment fault.
    for (const failureClass of FAILURE_CLASSES) {
      if (failureGroupOf(failureClass) !== 'PRE_EXECUTION') continue;
      expect(consumesAttempt(failureClass), failureClass).toBe(false);
    }
  });

  it('is not merely a restatement of the group', () => {
    // Two RUNNER classes also consume nothing, so a caller reasoning from the group alone
    // would be wrong about exactly the case that forced `retry --force` in the evidence
    // run: an attempt died on a denied command, which says nothing about the work.
    expect(consumesAttempt('runner_permission_required')).toBe(false);
    expect(failureGroupOf('runner_permission_required')).toBe('RUNNER');

    expect(consumesAttempt('runner_quota_exhausted')).toBe(false);
    expect(consumesAttempt('runner_execution_failed')).toBe(true);
  });

  it('counts the TASK failures that did produce judged work', () => {
    for (const failureClass of [
      'validation_unsatisfied',
      'acceptance_evidence_missing',
      'acceptance_evidence_unsatisfied',
      'scope_violation',
      'agent_blocked',
    ] as const) {
      expect(consumesAttempt(failureClass), failureClass).toBe(true);
    }
  });
});

describe('dispositions (AR §3.6)', () => {
  it('gives every class exactly one disposition', () => {
    for (const failureClass of FAILURE_CLASSES) {
      expect(['recoverable', 'requires_human', 'recovery_exhausted']).toContain(
        dispositionOf(failureClass),
      );
    }
  });

  it('names one specific human action for every class that needs a human', () => {
    // C-22's contract at the table level: `something failed, inspect logs` is a contract
    // violation, so a class that escalates without an action would be that sentence with
    // the words removed.
    for (const failureClass of FAILURE_CLASSES) {
      if (dispositionOf(failureClass) !== 'requires_human') continue;

      const action = failureClassDefinition(failureClass).humanAction;
      expect(action, failureClass).toBeDefined();
      expect((action ?? '').trim().length, failureClass).toBeGreaterThan(0);
      expect(action, failureClass).not.toMatch(/inspect logs/i);
    }
  });

  it('records what evidence each class must carry', () => {
    // AR §5's last column. A class with no required evidence is a class whose escalation
    // can be empty.
    for (const failureClass of FAILURE_CLASSES) {
      expect(failureClassDefinition(failureClass).evidence.length, failureClass).toBeGreaterThan(0);
    }
  });

  it('never auto-recovers the three classes AR §3 forbids recovering', () => {
    // Each for its own reason, and each is a rule the evidence run needed:
    //   `agent_blocked`      — a decision is missing; re-running produces the same gap.
    //   `scope_violation`    — the task may already have changed another task's outcome.
    //   `corrective_plan_rejected` — answering a semantic objection would let the system
    //                          talk itself past its own gate.
    for (const failureClass of [
      'agent_blocked',
      'scope_violation',
      'corrective_plan_rejected',
    ] as const) {
      expect(dispositionOf(failureClass), failureClass).toBe('requires_human');
    }
  });
});

describe('authority (AR §5) — mechanical for all but the review verdicts', () => {
  it('routes only the two model verdicts to advisory authority', () => {
    const advisory = FAILURE_CLASSES.filter(
      (failureClass) => failureClassDefinition(failureClass).authority === 'llm_advisory',
    ).sort();

    // `corrective_plan_rejected` joins the two review verdicts: a plan reviewer's
    // objection is a model's judgement, and the row records whose judgement it was.
    expect(advisory).toEqual([
      'corrective_plan_rejected',
      'final_review_failed',
      'semantic_review_failed',
    ]);
  });

  it('never routes an acceptance or Git decision to a model', () => {
    // The security model, as a table assertion: an LLM never decides whether a command
    // passed, whether a merge happened, or whether required evidence exists.
    for (const failureClass of [
      'acceptance_evidence_missing',
      'acceptance_evidence_unsatisfied',
      'scope_violation',
      'validation_unsatisfied',
      'merge_conflict',
      'integration_history_invalid',
      'corrective_plan_invalid',
    ] as const) {
      expect(failureClassDefinition(failureClass).authority, failureClass).toBe('mechanical');
    }
  });
});

describe('refinement lookups', () => {
  it('reports every class refining one code', () => {
    // The case AD-36 exists for: one transport failure, three different correct responses.
    expect([...classesRefining('execution_failed')].sort()).toEqual([
      'runner_execution_failed',
      'runner_permission_required',
    ]);
  });

  it('defaults an ambiguous code to the generic class, not the specific one', () => {
    // Claiming a permission problem without having matched a denial signature would be an
    // assertion nobody measured. AR-02 upgrades this once the signature is read.
    expect(defaultClassForRunnerError('execution_failed')).toBe('runner_execution_failed');
  });

  it('defaults every runner code to some class', () => {
    // Otherwise a failure arrives with a code and no class, which is the state AR-02 is
    // meant to end rather than one it should have to work around.
    for (const code of RUNNER_ERROR_CODES) {
      expect(defaultClassForRunnerError(code), code).toBeDefined();
    }
  });

  it('maps each unambiguous code to the class that refines it', () => {
    expect(defaultClassForRunnerError('timeout')).toBe('runner_timeout');
    expect(defaultClassForRunnerError('quota_exceeded')).toBe('runner_quota_exhausted');
    expect(defaultClassForRunnerError('invalid_output')).toBe('malformed_runner_output');
    expect(defaultClassForRunnerError('blocked')).toBe('agent_blocked');
    expect(defaultClassForRunnerError('auth_required')).toBe('runner_not_authenticated');
    expect(defaultClassForRunnerError('runner_unavailable')).toBe('runner_unavailable');
  });
});

describe('determinism', () => {
  it('answers identically on repeated calls', () => {
    // Pure and table-driven: no clock, no filesystem, no model. Asserted because AR-03
    // requires an identical failure to produce a byte-identical packet, and the class is
    // the first field in one.
    for (const failureClass of FAILURE_CLASSES) {
      expect(failureClassDefinition(failureClass)).toEqual(failureClassDefinition(failureClass));
    }
  });
});
