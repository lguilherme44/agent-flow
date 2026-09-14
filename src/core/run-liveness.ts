import type { RunStatus } from '../contracts/index.js';

/**
 * Whether a run that calls itself ongoing can still be telling the truth.
 *
 * **Derived, never recorded.** Every input here is a fact the run already carries, and
 * that is the point: the alternative designs — a PID on the run, or a heartbeat written
 * during a stage — both add state that can itself go stale, and a PID is worse than
 * useless on a machine that has since reused it.
 *
 * The inference is a comparison the product could always have made and never did. A stage
 * is spawned with a timeout, and `NodeProcessRunner` kills the whole process group at that
 * deadline plus a grace period. So a stage *cannot* legitimately outlive its own budget:
 * past that line, either a terminal event was written, or nobody was there to write one.
 *
 * Measured, on a real repository: a warm-up's discovery started at 15:58:43 against a
 * 900 s budget; twenty minutes later `state.json` still said `running`, no `stage_failed`
 * had been written, no stage log existed, and no `agent-flow` process was alive anywhere
 * on the machine. Nothing in the product could say so — `status` reported a run in
 * progress, which was the one thing it definitely was not.
 *
 * **This does not decide anything.** It is not consulted by `isRunActive`, and a gate
 * that inferred liveness would be a gate that guesses: a paused run, a clock that moved,
 * or a machine asleep would all read as death. It exists so a person can be told, and
 * then close the run themselves with `cancel` — which is a decision, and belongs to them.
 */
export interface RunLiveness {
  /** How long the run has been silent. */
  readonly idleMs: number;
  /** The deadline it is measured against: the stage's budget plus the kill grace. */
  readonly deadlineMs: number;
}

/**
 * The grace the process runner allows between SIGTERM and SIGKILL, plus room for the
 * orchestrator to write what happened.
 *
 * `DEFAULT_KILL_GRACE_MS` in the process adapter is 5 s; the rest is the write itself —
 * a log file, an event, a state update, each of which is an atomic write to disk. Sixty
 * seconds is far more than any of that needs and far less than any real budget, so the
 * answer does not depend on tuning it.
 */
const WRITE_GRACE_MS = 60_000;

/**
 * Says a run is stalled, or says nothing.
 *
 * `undefined` is the answer for every run that is terminal, that has not passed its
 * deadline, or whose budget is unknown — three different reasons to stay quiet, and all
 * three mean the same thing here: there is no evidence of a problem, which is not the
 * same as evidence of health. This function never claims a run is alive.
 */
export function stalledRun(input: {
  readonly status: RunStatus;
  /** When the run last wrote anything. A stage start is a write, which is what makes this work. */
  readonly updatedAtMs: number;
  /** The budget of the stage that is open, in seconds. */
  readonly budgetSeconds: number;
  readonly nowMs: number;
}): RunLiveness | undefined {
  if (isTerminal(input.status)) return undefined;
  // A budget of zero or less is not a deadline, and inventing one from it would produce a
  // stalled verdict for every run on a misconfigured role.
  if (!(input.budgetSeconds > 0)) return undefined;

  const deadlineMs = input.budgetSeconds * 1000 + WRITE_GRACE_MS;
  const idleMs = input.nowMs - input.updatedAtMs;

  // Strictly greater: a run exactly at its deadline has not passed it, and a clock with
  // second resolution should not be able to tip the verdict.
  return idleMs > deadlineMs ? { idleMs, deadlineMs } : undefined;
}

/**
 * The three statuses that end a run.
 *
 * Named rather than derived as a complement, because the complement is what let
 * `cancelled` be reported as ongoing for as long as it was — see `isRunActive`, which
 * carries that finding.
 */
export function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
