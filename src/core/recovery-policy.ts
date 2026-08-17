import type {
  FailureClass,
  RecoveryDisposition,
  RecoveryConfig,
} from '../contracts/index.js';
import {
  consumesAttempt,
  dispositionOf,
  failureClassDefinition,
} from './failure-classification.js';

/**
 * What autonomy is allowed to do next, and when it must stop (AR §6, AR §3.6).
 *
 * Pure and total: every answer is a function of the arguments. No filesystem, no
 * AgentRunner, no Git, no shell — and, by architecture test, **no dependency on
 * `ports/utility-model.ts`**. The UtilityModel's role in this milestone is none: no
 * decision in AR §5 may be routed to it, and a module that could ask it would be a
 * module where somebody eventually does.
 *
 * The division of labour with `failure-classification.ts` is worth stating: that module
 * answers *what kind of failure this is*, once, from evidence. This one answers *what
 * the run may do about it*, from that class plus the counters. Keeping them apart is
 * what stops a budget from being consulted while a failure is still being identified.
 *
 * AR-00 lands the policy. The coordinator that acts on it is AR-03's.
 */

/** The counters a decision is made against. All of them are already persisted. */
/**
 * The budgets, re-exported from the contracts.
 *
 * Consumers of this module reach for the policy and the shape it is configured by in the
 * same import; sending them to two places for one decision is how a caller ends up
 * reading the budgets from somewhere the policy does not.
 */
export type { RecoveryConfig };

export interface TaskRecoveryCounters {
  /** Work attempts spent (AD-37). */
  readonly attempts: number;
  /** Preflight and environment failures spent (AD-37). */
  readonly infrastructureFailures: number;
  /** Environment repairs already applied for this task. */
  readonly environmentRepairs: number;
  /** AgentRunner invocations for this task, across every attempt. */
  readonly modelCalls: number;
  /**
   * How many times in a row the *same* `(class, command, exit)` has been seen.
   *
   * One means "this failure is new". The caller computes it, because identity across
   * failures is a comparison over persisted attempts and this module holds no history.
   */
  readonly identicalFailures: number;
}

export interface RunRecoveryCounters {
  readonly correctiveRoundsUsed: number;
  readonly correctivePlanRepairs: number;
  readonly verificationCycles: number;
  /** Agent calls made with no intervening human action (AR §6.2). */
  readonly autonomousModelCalls: number;
}

/**
 * Every budget this milestone declares, by the name AR §6 gives it.
 *
 * A closed union rather than a string: the exhausted budget is named in an escalation a
 * person reads, and in an event a read model groups by. Two spellings of one budget is a
 * dashboard reporting half of what happened.
 */
export type RecoveryBudget =
  | 'retry.maxAttempts'
  | 'recovery.maxEnvironmentRepairs'
  | 'recovery.maxIdenticalFailures'
  | 'recovery.maxModelCallsPerTask'
  | 'recovery.maxCorrectiveRounds'
  | 'recovery.maxCorrectivePlanRepairs'
  | 'recovery.maxVerificationCycles'
  | 'recovery.maxAutonomousModelCalls';

/**
 * What may happen next.
 *
 * `disposition` is the AR §3.6 vocabulary, and it is what a projection renders. The
 * three cases are exhaustive by construction: a class either recovers, needs a person,
 * or has run out of budget — and the third is the only one that can arise from counters
 * rather than from the class itself.
 */
export interface RecoveryDecision {
  readonly disposition: RecoveryDisposition;
  /** True only for `recoverable`. Kept explicit so no caller infers it from a string. */
  readonly mayProceedAutomatically: boolean;
  /** Which budget ran out, when the disposition is `recovery_exhausted`. */
  readonly exhaustedBudget?: RecoveryBudget;
  /** The kind of automatic step that is permitted. Absent unless recoverable. */
  readonly step?: RecoveryStep;
  /**
   * The one specific human action, when a person is needed.
   *
   * Present for `requires_human` and `recovery_exhausted` alike. AR §3.6 makes this
   * mandatory: an escalation without one is the message the contract forbids.
   */
  readonly humanAction?: string;
  /** Why this decision, in one sentence a person can read. */
  readonly reason: string;
}

/**
 * The two shapes an automatic recovery step can take (AR §4.5).
 *
 * `environment_repair` re-prepares and re-verifies; `work_retry` builds a Failure
 * Context Packet and requeues from the integration head. The distinction is not
 * cosmetic — they draw on different budgets, and an environment repair must not spend a
 * work attempt (I-22).
 */
export type RecoveryStep = 'environment_repair' | 'work_retry';

/**
 * Whether an automatic recovery step may run for this failure, and which one.
 *
 * Order of checks is the contract, and it is deliberate:
 *
 * 1. **The class first.** A class whose disposition is `requires_human` is never
 *    overridden by an unspent budget — `agent_blocked` means a decision is missing, and
 *    having attempts left does not conjure one.
 * 2. **Then the budgets**, cheapest and most universal first. `maxIdenticalFailures`
 *    precedes the per-kind budgets because it applies whatever they allow: a loop
 *    repeating one failure has learned nothing.
 *
 * Reversing 1 and 2 would let a run with budget to spare retry a `scope_violation`,
 * which is the one class where a retry can make things worse rather than merely waste a
 * call.
 */
export function decideTaskRecovery(input: {
  readonly failureClass: FailureClass;
  readonly counters: TaskRecoveryCounters;
  readonly config: RecoveryConfig;
  readonly maxAttempts: number;
}): RecoveryDecision {
  const { failureClass, counters, config, maxAttempts } = input;
  const definition = failureClassDefinition(failureClass);
  const disposition = dispositionOf(failureClass);

  if (disposition === 'requires_human') {
    return {
      disposition,
      mayProceedAutomatically: false,
      // The table guarantees an action for every `requires_human` class; the fallback
      // exists so a table edited badly produces a useless sentence rather than an
      // escalation with no action at all.
      humanAction: definition.humanAction ?? 'Inspect this failure and decide',
      reason: `${failureClass} is never recovered automatically`,
    };
  }

  if (counters.identicalFailures >= config.maxIdenticalFailures) {
    return exhausted(
      'recovery.maxIdenticalFailures',
      `the same failure has occurred ${String(counters.identicalFailures)} times in a row`,
      definition.humanAction ??
        'Read the repeated failure evidence and change something the loop cannot',
    );
  }

  if (counters.modelCalls >= config.maxModelCallsPerTask) {
    return exhausted(
      'recovery.maxModelCallsPerTask',
      `this task has already used ${String(counters.modelCalls)} agent calls`,
      'Decide whether this task is worth more model time, then retry with --force',
    );
  }

  // An environment fault is repaired, not retried: nothing about the work was wrong.
  // This is also where I-22 becomes observable — the branch is chosen by the class's own
  // `consumesAttempt`, so a PRE_EXECUTION failure cannot reach the attempt budget below.
  if (!consumesAttempt(failureClass)) {
    if (counters.environmentRepairs >= config.maxEnvironmentRepairs) {
      return exhausted(
        'recovery.maxEnvironmentRepairs',
        `the environment has already been repaired ${String(counters.environmentRepairs)} times`,
        definition.humanAction ?? 'Fix the environment this run depends on',
      );
    }

    return {
      disposition: 'recoverable',
      mayProceedAutomatically: true,
      step: 'environment_repair',
      reason: `${failureClass} is an environment fault and consumes no work attempt`,
    };
  }

  if (counters.attempts >= maxAttempts) {
    return exhausted(
      'retry.maxAttempts',
      `this task has already been attempted ${String(counters.attempts)} times`,
      'Review the attempt evidence, then retry with --force if the work is still wanted',
    );
  }

  return {
    disposition: 'recoverable',
    mayProceedAutomatically: true,
    step: 'work_retry',
    reason: `${failureClass} is recoverable and ${String(maxAttempts - counters.attempts)} attempt(s) remain`,
  };
}

/**
 * Whether another corrective round may run without asking a person (AR §6.2).
 *
 * Budget only. Whether every *task* in the round is inside the AD-46 envelope is a
 * separate question, answered by set arithmetic over the integration diff, and it belongs
 * to AR-05b — so this function deliberately cannot approve a round on its own.
 */
export function decideCorrectiveRound(input: {
  readonly counters: RunRecoveryCounters;
  readonly config: RecoveryConfig;
}): RecoveryDecision {
  const { counters, config } = input;

  if (counters.autonomousModelCalls >= config.maxAutonomousModelCalls) {
    return exhausted(
      'recovery.maxAutonomousModelCalls',
      `this run has made ${String(counters.autonomousModelCalls)} agent calls with no human action`,
      'Review what the run has produced so far and decide whether to continue',
    );
  }

  if (counters.correctiveRoundsUsed >= config.maxCorrectiveRounds) {
    return exhausted(
      'recovery.maxCorrectiveRounds',
      `${String(counters.correctiveRoundsUsed)} corrective round(s) have already run`,
      'Review the outstanding findings and decide whether to approve more corrective work',
    );
  }

  if (counters.verificationCycles >= config.maxVerificationCycles) {
    return exhausted(
      'recovery.maxVerificationCycles',
      `${String(counters.verificationCycles)} verification cycle(s) have already run`,
      'Review the verification history and decide whether the run can converge',
    );
  }

  return {
    disposition: 'recoverable',
    mayProceedAutomatically: true,
    reason: 'the corrective budget is not exhausted',
  };
}

/** Whether a generated corrective plan may be mechanically repaired again (AD-47). */
export function decideCorrectivePlanRepair(input: {
  readonly repairsUsed: number;
  readonly config: RecoveryConfig;
}): RecoveryDecision {
  if (input.repairsUsed >= input.config.maxCorrectivePlanRepairs) {
    return exhausted(
      'recovery.maxCorrectivePlanRepairs',
      `the corrective plan has already been repaired ${String(input.repairsUsed)} times`,
      'Read the remaining plan problems and revise the corrective plan',
    );
  }

  return {
    disposition: 'recoverable',
    mayProceedAutomatically: true,
    reason: 'the plan repair budget is not exhausted',
  };
}

/**
 * What an `AUTO_RECOVERY_EXHAUSTED` escalation must carry (AR §3.6, C-22).
 *
 * A shape rather than a convention, because the contract is a list of things that must
 * be present and prose cannot enforce presence. `"something failed, inspect logs"` is a
 * contract violation, and this type is what makes writing it require deleting fields.
 */
export interface RecoveryExhaustion {
  readonly failureClass: FailureClass;
  readonly exhaustedBudget: RecoveryBudget;
  /** Every counter as it stood, so the numbers in the message are re-checkable. */
  readonly counts: Readonly<Record<string, number>>;
  /** Redacted, and bounded. Never raw runner output (AD-35, I-21). */
  readonly evidence: readonly string[];
  /** Each repair already attempted, and why it did not work. */
  readonly attemptedRepairs: readonly {
    readonly step: RecoveryStep;
    readonly outcome: string;
  }[];
  /** Exactly one, and specific. */
  readonly humanAction: string;
}

/**
 * Whether an escalation satisfies C-22.
 *
 * Exported so both the CLI and the HTTP API can be held to it by the same predicate,
 * rather than each surface asserting its own idea of "enough detail".
 */
export function isCompleteEscalation(escalation: RecoveryExhaustion): boolean {
  return (
    escalation.humanAction.trim().length > 0 &&
    escalation.evidence.length > 0 &&
    Object.keys(escalation.counts).length > 0
  );
}

function exhausted(
  budget: RecoveryBudget,
  reason: string,
  humanAction: string,
): RecoveryDecision {
  return {
    disposition: 'recovery_exhausted',
    mayProceedAutomatically: false,
    exhaustedBudget: budget,
    humanAction,
    reason,
  };
}
