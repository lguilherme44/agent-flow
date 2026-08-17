import type { Plan, RunState, TaskResult, TaskState } from '../contracts/index.js';
import type { TaskWorkspace, TaskWorkspaces } from './task-workspaces.js';
import type { TaskBlockReason } from '../contracts/state.schema.js';
import {
  blockedByFailure,
  buildDag,
  readyTasks,
  topologicalOrder,
  unblockedByRecovery,
  type Dag,
} from '../core/dag.js';
import type { StateStore } from './state-store.js';
import type { TaskExecutor } from './task-executor.js';
import type {
  IntegrationWorkspace,
  WaveAttempt,
  WaveIntegrator,
} from './integrator.js';
import type { RunRecovery, RunRecoveryOutcome } from './worktree-recovery.js';

export interface SchedulerOptions {
  readonly store: StateStore;
  readonly executor: TaskExecutor;
  /**
   * How many tasks this scheduler may have in flight, as a fixed number.
   *
   * The scheduler's own contract at N, for the tests that are about the loop
   * rather than about the policy. **No production path sets this**: which limit a
   * run gets depends on the mode that run was born in, and a number fixed when
   * this object was constructed cannot know it — see {@link concurrencyFor}.
   */
  readonly maxConcurrency?: number;
  /**
   * How many tasks this run may have in flight, from the run's own state (M2-11).
   *
   * The production path, and the reason it is a function of `RunState` rather than
   * a number: a configured `maxTasks: 4` is an intention, and what it resolves to
   * depends on whether *this run* isolates its tasks. `state.isolationMode` was
   * captured at `createRun` and is immutable (I-13), so the same run resolves to
   * the same number on every entry however the configuration has been edited since.
   *
   * The policy itself stays in `core/concurrency.ts`; this is only where the run is
   * handed to it. A scheduler that read the configuration would be deciding a
   * question §6.1 already answered, and a scheduler that probed the repository
   * would be answering it from the layer that must not.
   *
   * Takes precedence over {@link maxConcurrency}. Absent, the fixed number applies
   * — which is every caller predating M2-11 and no production path.
   */
  readonly concurrencyFor?: (state: RunState) => number;
  /**
   * Prepares one workspace per dispatched attempt (M2-04, §8).
   *
   * Optional so that every caller predating this milestone — and every
   * sequential run — keeps working with no workspace at all, which the executor
   * reads as "the project directory". When it is present the §8.1 sequence runs
   * before the agent is invoked, and a refusal fails the task without one.
   */
  readonly workspaces?: TaskWorkspaces;
  /**
   * Turns validated attempts into completed tasks (M2-06, §14).
   *
   * Optional for the same reason `workspaces` is: a sequential run has no
   * integration branch, nothing to merge and no second tree — and every caller
   * predating this milestone keeps working with none wired. When one *is* wired
   * it still answers `sequential` for a run that is not isolated, so the mode is
   * decided by the run's own `isolationMode` rather than by the wiring (I-13).
   *
   * **While it is present, this scheduler never decides that a task is
   * completed** (§14.4). It dispatches attempts, awaits the barrier, and hands the
   * satisfied ones over; the state each task ends in comes back from the
   * Integrator. That is the whole of I-3 as far as the scheduler is concerned —
   * releasing a dependent against a branch that does not contain its dependency's
   * work is silent, and only visible three tasks later.
   */
  readonly integrator?: WaveIntegrator;
  /**
   * The Git half of crash recovery, before the first wave (M2-07, §17).
   *
   * Optional for the same reason `integrator` is: a sequential run has no durable
   * Git evidence to reconcile, and every caller predating this milestone keeps
   * working with none wired. With none, {@link Scheduler.recoverInterrupted} is
   * the whole of recovery — which is byte-for-byte what M2-06 did.
   */
  readonly recovery?: RunRecovery;
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
  /** Dependency-blocked tasks returned to the queue because the block ended. */
  readonly released: string[];
  /** Tasks found orphaned in `running` and put back in the queue. */
  readonly recovered: string[];
  /** Set when the run stopped before finishing, with the reason. */
  readonly haltedBy?: string;
}

/**
 * What one dispatched attempt produced.
 *
 * Two shapes, because there are two genuinely different outcomes and only one of
 * them is an execution. A `TaskResult` records *what ran* — the runner, the model,
 * the reasoning level, the validation it went through — and a workspace that was
 * refused ran nothing at all. Describing that as a `TaskResult` would mean naming
 * a runner that was never invoked, which puts a fiction in the one artifact
 * everything downstream reads as evidence.
 *
 * So a refusal carries the four facts §8.3 defines and no more, and never becomes
 * a result: no `result.json` is written, `onTaskFinish` is not called, and
 * `SchedulerOutcome.results` has no entry for it. The task's `failed` state and
 * the `task_workspace_preparation_failed` event are the record.
 */
type DispatchOutcome =
  | {
      readonly kind: 'executed';
      readonly result: TaskResult;
      /**
       * Which attempt ran — the one the dispatch above spent.
       *
       * Carried rather than looked up again at integration time, because the
       * counter is a live field: reading it back would answer "how many attempts
       * has this task had by now", and what the Integrator needs is "which
       * attempt produced this evidence".
       *
       * Absent only where no workspace service is wired at all, which is every
       * caller predating M2-04 and no production path.
       */
      readonly attempt?: number;
    }
  | {
      readonly kind: 'workspace_preparation_failed';
      readonly task: string;
      readonly code: 'task_workspace_preparation_failed';
      readonly phase: 'checkout' | 'setup';
      /** Repository-relative and bounded. Never absolute (§7.2, §21.3). */
      readonly changes: readonly string[];
      /**
       * A sentence for a person, path-free by construction.
       *
       * Reaches the halt reason and therefore the CLI, and nothing else — it is
       * deliberately absent from the event, whose payload is the closed shape
       * Appendix B specifies.
       */
      readonly detail: string;
    };

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
    initialBlockReasons: Readonly<Partial<Record<string, TaskBlockReason>>> = {},
  ): Promise<SchedulerOutcome> {
    const dag = buildDag(
      plan.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })),
    );
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));

    const states: Record<string, TaskState> = {};
    for (const id of topologicalOrder(dag)) states[id] = initialStates[id] ?? 'queued';

    // Why each task sits where it sits (§20, §23). Persisted so a resume knows
    // a `blocked` task from its own answer apart from one held back the wave
    // an upstream failure stopped — the first must never be released by
    // recovery, the second is released the moment its dependency completes.
    //
    // Absent a recorded reason (a task already `blocked` when this provenance
    // exists in the schema but not in the state), the fail-closed default is
    // `agent`: no record is not a promise the task is releaseable.
    const blockReasons: Record<string, TaskBlockReason> = {};
    for (const id of topologicalOrder(dag)) blockReasons[id] = initialBlockReasons[id] ?? 'agent';

    const results: TaskResult[] = [];
    // Tasks released back into the queue because their dependency block ended.
    const released: string[] = [];
    // Resolved once, from the run, before anything is dispatched. Once per wave
    // would let a configuration edit mid-run change the width of the next wave,
    // which is the property I-13 exists to deny — and it would make "how many
    // tasks did this run execute at once" a question with more than one answer.
    const concurrency = await this.concurrencyOf(runId);
    let haltedBy: string | undefined;

    // §5.3 and §14.1, once, before anything is dispatched: the integration branch
    // is cut from `planningBase` and checked out, or the run's own namespace is
    // resumed. A refusal here stops the run before a single agent is invoked —
    // work built on a namespace this run does not own is work nobody can trust.
    //
    // **First, and before either half of recovery.** §17.3 window 0 is the run's
    // own initialisation, checked once before the per-task loop; and the Git half
    // below needs the integration workspace to reconcile anything into.
    const integration = await this.prepareIntegration(runId);
    if (integration?.kind === 'refused') {
      return this.stopped(states, [], dag, integration.reason);
    }
    const workspace = integration?.workspace;

    // §17: the Git half of recovery, **before the state half below, and the order
    // is the invariant rather than a preference.** A task whose durable evidence
    // finished its attempt is completed from `running`, which §22 allows; demoting
    // it to `interrupted` first would leave `interrupted → completed`, which §22
    // does not — so the work would be thrown away and the agent run again over a
    // tree that was already validated and merged.
    const durable = await this.recoverDurable(runId, workspace, dag, states);
    if (durable !== undefined && durable.outcomes.length > 0) {
      for (const outcome of durable.outcomes) {
        // Copied, never named: the state a recovered task ends in comes from the
        // Integrator, which is the only module that may write `completed` (I-3).
        if (outcome.kind !== 'requeue') states[outcome.task] = outcome.state;
      }
      // Written only when recovery found something. A pass that observed nothing
      // writes nothing — the same rule §6.4 applies to a precondition refusal, and
      // it matters for the same reason: a write that merely restates this
      // invocation's opening view of the world can contradict what is on disk.
      await this.persist(runId, states);
    }
    if (durable?.haltedBy !== undefined) haltedBy = durable.haltedBy;

    // Nothing is executing yet, so anything still marked `running` was left
    // behind by a process that died. Recovered rather than left alone: the DAG
    // admits only `queued` and `ready`, so an orphan would sit there forever
    // and the run would make no further progress while reporting no failure.
    const recovered = await this.recoverInterrupted(runId, states);

    if (haltedBy !== undefined) return this.stopped(states, recovered, dag, haltedBy);

    while (haltedBy === undefined) {
      // A dependency block is a condition over the graph, not a fact about the
      // task (§20): it means "a task this one depends on failed", never "this
      // task answered BLOCKED". Once every dependency is `completed`, the
      // condition has ended and the task may run again — no `--force`, no human
      // noticing a dependent was left behind (§23 owns agent-blocks; nothing
      // here touches those).
      const releasable = unblockedByRecovery(dag, states, blockReasons);
      for (const id of releasable) {
        states[id] = 'queued';
        delete blockReasons[id];
        released.push(id);
        await this.options.store.appendEvent(runId, 'task_unblocked', {
          task: id,
          reason: 'dependency',
        });
      }
      // Persisted whether or not anything dispatches this pass. A released task
      // excluded by `only` must still be `queued` on disk, or the next run
      // re-derives a release it cannot see.
      if (releasable.length > 0) await this.persist(runId, states, [], blockReasons);

      const ready = readyTasks(dag, states)
        .filter((id) => states[id] !== 'completed')
        // Dependency rules were already applied against the complete graph;
        // this only decides which of the eligible tasks we are willing to run.
        .filter((id) => options.only?.has(id) ?? true);
      if (ready.length === 0) break;

      // §9.1 step 1: **the wave base is read once, and every task in the wave is
      // cut from it.** Reading it per task would let a task start from a head an
      // unintegrated sibling was about to move, which is precisely the
      // nondeterminism the barrier exists to remove.
      const waveBase = await this.waveBase(workspace);
      if (workspace !== undefined && waveBase === undefined) {
        return this.stopped(
          states,
          recovered,
          dag,
          'the integration branch could not be read, so no wave base exists to cut this wave from',
        );
      }

      const batch = ready.slice(0, concurrency);
      for (const id of batch) states[id] = 'running';

      // Persisted before the work starts, not only after it. Two reasons: the
      // attempt counter has to move when an attempt begins, and a process
      // killed mid-task must leave evidence that the task was in flight rather
      // than looking as though it never started.
      //
      // The batch is named, because this is the write that spends the attempts.
      await this.persist(runId, states, batch);

      const dispatched = await Promise.all(
        batch.map(async (id): Promise<DispatchOutcome> => {
          const task = byId.get(id);
          if (task === undefined) throw new Error(`plan has no task ${id}`);

          this.options.onTaskStart?.(id);

          // §8.1: the workspace is prepared *after* the attempt was spent by the
          // dispatch above (M2-00.2) and *before* the agent is invoked. A failed
          // preparation therefore costs an attempt and produces no agent call,
          // which is what §8.3 specifies — the counter already moved, and
          // pretending otherwise would make a retry policy count wrong.
          const prepared = await this.prepareWorkspace(runId, id, waveBase);
          if (prepared.kind === 'workspace_preparation_failed') return prepared;

          const result = await this.options.executor.execute(
            task,
            runId,
            sdd,
            prepared.workspace,
          );
          // Only an execution reaches this callback, because its argument is a
          // `TaskResult` and there is no honest one to pass for a refusal.
          this.options.onTaskFinish?.(result);
          return { kind: 'executed', result, attempt: prepared.attempt };
        }),
      );

      /** Satisfied attempts, awaiting the merge that makes them outcomes. */
      const awaitingIntegration: WaveAttempt[] = [];

      // Iterated in `batch` order, which `readyTasks` sorts — so which task sets
      // the halt reason is a property of the plan and the state, never of which
      // worker happened to finish first.
      for (const outcome of dispatched) {
        if (outcome.kind === 'executed') {
          // §14.4. In worktree mode a satisfied attempt is *evidence*, not an
          // outcome: nothing here writes the state, because the state this task
          // ends in depends on a merge that has not happened yet. Writing it now
          // would release dependents against a branch their dependency's work is
          // not on.
          if (workspace !== undefined && outcome.result.status === 'completed') {
            if (outcome.attempt === undefined) {
              // Unreachable in production, where the workspace service and the
              // Integrator are wired together. Loud rather than silent, because
              // the silent alternative is falling through to the line below and
              // completing a task nothing merged.
              throw new Error(
                `${outcome.result.task} executed in worktree mode without a prepared attempt`,
              );
            }
            awaitingIntegration.push({
              task: outcome.result.task,
              attempt: outcome.attempt,
              result: outcome.result,
            });
            continue;
          }

          states[outcome.result.task] = outcome.result.status;
          results.push(outcome.result);
          // The task's *own* agent answered — this is the §23 half of blocked,
          // and recording it keeps recovery from ever reopening the task.
          if (outcome.result.status === 'blocked') {
            blockReasons[outcome.result.task] = 'agent';
          }

          if (outcome.result.status !== 'completed' && haltedBy === undefined) {
            haltedBy = `${outcome.result.task} ended as ${outcome.result.status}`;
          }
          continue;
        }

        // No result to push: nothing executed. The state transition and the event
        // are the whole record, and the halt reason says which task and why so a
        // person is not left reading "not all tasks completed".
        states[outcome.task] = 'failed';

        if (haltedBy === undefined) {
          haltedBy =
            `${outcome.task} never started: workspace preparation failed ` +
            `at the ${outcome.phase} check — ${outcome.detail}`;
        }
      }

      // §9.2: **the wave completes before the run halts.** A sibling that failed
      // does not discard work that was already paid for and already validated —
      // and making the outcome depend on which task finished first is exactly the
      // nondeterminism this milestone exists to avoid.
      if (workspace !== undefined && awaitingIntegration.length > 0) {
        const integrator = this.options.integrator;
        if (integrator === undefined) throw new Error('an integration workspace with no integrator');

        const integrated = await integrator.integrate({
          runId,
          workspace,
          dag,
          attempts: awaitingIntegration,
        });

        for (const outcome of integrated.outcomes) {
          // Copied, never named: the Integrator decides what state a merge leaves
          // a task in, and the literal lives in the module that owns the write.
          states[outcome.task] = outcome.state;
          if (outcome.kind === 'integrated') results.push(outcome.result);
        }

        if (integrated.haltedBy !== undefined && haltedBy === undefined) {
          haltedBy = integrated.haltedBy;
        }
      }

      await this.persist(runId, states);
    }

    const blocked = blockedByFailure(dag, states);
    for (const id of blocked) {
      states[id] = 'blocked';
      // Every task this marks is a dependent of a failed/blocked task — none of
      // them ran (§20), so this is dependency-derived by construction.
      blockReasons[id] = 'dependency';
    }
    if (blocked.length > 0) await this.persist(runId, states, [], blockReasons);

    const inScope = (id: string): boolean => options.only?.has(id) ?? true;

    return {
      states,
      results,
      complete: Object.entries(states).every(
        ([id, state]) => !inScope(id) || state === 'completed',
      ),
      planComplete: Object.values(states).every((state) => state === 'completed'),
      blocked,
      released,
      recovered,
      ...(haltedBy === undefined ? {} : { haltedBy }),
    };
  }

  /**
   * How wide this run's waves may be (M2-11, §4.4).
   *
   * The run is loaded and handed to the resolver the application wired in; nothing
   * here interprets the mode, and nothing here reads the configuration. Never less
   * than one, so a resolver bug becomes a sequential run rather than a scheduler
   * with nothing to dispatch — which would hang instead of failing.
   */
  private async concurrencyOf(runId: string): Promise<number> {
    const resolve = this.options.concurrencyFor;
    if (resolve === undefined) return Math.max(1, this.options.maxConcurrency ?? 1);

    return Math.max(1, resolve(await this.options.store.loadRun(runId)));
  }

  /**
   * §5.3 and §14.1, before the first wave: the run's integration branch and its
   * checkout, or the refusal that stops the run.
   *
   * `undefined` covers the two cases that must behave exactly as they always
   * have: no Integrator wired at all, and a run whose `isolationMode` is not
   * `worktree`. Neither creates a ref, neither reaches Git through this path, and
   * neither changes a single line of the loop below (§25.1).
   */
  private async prepareIntegration(
    runId: string,
  ): Promise<
    | { readonly kind: 'ready'; readonly workspace: IntegrationWorkspace }
    | { readonly kind: 'refused'; readonly reason: string }
    | undefined
  > {
    const integrator = this.options.integrator;
    if (integrator === undefined) return undefined;

    const prepared = await integrator.prepare(runId);
    if (prepared.kind === 'sequential') return undefined;
    if (prepared.kind === 'refused') {
      return { kind: 'refused', reason: `${prepared.refusal.code}: ${prepared.refusal.detail}` };
    }

    return { kind: 'ready', workspace: prepared.workspace };
  }

  /**
   * §17: what durable evidence a dead process left, reconciled.
   *
   * `undefined` covers the two cases that must behave exactly as they always
   * have: no recovery service wired, and a run that has no integration workspace
   * because it is not isolated. Neither reaches Git through this path (§25.1).
   */
  private async recoverDurable(
    runId: string,
    workspace: IntegrationWorkspace | undefined,
    dag: Dag,
    states: Record<string, TaskState>,
  ): Promise<RunRecoveryOutcome | undefined> {
    const recovery = this.options.recovery;
    if (recovery === undefined || workspace === undefined) return undefined;

    return recovery.recoverRun({ runId, workspace, dag, states });
  }

  /** The commit this wave's workspaces are cut from, or none in sequential mode. */
  private async waveBase(
    workspace: IntegrationWorkspace | undefined,
  ): Promise<string | undefined> {
    if (workspace === undefined) return undefined;
    return this.options.integrator?.waveBase(workspace);
  }

  /**
   * A run that stopped before it could dispatch anything.
   *
   * Distinct from a run that halted mid-flight, and reported as such: `results`
   * is empty because nothing executed, and the reason names the repository state
   * a person has to act on rather than "not all tasks completed".
   */
  private stopped(
    states: Record<string, TaskState>,
    recovered: string[],
    dag: Dag,
    reason: string,
  ): SchedulerOutcome {
    return {
      states,
      results: [],
      complete: false,
      planComplete: Object.values(states).every((state) => state === 'completed'),
      blocked: blockedByFailure(dag, states),
      released: [],
      recovered,
      haltedBy: reason,
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
  /**
   * The workspace for one dispatched attempt, or the refusal that stopped it.
   *
   * Absent `workspaces`, every task gets the project directory — which is what
   * keeps the sequential path unchanged for callers that never wired one.
   *
   * On failure the worktree is **retained and still locked** (§7.4, §9). It is
   * the only remaining copy of what the checkout and the install produced, and
   * deleting it to save disk would be deleting the evidence that explains the
   * refusal. Reclaiming it is M2-09's.
   *
   * Writes the event and nothing else: the state transition and the halt reason
   * belong to the loop, which is where every other transition already happens.
   */
  private async prepareWorkspace(
    runId: string,
    taskId: string,
    waveBase: string | undefined,
  ): Promise<
    | {
        readonly kind: 'prepared';
        readonly workspace?: TaskWorkspace;
        readonly attempt?: number;
      }
    | Extract<DispatchOutcome, { kind: 'workspace_preparation_failed' }>
  > {
    const workspaces = this.options.workspaces;
    // Nothing wired: the executor falls back to the project directory, which is
    // every sequential caller and every test that predates M2-04.
    if (workspaces === undefined) return { kind: 'prepared' };

    const state = await this.options.store.loadRun(runId);
    const attempt = state.tasks.find((task) => task.id === taskId)?.attempts ?? 1;

    // §9.1 step 1: one wave base, read once above and given to every task in the
    // wave. Before M2-06 that commit was always `planningBase`, because nothing
    // moved the integration branch; now the Integrator advances it after each
    // merge, so a second wave is cut from a branch that already contains the
    // first wave's work — which is what makes a dependent's worktree hold its
    // dependency's code.
    //
    // `planningBase` remains the fallback for a run with no Integrator wired,
    // which is every caller predating this milestone. Passed as-is when it is
    // absent rather than coerced to an empty string: preparation re-validates the
    // base against `CommitOidSchema` before composing an argv, so a worktree-mode
    // run that somehow reached here without one refuses with a sentence saying so
    // instead of handing Git an empty commit-ish.
    const outcome = await workspaces.prepare({
      state,
      taskId,
      attempt,
      base: waveBase ?? state.planningBase,
    });

    if (outcome.ok) {
      if (outcome.workspace.isolation !== undefined) {
        await this.options.store.appendEvent(runId, 'task_workspace_created', {
          task: taskId,
          attempt,
          branch: outcome.workspace.isolation.branch,
          base: outcome.workspace.isolation.base,
        });
      }
      return { kind: 'prepared', workspace: outcome.workspace, attempt };
    }

    // Exactly the four keys Appendix B specifies, and the shape is closed: no
    // absolute path (§7.2, §21.3), and no free-text `detail` either. The sentence
    // a person reads is diagnostic, and diagnostics belong on the internal
    // outcome and in the halt reason — a fifth key here would be a payload the
    // Appendix does not describe, which is how an event contract stops being one.
    await this.options.store.appendEvent(runId, 'task_workspace_preparation_failed', {
      task: taskId,
      attempt,
      phase: outcome.failure.phase,
      changes: outcome.failure.changes,
    });

    // A value rather than a throw, so the wave completes and its siblings still
    // run to their own conclusion (§9.2). Deliberately **not** a `TaskResult`:
    // nothing executed, so there is no runner, no model and no reasoning level to
    // record, and inventing them would put a fiction in the artifact everything
    // downstream reads as evidence of what ran.
    return {
      kind: 'workspace_preparation_failed',
      task: taskId,
      code: 'task_workspace_preparation_failed',
      phase: outcome.failure.phase,
      changes: outcome.failure.changes,
      detail: outcome.failure.detail,
    };
  }

  private async persist(
    runId: string,
    states: Record<string, TaskState>,
    dispatched: readonly string[] = [],
    blockReasons: Readonly<Partial<Record<string, TaskBlockReason>>> = {},
  ): Promise<void> {
    const starting = new Set(dispatched);

    await this.options.store.updateRun(runId, (state) => ({
      ...state,
      tasks: Object.entries(states).map(([id, taskState]) => {
        const entry = state.tasks.find((item) => item.id === id);
        const attempts = entry?.attempts ?? 0;
        return {
          id,
          state: taskState,
          attempts: starting.has(id) ? attempts + 1 : attempts,
          // Carried forward, never recomputed. AR-00 splits the counter (AD-37) and
          // nothing yet increments this one — but a rebuild of the task list that
          // dropped it would silently reset a budget the moment AR-03 starts using it,
          // and the reset would look like an environment that had never faulted.
          infrastructureFailures: entry?.infrastructureFailures ?? 0,
          ...(entry?.failureClass === undefined ? {} : { failureClass: entry.failureClass }),
          ...(entry?.lastFailureAt === undefined ? {} : { lastFailureAt: entry.lastFailureAt }),
          // Provenance travels with the block: a task leaving `blocked` drops
          // its reason, and one that stays blocked keeps or learns its own.
          ...(taskState === 'blocked'
            ? { blockReason: blockReasons[id] ?? entry?.blockReason ?? 'agent' }
            : {}),
        };
      }),
    }));
  }
}
