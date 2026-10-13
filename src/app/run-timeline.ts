import {
  WORKFLOW_ROLES,
  roleConfigForStage,
  type EffectiveConfig,
  type RunState,
  type TaskResult,
} from '../contracts/index.js';
import { buildRunTimeline, type RunTimeline } from '../core/run-timeline.js';
import { isTerminal, stalledRun } from '../core/run-liveness.js';
import { roleForStage } from './stages/definitions.js';
import type { StateStore } from './state-store.js';

/**
 * Loads what `buildRunTimeline` folds: the run's event log and the result each task left.
 *
 * One loader for the server and the CLI, so the two surfaces cannot read different files
 * and print different minutes.
 *
 * **`now` reaches the fold only while the run is open, and alive.** A run waiting at a gate
 * is costing somebody time right now, and that is what the bar has to show; a run that
 * completed, failed or was cancelled stopped at its last event, and extending it to the
 * present would grow its "human wait" every time somebody looked at it.
 *
 * The third case is the run that says it is working and is not: a stage was started, no
 * outcome was ever written, and whatever ran it is gone. Left alone, that stage would count
 * as model time up to `now`, forever. It is judged the way `status` judges it — silent past
 * its stage's budget plus the kill grace (`stalledRun`) — and then folded without `now`, so
 * the open execution closes at the last event, and marked `stale` so a reader is told.
 *
 * `null` for a run that does not exist. A task result that will not parse is left out
 * rather than failing the read, so its validation falls into `other` — the same tolerance
 * `readEventsBestEffort` gives a malformed log line.
 */
export async function loadRunTimeline(
  store: StateStore,
  runId: string,
  now: string,
  /** The effective configuration, for the stage budget. Absent: no staleness verdict. */
  config?: () => Promise<EffectiveConfig | undefined>,
): Promise<RunTimeline | null> {
  let state;
  try {
    state = await store.loadRun(runId);
  } catch {
    return null;
  }

  const events = await store.readEventsBestEffort(runId);
  const results: TaskResult[] = [];
  for (const task of state.tasks) {
    try {
      const result = await store.readTaskResult(runId, task.id);
      if (result !== null) results.push(result);
    } catch {
      // See above: omitted, never invented.
    }
  }

  if (isTerminal(state.status)) return buildRunTimeline(events, results);

  const live = buildRunTimeline(events, results, now);
  if (!live.inFlight || config === undefined) return live;

  const stalled = stalledRun({
    status: state.status,
    updatedAtMs: Date.parse(state.updatedAt),
    budgetSeconds: openStageBudgetSeconds(await config(), state),
    nowMs: Date.parse(now),
  });
  return stalled === undefined ? live : { ...buildRunTimeline(events, results), stale: true };
}

/**
 * The budget the open stage runs against, or zero (no verdict) when it cannot be known.
 *
 * A stage with a fixed role gets that role's timeout, as `status` reads it. A stage whose
 * role is chosen per task — implementation, code review — gets the longest timeout any role
 * has: a run silent past *every* budget cannot still be inside one, and a shorter guess
 * could call a live run dead.
 */
export function openStageBudgetSeconds(config: EffectiveConfig | undefined, state: RunState): number {
  if (config === undefined) return 0;

  try {
    const role = roleForStage(state.stage);
    if (role !== undefined) return roleConfigForStage(config.global.roles, role, state.stage).timeoutSeconds;
    return Math.max(
      0,
      ...WORKFLOW_ROLES.map((each) => roleConfigForStage(config.global.roles, each, state.stage).timeoutSeconds),
    );
  } catch {
    return 0;
  }
}
