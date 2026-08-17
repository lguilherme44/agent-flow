import { describe, it, expect } from 'vitest';
import {
  FAILURE_CLASSES,
  RUNNER_ERROR_CODES,
  FALLBACK_TRIGGERS,
  type FailureClass,
} from '../../src/contracts/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FAILURE_CLASS_DEFINITIONS,
  classesRefining,
  classifyRunnerFailure,
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

/**
 * AR-02's half: the signature matching that turns a raw string into a class.
 *
 * AR-00 landed the table and the dumbest-correct classification — one runner code in, its
 * default refinement out. This is the sharpening: reading redacted raw output and choosing
 * among `classesRefining(code)` when, and only when, the evidence actually says so.
 *
 * The discipline that matters here is **not** recall. A classifier that guesses
 * `runner_permission_required` from a stray "permission denied" in a compiler message
 * would send a person to grant a tool that was never the problem, and would mark an
 * attempt as not-consumed when the agent genuinely failed at its work. Silence — falling
 * back to the default refinement — is always a correct answer.
 */
describe('classifying a runner failure from its raw output (AR-02, C-06)', () => {
  const PERMISSION_DENIAL = readFileSync(
    join(import.meta.dirname, '../fixtures/responses/agy/SYNTHETIC-error-permission-denied.txt'),
    'utf8',
  );
  const QUOTA = readFileSync(
    join(import.meta.dirname, '../fixtures/responses/agy/SYNTHETIC-error-quota.txt'),
    'utf8',
  );
  const UNSUPPORTED_EFFORT = readFileSync(
    join(import.meta.dirname, '../fixtures/responses/agy/SYNTHETIC-error-unsupported-effort.txt'),
    'utf8',
  );

  it('recognises the denial that cost the evidence run an attempt', () => {
    const result = classifyRunnerFailure({
      errorCode: 'execution_failed',
      redactedRaw: PERMISSION_DENIAL,
    });

    expect(result.failureClass).toBe('runner_permission_required');
  });

  it('extracts the denied command, so the escalation can name it', () => {
    // "The denied command is extracted and persisted" — C-06. Without it the escalation
    // degrades to "grant something", which is the sentence §3.6 forbids.
    const result = classifyRunnerFailure({
      errorCode: 'execution_failed',
      redactedRaw: PERMISSION_DENIAL,
    });

    expect(result.deniedCommand).toBe('Bash');
  });

  it('does not consume an attempt, and says why', () => {
    const result = classifyRunnerFailure({
      errorCode: 'execution_failed',
      redactedRaw: PERMISSION_DENIAL,
    });

    expect(consumesAttempt(result.failureClass)).toBe(false);
    expect(dispositionOf(result.failureClass)).toBe('requires_human');
    expect(failureClassDefinition(result.failureClass).humanAction).toBeTruthy();
  });

  it('falls back to the default refinement when the raw says nothing', () => {
    // The honest answer. Claiming a permission problem without having matched a denial
    // signature would be an assertion nobody measured.
    expect(
      classifyRunnerFailure({ errorCode: 'execution_failed', redactedRaw: 'segmentation fault' })
        .failureClass,
    ).toBe('runner_execution_failed');

    expect(classifyRunnerFailure({ errorCode: 'execution_failed' }).failureClass).toBe(
      'runner_execution_failed',
    );
  });

  it('does not read a permission denial into an unrelated failure', () => {
    // An unsupported model is a configuration fault, not a tool grant. Getting this wrong
    // sends a person to edit permissions for a problem in their config file.
    expect(
      classifyRunnerFailure({ errorCode: 'execution_failed', redactedRaw: UNSUPPORTED_EFFORT })
        .failureClass,
    ).toBe('runner_execution_failed');
  });

  it('does not fire on an ordinary filesystem or compiler "permission denied"', () => {
    // The false positive that would matter most, because this string is everywhere.
    const noise = [
      "error: EACCES: permission denied, open '<workspace>/dist/out.js'",
      'sh: ./scripts/build.sh: Permission denied',
      "test/auth.test.ts:14 expected 'permission denied' to equal 'ok'",
    ];

    for (const raw of noise) {
      expect(
        classifyRunnerFailure({ errorCode: 'execution_failed', redactedRaw: raw }).failureClass,
        raw,
      ).toBe('runner_execution_failed');
    }
  });

  it('never overrides a code that is already unambiguous', () => {
    // `quota_exceeded` is refined by exactly one class. Reading raw text could only ever
    // make that answer worse, so the signature pass does not run for it.
    const result = classifyRunnerFailure({ errorCode: 'quota_exceeded', redactedRaw: QUOTA });
    expect(result.failureClass).toBe('runner_quota_exhausted');
    expect(result.deniedCommand).toBeUndefined();

    expect(classifyRunnerFailure({ errorCode: 'auth_required', redactedRaw: '' }).failureClass).toBe(
      'runner_not_authenticated',
    );
    expect(classifyRunnerFailure({ errorCode: 'timeout' }).failureClass).toBe('runner_timeout');
    expect(classifyRunnerFailure({ errorCode: 'invalid_output' }).failureClass).toBe(
      'malformed_runner_output',
    );
    expect(classifyRunnerFailure({ errorCode: 'blocked' }).failureClass).toBe('agent_blocked');
  });

  it('returns a class every caller can look up, for every runner code', () => {
    // Totality at the call site: no code may leave a caller with nothing to persist.
    for (const code of RUNNER_ERROR_CODES) {
      const result = classifyRunnerFailure({ errorCode: code });
      expect(() => failureClassDefinition(result.failureClass), code).not.toThrow();
    }
  });

  it('is deterministic: the same evidence classifies identically every time', () => {
    const once = classifyRunnerFailure({
      errorCode: 'execution_failed',
      redactedRaw: PERMISSION_DENIAL,
    });
    const twice = classifyRunnerFailure({
      errorCode: 'execution_failed',
      redactedRaw: PERMISSION_DENIAL,
    });

    expect(once).toEqual(twice);
  });

  it('recognises a denial phrased as an approval request', () => {
    // Wording differs per CLI and the signature table is where that belongs. Each entry
    // still has to describe a *tool confirmation*, never a bare "denied".
    const result = classifyRunnerFailure({
      errorCode: 'execution_failed',
      redactedRaw: 'the tool call requires approval: run_command("npm test")',
    });

    expect(result.failureClass).toBe('runner_permission_required');
    expect(result.deniedCommand).toBe('run_command');
  });
});
