import type { TaskState } from '../contracts/task.schema.js';
import type { TaskBlockReason } from '../contracts/state.schema.js';

/**
 * Dependency graph over tasks. Pure — no I/O, no provider, no scheduling policy.
 *
 * This lives in the foundation rather than alongside the scheduler because the
 * planning stage needs it first: a generated plan is validated here (unknown
 * dependencies, cycles) before anyone considers executing it. Splitting a
 * partial cycle check into planning and a full graph into the scheduler would
 * mean two implementations of the same thing.
 *
 * Concurrency is not this module's concern. It answers "what may run" and the
 * scheduler decides how many of those actually do — which is why raising
 * parallelism later touches the scheduler and nothing here.
 */

export type DagErrorKind = 'unknown_dependency' | 'duplicate_id' | 'cycle';

export class DagError extends Error {
  constructor(
    readonly kind: DagErrorKind,
    message: string,
    /** Closed path (first element repeated at the end) when kind is 'cycle'. */
    readonly cycle?: readonly string[],
  ) {
    super(message);
    this.name = 'DagError';
  }
}

export interface DagNode {
  readonly id: string;
  readonly dependencies: readonly string[];
}

export interface Dag {
  /** Node ids, sorted, so every derived result is deterministic. */
  readonly ids: readonly string[];
  dependenciesOf(id: string): readonly string[];
  dependentsOf(id: string): readonly string[];
}

/**
 * Validates and indexes a graph. Throws rather than returning a result type:
 * every caller treats an invalid graph as fatal, and an unchecked `Dag` should
 * not be constructible.
 */
export function buildDag(nodes: readonly DagNode[]): Dag {
  const dependencies = new Map<string, readonly string[]>();

  for (const node of nodes) {
    if (dependencies.has(node.id)) {
      throw new DagError('duplicate_id', `duplicate task id ${node.id}`);
    }
    dependencies.set(node.id, [...node.dependencies]);
  }

  for (const [id, deps] of dependencies) {
    for (const dep of deps) {
      if (!dependencies.has(dep)) {
        throw new DagError(
          'unknown_dependency',
          `task ${id} depends on ${dep}, which does not exist in the plan`,
        );
      }
    }
  }

  const dependents = new Map<string, string[]>();
  for (const id of dependencies.keys()) dependents.set(id, []);
  for (const [id, deps] of dependencies) {
    for (const dep of deps) dependents.get(dep)?.push(id);
  }

  const ids = [...dependencies.keys()].sort();
  const cycle = findCycle(ids, dependencies);
  if (cycle) {
    throw new DagError('cycle', `dependency cycle: ${cycle.join(' → ')}`, cycle);
  }

  return {
    ids,
    dependenciesOf: (id) => dependencies.get(id) ?? [],
    dependentsOf: (id) => [...(dependents.get(id) ?? [])].sort(),
  };
}

/**
 * Depth-first search returning the offending path, not just a boolean.
 * "There is a cycle somewhere in your plan" is not something a user can act on.
 */
function findCycle(
  ids: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const VISITING = 1;
  const DONE = 2;
  const marks = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const mark = marks.get(id);
    if (mark === DONE) return null;
    if (mark === VISITING) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }

    marks.set(id, VISITING);
    stack.push(id);
    for (const dep of [...(dependencies.get(id) ?? [])].sort()) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    marks.set(id, DONE);
    return null;
  };

  for (const id of ids) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

/**
 * Kahn's algorithm with a sorted frontier, so the same plan always produces the
 * same order. Reruns and resumes reshuffling work would undermine the audit
 * trail the spec asks for.
 */
export function topologicalOrder(dag: Dag): string[] {
  const remaining = new Map<string, number>();
  for (const id of dag.ids) remaining.set(id, dag.dependenciesOf(id).length);

  const frontier = dag.ids.filter((id) => remaining.get(id) === 0).sort();
  const order: string[] = [];

  while (frontier.length > 0) {
    const id = frontier.shift() as string;
    order.push(id);

    for (const dependent of dag.dependentsOf(id)) {
      const left = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, left);
      if (left === 0) {
        frontier.push(dependent);
        frontier.sort();
      }
    }
  }

  return order;
}

/**
 * Dependency-derived blocks whose reason to exist is gone.
 *
 * `blockedByFailure` marks a dependent `blocked` because something upstream
 * failed — the mark is a *condition over the graph*, not a fact about the task:
 * the task never ran (§20). When every dependency is now `completed`, the
 * condition has ended, so the task may return to the queue. Only
 * dependency-derived blocks release this way; an agent-BLOCKED task (or a
 * legacy `blocked` with no recorded reason) is a fact about the task itself and
 * is never reopened by recovery (§23).
 */
export function unblockedByRecovery(
  dag: Dag,
  states: TaskStates,
  reasons: Readonly<Partial<Record<string, TaskBlockReason>>>,
): string[] {
  return dag.ids
    .filter((id) => {
      if (stateOf(states, id) !== 'blocked') return false;
      if (reasons[id] !== 'dependency') return false;
      return dag.dependenciesOf(id).every((dep) => stateOf(states, dep) === 'completed');
    })
    .sort();
}

export type TaskStates = Readonly<Record<string, TaskState>>;

const stateOf = (states: TaskStates, id: string): TaskState => states[id] ?? 'queued';

/**
 * The one rule of §22: a task is ready only when every dependency is
 * `completed`. Anything else — running, failed, blocked — holds it back.
 */
export function readyTasks(dag: Dag, states: TaskStates): string[] {
  return dag.ids.filter((id) => {
    const state = stateOf(states, id);
    if (state !== 'queued' && state !== 'ready') return false;
    return dag.dependenciesOf(id).every((dep) => stateOf(states, dep) === 'completed');
  });
}

/**
 * Everything downstream of a failed or blocked task.
 *
 * Without this the scheduler would leave dependents sitting in `queued` forever,
 * which reads as "not started yet" when it actually means "will never start".
 */
export function blockedByFailure(dag: Dag, states: TaskStates): string[] {
  const poisoned = new Set(
    dag.ids.filter((id) => {
      const state = stateOf(states, id);
      return state === 'failed' || state === 'blocked';
    }),
  );

  const blocked = new Set<string>();
  const walk = (id: string): void => {
    for (const dependent of dag.dependentsOf(id)) {
      if (blocked.has(dependent) || poisoned.has(dependent)) continue;
      blocked.add(dependent);
      walk(dependent);
    }
  };
  for (const id of poisoned) walk(id);

  return [...blocked].sort();
}
