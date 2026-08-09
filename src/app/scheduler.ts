import type { Plan, TaskResult, TaskState } from '../contracts/index.js';
import { blockedByFailure, buildDag, readyTasks, topologicalOrder } from '../core/dag.js';
import type { StateStore } from './state-store.js';
import type { TaskExecutor } from './task-executor.js';

export interface SchedulerOptions {
  readonly store: StateStore;
  readonly executor: TaskExecutor;
  /**
   * One in MVP 1 (AD-05).
   *
   * The loop below is already written for N. Raising this is what MVP 2 costs —
   * plus worktrees, because at N > 1 tasks would otherwise write to the same
   * working tree at the same time.
   */
  readonly maxConcurrency?: number;
  readonly onTaskStart?: (taskId: string) => void;
  readonly onTaskFinish?: (result: TaskResult) => void;
}

export interface SchedulerOutcome {
  readonly states: Record<string, TaskState>;
  readonly results: TaskResult[];
  /** True when every task reached `completed`. */
  readonly complete: boolean;
  /** Tasks that will never run because something upstream failed. */
  readonly blocked: string[];
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
  ): Promise<SchedulerOutcome> {
    const dag = buildDag(
      plan.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })),
    );
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));

    const states: Record<string, TaskState> = {};
    for (const id of topologicalOrder(dag)) states[id] = initialStates[id] ?? 'queued';

    const results: TaskResult[] = [];
    const concurrency = Math.max(1, this.options.maxConcurrency ?? 1);
    let haltedBy: string | undefined;

    while (haltedBy === undefined) {
      const ready = readyTasks(dag, states).filter((id) => states[id] !== 'completed');
      if (ready.length === 0) break;

      const batch = ready.slice(0, concurrency);
      for (const id of batch) states[id] = 'running';

      // Persisted before the work starts, not only after it. Two reasons: the
      // attempt counter has to move when an attempt begins, and a process
      // killed mid-task must leave evidence that the task was in flight rather
      // than looking as though it never started.
      await this.persist(runId, states);

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

    return {
      states,
      results,
      complete: Object.values(states).every((state) => state === 'completed'),
      blocked,
      ...(haltedBy === undefined ? {} : { haltedBy }),
    };
  }

  /**
   * Written after every batch, not at the end. A run killed mid-flight must
   * resume from what actually happened, and the whole point of persisting task
   * state is that the terminal closing is a normal event.
   */
  private async persist(runId: string, states: Record<string, TaskState>): Promise<void> {
    await this.options.store.updateRun(runId, (state) => ({
      ...state,
      tasks: Object.entries(states).map(([id, taskState]) => {
        const previous = state.tasks.find((entry) => entry.id === id);
        return {
          id,
          state: taskState,
          attempts:
            taskState === 'running' ? (previous?.attempts ?? 0) + 1 : (previous?.attempts ?? 0),
        };
      }),
    }));
  }
}
