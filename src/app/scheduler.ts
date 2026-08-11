import type { Plan, TaskResult, TaskState } from '../contracts/index.js';
import { blockedByFailure, buildDag, readyTasks, topologicalOrder } from '../core/dag.js';
import type { StateStore } from './state-store.js';
import type { TaskExecutor } from './task-executor.js';

export interface SchedulerOptions {
  readonly store: StateStore;
  readonly executor: TaskExecutor;
  /**
   * How many tasks this scheduler may have in flight. One in MVP 1 (AD-05).
   *
   * The loop below is already written for N, and deliberately still is. What it
   * is *not* is the place the limit is decided: nothing in production reads
   * `parallelism.maxTasks` and hands it here, because a configured number is an
   * intention and this is an instruction. `core/concurrency.ts` resolves one into
   * the other, and until tasks have isolated workspaces it resolves to one
   * however the configuration is written — see `app/execution-context.ts`.
   *
   * Left as an option rather than removed because the scheduler's own contract is
   * worth testing at N, and because the resolver is the only thing that should
   * ever have to change.
   */
  readonly maxConcurrency?: number;
  /** Bounds recovery of interrupted tasks. Comes from `retry.maxAttempts`. */
  readonly maxAttempts?: number;
  readonly onTaskStart?: (taskId: string) => void;
  readonly onTaskFinish?: (result: TaskResult) => void;
}

export interface RunOptions {
  /**
   * Restricts execution to these tasks, without narrowing the graph.
   *
   * `agent-flow task TASK-004` used to filter the plan down to one task and
   * hand that to the scheduler, which then built a DAG over a plan whose
   * dependencies did not exist — `unknown_dependency`, on a plan that was
   * perfectly valid. The graph stays whole so dependency rules are still
   * applied by the DAG; only the set of tasks allowed to *start* is narrowed.
   */
  readonly only?: ReadonlySet<string>;
}

export interface SchedulerOutcome {
  readonly states: Record<string, TaskState>;
  readonly results: TaskResult[];
  /**
   * True when everything this invocation was asked to run reached `completed`.
   *
   * Distinct from `planComplete`, and the distinction is the whole point:
   * `agent-flow task TASK-002` asks for one task. Judging that invocation
   * against the whole plan reported failure for work that had succeeded, and
   * exited non-zero — so a script driving one task at a time could never make
   * progress.
   */
  readonly complete: boolean;
  /**
   * True when every task in the plan reached `completed`.
   *
   * The gate to review. Only this may advance the run's stage; `complete`
   * decides nothing beyond the exit code of the command that just ran.
   */
  readonly planComplete: boolean;
  /** Tasks that will never run because something upstream failed. */
  readonly blocked: string[];
  /** Tasks found orphaned in `running` and put back in the queue. */
  readonly recovered: string[];
  /** Set when the run stopped before finishing, with the reason. */
  readonly haltedBy?: string;
}

/**
 * Executes a plan in dependency order.
 *
 * The scheduler owns *when* work runs; the DAG owns *what may* run. That split
 * is why raising concurrency later touches only the batch size here, and why
 * `core/dag.ts` stays pure and fully testable.
 *
 * Stops on the first task that fails or blocks rather than pressing on. The
 * alternative — carrying on with independent branches — produces a half-built
 * feature whose state is harder to reason about than a clean stop, and every
 * downstream task would be working on a foundation that was never laid.
 */
export class Scheduler {
  constructor(private readonly options: SchedulerOptions) {}

  async run(
    plan: Plan,
    runId: string,
    sdd: string,
    initialStates: Record<string, TaskState> = {},
    options: RunOptions = {},
  ): Promise<SchedulerOutcome> {
    const dag = buildDag(
      plan.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })),
    );
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));

    const states: Record<string, TaskState> = {};
    for (const id of topologicalOrder(dag)) states[id] = initialStates[id] ?? 'queued';

    // Nothing is executing yet, so anything still marked `running` was left
    // behind by a process that died. Recovered rather than left alone: the DAG
    // admits only `queued` and `ready`, so an orphan would sit there forever
    // and the run would make no further progress while reporting no failure.
    const recovered = await this.recoverInterrupted(runId, states);

    const results: TaskResult[] = [];
    const concurrency = Math.max(1, this.options.maxConcurrency ?? 1);
    let haltedBy: string | undefined;

    while (haltedBy === undefined) {
      const ready = readyTasks(dag, states)
        .filter((id) => states[id] !== 'completed')
        // Dependency rules were already applied against the complete graph;
        // this only decides which of the eligible tasks we are willing to run.
        .filter((id) => options.only?.has(id) ?? true);
      if (ready.length === 0) break;

      const batch = ready.slice(0, concurrency);
      for (const id of batch) states[id] = 'running';

      // Persisted before the work starts, not only after it. Two reasons: the
      // attempt counter has to move when an attempt begins, and a process
      // killed mid-task must leave evidence that the task was in flight rather
      // than looking as though it never started.
      //
      // The batch is named, because this is the write that spends the attempts.
      await this.persist(runId, states, batch);

      const executed = await Promise.all(
        batch.map(async (id) => {
          const task = byId.get(id);
          if (task === undefined) throw new Error(`plan has no task ${id}`);

          this.options.onTaskStart?.(id);
          const result = await this.options.executor.execute(task, runId, sdd);
          this.options.onTaskFinish?.(result);
          return result;
        }),
      );

      for (const result of executed) {
        states[result.task] = result.status;
        results.push(result);

        if (result.status !== 'completed' && haltedBy === undefined) {
          haltedBy = `${result.task} ended as ${result.status}`;
        }
      }

      await this.persist(runId, states);
    }

    const blocked = blockedByFailure(dag, states);
    for (const id of blocked) states[id] = 'blocked';
    if (blocked.length > 0) await this.persist(runId, states);

    const inScope = (id: string): boolean => options.only?.has(id) ?? true;

    return {
      states,
      results,
      complete: Object.entries(states).every(
        ([id, state]) => !inScope(id) || state === 'completed',
      ),
      planComplete: Object.values(states).every((state) => state === 'completed'),
      blocked,
      recovered,
      ...(haltedBy === undefined ? {} : { haltedBy }),
    };
  }

  /**
   * Brings tasks left `running` by a dead process back into the queue.
   *
   * Two things keep this from becoming an automatic retry loop, which §23
   * forbids. The attempt counter was already incremented when the attempt
   * began, so `maxAttempts` still bounds it; and a task past that limit is left
   * `interrupted` for a person to look at rather than tried again.
   *
   * Recorded as an event either way — a run that silently restarted work is
   * indistinguishable from one that never stopped.
   */
  private async recoverInterrupted(
    runId: string,
    states: Record<string, TaskState>,
  ): Promise<string[]> {
    const orphans = Object.entries(states)
      .filter(([, state]) => state === 'running')
      .map(([id]) => id);

    if (orphans.length === 0) return [];

    const persisted = await this.options.store.loadRun(runId);
    const attemptsOf = (id: string): number =>
      persisted.tasks.find((task) => task.id === id)?.attempts ?? 0;

    const maxAttempts = this.options.maxAttempts ?? Number.POSITIVE_INFINITY;
    const requeued: string[] = [];

    // Every orphan passes through `interrupted` first, including the ones that
    // go straight back to the queue. Skipping it wrote `queued` over `running`
    // — a transition §22 forbids, and forbids for a reason: the state on disk
    // would then be indistinguishable from a task that had simply never
    // started, and a run that silently restarted work is exactly what the
    // recovery path must not look like.
    for (const id of orphans) states[id] = 'interrupted';
    await this.persist(runId, states);

    for (const id of orphans) {
      const attempts = attemptsOf(id);
      const exhausted = attempts >= maxAttempts;

      if (!exhausted) {
        states[id] = 'queued';
        requeued.push(id);
      }

      await this.options.store.appendEvent(runId, 'task_interrupted', {
        task: id,
        attempts,
        requeued: !exhausted,
        ...(exhausted ? { reason: `attempt limit of ${String(maxAttempts)} reached` } : {}),
      });
    }

    await this.persist(runId, states);
    return requeued;
  }

  /**
   * Written after every batch, not at the end. A run killed mid-flight must
   * resume from what actually happened, and the whole point of persisting task
   * state is that the terminal closing is a normal event.
   *
   * **`dispatched` is what spends an attempt, and only that (M2-00.2).** The
   * counter used to be derived here from `taskState === 'running'`, which made it
   * a count of writes that happened to catch a task in flight rather than a count
   * of times the task was sent to a runner. The two agree only because a batch is
   * a barrier: everything in it has left `running` before the next write. So the
   * old rule was not wrong, it was true by coincidence — and `retry.maxAttempts`,
   * the recovery bound and everything a person reads off `attempts` rested on that
   * coincidence. Naming the dispatch makes the counter mean what it says whatever
   * the dispatch shape becomes.
   */
  private async persist(
    runId: string,
    states: Record<string, TaskState>,
    dispatched: readonly string[] = [],
  ): Promise<void> {
    const starting = new Set(dispatched);

    await this.options.store.updateRun(runId, (state) => ({
      ...state,
      tasks: Object.entries(states).map(([id, taskState]) => {
        const attempts = state.tasks.find((entry) => entry.id === id)?.attempts ?? 0;
        return {
          id,
          state: taskState,
          attempts: starting.has(id) ? attempts + 1 : attempts,
        };
      }),
    }));
  }
}
