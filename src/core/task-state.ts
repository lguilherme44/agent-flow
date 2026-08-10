import type { TaskState } from '../contracts/task.schema.js';

/**
 * Legal transitions between the seven task states of §22.
 *
 * Written as data rather than conditionals so the whole policy is readable in
 * one place. Two decisions are encoded here that the spec states in prose and
 * that are easy to erode later:
 *
 *   - `blocked` and `failed` may only return to `ready`, never straight to
 *     `running`. BLOCKED means the SDD did not answer an architectural question
 *     (§20), so it must not be retried automatically (§23).
 *   - `running` may reach `review_required` but never re-route to a different
 *     model. A failed validation stays visible (§55) instead of being retried
 *     elsewhere until something passes.
 */
const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  // `ready` is computed by the DAG on every pass, never stored: readiness
  // depends on the dependencies' current states, and a persisted `ready` would
  // go stale the moment one of them failed. So the stored move is
  // `queued → running`, and `ready` remains for rendering and for callers that
  // want to name the condition.
  queued: ['ready', 'running', 'blocked'],
  ready: ['running', 'blocked', 'queued'],
  // `interrupted` is what a killed process leaves behind, recorded when a later
  // run finds a task still marked `running` that nothing is executing.
  running: ['completed', 'failed', 'blocked', 'review_required', 'interrupted'],
  // Requeued rather than resumed: the agent's work was not observed, so the
  // task starts over. The attempt counter already moved, which is what keeps
  // this from becoming an unbounded loop.
  interrupted: ['queued', 'blocked'],
  completed: [],
  // `agent-flow retry` puts a task back in the queue. It goes to `queued` and
  // not to `ready` for the reason above — the DAG decides readiness, and it
  // may well decide this task is not ready at all.
  failed: ['ready', 'queued'],
  blocked: ['ready', 'queued'],
  review_required: ['ready', 'queued', 'completed', 'failed'],
};

/** Only `completed` is final. Everything else can still move. */
export function isTerminal(state: TaskState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class TaskStateError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`illegal task transition: ${from} → ${to}`);
    this.name = 'TaskStateError';
  }
}

export function transition(from: TaskState, to: TaskState): TaskState {
  if (!canTransition(from, to)) throw new TaskStateError(from, to);
  return to;
}

/** Successors of a state, for rendering and for exhaustiveness tests. */
export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from];
}
