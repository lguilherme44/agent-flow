import { createHash } from 'node:crypto';
import {
  ReviewResultSchema,
  type Plan,
  type ReviewResult,
  type RunState,
  type TaskState,
} from '../contracts/index.js';
import {
  FORCIBLE_REFUSALS,
  approvalCoversPlan,
  approveRun as recordApproval,
  checkApproval,
  planHash,
  type ApprovalRefusal,
} from './approval.js';
import {
  buildExecutionContext,
  buildPlanningPipeline,
  loadPlan,
  type BuildContextOptions,
  type ExecutionContext,
} from './execution-context.js';
import {
  RunExecutionLock,
  type LockOperation,
  type LockOwner,
  type LockRefusal,
} from './run-execution-lock.js';
import type { SchedulerOutcome } from './scheduler.js';
import { StateStore } from './state-store.js';
import type { Host } from '../ports/index.js';

/**
 * Every state transition a person can ask for, as use cases (UI-27).
 *
 * The reason this file exists is a rule rather than a convenience: the CLI and the
 * local server must be two adapters over one implementation, not two
 * implementations of one workflow. Approving a plan involves a hash, a review
 * verdict, a forcible-refusal policy and a degradation record; if an HTTP handler
 * did any of that itself, the browser and the terminal would be enforcing the gate
 * separately, and the first time they disagreed the disagreement would be silent.
 *
 * So the decisions live here, and both adapters only translate. The CLI turns an
 * outcome into stdout and an exit code; the server turns it into a status code and
 * a JSON body. Neither one decides anything.
 *
 * Three properties this file is responsible for keeping:
 *
 *   **The plan hash is computed, never received.** `approve` takes no hash. It
 *   reads the plan on disk and hashes it, so there is no request shape in which a
 *   caller could name the plan it wants credited with an approval.
 *   **Refusals are structured.** An outcome carries a code, a message and the
 *   suggested next step, because "gate not satisfied" is not something a person
 *   can act on and a stack trace is not something they should see.
 *   **Nothing here writes state directly.** Every mutation goes through
 *   `StateStore.updateRun`, which is where the §22 task machine is enforced.
 */

export type ActionErrorCode =
  | 'no_run'
  | 'no_such_run'
  | 'not_current_run'
  | 'no_plan'
  | 'no_sdd'
  | 'already_approved'
  | 'already_rejected'
  | 'run_completed'
  | 'review_missing'
  | 'review_stale'
  | 'review_unverifiable'
  | 'review_failed'
  | 'approval_required'
  | 'approval_stale'
  | 'no_such_task'
  | 'task_blocked'
  | 'attempts_exhausted'
  | 'unmet_dependencies'
  | 'run_busy'
  | 'invalid_input';

export interface ActionError {
  readonly code: ActionErrorCode;
  /** What happened, in the words a person needs. Never a stack trace. */
  readonly message: string;
  /** What to do about it. Absent only when there is genuinely nothing. */
  readonly action?: string;
  /**
   * True when `--force` (or its deliberate equivalent) could override this.
   *
   * Reported rather than inferred: a caller must not have to keep its own copy of
   * which refusals are forcible, because a copy is a thing that can be wrong.
   */
  readonly forcible?: boolean;
  /** Structured extras a renderer may use. Never a credential, never a path. */
  readonly detail?: Record<string, unknown>;
}

/**
 * Warnings ride on both branches, and that is deliberate (R-16).
 *
 * A degraded run is still approvable, and the person approving should know what
 * was lost *while they still have the choice*. Attaching warnings only to success
 * would drop them exactly when the answer is "no, unless you insist" — which is
 * the moment they matter most.
 */
export type ActionOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: ActionError; readonly warnings: readonly string[] };

function failed(error: ActionError, warnings: readonly string[] = []): ActionOutcome<never> {
  return { ok: false, error, warnings };
}

function done<T>(value: T, warnings: readonly string[] = []): ActionOutcome<T> {
  return { ok: true, value, warnings };
}

/** Everything a use case needs, as ports. Nothing concrete, nothing global. */
export type RunActionDeps = Omit<BuildContextOptions, 'onTaskStart' | 'onTaskFinish'> & {
  /**
   * This process, for the execution lock (AF-L01).
   *
   * A port rather than `process.pid`, because the lock is decided on facts about the
   * operating system and a use case that read them directly could be driven by one
   * caller and tested by none.
   */
  readonly host: Host;
  /**
   * Which entry point is asking. Recorded in the lock and shown to whoever is
   * refused, so "this run is busy" can say *what* is busy with it.
   */
  readonly owner: LockOwner;
};

// ---------------------------------------------------------------------------
// the execution lock
// ---------------------------------------------------------------------------

/**
 * Runs `work` while holding the run's execution lock (AF-L01).
 *
 * The single place acquisition, the audit events and release live, so all three
 * locked use cases get identical behaviour and none of them can forget the `finally`.
 * Release happens on success, on a refusal and on a thrown exception — and *not* on
 * SIGKILL or power loss, which is precisely what stale detection is for.
 *
 * The events are the audit trail: who executed this run, from where, and when. There
 * is no heartbeat, so there is nothing to poll and no polling event to emit.
 *
 * **Every exit from the point the lease exists goes through release (AF-L01.1).** The
 * audit events used to be appended before the `try`, which is a leak with no recovery
 * behind it: a full disk or a permission error on `events.jsonl` would throw out of a
 * function that had already claimed the lock, and the claim left behind names *this*
 * process — which is still alive, so stale detection can never clear it. The run would
 * be refused until the process exited. So the `try` opens on the line after
 * acquisition, and the audit happens inside it.
 *
 * **Order in the `finally` is safety before audit.** The claim is removed first and the
 * event is written second, because a failed append must not be able to leave a lock on
 * disk. The two failures are then treated differently on purpose:
 *
 *   `lease.release()` propagates. It is the one failure that keeps the run refused for
 *   as long as this process lives, and there is no other channel to report it — so it
 *   is allowed to replace whatever `work` was reporting.
 *   The `execution_lock_released` event is best-effort. By that line the claim is
 *   already gone, so a failure costs a line in the audit trail and nothing else, while
 *   throwing from a `finally` would swap a real execution error for a logging one. The
 *   loss is still visible anyway: an `execution_lock_acquired` with nothing closing it.
 */
async function withExecutionLock<T>(
  deps: RunActionDeps,
  store: StateStore,
  runId: string,
  operation: LockOperation,
  work: () => Promise<ActionOutcome<T>>,
): Promise<ActionOutcome<T>> {
  const lock = new RunExecutionLock({
    fs: deps.fs,
    clock: deps.clock,
    host: deps.host,
    projectDir: deps.projectDir,
  });

  const acquired = await lock.acquire({ runId, owner: deps.owner, operation });
  if (!acquired.ok) return failed(busy(acquired.refusal, operation));

  const { lease } = acquired;

  try {
    if (lease.recoveredStale !== undefined) {
      // Recorded explicitly. A lock taken over from a dead process is a recovery, and
      // the alternative — reclaiming it silently — leaves no trace that a previous
      // execution of this run ended without releasing anything.
      await store.appendEvent(runId, 'stale_execution_lock_recovered', {
        pid: lease.recoveredStale.pid,
        owner: lease.recoveredStale.owner,
        operation: lease.recoveredStale.operation,
        createdAt: lease.recoveredStale.createdAt,
      });
    }

    await store.appendEvent(runId, 'execution_lock_acquired', {
      pid: lease.lock.pid,
      owner: lease.lock.owner,
      operation: lease.lock.operation,
    });

    return await work();
  } finally {
    await lease.release();

    try {
      await store.appendEvent(runId, 'execution_lock_released', {
        pid: lease.lock.pid,
        owner: lease.lock.owner,
        operation: lease.lock.operation,
      });
    } catch {
      // Swallowed deliberately, and only here: the claim is already off disk, so the
      // filesystem is in the state it needs to be in. See the note above the function.
    }
  }
}

/**
 * A refusal a person can act on (§95).
 *
 * Names the operation that is in progress and where it is running, because "this run
 * is busy" without those leaves somebody guessing whether they are competing with
 * their own terminal or with something they should not interrupt. The pid is included
 * only when it is a pid on this machine, where it means something.
 */
function busy(refusal: LockRefusal, wanted: LockOperation): ActionError {
  const holder = refusal.holder;

  if (holder === undefined) {
    // Deliberately not "run `rm`" (AF-L01.1-C). A claim that cannot be read is the one
    // case where Agent Flow knows nothing about who holds it, so the first instruction
    // has to be the check, not the delete — and the file named has to be the one the
    // algorithm actually uses. There is no `execution.lock`; there are numbered
    // generations, and only the highest is the holder.
    return {
      code: 'run_busy',
      message: `${refusal.runId} is locked, and the claim on it could not be read.`,
      action:
        'Agent Flow refuses a claim it cannot read rather than guessing, because guessing ' +
        'is how a run gets executed twice. Confirm no Agent Flow process is working on this ' +
        'run — then remove the highest-numbered execution.lock.* file in the run directory.',
    };
  }

  const where = refusal.sameHost
    ? `pid ${String(holder.pid)}`
    : `host ${holder.hostname}, which is not this machine`;

  return {
    code: 'run_busy',
    message:
      `${refusal.runId} is already being ${gerund(holder.operation)} by the ` +
      `${holder.owner} (${where}), since ${holder.createdAt}.`,
    action: refusal.sameHost
      ? 'Wait for the active execution to finish.'
      : 'Agent Flow does not judge a lock from another machine. Stop the execution on that ' +
        'host, or — if that host is gone — remove the highest-numbered execution.lock.* file ' +
        'in the run directory here.',
    detail: {
      wanted,
      holder: {
        owner: holder.owner,
        operation: holder.operation,
        pid: holder.pid,
        hostname: holder.hostname,
        createdAt: holder.createdAt,
      },
      sameHost: refusal.sameHost,
      ...(refusal.holderAlive === undefined ? {} : { holderAlive: refusal.holderAlive }),
    },
  };
}

function gerund(operation: LockOperation): string {
  switch (operation) {
    case 'run':
      return 'executed';
    case 'revise':
      return 're-planned';
    case 'retry':
      return 'modified by a retry';
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
  }
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export interface ApprovalGate {
  readonly runId: string;
  readonly approved: boolean;
  readonly approvedAt?: string;
  readonly canApprove: boolean;
  readonly refusal?: { readonly kind: string; readonly forcible: boolean };
  readonly warnings: readonly string[];
  /**
   * The hash the server computed from the plan on disk, right now.
   *
   * Shown so a person can see what they are approving. Never accepted back: the
   * approve use case recomputes it, so a stale or crafted value has nowhere to go.
   */
  readonly planHash: string;
  readonly taskCount: number;
  /** Digest of the SDD, since neither artifact declares a version. */
  readonly sddDigest?: string;
  readonly review?: {
    readonly verdict: 'PASS' | 'FAIL';
    readonly independence: string;
    readonly planHash?: string;
    readonly coversThisPlan: boolean;
    readonly findings: ReviewResult['findings'];
  };
  readonly degradations: RunState['degradations'];
}

/**
 * The gate as the server sees it (§90).
 *
 * A read, so the modal can show the verdict, the findings and the hash before
 * anybody clicks anything — and so the thing it shows is the same computation the
 * approve action will perform, rather than a second guess at it.
 */
export async function describeApprovalGate(
  deps: RunActionDeps,
  runId: string,
): Promise<ActionOutcome<ApprovalGate>> {
  const context = await buildExecutionContext(deps);
  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  const plan = await loadPlanArtifact(context.store, runId);
  const review = await loadReview(context.store, runId);
  const check = checkApproval(state, plan, review);

  if (plan === null) {
    return failed({
      code: 'no_plan',
      message: `${runId} has no plan yet, so there is nothing to approve.`,
      action: 'Finish planning first.',
    });
  }

  const hash = planHash(plan);
  const sdd = await context.store.readArtifact(runId, 'sdd');

  return done({
    runId,
    approved: state.approved,
    ...(state.approvedAt === undefined ? {} : { approvedAt: state.approvedAt }),
    canApprove: check.allowed,
    ...(check.refusal === undefined
      ? {}
      : {
          refusal: {
            kind: check.refusal.kind,
            forcible: FORCIBLE_REFUSALS.has(check.refusal.kind),
          },
        }),
    warnings: check.warnings,
    planHash: hash,
    taskCount: plan.tasks.length,
    ...(sdd === null ? {} : { sddDigest: digest(sdd) }),
    ...(review === null
      ? {}
      : {
          review: {
            verdict: review.verdict,
            independence: review.independence,
            ...(review.planHash === undefined ? {} : { planHash: review.planHash }),
            // Whether the verdict is about *this* plan. A review of a different
            // document is not a verdict about the one in hand (§17).
            coversThisPlan: review.planHash === hash,
            findings: review.findings,
          },
        }),
    degradations: state.degradations,
  });
}

export interface ApproveResult {
  readonly runId: string;
  readonly planHash: string;
  readonly taskCount: number;
  readonly forced: boolean;
}

/**
 * Opens the gate for the plan currently on disk (§17, §90).
 *
 * Takes no hash, and that is the load-bearing part. Approval is granted to a
 * specific plan, so the identity of that plan has to be established by whoever is
 * granting it — a caller that supplied its own hash could approve a plan nobody
 * read, which is precisely the failure the gate exists to prevent.
 *
 * **Locked, because it reads a plan another operation may be rewriting (AF-L01.2).**
 * The question is not whether approving looks harmful; it is whether there is a moment
 * during `run`, `revise` or `retry` at which approving is *useful*. There is not.
 * `start` reads the gate once, before the first runner is spawned, so an approval that
 * lands afterwards changes no execution — it only records that one was authorised when
 * it was not. And under `revise` it is actively wrong: `replan` clears the approval and
 * then rewrites `plan.json` through the pipeline, so an approval racing it hashes
 * whichever version of the plan happened to be on disk. The plan hash catches the
 * common case — a hash of the old plan no longer covers the new one — but only when
 * nobody passes `--force`, and "safe as long as you do not force it" is safe by
 * accident. So the answer is a refusal rather than a wait: a caller told `run_busy` can
 * look at the plan again, which is the whole point of the gate.
 *
 * `describeApprovalGate` above takes no lock. It is a read, and refusing to *show*
 * somebody the gate because a run is busy would help nobody.
 */
export async function approve(
  deps: RunActionDeps,
  runId: string,
  options: { force?: boolean } = {},
): Promise<ActionOutcome<ApproveResult>> {
  const store = storeFor(deps);
  return withExecutionLock(deps, store, runId, 'approve', () =>
    grantApproval(deps, runId, options),
  );
}

async function grantApproval(
  deps: RunActionDeps,
  runId: string,
  options: { force?: boolean },
): Promise<ActionOutcome<ApproveResult>> {
  const context = await buildExecutionContext(deps);
  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  const plan = await loadPlanArtifact(context.store, runId);
  const review = await loadReview(context.store, runId);
  const check = checkApproval(state, plan, review);

  if (!check.allowed) {
    const refusal = check.refusal;
    const forcible = refusal !== undefined && FORCIBLE_REFUSALS.has(refusal.kind);

    if (!(forcible && options.force === true)) {
      return failed(explainRefusal(refusal, forcible), check.warnings);
    }
  }

  if (plan === null) {
    return failed({
      code: 'no_plan',
      message: 'There is no plan to approve.',
      action: 'Finish planning first.',
    });
  }

  const forced = !check.allowed && options.force === true;
  await recordApproval(context.store, runId, plan, { forced });

  return done(
    { runId, planHash: planHash(plan), taskCount: plan.tasks.length, forced },
    check.warnings,
  );
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

/**
 * Turns down the plan (§17) — and never behind an execution's back (AF-L01.2).
 *
 * A rejection while the scheduler is running is not a race that corrupts a file; it is
 * a sentence that is not true. `reject` writes `plan_rejected` while agents keep
 * spawning against that very plan, and the run then claims its plan was turned down
 * while the work it describes is being done. The only honest orderings are "rejected,
 * therefore not executed" and "executed, and rejected afterwards is too late".
 *
 * So it takes the same lease `start`, `revise` and `retry` take. Not a second mutex and
 * not a `describe()` followed by an update — that is the `exists()`-then-`write()` shape
 * the whole mechanism exists to avoid, and it would leave exactly the window this is
 * closing. Refusing is the answer, rather than waiting: a rejection that queued behind
 * a run would land on a run that had finished, which is the retrospective rejection
 * this exists to prevent.
 */
export async function reject(
  deps: RunActionDeps,
  runId: string,
  reason: string | undefined,
): Promise<ActionOutcome<{ readonly runId: string }>> {
  const store = storeFor(deps);
  return withExecutionLock(deps, store, runId, 'reject', () => rejectPlan(deps, runId, reason));
}

async function rejectPlan(
  deps: RunActionDeps,
  runId: string,
  reason: string | undefined,
): Promise<ActionOutcome<{ readonly runId: string }>> {
  const context = await buildExecutionContext(deps);
  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  // Two refusals the CLI did not have, and both are about not writing nonsense
  // into the state file. `updateRun` guards *task* transitions; nothing guarded
  // the run's own status, so rejecting a finished run used to succeed and record
  // that its plan had been turned down.
  if (state.status === 'plan_rejected') {
    return failed({
      code: 'already_rejected',
      message: `${runId} was already rejected.`,
    });
  }

  if (state.status === 'completed') {
    return failed({
      code: 'run_completed',
      message: `${runId} has already completed. Its plan cannot be rejected after the fact.`,
      action: 'Start a new run if the work needs revisiting.',
    });
  }

  await context.store.updateRun(runId, (current) => ({ ...current, status: 'plan_rejected' }));
  await context.store.appendEvent(runId, 'run_rejected', {
    reason: reason ?? '(no reason given)',
  });

  return done({ runId });
}

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

export interface RetryResult {
  readonly runId: string;
  readonly taskId: string;
  readonly attempts: number;
  readonly forced: boolean;
}

/**
 * Puts a finished-badly task back in the queue (§23).
 *
 * Explicit and bounded. The scheduler never retries on its own, because an
 * automatic loop would keep paying for the same failure — so this is the only way
 * a task gets another attempt, and both refusals below are deliberate friction.
 */
export async function retryTask(
  deps: RunActionDeps,
  runId: string,
  taskId: string,
  options: { force?: boolean } = {},
): Promise<ActionOutcome<RetryResult>> {
  // Locked too, and briefly. Requeuing a task while the scheduler is executing it
  // would have the two fighting over the same entry in `state.json` — the retry
  // setting it back to `queued` under an executor that is mid-flight.
  const store = storeFor(deps);
  return withExecutionLock(deps, store, runId, 'retry', () =>
    requeue(deps, runId, taskId, options),
  );
}

async function requeue(
  deps: RunActionDeps,
  runId: string,
  taskId: string,
  options: { force?: boolean },
): Promise<ActionOutcome<RetryResult>> {
  const context = await buildExecutionContext(deps);
  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  const entry = state.tasks.find((task) => task.id === taskId);
  if (entry === undefined) {
    return failed({
      code: 'no_such_task',
      message: `${taskId} has not run in ${runId}.`,
      action: 'Only a task that has already been attempted can be retried.',
    });
  }

  if (entry.state === 'blocked' && options.force !== true) {
    return failed({
      code: 'task_blocked',
      message:
        `${taskId} is BLOCKED: it stopped because of something the SDD does not answer. ` +
        'Retrying will not supply that answer, or it will produce a guess.',
      action: 'Fix the SDD or the plan — or force the retry deliberately.',
      forcible: true,
    });
  }

  const maxAttempts = context.config.global.retry.maxAttempts;
  if (entry.attempts >= maxAttempts && options.force !== true) {
    return failed({
      code: 'attempts_exhausted',
      message:
        `${taskId} has already been attempted ${String(entry.attempts)} times ` +
        `(limit ${String(maxAttempts)}).`,
      action: 'Force the retry to try again beyond the limit.',
      forcible: true,
      detail: { attempts: entry.attempts, maxAttempts },
    });
  }

  await context.store.updateRun(runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === taskId ? { ...task, state: 'queued' as const } : task,
    ),
  }));
  await context.store.appendEvent(runId, 'task_requeued', {
    task: taskId,
    forced: options.force === true,
  });

  return done({ runId, taskId, attempts: entry.attempts, forced: options.force === true });
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export interface StartResult {
  readonly runId: string;
  readonly outcome: SchedulerOutcome;
  readonly taskCount: number;
}

export interface StartOptions {
  readonly taskId?: string;
  readonly onTaskStart?: (taskId: string) => void;
  readonly onTaskFinish?: BuildContextOptions['onTaskFinish'];
}

/**
 * Executes the approved plan (§18) — the long one.
 *
 * Long enough that the two adapters treat it differently: the CLI awaits it, and
 * the server runs it as a background job and answers immediately. That difference
 * is entirely in the adapters. This function is the same code either way, which is
 * the whole point — "the UI may only start execution through the same logic
 * `agent-flow run` uses" is a property of *this* being the only implementation.
 *
 * Every gate is checked before a single runner is spawned, and the second one is
 * the one that matters: approval applies to a specific plan, so a plan changed
 * after approval has not been through the gate and running it would execute work
 * no human read.
 */
export async function start(
  deps: RunActionDeps,
  runId: string,
  options: StartOptions = {},
): Promise<ActionOutcome<StartResult>> {
  const store = storeFor(deps);
  return withExecutionLock(deps, store, runId, 'run', () => execute(deps, runId, options));
}

async function execute(
  deps: RunActionDeps,
  runId: string,
  options: StartOptions,
): Promise<ActionOutcome<StartResult>> {
  const context = await buildExecutionContext({
    ...deps,
    ...(options.onTaskStart === undefined ? {} : { onTaskStart: options.onTaskStart }),
    ...(options.onTaskFinish === undefined ? {} : { onTaskFinish: options.onTaskFinish }),
  });

  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  // A turned-down plan is not executable (AF-L01.2). Mutual exclusion gives the two
  // operations an order; this is what makes the order *mean* something. Without it,
  // "rejected, therefore not executed" held only by luck: `reject` writes `status` and
  // nothing else, so a run approved before it was rejected still satisfied every gate
  // below and ran the plan a person had explicitly refused. Checked here rather than
  // left to the approval gate, because it must hold even where
  // `approval.requiredBeforeImplementation` is off — that switch turns off the review
  // ceremony, not a person's "no".
  if (state.status === 'plan_rejected') {
    return failed({
      code: 'already_rejected',
      message: `The plan for ${runId} was rejected, so it will not be executed.`,
      action: 'Revise the plan and approve the result, or start a new run.',
    });
  }

  const current = await requireCurrent(context, runId);
  if (current !== undefined) return failed(current);

  const plan = await loadPlanArtifact(context.store, runId);
  if (plan === null) {
    return failed({
      code: 'no_plan',
      message: `${runId} has no plan yet.`,
      action: 'Finish planning before starting implementation.',
    });
  }

  if (context.config.global.approval.requiredBeforeImplementation) {
    if (!state.approved) {
      return failed({
        code: 'approval_required',
        message: `The plan for ${runId} has not been approved.`,
        action: 'Review and approve the current plan before starting.',
      });
    }

    if (!approvalCoversPlan(state, plan)) {
      return failed({
        code: 'approval_stale',
        message:
          'The plan changed after it was approved. Approval applies to a specific plan, ' +
          'not to the run.',
        action: 'Read the current plan and approve it again.',
        detail: { approvedPlanHash: state.approvedPlanHash, currentPlanHash: planHash(plan) },
      });
    }
  }

  const sdd = await context.store.readArtifact(runId, 'sdd');
  if (sdd === null) {
    return failed({
      code: 'no_sdd',
      message: `${runId} has no SDD, which the implementation agent requires.`,
      action: 'Re-run the SDD stage before starting implementation.',
    });
  }

  // Resumed from what was persisted, so work already completed is not paid for
  // twice — a killed terminal, or a closed browser tab, is a normal event.
  const previous = Object.fromEntries(
    state.tasks.map((task) => [task.id, task.state as TaskState]),
  );

  const target =
    options.taskId === undefined
      ? undefined
      : plan.tasks.find((task) => task.id === options.taskId);

  if (options.taskId !== undefined && target === undefined) {
    return failed({
      code: 'no_such_task',
      message: `No task ${options.taskId} in the plan for ${runId}.`,
    });
  }

  if (target !== undefined) {
    // Refused up front so the message names the missing work, rather than letting
    // the scheduler quietly find nothing to do.
    const unmet = target.dependencies.filter((dep) => previous[dep] !== 'completed');
    if (unmet.length > 0) {
      return failed({
        code: 'unmet_dependencies',
        message: `${target.id} depends on ${unmet.join(', ')}, which has not completed.`,
        action: 'Run the plan in order, or run the dependencies first.',
        detail: { unmet },
      });
    }
  }

  // A run that was asked for parallelism it did not get has to be able to say so
  // afterwards (M2-00.3). Recorded here rather than where the number is resolved,
  // because `buildExecutionContext` is also assembled by every read — the approval
  // gate, `review`, `status` — and a degradation written by a read would appear on
  // runs that never executed anything.
  //
  // `recordDegradation` deduplicates by kind and reason, so resuming a run does not
  // stack up copies of the same sentence.
  if (context.concurrency.clamped) {
    await context.store.recordDegradation(runId, {
      kind: 'parallelism_clamped',
      reason: context.concurrency.reason ?? 'the configured task limit could not be honoured',
      impact:
        `implementation ran ${String(context.concurrency.effective)} task at a time ` +
        `rather than ${String(context.concurrency.requested)}`,
    });
  }

  const outcome = await context.scheduler.run(plan, runId, sdd, previous, {
    ...(target === undefined ? {} : { only: new Set([target.id]) }),
  });

  // Only a complete plan may advance the stage. `complete` describes the
  // invocation; `planComplete` describes the run, and this is the run's record.
  if (outcome.planComplete) {
    await context.store.updateRun(runId, (entry) => ({ ...entry, stage: 'implementation' }));
  }

  return done({
    runId,
    outcome,
    taskCount: target === undefined ? plan.tasks.length : 1,
  });
}

// ---------------------------------------------------------------------------
// revise
// ---------------------------------------------------------------------------

export interface ReviseResult {
  readonly runId: string;
  readonly taskCount: number;
  readonly reviewVerdict?: 'PASS' | 'FAIL';
  readonly approvalCleared: boolean;
}

/**
 * Re-plans with an extra instruction (§91) — the other long one.
 *
 * Invalidates any approval first, and that ordering is not cosmetic: the gate is
 * granted to a specific plan, so a plan produced after approval has not been
 * through it. Leaving the flag set for even the duration of the re-plan would give
 * a window in which unreviewed work could execute.
 *
 * The new plan comes out of the existing planning pipeline, writing the same
 * artifacts through the same StateStore. Nothing here edits `plan.json`.
 */
export async function revise(
  deps: RunActionDeps,
  runId: string,
  instruction: string,
): Promise<ActionOutcome<ReviseResult>> {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) {
    return failed({
      code: 'invalid_input',
      message: 'A revision needs an instruction saying what should change.',
    });
  }

  const store = storeFor(deps);
  return withExecutionLock(deps, store, runId, 'revise', () => replan(deps, runId, trimmed));
}

async function replan(
  deps: RunActionDeps,
  runId: string,
  trimmed: string,
): Promise<ActionOutcome<ReviseResult>> {
  const context = await buildExecutionContext(deps);
  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  const notCurrent = await requireCurrent(context, runId);
  if (notCurrent !== undefined) return failed(notCurrent);

  let approvalCleared = false;
  if (state.approved) {
    await context.store.updateRun(runId, (entry) => ({
      ...entry,
      approved: false,
      approvedPlanHash: undefined,
      approvedAt: undefined,
      status: 'running',
    }));
    await context.store.appendEvent(runId, 'approval_invalidated', { reason: 'revise' });
    approvalCleared = true;
  }

  await context.store.appendEvent(runId, 'revision_requested', { instruction: trimmed });

  const request = (await context.store.readArtifact(runId, 'request')) ?? state.feature;
  const pipeline = buildPlanningPipeline(context);

  const result = await pipeline.run(
    runId,
    `${request.trim()}\n\n---\n\nRevision requested by the reviewer:\n${trimmed}`,
    { from: 'planning' },
  );

  return done({
    runId,
    taskCount: result.plan.tasks.length,
    ...(result.review === undefined ? {} : { reviewVerdict: result.review.verdict }),
    approvalCleared,
  });
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function noSuchRun(runId: string): ActionError {
  return {
    code: 'no_such_run',
    message: `There is no run ${runId} in this project.`,
  };
}

/**
 * Refuses to act on a run that is not the one in flight.
 *
 * The CLI has always operated on `.agent-flow/current-run`, and the write API can
 * name any run the dashboard can show. Executing or re-planning an older run would
 * write into a directory the rest of the tool has moved on from — and the person
 * clicking would have no way to tell that had happened.
 */
async function requireCurrent(
  context: ExecutionContext,
  runId: string,
): Promise<ActionError | undefined> {
  const current = await context.store.currentRunId();
  if (current === runId) return undefined;

  return {
    code: 'not_current_run',
    message:
      current === null
        ? `${runId} is not the active run, and this project has none.`
        : `${runId} is not the active run — ${current} is.`,
    action: 'Only the active run can be started or re-planned.',
    ...(current === null ? {} : { detail: { currentRunId: current } }),
  };
}

/**
 * A StateStore from the ports alone.
 *
 * The lock helper needs one before `buildExecutionContext` runs, because it appends
 * its audit events around work that may never get as far as assembling a context —
 * a refused acquisition does not, and neither does a config that will not load.
 */
function storeFor(deps: RunActionDeps): StateStore {
  return new StateStore({ fs: deps.fs, clock: deps.clock, projectDir: deps.projectDir });
}

async function loadRun(store: StateStore, runId: string): Promise<RunState | null> {
  try {
    return await store.loadRun(runId);
  } catch {
    return null;
  }
}

async function loadPlanArtifact(store: StateStore, runId: string): Promise<Plan | null> {
  try {
    return await loadPlan(store, runId);
  } catch {
    // A plan that will not parse is not a plan to approve. Treated as absent so
    // the refusal names the plan rather than surfacing a Zod error to a browser.
    return null;
  }
}

async function loadReview(store: StateStore, runId: string): Promise<ReviewResult | null> {
  const raw = await store.readArtifact(runId, 'planReview');
  if (raw === null) return null;

  try {
    return ReviewResultSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Short digest of an artifact's bytes. Neither the SDD nor the plan has a version. */
function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** The refusal, phrased for whoever is about to be told no. */
function explainRefusal(
  refusal: ApprovalRefusal | undefined,
  forcible: boolean,
): ActionError {
  const base = { forcible };

  switch (refusal?.kind) {
    case 'no_run':
      return { ...base, code: 'no_run', message: 'There is no active run.' };
    case 'no_plan':
      return {
        ...base,
        code: 'no_plan',
        message: 'This run has no plan yet.',
        action: 'Finish planning first.',
      };
    case 'review_missing':
      return {
        ...base,
        code: 'review_missing',
        message: 'This plan has not been reviewed.',
        action: 'Run the review, or approve deliberately over it.',
      };
    case 'review_stale':
      return {
        ...base,
        code: 'review_stale',
        message:
          'The plan review on file judged a different version of this plan. A verdict ' +
          'about another document is not a verdict about this one.',
        action: 'Request a revision, or approve deliberately — which is recorded on the run.',
      };
    case 'review_unverifiable':
      return {
        ...base,
        code: 'review_unverifiable',
        message:
          'The plan review on file does not say which plan it judged, so nothing ' +
          'connects it to the plan in hand.',
        action: 'Request a revision, or approve deliberately — which is recorded on the run.',
      };
    case 'review_failed':
      return {
        ...base,
        code: 'review_failed',
        message: `The plan review returned FAIL with ${String(
          refusal.review.findings.length,
        )} finding(s).`,
        action: 'Request a revision addressing them, or approve over the verdict deliberately.',
        detail: { findings: refusal.review.findings },
      };
    case 'already_approved':
      return { ...base, code: 'already_approved', message: 'This run is already approved.' };
    case 'plan_rejected':
      return {
        ...base,
        code: 'already_rejected',
        message:
          'This plan was rejected. Approving it now would leave the run recording both, ' +
          'and nothing would execute either way.',
        action:
          'Revise the plan and approve the result — or approve over the rejection ' +
          'deliberately, which is recorded on the run.',
      };
    default:
      return {
        ...base,
        code: 'no_run',
        message: 'Approval is not possible in the current state.',
      };
  }
}

/** Re-exported so an adapter can render a plan hash without recomputing one. */
export { planHash };
