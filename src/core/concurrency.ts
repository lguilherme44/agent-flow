/**
 * How many tasks may execute at once — as opposed to how many were asked for.
 *
 * These are two different questions and the product used to answer only one of
 * them. `parallelism.maxTasks` went from the configuration file straight into
 * `Scheduler.maxConcurrency`, so writing `maxTasks: 4` really did run four
 * implementation agents at the same time — against one working tree, one
 * `git status`, one `AGENTS.md`, one set of validation commands. Every isolation
 * assumption the workflow rests on quietly stopped holding, and nothing said so.
 *
 * `git.useWorktrees` looks like the safety catch and is not one: no execution
 * path reads it, so switching it on isolates nothing. Deciding concurrency from
 * that flag would be worse than deciding it from `maxTasks` alone, because it
 * would look deliberate.
 *
 * So the two answers are separated here. Configuration keeps recording intent —
 * `maxTasks: 4` stays a legal, unchanged setting — and the runtime resolves that
 * intent against what the product can actually isolate. Today that is one task.
 *
 * Pure on purpose: no filesystem, no git, no configuration shape. A policy that
 * needed to probe something would have to live above the core, and then the
 * question "why did this run one task at a time" would be answered in as many
 * places as there are callers.
 */

/**
 * The most tasks that may run at once, given what the product can isolate.
 *
 * One, because tasks share a working tree. Raising this is the *last* step of
 * task-workspace isolation, not the first: the number is meaningless until a
 * dispatched task has a workspace of its own, and it is a single edit here so
 * that landing it needs no search.
 */
export const MAX_SUPPORTED_TASK_CONCURRENCY = 1;

export interface ConcurrencyDecision {
  /** What the configuration asked for. */
  readonly requested: number;
  /** What the scheduler is actually given. Never above the supported ceiling. */
  readonly effective: number;
  readonly clamped: boolean;
  /**
   * Why the two differ, in the words somebody debugging needs.
   *
   * Present only when they do differ. A reason on every decision would be a
   * warning that always fires, and the answer to "why one task at a time" when
   * one task was requested is "because you asked for one".
   */
  readonly reason?: string;
}

/**
 * Resolves a configured task limit into one the product can honour.
 *
 * Never returns less than one. The schema already refuses zero and negatives, so
 * this is not validation — it is the guarantee that a resolver bug becomes a
 * sequential run rather than a scheduler with nothing to dispatch, which would
 * hang instead of failing.
 */
export function resolveTaskConcurrency(requested: number): ConcurrencyDecision {
  const wanted = Number.isFinite(requested) ? Math.floor(requested) : 1;
  const effective = Math.max(1, Math.min(wanted, MAX_SUPPORTED_TASK_CONCURRENCY));

  if (wanted <= effective) return { requested: wanted, effective, clamped: false };

  return {
    requested: wanted,
    effective,
    reason:
      `parallelism.maxTasks is ${String(wanted)}, and task workspace isolation does not ` +
      'exist yet: parallel tasks would share one working tree, one diff and one set of ' +
      'validation commands',
    clamped: true,
  };
}
