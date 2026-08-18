import type { StateStore } from './state-store.js';
import type { RecoveryConfig, RunState } from '../contracts/index.js';
import { decideCorrectiveRound } from '../core/recovery-policy.js';
import type { RecoveryDecision } from '../core/recovery-policy.js';

/**
 * The two run-level autonomy counters, kept (C-22, AR §6.2).
 *
 * **They were read and never written.** `evaluateRound` compared `correctiveRoundsUsed`
 * against `maxCorrectiveRounds` and always saw zero, so a plan could produce corrective
 * rounds indefinitely; and `maxAutonomousModelCalls` — 24 by default, whose entire purpose
 * is that an unattended run stops and asks — was never compared against anything.
 *
 * The per-task budgets did work, which is why this went unnoticed: no single task looped.
 * What had no ceiling was the run, and a run is what autonomy is granted to.
 *
 * One module, because two writers of one counter drift and the one that drifted would be
 * the one deciding whether a machine keeps spending money unattended.
 */

/**
 * One agent call made with no intervening human action.
 *
 * Called where the *machine* decided to invoke a runner. A call a person asked for is not
 * autonomous and must not count against a budget that exists to bound unattended work.
 */
export async function recordAutonomousCall(store: StateStore, runId: string): Promise<void> {
  await store.updateRun(runId, (state) => ({
    ...state,
    autonomy: {
      correctiveRoundsUsed: state.autonomy?.correctiveRoundsUsed ?? 0,
      autonomousModelCalls: (state.autonomy?.autonomousModelCalls ?? 0) + 1,
      // Stamped once. Moving it on every increment would make "how long has this been
      // running unattended" unanswerable, which is the question the stamp is for.
      grantedAt: state.autonomy?.grantedAt ?? state.updatedAt,
    },
  }));
}

/** One corrective round begun. Spent rounds stay spent. */
export async function recordCorrectiveRound(store: StateStore, runId: string): Promise<void> {
  await store.updateRun(runId, (state) => ({
    ...state,
    autonomy: {
      correctiveRoundsUsed: (state.autonomy?.correctiveRoundsUsed ?? 0) + 1,
      autonomousModelCalls: state.autonomy?.autonomousModelCalls ?? 0,
      grantedAt: state.autonomy?.grantedAt ?? state.updatedAt,
    },
  }));
}

/**
 * A human acted: the unattended streak is over.
 *
 * The two counters answer different questions and only one resets. Rounds already spent are
 * spent — approving the next one does not un-run the last — while the streak of calls made
 * *with no intervening human action* is, by definition, broken by that action.
 *
 * A run with no autonomy record is left without one. Absent is not `{ used: 0 }`: a run that
 * never went autonomous never had the grant, and nothing may read one into it.
 */
export async function clearAutonomy(store: StateStore, runId: string): Promise<void> {
  await store.updateRun(runId, (state) =>
    state.autonomy === undefined
      ? state
      : { ...state, autonomy: { ...state.autonomy, autonomousModelCalls: 0 } },
  );
}

/**
 * May the machine spend another call on this run, unattended? (C-22)
 *
 * A thin adapter over `decideCorrectiveRound`, which was the table all along and had no
 * caller. The counters it wants are the two above; the ones it does not track at this level
 * are supplied at zero because they are per-task and already bounded there.
 *
 * Exhaustion always names the budget and one specific action. C-22's last line is a
 * prohibition — no surface renders "something failed, inspect logs" — and a run that stops
 * because it ran out of autonomy is exactly the moment somebody needs to be told why.
 */
export function decideRunAutonomy(input: {
  readonly counters: Pick<
    NonNullable<RunState['autonomy']>,
    'autonomousModelCalls' | 'correctiveRoundsUsed'
  >;
  readonly config: RecoveryConfig;
}): RecoveryDecision {
  return decideCorrectiveRound({
    counters: {
      autonomousModelCalls: input.counters.autonomousModelCalls,
      correctiveRoundsUsed: input.counters.correctiveRoundsUsed,
      // Per-task budgets, bounded per task. Zero here says "this decision is not about
      // them", which is true: `decideTaskRecovery` already refused or allowed on those
      // before anything reached this level.
      verificationCycles: 0,
      correctivePlanRepairs: 0,
    },
    config: input.config,
  });
}
