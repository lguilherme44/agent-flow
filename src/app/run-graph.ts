import { blockedByFailure, buildDag, readyTasks, topologicalOrder } from '../core/dag.js';
import type { TaskState } from '../contracts/index.js';

/**
 * The run's dependency graph, as something that can be read (§92).
 *
 * Two answers come out of this module and both of them already existed: the graph
 * is the plan's `dependencies`, and readiness is `core/dag`'s rule. Nothing here
 * decides either. It exists so that the browser does not have to — a React
 * component that worked out which tasks were ready would be a second scheduler,
 * and it would be the one that drifts, because the real one is not on screen.
 *
 * The split between *structure* and *state* is deliberate and load-bearing:
 *
 *   - `describeRunGraph` answers what depends on what. It changes when the plan
 *     changes, which is rare — a re-plan or a corrective round, not a task
 *     finishing.
 *   - `effectiveTaskStates` answers what each task is doing right now. It changes
 *     constantly.
 *
 * Keeping them apart is what lets a dashboard lay a 500-node graph out once and
 * then repaint statuses on it, instead of re-running a layout every time a log
 * line arrives.
 *
 * `depth` is a drawing coordinate, not a schedule. It is the longest dependency
 * chain reaching a task, which is what puts a graph into readable columns. The
 * scheduler runs one task at a time in topological order; two tasks at the same
 * depth are not a parallel wave, and nothing here should be read as promising one.
 */

export interface GraphTask {
  readonly id: string;
  readonly dependencies: readonly string[];
}

export interface RunGraphNode {
  readonly taskId: string;
  /** Longest dependency chain reaching this task. Layout only — see above. */
  readonly depth: number;
}

export interface RunGraphEdge {
  readonly from: string;
  readonly to: string;
}

/** A dependency the plan named and the plan does not contain. */
export interface UnresolvedDependency {
  readonly taskId: string;
  readonly dependsOn: string;
}

export interface RunGraphProblem {
  readonly kind: string;
  readonly message: string;
  /** Closed path, when the problem is a cycle. */
  readonly cycle?: readonly string[];
}

export interface RunGraph {
  /** Topological order where one exists, id order when it does not. */
  readonly nodes: readonly RunGraphNode[];
  readonly edges: readonly RunGraphEdge[];
  /**
   * Dependencies pointing at tasks that do not exist.
   *
   * Reported rather than drawn. Inventing the missing node would put a task on
   * screen that nothing in the plan describes, and dropping the edge silently
   * would show a task as a root when the plan says it is waiting for something.
   */
  readonly unresolved: readonly UnresolvedDependency[];
  /** Present when the plan's graph is not a DAG. Then `depth` is not meaningful. */
  readonly invalid?: RunGraphProblem;
}

/**
 * Builds the readable graph, tolerating a plan that should never have been written.
 *
 * `buildDag` throws on an unknown dependency, and rightly so — the planner's output
 * is validated before anything runs. A reader has a different job: a plan that got
 * onto disk broken is exactly the one somebody needs to look at, so the unknown
 * edges are set aside and named instead of taking the whole view down.
 */
export function describeRunGraph(tasks: readonly GraphTask[]): RunGraph {
  const known = new Set(tasks.map((task) => task.id));

  const unresolved: UnresolvedDependency[] = [];
  const nodes = tasks.map((task) => {
    const dependencies: string[] = [];
    for (const dependency of task.dependencies) {
      if (known.has(dependency)) dependencies.push(dependency);
      else unresolved.push({ taskId: task.id, dependsOn: dependency });
    }
    return { id: task.id, dependencies };
  });

  const edges = nodes.flatMap((node) =>
    node.dependencies.map((from) => ({ from, to: node.id })),
  );

  let dag;
  try {
    dag = buildDag(nodes);
  } catch (error) {
    const problem = error as { kind?: string; message?: string; cycle?: readonly string[] };
    return {
      // Ordered by id, because there is no topological order to give.
      nodes: [...known].sort().map((taskId) => ({ taskId, depth: 0 })),
      edges,
      unresolved,
      invalid: {
        kind: problem.kind ?? 'invalid_graph',
        message: problem.message ?? 'the plan’s dependency graph could not be read',
        ...(problem.cycle === undefined ? {} : { cycle: [...problem.cycle] }),
      },
    };
  }

  const order = topologicalOrder(dag);
  const depths = new Map<string, number>();

  // One pass in topological order: every dependency of a task is already
  // measured by the time the task is reached, so the longest chain is a max over
  // values that are final. Quadratic re-walks are what a 500-task plan cannot
  // afford, and are the reason this is computed once, here, rather than per frame.
  for (const id of order) {
    let depth = 0;
    for (const dependency of dag.dependenciesOf(id)) {
      depth = Math.max(depth, (depths.get(dependency) ?? 0) + 1);
    }
    depths.set(id, depth);
  }

  return {
    nodes: order.map((taskId) => ({ taskId, depth: depths.get(taskId) ?? 0 })),
    edges,
    unresolved,
  };
}

/**
 * What each task is, once the graph has had its say (§22).
 *
 * Two of the eight task states are conditions rather than records, and the
 * StateStore is right not to persist either:
 *
 *   - `ready` is "every dependency completed", which goes stale the moment one of
 *     them fails. A stored `ready` would be a claim about other tasks.
 *   - `blocked` here means "downstream of something that failed" — the scheduler's
 *     own conclusion. Left as `queued`, those tasks read as *not started yet* when
 *     what they actually are is *never going to start*.
 *
 * Every reader goes through this, so the task table and the graph cannot describe
 * the same task differently. That is the whole point of it being one function.
 */
export function effectiveTaskStates(
  tasks: readonly GraphTask[],
  stored: Readonly<Record<string, TaskState>>,
): Record<string, TaskState> {
  const effective: Record<string, TaskState> = {};
  for (const task of tasks) effective[task.id] = stored[task.id] ?? 'queued';

  const known = new Set(tasks.map((task) => task.id));
  const nodes = tasks.map((task) => ({
    id: task.id,
    dependencies: task.dependencies.filter((dependency) => known.has(dependency)),
  }));

  let dag;
  try {
    dag = buildDag(nodes);
  } catch {
    // A graph that will not build has no readiness to report. The stored states
    // are still true — they were written by something that ran — and reporting
    // them unchanged is more honest than guessing at a graph nobody can traverse.
    return effective;
  }

  for (const id of blockedByFailure(dag, effective)) effective[id] = 'blocked';
  // After the blocking pass: a task downstream of a failure is not ready, and
  // `readyTasks` reads the states it is given.
  for (const id of readyTasks(dag, effective)) effective[id] = 'ready';

  return effective;
}
