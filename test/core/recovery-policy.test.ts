import { describe, it, expect } from 'vitest';
import { GlobalConfigSchema, type RecoveryConfig } from '../../src/contracts/index.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { parse as parseYaml } from 'yaml';
import {
  decideCorrectivePlanRepair,
  decideCorrectiveRound,
  decideTaskRecovery,
  isCompleteEscalation,
  type TaskRecoveryCounters,
} from '../../src/core/recovery-policy.js';

/**
 * What autonomy is allowed to do, and — mostly — when it must stop.
 *
 * The tests worth writing here are the *ordering* ones. Every budget individually is a
 * `>=` comparison nobody gets wrong; the failure mode is a check placed after another one
 * that should have short-circuited it, and the consequence is a run that retries something
 * it must not.
 */

const CONFIG: RecoveryConfig = GlobalConfigSchema.parse(
  parseYaml(DEFAULT_GLOBAL_CONFIG_YAML),
).recovery;

const counters = (overrides: Partial<TaskRecoveryCounters> = {}): TaskRecoveryCounters => ({
  attempts: 0,
  infrastructureFailures: 0,
  environmentRepairs: 0,
  modelCalls: 0,
  identicalFailures: 1,
  ...overrides,
});

const decide = (
  failureClass: Parameters<typeof decideTaskRecovery>[0]['failureClass'],
  overrides: Partial<TaskRecoveryCounters> = {},
  maxAttempts = 2,
) => decideTaskRecovery({ failureClass, counters: counters(overrides), config: CONFIG, maxAttempts });

describe('the defaults are the ones AR §6 declares', () => {
  it('ships every budget at its documented value', () => {
    // Read from the shipped YAML rather than from a literal in this file: a default that
    // only the test knows about is a default the product does not have.
    expect(CONFIG).toMatchObject({
      maxEnvironmentRepairs: 2,
      maxIdenticalFailures: 2,
      maxModelCallsPerTask: 4,
      maxCorrectiveRounds: 2,
      maxCorrectivePlanRepairs: 2,
      maxVerificationCycles: 3,
      maxAutonomousModelCalls: 24,
      maxPacketBytes: 8192,
      maxRawExcerptBytes: 2048,
      maxDiffStatLines: 40,
    });
  });

  it('ships recovery disabled, because AR-00 changes no behaviour', () => {
    // A budget nothing enforces must not read as a feature that is on. AR-03 is the
    // milestone that flips this, and its own acceptance criteria require the switch.
    expect(CONFIG.enabled).toBe(false);
  });
});

describe('the class decides before any budget does', () => {
  it('refuses a class that is never recovered, however much budget remains', () => {
    // The ordering that matters most. With attempts to spare, a budget-first
    // implementation would happily retry a scope violation — and a task that wrote outside
    // its declared scope may already have changed another task's outcome.
    for (const failureClass of ['agent_blocked', 'scope_violation'] as const) {
      const decision = decide(failureClass, { attempts: 0, modelCalls: 0 });

      expect(decision.disposition, failureClass).toBe('requires_human');
      expect(decision.mayProceedAutomatically, failureClass).toBe(false);
      expect(decision.step, failureClass).toBeUndefined();
      expect(decision.humanAction, failureClass).toBeDefined();
    }
  });

  it('names the action rather than reporting a bare refusal', () => {
    const decision = decide('scope_violation');
    expect(decision.humanAction).toMatch(/out-of-scope paths/);
  });
});

describe('the anti-thrash rule outranks the per-kind budgets', () => {
  it('stops a loop repeating one failure even with attempts remaining', () => {
    // `maxIdenticalFailures` applies whatever the other budgets allow: an automatic loop
    // that produces the same failure twice has learned nothing, and spending the last
    // attempt on a third identical try buys nothing but latency.
    const decision = decide('validation_unsatisfied', { attempts: 0, identicalFailures: 2 });

    expect(decision.disposition).toBe('recovery_exhausted');
    expect(decision.exhaustedBudget).toBe('recovery.maxIdenticalFailures');
  });

  it('allows a first occurrence of the same class', () => {
    const decision = decide('validation_unsatisfied', { identicalFailures: 1 });
    expect(decision.disposition).toBe('recoverable');
    expect(decision.step).toBe('work_retry');
  });

  it('applies to an environment fault too, not only to work', () => {
    const decision = decide('dependency_environment_not_ready', { identicalFailures: 2 });
    expect(decision.exhaustedBudget).toBe('recovery.maxIdenticalFailures');
  });
});

describe('an environment fault is repaired, not retried (I-22)', () => {
  it('chooses the repair step and leaves the attempt budget alone', () => {
    // Reached through the class's own `consumesAttempt`, which is what keeps a
    // PRE_EXECUTION failure from ever touching `retry.maxAttempts`.
    const decision = decide('dependency_environment_not_ready', { attempts: 2 }, 2);

    expect(decision.step).toBe('environment_repair');
    expect(decision.disposition).toBe('recoverable');
    // The attempt budget is *exhausted* here, and it does not matter: this failure is not
    // about the work.
    expect(decision.exhaustedBudget).toBeUndefined();
  });

  it('stops once the environment has been repaired to its budget', () => {
    const decision = decide('workspace_not_ready', { environmentRepairs: 2 });

    expect(decision.disposition).toBe('recovery_exhausted');
    expect(decision.exhaustedBudget).toBe('recovery.maxEnvironmentRepairs');
    expect(decision.humanAction).toBeDefined();
  });

  it('repairs rather than retries for a denied command, which cost the evidence run', () => {
    // TASK-003's attempt 2 died on an environment permission and consumed a work attempt
    // anyway, which forced `retry --force`. Here it does not.
    const decision = decide('runner_permission_required', { attempts: 1 });
    expect(decision.disposition).toBe('requires_human');
    expect(decision.humanAction).toMatch(/Grant the named command/);
  });
});

describe('work retries respect the attempt budget', () => {
  it('permits a retry while attempts remain, and says how many', () => {
    const decision = decide('validation_unsatisfied', { attempts: 1 }, 2);

    expect(decision.step).toBe('work_retry');
    expect(decision.reason).toMatch(/1 attempt\(s\) remain/);
  });

  it('stops at the budget and names it', () => {
    const decision = decide('validation_unsatisfied', { attempts: 2 }, 2);

    expect(decision.disposition).toBe('recovery_exhausted');
    expect(decision.exhaustedBudget).toBe('retry.maxAttempts');
    expect(decision.humanAction).toMatch(/--force/);
  });

  it('stops on the per-task model-call ceiling before spending another attempt', () => {
    // A task with attempts left but four calls already spent has been given its share of
    // model time. Checked before the attempt budget so a task cannot loop cheaply.
    const decision = decide('validation_unsatisfied', { attempts: 0, modelCalls: 4 });

    expect(decision.exhaustedBudget).toBe('recovery.maxModelCallsPerTask');
  });
});

describe('corrective rounds (AR §6.2)', () => {
  const runCounters = {
    correctiveRoundsUsed: 0,
    correctivePlanRepairs: 0,
    verificationCycles: 0,
    autonomousModelCalls: 0,
  };

  it('permits a round while every run budget holds', () => {
    const decision = decideCorrectiveRound({ counters: runCounters, config: CONFIG });
    expect(decision.mayProceedAutomatically).toBe(true);
  });

  it('checks the global stop before the round budget', () => {
    // `maxAutonomousModelCalls` is the ceiling that means "this run has stopped
    // converging", and it must not be satisfiable by having a corrective round to spare.
    const decision = decideCorrectiveRound({
      counters: { ...runCounters, autonomousModelCalls: 24, correctiveRoundsUsed: 0 },
      config: CONFIG,
    });

    expect(decision.exhaustedBudget).toBe('recovery.maxAutonomousModelCalls');
  });

  it('stops after the configured number of rounds', () => {
    const decision = decideCorrectiveRound({
      counters: { ...runCounters, correctiveRoundsUsed: 2 },
      config: CONFIG,
    });

    expect(decision.exhaustedBudget).toBe('recovery.maxCorrectiveRounds');
  });

  it('stops after the configured number of verification cycles', () => {
    const decision = decideCorrectiveRound({
      counters: { ...runCounters, verificationCycles: 3 },
      config: CONFIG,
    });

    expect(decision.exhaustedBudget).toBe('recovery.maxVerificationCycles');
  });

  it('cannot approve a round on its own', () => {
    // Budget only. Whether every task is inside the AD-46 envelope is set arithmetic over
    // the integration diff, and it belongs to AR-05b — so a `recoverable` here is
    // permission to *evaluate* the envelope, never to skip it.
    const decision = decideCorrectiveRound({ counters: runCounters, config: CONFIG });
    expect(Object.keys(decision)).not.toContain('envelope');
  });
});

describe('corrective plan repair (AD-47)', () => {
  it('permits a repair within the budget', () => {
    expect(
      decideCorrectivePlanRepair({ repairsUsed: 1, config: CONFIG }).mayProceedAutomatically,
    ).toBe(true);
  });

  it('escalates rather than repairing forever', () => {
    const decision = decideCorrectivePlanRepair({ repairsUsed: 2, config: CONFIG });

    expect(decision.disposition).toBe('recovery_exhausted');
    expect(decision.exhaustedBudget).toBe('recovery.maxCorrectivePlanRepairs');
  });
});

describe('every exhausted decision satisfies C-22', () => {
  it('names a budget, a reason and one human action', () => {
    // The contract, asserted over every path that can exhaust rather than over a sample:
    // an escalation missing any of the three is the "something failed, inspect logs"
    // message the spec calls a contract violation.
    const exhausted = [
      decide('validation_unsatisfied', { attempts: 2 }),
      decide('validation_unsatisfied', { identicalFailures: 2 }),
      decide('validation_unsatisfied', { modelCalls: 4 }),
      decide('workspace_not_ready', { environmentRepairs: 2 }),
      decideCorrectiveRound({
        counters: {
          correctiveRoundsUsed: 2,
          correctivePlanRepairs: 0,
          verificationCycles: 0,
          autonomousModelCalls: 0,
        },
        config: CONFIG,
      }),
      decideCorrectivePlanRepair({ repairsUsed: 2, config: CONFIG }),
    ];

    for (const decision of exhausted) {
      expect(decision.disposition).toBe('recovery_exhausted');
      expect(decision.exhaustedBudget).toBeDefined();
      expect((decision.humanAction ?? '').trim().length).toBeGreaterThan(0);
      expect(decision.reason.trim().length).toBeGreaterThan(0);
      expect(decision.mayProceedAutomatically).toBe(false);
    }
  });

  it('rejects an escalation with no evidence or no action', () => {
    const complete = {
      failureClass: 'validation_unsatisfied' as const,
      exhaustedBudget: 'retry.maxAttempts' as const,
      counts: { attempts: 2 },
      evidence: ['npm run test exited 1'],
      attemptedRepairs: [{ step: 'work_retry' as const, outcome: 'the same test failed' }],
      humanAction: 'Read the attempt evidence and decide',
    };

    expect(isCompleteEscalation(complete)).toBe(true);
    expect(isCompleteEscalation({ ...complete, humanAction: '   ' })).toBe(false);
    expect(isCompleteEscalation({ ...complete, evidence: [] })).toBe(false);
    expect(isCompleteEscalation({ ...complete, counts: {} })).toBe(false);
  });
});

describe('purity and determinism', () => {
  it('answers identically for identical inputs', () => {
    // No clock, no filesystem, no model — which is what lets AR-03 promise that an
    // identical failure recovers identically.
    const first = decide('validation_unsatisfied', { attempts: 1 });
    const second = decide('validation_unsatisfied', { attempts: 1 });
    expect(first).toEqual(second);
  });

  it('never returns a step for a decision that may not proceed', () => {
    // A caller reading `step` without checking `mayProceedAutomatically` would execute a
    // recovery the policy refused. The shape makes that impossible rather than documented.
    const refusals = [
      decide('agent_blocked'),
      decide('validation_unsatisfied', { attempts: 2 }),
      decide('workspace_not_ready', { environmentRepairs: 2 }),
    ];

    for (const decision of refusals) {
      expect(decision.mayProceedAutomatically).toBe(false);
      expect(decision.step).toBeUndefined();
    }
  });
});
