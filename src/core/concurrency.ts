import type { IsolationMode } from '../contracts/common.schema.js';

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
 * So the two answers are separated here. Configuration keeps recording intent —
 * `maxTasks: 4` stays a legal, unchanged setting — and the runtime resolves that
 * intent against what the product can actually isolate for *this run*.
 *
 * MVP 2 makes that last phrase mean something. The resolver gains a discriminant,
 * `IsolationMode`, and the ceiling depends on it: a run whose tasks each own a
 * worktree can honour more than one, a run sharing the user's working tree cannot.
 *
 * **The mode is handed in, never worked out here** (I-13). It is captured when the
 * run is created and read from the run afterwards — not from
 * `config.global.git.useWorktrees`, and not from a probe. Core answers a policy
 * question about a mode it is given; deciding the mode is somebody else's job, and
 * a resolver that decided it would be answering "is this repository usable" from a
 * layer that cannot look at a repository.
 *
 * Pure on purpose: no filesystem, no git, no configuration shape. A policy that
 * needed to probe something would have to live above the core, and then the
 * question "why did this run one task at a time" would be answered in as many
 * places as there are callers.
 */

/**
 * The most tasks that may run at once when they share one working tree.
 *
 * One, and not a number to be tuned: without isolation, two concurrent tasks write
 * to the same tree, see each other's edits in `git status` and run each other's
 * validation commands. This is the ceiling for `isolation: 'none'`, and for every
 * caller that does not say otherwise.
 */
export const MAX_SUPPORTED_TASK_CONCURRENCY = 1;

/**
 * The most tasks that may run at once when each one owns a worktree (§4.4, §24).
 *
 * Not unbounded, and the reason is not timidity: each concurrent task is one agent
 * process, one full repository checkout and one install of the project's
 * dependencies. Eight is a number with a stated basis in §24 and a single edit to
 * change.
 */
export const MAX_ISOLATED_TASK_CONCURRENCY = 8;

export type { IsolationMode };

export interface ConcurrencyDecision {
  /** What the configuration asked for. */
  readonly requested: number;
  /** What the scheduler is actually given. Never above the ceiling for the mode. */
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

function ceilingFor(isolation: IsolationMode): number {
  return isolation === 'worktree' ? MAX_ISOLATED_TASK_CONCURRENCY : MAX_SUPPORTED_TASK_CONCURRENCY;
}

function reasonFor(isolation: IsolationMode, wanted: number, effective: number): string {
  if (isolation === 'worktree') {
    return (
      `parallelism.maxTasks is ${String(wanted)}, and isolated execution is capped at ` +
      `${String(effective)} concurrent task workspaces: each one is an agent process, a full ` +
      'checkout of the repository and an install of its dependencies'
    );
  }

  return (
    `parallelism.maxTasks is ${String(wanted)}, and task workspace isolation does not ` +
    'exist yet: parallel tasks would share one working tree, one diff and one set of ' +
    'validation commands'
  );
}

/**
 * Resolves a configured task limit into one the product can honour in this mode.
 *
 * `isolation` defaults to `'none'`, which is the conservative direction: a caller
 * that has not been taught about isolation gets the sequential ceiling rather than
 * the isolated one. Granting parallelism has to be something a caller *says*, not
 * something it forgets to deny.
 *
 * Never returns less than one. The schema already refuses zero and negatives, so
 * this is not validation — it is the guarantee that a resolver bug becomes a
 * sequential run rather than a scheduler with nothing to dispatch, which would
 * hang instead of failing.
 */
export function resolveTaskConcurrency(
  requested: number,
  isolation: IsolationMode = 'none',
): ConcurrencyDecision {
  const wanted = Number.isFinite(requested) ? Math.floor(requested) : 1;
  const effective = Math.max(1, Math.min(wanted, ceilingFor(isolation)));

  if (wanted <= effective) return { requested: wanted, effective, clamped: false };

  return {
    requested: wanted,
    effective,
    reason: reasonFor(isolation, wanted, effective),
    clamped: true,
  };
}
