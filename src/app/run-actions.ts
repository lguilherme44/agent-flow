import { clearAutonomy } from './autonomy-budget.js';
import { createHash } from 'node:crypto';
import {
  ReviewResultSchema,
  type Plan,
  type CorrectiveOriginStage,
  type ReviewResult,
  type RunState,
  type TaskState,
} from '../contracts/index.js';
import type { TaskBlockReason } from '../contracts/state.schema.js';
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
import { watchLifecycle } from './run-lifecycle.js';
import type { Host } from '../ports/index.js';
import {
  checkWorktreePreconditions,
  observePlanningBaseDrift,
  worktreeRefusalAction,
  type PlanningBaseMoment,
  type WorktreeRefusalCode,
} from './run-git-identity.js';
import type { IntegrationRefusalCode } from './integrator.js';
import { GitClient, renderChanges } from '../adapters/git/git-client.js';
import {
  failureDetail,
  runVerification,
  summariseVerification,
  VERIFICATION_ORDER,
  type VerificationOutcome,
} from './verification-commands.js';
import { prepareWorkspace } from './workspace-preparation.js';
import {
  FINAL_REVIEW_STAGE,
  ReviewResponseSchema,
  VERIFICATION_STAGE,
  authorsOf,
  buildReview,
} from './stages/final-review.js';
import { runCorrectiveRound, type CorrectiveRound } from './corrective-round.js';
import { ReviewStore } from './review-store.js';
import { CollaborationStore } from './collaboration-store.js';
import { projectFindings } from '../core/review/findings.js';
import { correctiveSelection } from '../core/review/corrective.js';
import { assessIndependence, explainIndependence } from '../core/independence.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import { extractRequirementIds } from '../core/sdd-validator.js';
import { isResumable } from '../core/run-projection.js';
import {
  checkDefinitionOfDone,
  type DoneCheck,
  type MechanicalVerification,
} from '../core/definition-of-done.js';
import { getCeremonyBudget } from '../core/adaptive-workflow.js';

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
  // MVP 2 §16. Two states a retry must not touch, and neither was named before
  // M2-07 gave them meaning: `completed` is terminal — in worktree mode it means
  // *integrated* (I-3) — and `running` is what a dead process leaves, which
  // recovery may still be able to finish from durable evidence (§17.3). Both used
  // to reach `StateStore` and come back as a raw illegal-transition error, which
  // is a stack trace where a person needed a sentence.
  | 'task_completed'
  | 'task_in_flight'
  | 'unmet_dependencies'
  | 'run_busy'
  /**
   * The run has no task that could start (C-19).
   *
   * Distinct from `run_busy`, which means "wait", and from the gate codes, which mean
   * "fix something": this one means the run is at a gate a *person* clears, and it is
   * refused before the execution lease is taken.
   */
  | 'nothing_to_run'
  /**
   * An operator asked this run to stop, and it has not been resumed (PRI-15).
   *
   * Distinct from `nothing_to_run`, which means the run is at a gate: this one means the
   * run has work and a person said not yet. It names `resume` rather than offering a
   * force, because overriding a pause is what `resume` *is*.
   */
  | 'run_paused'
  /** Terminal by an operator's decision (PRI-14). Nothing reopens it; a new run does. */
  | 'run_cancelled'
  /** `resume` on a run nobody paused. Starting it is a different command. */
  | 'not_paused'
  | 'invalid_input'
  | 'ceremony_budget_exceeded'
  // MVP 2 §6.3. Every one of these names a repository state a user changes with
  // one command, and none of them is forcible: there is no `--force` for a moved
  // planning base or a dirty tree, and adding one would be adding a flag whose
  // only function is to produce an unexplainable tree.
  | WorktreeRefusalCode
  // MVP 2 §14, §15. A run whose integration branch cannot be read or merged into
  // stops, and it stops with the code that names what is wrong rather than with a
  // generic "gate not satisfied" — which is the difference between a person
  // knowing their branch was rewound and a person re-running the command.
  | IntegrationRefusalCode;

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
/**
 * The execution lease, for the two commands that need to *read* it without taking it.
 *
 * `pause` and `cancel` both have to work while another process holds the lease — that is
 * what makes them the commands they are. Asking who holds it is how they tell "the run
 * will observe this shortly" apart from "nothing is running, so this took effect now",
 * and the difference is the sentence an operator reads.
 */
/**
 * "(pid 1234 on some-host)", or nothing when the claim could not be read.
 *
 * `LockRefusal.holder` is optional because a claim can be observed after creation and
 * before its contents are written — a known diagnosis gap. The mutual exclusion is
 * unaffected either way, so this reports what it has rather than asserting a pid it does
 * not.
 */
function describeHolder(held: LockRefusal | undefined): string {
  if (held?.holder === undefined) return '';
  return ` (pid ${String(held.holder.pid)} on ${held.holder.hostname})`;
}

function lockFor(deps: RunActionDeps, _runId: string): RunExecutionLock {
  return new RunExecutionLock({
    fs: deps.fs,
    clock: deps.clock,
    host: deps.host,
    projectDir: deps.projectDir,
  });
}

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
    case 'review':
      return 'reviewed';
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
    readonly adjudications?: ReviewResult['adjudications'];
    readonly residualRisks?: readonly string[];
    readonly integrationHead?: string;
    /**
     * Whether the verdict still describes the integrated code (M6, I-41).
     *
     * Listed here as well as on the view because this type is *reconstructed* by the
     * server rather than spread wholesale, and a type that enumerates what it keeps
     * silently drops every field added after it.
     */
    readonly freshness: 'current' | 'stale' | 'unverifiable';
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
            adjudications: review.adjudications,
            residualRisks: review.residualRisks,
            // The commit the reviewer read the code against (§19.2). Absent for
            // legacy reviews written before this field existed.
            ...(review.integrationHead === undefined
              ? {}
              : { integrationHead: review.integrationHead }),
            // I-41, decided here because only this side knows both halves. Identity, not
            // a timestamp: a review written after a change can still have read what came
            // before it.
            freshness: reviewFreshness(review.integrationHead, state.integrationHead),
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

/**
 * §6.2 at one of its four moments: enforce for an isolated run, observe for a
 * sequential one, ask nothing of a legacy one.
 *
 * One function for both halves, because they are two outcomes of the *same*
 * question and splitting them is how a caller ends up enforcing at approve and
 * observing at start. Keyed on `state.isolationMode` and never on
 * `config.global.git.useWorktrees` (I-13): a run created sequential stays
 * sequential when the flag is switched on afterwards, and a run created isolated
 * stays isolated when it is switched off.
 *
 * The sequential half is §6.2's stated deviation. Enforcing the gates
 * unconditionally would refuse every existing user who plans a feature on a
 * dirty working tree — which sequential mode has always allowed and which is the
 * normal way people work — so the checks still run and their result is recorded.
 * The information exists without the refusal.
 *
 * **This writes no run state.** It appends to the audit trail and returns; a
 * refusal reports that the repository is not ready and does not reclassify the
 * run (§6.4).
 */
async function planningBaseGate(
  context: Awaited<ReturnType<typeof buildExecutionContext>>,
  state: RunState,
  moment: PlanningBaseMoment,
): Promise<ActionError | undefined> {
  const repository = {
    workspaces: context.workspaces,
    fs: context.fs,
    host: context.host,
    projectDir: context.projectDir,
  };

  if (state.isolationMode !== 'worktree') {
    const observation = await observePlanningBaseDrift(repository, state);
    if (observation !== null) {
      await context.store.appendEvent(state.runId, 'planning_base_observation', {
        moment,
        ...observation,
      });
    }
    return undefined;
  }

  const preconditions = await checkWorktreePreconditions(repository, state);
  if (preconditions.satisfied) return undefined;

  await context.store.appendEvent(state.runId, 'worktree_mode_refused', {
    moment,
    code: preconditions.code,
    detail: preconditions.detail,
  });

  return {
    code: preconditions.code,
    message: `${state.runId} is an isolated run and this repository is not ready: ${preconditions.detail}.`,
    action: worktreeRefusalAction(preconditions.code),
  };
}

async function grantApproval(
  deps: RunActionDeps,
  runId: string,
  options: { force?: boolean },
): Promise<ActionOutcome<ApproveResult>> {
  const context = await buildExecutionContext(deps);
  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  // §6.2 moment three. The gate binds a human decision to a plan, and a plan
  // written against a tree that has since moved is a decision about something
  // else. Here rather than in `describeApprovalGate`, which is a read: showing
  // somebody the gate must not append to the audit trail.
  const notReady = await planningBaseGate(context, state, 'approve');
  if (notReady !== undefined) return failed(notReady);

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

  // A human acted, so the unattended streak is over (C-22, AR §6.2). Rounds already spent
  // stay spent; the count of calls made *with no intervening human action* is by definition
  // broken by this one.
  await clearAutonomy(context.store, runId);

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
  // A human acted, so the unattended streak is over (C-22, AR §6.2). Rounds already spent
  // stay spent; the count of calls made *with no intervening human action* is by definition
  // broken by this one.
  await clearAutonomy(context.store, runId);

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

  // §16: a retry is a *new* attempt on a new branch in a new worktree. Two states
  // cannot receive one, and both refuse before anything is written.
  //
  // **`completed` is terminal, and in worktree mode it means integrated** (I-3).
  // A second attempt over work that is already on the integration branch would
  // produce a marker for a task the branch has, and `--force` deliberately does
  // not open it: this is not a gate a person is entitled to overrule, it is a
  // contradiction.
  if (entry.state === 'completed') {
    return failed({
      code: 'task_completed',
      message:
        `${taskId} is already completed${
          state.isolationMode === 'worktree' ? ', which in worktree mode means integrated' : ''
        }.`,
      action:
        'Retrying finished work would build a second attempt for something the run already ' +
        'has. Revise the plan and start a new run if the work needs to change.',
    });
  }

  // **`running` is what a killed process leaves behind, and it is recovery's.**
  // The attempt may have left a validated tree, a receipt and a marker — even a
  // merge — and requeuing would throw all of it away and pay for the agent again
  // (§17.3 windows 3–7). `agent-flow run` reconciles it first and requeues only
  // what has no durable evidence.
  if (entry.state === 'running') {
    return failed({
      code: 'task_in_flight',
      message:
        `${taskId} is marked running, so either it is executing now or a process died holding it.`,
      action:
        'Run `agent-flow run`: it reconciles what the interrupted attempt actually left before ' +
        'requeuing anything, so a validated attempt is finished rather than repeated.',
    });
  }

  if (entry.state === 'blocked' && entry.blockReason !== 'dependency' && options.force !== true) {
    return failed({
      code: 'task_blocked',
      message:
        `${taskId} is BLOCKED: its agent answered BLOCKED, so it stopped because of ` +
        'something the SDD does not answer.',
      action: 'Fix the SDD or the plan — or force the retry deliberately.',
      forcible: true,
    });
  }

  // A *dependency*-derived block took no answer (§20): the task never ran, so
  // there is nothing §23 protects. It retries without force, and the scheduler
  // also releases it on the next `run` the moment its dependency completes.
  // **No attempt budget is checked here, and that is the fix rather than the omission.**
  //
  // `retry.maxAttempts` bounds attempts made with nobody watching. This function is
  // reached from exactly two places — `agent-flow retry` and the dashboard's Retry
  // button — so reaching it *is* somebody watching, and the budget has nothing to say
  // about it. `app/autonomy-budget.ts` already states the principle for the run-level
  // counters: "a call a person asked for is not autonomous and must not count against a
  // budget that exists to bound unattended work."
  //
  // It was applied to those counters and not to this one, which was free until AR-03
  // turned `recovery.enabled` on by default. After that the repair loop spent the whole
  // budget before anybody was asked, so every ordinary failure arrived here exhausted:
  // the dashboard's Retry button refused every press, and the CLI answered
  // `attempts_exhausted` and offered `--force`. The machine stopped to ask for a human
  // action and then refused the action it asked for.
  //
  // What stays bounded is the machine. `attemptsBeforeHumanRetry` below restarts the
  // unattended streak, so the recovery loop gets one fresh budget per intervention and
  // no more — every continuation past the bound costs a deliberate human act.

  await context.store.updateRun(runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            state: 'queued' as const,
            blockReason: undefined,
            // A person acted, so the unattended streak restarts here. `attempts` is left
            // alone: it is evidence, and evidence that moves is not evidence.
            attemptsBeforeHumanRetry: task.attempts,
          }
        : task,
    ),
  }));
  await context.store.appendEvent(runId, 'task_requeued', {
    task: taskId,
    forced: options.force === true,
  });

  // A human acted, so the unattended streak is over (C-22, AR §6.2). Rounds already spent
  // stay spent; the count of calls made *with no intervening human action* is by definition
  // broken by this one.
  await clearAutonomy(context.store, runId);

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

  // **Refused before the lock, not inside it** (C-19).
  //
  // Every gate in `execute` lives under the lease, so a run with nothing to do still cost
  // a full acquire/refuse/release cycle and wrote two events describing work that never
  // happened — the evidence run did it three times. Whether a run has anything runnable is
  // answerable from persisted state alone, so it is answered here.
  //
  // Deliberately only this question. A run with no plan, an unapproved plan or a moved
  // planning base has its own gate below with a better sentence, and asking any of them
  // twice is how the two answers start to disagree.
  const notRunnable = await refuseUnrunnable(store, runId);
  if (notRunnable !== undefined) return failed(notRunnable);

  return withExecutionLock(deps, store, runId, 'run', () => execute(deps, runId, options));
}

/**
 * Is there anything for `run` to do? (C-19, I-26)
 *
 * Derived through the same pure projection the CLI and the HTTP API read, so "Resume is
 * offered" and "resuming is allowed" cannot disagree — they are one function.
 *
 * Silent when it cannot tell. A missing run, an unreadable plan or a state this projection
 * has no opinion on all fall through to the gates inside, which are the ones that own
 * those questions.
 */
async function refuseUnrunnable(
  store: StateStore,
  runId: string,
): Promise<ActionError | undefined> {
  const state = await loadRun(store, runId);
  if (state === null) return undefined;

  // Statuses that already have a gate of their own inside, with a better sentence than
  // "nothing to run": a rejected plan says it was rejected and how to revise it, and one
  // waiting for approval says which gate is open. Answering either here would replace a
  // specific message with a general one — and put the same judgement in two places.
  if (state.status === 'plan_rejected' || state.status === 'waiting_for_approval') {
    return undefined;
  }

  // Both entry points, or neither (PRI-15). The request is on disk, so `agent-flow run`
  // typed after a pause has to meet it here — in the use case the CLI and the HTTP API
  // both call — rather than in one of them. A pause only the dashboard honoured would be
  // a pause the terminal silently overrode.
  //
  // Ahead of `isResumable` below, which also answers `false` for a paused run: it would
  // report "nothing to run", which is true of the projection and useless to a person
  // holding the one command that fixes it.
  if (state.pauseRequestedAt !== undefined) {
    return {
      code: 'run_paused',
      message: `${runId} was paused at ${state.pauseRequestedAt}.`,
      action: 'Resume it with `agent-flow resume`.',
      forcible: false,
    };
  }

  if (state.status === 'cancelled') {
    return {
      code: 'run_cancelled',
      message: `${runId} was cancelled${
        state.cancelledAt === undefined ? '' : ` at ${state.cancelledAt}`
      }, and a cancelled run is terminal.`,
      action:
        'Its evidence, its integration branch and its worktrees are all still on disk. ' +
        'Start a new run with `agent-flow feature`.',
      forcible: false,
    };
  }

  const plan = await loadPlanArtifact(store, runId);
  const nodes = plan?.tasks.map((task) => ({
    id: task.id,
    dependencies: task.dependencies,
  }));

  if (isResumable({ state, ...(nodes === undefined ? {} : { nodes }) })) return undefined;

  // The gate, named. "Nothing to run" without saying what is holding it is the sentence
  // AR §3.6 calls a contract violation.
  const waiting = state.tasks.filter((task) => task.state === 'review_required');
  const blocked = state.tasks.filter((task) => task.state === 'blocked');

  return {
    code: 'nothing_to_run',
    message:
      state.status === 'completed' || state.status === 'failed'
        ? `${runId} has finished (${state.status}), so there is nothing to run.`
        : waiting.length > 0
          ? `${runId} has no runnable task: ${waiting.map((task) => task.id).join(', ')} ` +
            `${waiting.length === 1 ? 'is' : 'are'} at review_required.`
          : blocked.length > 0
            ? `${runId} has no runnable task: ${blocked.map((task) => task.id).join(', ')} ` +
              `${blocked.length === 1 ? 'is' : 'are'} blocked.`
            : `${runId} has no runnable task in its current state (${state.status}).`,
    action:
      waiting.length > 0
        ? `Review the task's evidence, then \`agent-flow retry ${waiting[0]?.id ?? ''}\`.`
        : blocked.length > 0
          ? 'Answer what the blocked task reported, then retry it.'
          : 'Start a new run, or check `agent-flow status` for what this one is waiting on.',
  };
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

  // Implementation start. In worktree mode this is where the integration branch
  // would be cut from `planningBase`, so a moved HEAD or a dirty tree has to
  // stop the run rather than be built on. Checked on every entry, including a
  // resume.
  const notReady = await planningBaseGate(context, state, 'implementation start');
  if (notReady !== undefined) return failed(notReady);

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

  const workflow = state.workflow ?? 'standard';
  const sddRequired = workflow === 'standard' || workflow === 'high-risk';

  const sdd = await context.store.readArtifact(runId, 'sdd');
  if (sddRequired && sdd === null) {
    return failed({
      code: 'no_sdd',
      message: `${runId} has no SDD, which the ${workflow.toUpperCase()} workflow requires.`,
      action: 'Re-run the SDD stage before starting implementation.',
    });
  }

  const requestContent = (await context.store.readArtifact(runId, 'request')) ?? state.feature;
  const effectiveSdd =
    sdd ??
    `# Feature Request & Scope (${workflow.toUpperCase()} Workflow)\n\n${requestContent}\n\n*Note: This ${workflow} workflow operates without a separate SDD. The approved Plan and its acceptance criteria define the specification.*`;

  // Resumed from what was persisted, so work already completed is not paid for
  // twice — a killed terminal, or a closed browser tab, is a normal event.
  const previous = Object.fromEntries(
    state.tasks.map((task) => [task.id, task.state as TaskState]),
  );

  // Why each persisted task sits where it sits (§20, §23). A `blocked` task on
  // disk records whether its own agent answered BLOCKED or an upstream failure
  // held it back; passing it through keeps the scheduler's release rule honest
  // across a resume.
  const previousBlockReasons: Readonly<Partial<Record<string, TaskBlockReason>>> =
    Object.fromEntries(
      state.tasks
        .filter((task) => task.blockReason !== undefined)
        .map((task) => [task.id, task.blockReason as TaskBlockReason]),
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
  // **Resolved from this run's own mode** (M2-11, I-13), which is the same call the
  // scheduler is about to make and the same one the read model publishes. An
  // isolated run asking for four now gets four and records nothing, because nothing
  // was reduced; a sequential run asking for four still gets one, and still says so.
  //
  // `recordDegradation` deduplicates by kind and reason, so resuming a run does not
  // stack up copies of the same sentence.
  const concurrency = context.concurrencyFor(state.isolationMode);
  if (concurrency.clamped) {
    await context.store.recordDegradation(runId, {
      kind: 'parallelism_clamped',
      reason: concurrency.reason ?? 'the configured task limit could not be honoured',
      impact:
        `implementation ran ${String(concurrency.effective)} task at a time ` +
        `rather than ${String(concurrency.requested)}`,
    });
  }

  // **The operator and the run are not the same process** (PRI-14, PRI-15).
  //
  // `agent-flow pause` is typed in another terminal; the dashboard's Cancel is clicked in
  // a browser. Neither can abort a controller that lives in this process, so the intent
  // goes on disk and this — the one participant that can act on it — watches for it.
  //
  // Stopped in `finally`, so a run that ends on its own does not leave a poll behind.
  const lifecycle = watchLifecycle({ store: context.store, runId });

  let outcome: SchedulerOutcome;
  try {
    outcome = await context.scheduler.run(
      plan,
      runId,
      effectiveSdd,
      previous,
      {
        ...(target === undefined ? {} : { only: new Set([target.id]) }),
        signal: lifecycle.signal,
        terminateSignal: lifecycle.terminateSignal,
      },
      previousBlockReasons,
    );
  } finally {
    lifecycle.stop();
  }

  // The scheduler stopped at its boundary because a signal aborted; it does not know
  // which of the two it was, and it should not — its job is to stop, not to interpret why.
  // The watcher does know, and reporting a cancelled run as "paused" would be the kind of
  // small lie an audit trail cannot survive.
  if (lifecycle.observed() === 'cancelled') {
    outcome = { ...outcome, haltedBy: 'cancelled by an operator' };
  }

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
// ---------------------------------------------------------------------------
// pause · resume · cancel  (PRI-14, PRI-15)
// ---------------------------------------------------------------------------

export interface PauseResult {
  readonly runId: string;
  readonly pauseRequestedAt: string;
  /** True when the run was already paused. `pause` is idempotent. */
  readonly alreadyPaused: boolean;
  /** True when something is executing this run right now, so the pause is not yet in effect. */
  readonly executing: boolean;
}

/**
 * Asks a run to stop at its next safe boundary.
 *
 * **Takes no execution lock, and that is deliberate.** Every other write here runs under
 * the lease because it changes what the run *is*; this one changes what the run has been
 * asked to do, and the whole point is that it works while something else holds the lease.
 * A pause that had to wait for the run to finish would be a no-op with extra steps.
 *
 * What it writes is one timestamp. The executing process observes it at the top of its
 * dispatch loop and stops starting work; the task in flight runs to its natural end,
 * because its result file is written once, at the end, and there is no partial result to
 * keep. So the honest report is "pausing…", and `executing` is how a caller knows to say
 * that rather than "paused".
 *
 * Idempotent. Pausing an already-paused run keeps the original timestamp — the answer to
 * "when did somebody ask this to stop" must not move because they asked twice.
 */
export async function pause(
  deps: RunActionDeps,
  runId: string,
): Promise<ActionOutcome<PauseResult>> {
  const store = storeFor(deps);

  const state = await loadRun(store, runId);
  if (state === null) return failed(noSuchRun(runId));

  if (state.status === 'cancelled') {
    return failed({
      code: 'run_cancelled',
      message: `${runId} was cancelled, so there is nothing left to pause.`,
      action: 'Start a new run with `agent-flow feature`.',
      forcible: false,
    });
  }

  if (state.status === 'completed' || state.status === 'failed') {
    return failed({
      code: 'run_completed',
      message: `${runId} has finished (${state.status}), so there is nothing to pause.`,
      action: 'Start a new run with `agent-flow feature`.',
      forcible: false,
    });
  }

  const alreadyPaused = state.pauseRequestedAt !== undefined;
  const at = alreadyPaused ? state.pauseRequestedAt : deps.clock.now();

  if (!alreadyPaused) {
    await store.updateRun(runId, (current) => ({ ...current, pauseRequestedAt: at }));
    await store.appendEvent(runId, 'run_paused', { at });
  }

  // Read after the write, not before. A run that started executing between the two would
  // otherwise be reported as idle, and the operator would be told "paused" about a run
  // that is about to dispatch one more task.
  const held = await lockFor(deps, runId).describe(runId);

  return done(
    {
      runId,
      pauseRequestedAt: at ?? deps.clock.now(),
      alreadyPaused,
      executing: held !== undefined,
    },
    held === undefined
      ? []
      : ['A task is in flight. It will finish; nothing further will start.'],
  );
}

export interface ResumeResult {
  readonly runId: string;
  readonly outcome: SchedulerOutcome;
}

/**
 * Clears a pause and continues, through the same `start` this repository already has.
 *
 * **Not a second execution path.** If resume ran its own scheduler, every gate `start`
 * owns — approval, the planning base, the execution lease, the isolation mode — would have
 * to be duplicated into it, and the copy would eventually disagree. So resume does exactly
 * two things: it removes the request, and it calls `start`.
 *
 * A run nobody paused is refused rather than started. `resume` and `run` are not aliases,
 * and a command that silently did the other's job would make "did my pause take effect"
 * unanswerable.
 */
export async function resume(
  deps: RunActionDeps,
  runId: string,
): Promise<ActionOutcome<ResumeResult>> {
  const store = storeFor(deps);

  const state = await loadRun(store, runId);
  if (state === null) return failed(noSuchRun(runId));

  if (state.status === 'cancelled') {
    return failed({
      code: 'run_cancelled',
      message: `${runId} was cancelled, and a cancelled run is terminal.`,
      action:
        'Its evidence, its integration branch and its worktrees are all still on disk. ' +
        'Start a new run with `agent-flow feature`.',
      forcible: false,
    });
  }

  if (state.pauseRequestedAt === undefined) {
    return failed({
      code: 'not_paused',
      message: `${runId} is not paused.`,
      action: 'Run it with `agent-flow run`.',
      forcible: false,
    });
  }

  // Something is still executing: resume must not mean "start a second scheduler", which
  // is exactly what the execution lease exists to prevent. Asked before the request is
  // cleared, so a refusal leaves the run paused rather than half-resumed.
  const held = await lockFor(deps, runId).describe(runId);
  if (held !== undefined) {
    return failed({
      code: 'run_busy',
      message: `${runId} is still executing${describeHolder(held)}.`,
      action: 'Wait for the paused run to reach its boundary, then resume.',
      forcible: false,
    });
  }

  await store.updateRun(runId, (current) => ({ ...current, pauseRequestedAt: undefined }));
  await store.appendEvent(runId, 'run_resumed', { at: deps.clock.now() });

  const started = await start(deps, runId);
  if (!started.ok) return started;

  return done({ runId, outcome: started.value.outcome }, started.warnings);
}

export interface CancelResult {
  readonly runId: string;
  readonly cancelledAt: string;
  /** True when the run was already cancelled. `cancel` is idempotent. */
  readonly alreadyCancelled: boolean;
  /** Tasks moved from `running` to `interrupted`. */
  readonly interrupted: readonly string[];
  /** True when a process was executing this run and will observe the cancellation. */
  readonly executing: boolean;
}

/**
 * Ends a run: no new work, running processes terminated, evidence kept.
 *
 * The four halves of PRI-14, and each is a decision:
 *
 *  - **No new dispatch.** The terminal status is on disk before anything else, so a
 *    scheduler reaching its next boundary — in this process or another — stops there.
 *  - **Processes terminated.** The executing process observes the status and aborts its
 *    attempts, which reaches the agents' process groups through the same kill the timeout
 *    already uses. That is why `cancel` writes state rather than signalling a pid: the
 *    coordinator is the only participant that can end an attempt *and* record it.
 *  - **Evidence retained.** Nothing is deleted. Not the integration branch, not the failed
 *    worktrees, not an attempt artifact. A cancelled run is the one somebody is most
 *    likely to want to read.
 *  - **The checkout untouched.** Nothing here writes to the working tree, as nothing else
 *    does.
 *
 * Takes no execution lock, for the same reason `pause` does not: it has to work while
 * something else holds it. That is what cancelling *is*.
 *
 * Idempotent, and terminal. There is no un-cancel — reopening a run whose agents were
 * killed mid-edit would resume from a state nobody observed.
 */
export async function cancel(
  deps: RunActionDeps,
  runId: string,
): Promise<ActionOutcome<CancelResult>> {
  const store = storeFor(deps);

  const state = await loadRun(store, runId);
  if (state === null) return failed(noSuchRun(runId));

  if (state.status === 'cancelled') {
    return done({
      runId,
      cancelledAt: state.cancelledAt ?? deps.clock.now(),
      alreadyCancelled: true,
      interrupted: [],
      executing: false,
    });
  }

  if (state.status === 'completed' || state.status === 'failed') {
    return failed({
      code: 'run_completed',
      message: `${runId} has finished (${state.status}), so there is nothing to cancel.`,
      action: 'Start a new run with `agent-flow feature`.',
      forcible: false,
    });
  }

  const held = await lockFor(deps, runId).describe(runId);
  const at = deps.clock.now();
  const interrupted = state.tasks.filter((task) => task.state === 'running').map((task) => task.id);

  await store.updateRun(runId, (current) => ({
    ...current,
    status: 'cancelled',
    cancelledAt: at,
    // The pause request goes with it. A cancelled run that still carried one would report
    // two intents, and the weaker one would be the confusing half.
    pauseRequestedAt: undefined,
    tasks: current.tasks.map((task) =>
      // `interrupted` already exists and already means "was running and nothing is
      // executing it". A `cancelled` task state would differ only in *why*, and the why
      // is the event below.
      task.state === 'running' ? { ...task, state: 'interrupted' as const } : task,
    ),
  }));

  await store.appendEvent(runId, 'run_cancelled', {
    at,
    interrupted,
    ...(held?.holder === undefined
      ? {}
      : { pid: held.holder.pid, hostname: held.holder.hostname }),
  });

  return done(
    {
      runId,
      cancelledAt: at,
      alreadyCancelled: false,
      interrupted,
      executing: held !== undefined,
    },
    held === undefined
      ? []
      : [
          `A process was executing this run${describeHolder(held)}. ` +
            'It observes the cancellation and terminates its agents.',
        ],
  );
}

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

  const workflow = state.workflow ?? 'standard';
  const currentRevisions = state.revisionCount ?? 0;
  const budget = getCeremonyBudget(workflow);

  if (workflow === 'trivial') {
    return failed({
      code: 'ceremony_budget_exceeded',
      message: 'TRIVIAL workflow does not support automated revision cycles (budget = 0).',
      action: 'Approve the plan as is, or start a new run with STANDARD workflow.',
    });
  }

  if (currentRevisions >= budget.maxRevisionCycles) {
    return failed({
      code: 'ceremony_budget_exceeded',
      message:
        `STOP_AND_ASK_HUMAN: ${workflow.toUpperCase()} workflow reached its ceremony budget limit ` +
        `(${budget.maxRevisionCycles} revision cycle${budget.maxRevisionCycles === 1 ? '' : 's'}). ` +
        'Unresolved findings require human approval or workflow elevation.',
      action: 'Review residual findings in Approval dialog and approve over them, or start a new run with a higher workflow class.',
    });
  }

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

  // A human acted, so the unattended streak is over (C-22, AR §6.2). Rounds already spent
  // stay spent; the count of calls made *with no intervening human action* is by definition
  // broken by this one.
  await clearAutonomy(context.store, runId);

  await context.store.appendEvent(runId, 'revision_requested', {
    instruction: trimmed,
    attemptedRevision: currentRevisions + 1,
    maxAllowed: budget.maxRevisionCycles,
  });

  const request = (await context.store.readArtifact(runId, 'request')) ?? state.feature;
  const pipeline = buildPlanningPipeline(context);

  const result = await pipeline.run(
    runId,
    `${request.trim()}\n\n---\n\nRevision requested by the reviewer:\n${trimmed}`,
    { from: 'planning', workflow },
  );

  const nextRevisionCount = currentRevisions + 1;
  await context.store.updateRun(runId, (entry) => ({
    ...entry,
    revisionCount: nextRevisionCount,
  }));
  await context.store.appendEvent(runId, 'revision_completed', {
    instruction: trimmed,
    revisionCount: nextRevisionCount,
  });

  return done({
    runId,
    taskCount: result.plan.tasks.length,
    ...(result.review === undefined ? {} : { reviewVerdict: result.review.verdict }),
    approvalCleared,
  });
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export interface ReviewOptions {
  /** Turn the findings into corrective tasks, and review the corrected plan. */
  readonly fix?: boolean;
  /** Progress, for an adapter that streams. Decides nothing. */
  readonly onVerificationStep?: (step: string, passed: boolean) => void;
  readonly onStage?: (stage: 'verification' | 'inspection' | 'final-review') => void;
}

export interface ReviewOutcome {
  readonly runId: string;
  readonly verification: VerificationOutcome;
  /**
   * What the project's own commands said — three-valued (AD-45, C-11).
   *
   * Separate from `verificationReview` below, and that separation is the milestone. Those
   * are two different questions with two different authorities: exit codes answer "did the
   * commands pass", a model answers "does this look right". The evidence run rendered them
   * under one label with opposite answers, and the operator reasonably concluded the tool
   * was lying.
   *
   * `NOT_RUN` is the value that was missing. An environment that could not answer is not a
   * codebase that answered "no".
   */
  readonly mechanicalVerification: MechanicalVerification;
  /** Why the commands did not run, when they did not. Names the install and its exit code. */
  readonly environmentFailure?: { readonly phase: string; readonly detail: string };
  readonly verificationReview: { verdict: 'PASS' | 'FAIL'; findings: ReviewResult['findings'] };
  readonly finalReview: ReviewResult;
  readonly done: DoneCheck;
  readonly degradations: RunState['degradations'];
  /** Present only when `fix` was asked for and there was something to correct. */
  readonly corrective?: CorrectiveRound;
  /**
   * The one commit verification, the reviewer and the Definition of Done all
   * describe (§19.2). Absent in sequential mode, where the tree is the project
   * directory and there is no commit to name.
   */
  readonly integration?: { readonly branch: string; readonly head: string };
}

/**
 * `agent-flow review` as a use case — verification, the two agents, and the
 * Definition of Done (§19).
 *
 * It lives here rather than in the CLI for the reason every other write action
 * does: the terminal and the browser must be two adapters over one workflow, and
 * this one now *moves* a run — it writes `verification.json`, `final-review.json`
 * and the run's stage and status. It also decides, in worktree mode, which tree
 * everything downstream reads.
 *
 * **The lease is taken for what the command touches, not for what it is called**
 * (§18.2). In worktree mode this reads and runs commands inside the integration
 * worktree — the same checkout the Integrator merges into — so it takes the run
 * execution lock like every other write action, and a concurrent `review` gets
 * `run_busy`. In sequential mode it still only reads the project directory, so it
 * keeps running without the lease exactly as it always has.
 */
export async function review(
  deps: RunActionDeps,
  runId: string,
  options: ReviewOptions = {},
): Promise<ActionOutcome<ReviewOutcome>> {
  const store = storeFor(deps);
  const state = await loadRun(store, runId);
  if (state === null) return failed(noSuchRun(runId));

  return state.isolationMode === 'worktree'
    ? withExecutionLock(deps, store, runId, 'review', () => judgeRun(deps, runId, options))
    : judgeRun(deps, runId, options);
}

async function judgeRun(
  deps: RunActionDeps,
  runId: string,
  options: ReviewOptions,
): Promise<ActionOutcome<ReviewOutcome>> {
  const context = await buildExecutionContext(deps);
  const state = await loadRun(context.store, runId);
  if (state === null) return failed(noSuchRun(runId));

  const [plan, sdd] = await Promise.all([
    loadPlanArtifact(context.store, runId),
    context.store.readArtifact(runId, 'sdd'),
  ]);

  if (plan === null) {
    return failed({
      code: 'no_plan',
      message: `${runId} has no plan to review against.`,
      action: 'Finish planning before reviewing the implementation.',
    });
  }

  const workflow = state.workflow ?? 'standard';
  const sddRequired = workflow === 'standard' || workflow === 'high-risk';

  if (sddRequired && sdd === null) {
    return failed({
      code: 'no_sdd',
      message: `${runId} has no SDD, which the ${workflow.toUpperCase()} workflow requires.`,
      action: 'Finish planning before reviewing the implementation.',
    });
  }

  const requestContent = (await context.store.readArtifact(runId, 'request')) ?? state.feature;
  const effectiveSdd =
    sdd ??
    `# Feature Request & Scope (${workflow.toUpperCase()} Workflow)\n\n${requestContent}\n\n*Note: This ${workflow} workflow operates without a separate SDD. The approved Plan and its acceptance criteria define the specification.*`;

  // §19.2: **one tree, read once.** `state.integrationHead` is the commit the
  // Integrator advanced on every merge, and it is what verification, the
  // reviewer's diff and the Definition of Done all describe. A run reviewed
  // against a commit its own state does not name is a run whose green verdict
  // means nothing.
  const tree = await openReviewTree(context, state);
  if (!tree.ok) return failed(tree.error);

  const git = new GitClient(context.git, tree.value.cwd);
  const changes =
    tree.value.integration === undefined
      ? await git.changedFiles()
      : await git.changedFilesBetween(tree.value.base, tree.value.integration.head);
  const changedFiles = renderChanges(changes);

  // ---- The workspace first, then the commands (AD-44, C-10).
  //
  // **The integration worktree was the one tree nobody prepared.** Every task worktree
  // went through assert-clean → install → assert-clean; this one did not, so the evidence
  // run's `review` produced four `exit 127`s — lint, typecheck, test and build, each
  // reporting a missing binary — and those exit codes, which described the environment,
  // were read as a verdict on the code.
  //
  // `install` is not a verification step and is not in `VERIFICATION_ORDER`: it has to run
  // *before* the step whose failure it would otherwise be blamed for.
  const install = context.config.project?.commands?.install;
  const prepared = await prepareWorkspace(
    { workspaces: context.workspaces, processRunner: context.processRunner },
    {
      path: tree.value.cwd,
      ...(install === undefined ? {} : { install }),
    },
  );

  if (prepared.ok) {
    await context.store.appendEvent(runId, 'workspace_prepared', {
      phase: 'verification',
      ...(prepared.install === undefined
        ? { install: 'none configured' }
        : { install: prepared.install.command, exitCode: prepared.install.exitCode }),
    });
  } else {
    await context.store.appendEvent(runId, 'workspace_preparation_failed', {
      phase: prepared.failure.phase,
      detail: prepared.failure.detail,
      changes: prepared.failure.changes,
    });
  }

  // ---- Commands second: deterministic, free, and often decisive — but only meaningful in
  // a tree that can run them. An unprepared workspace produces `NOT_RUN`, never `FAIL`:
  // "we could not run your build" and "your build is broken" send a person to two
  // different places, and only one of them is a statement about the code (AD-45).
  options.onStage?.('verification');
  const verification = prepared.ok
    ? await runVerification({
        processRunner: context.processRunner,
        project: context.config.project,
        cwd: tree.value.cwd,
        onStep: (step, result) => options.onVerificationStep?.(step, result.exitCode === 0),
      })
    : { passed: false, results: [], skipped: [...VERIFICATION_ORDER] };

  const mechanicalVerification: MechanicalVerification = !prepared.ok
    ? 'NOT_RUN'
    : verification.passed
      ? 'PASS'
      : 'FAIL';

  const commandResults = [summariseVerification(verification), failureDetail(verification)]
    .filter((part) => part.length > 0)
    .join('\n\n');

  // ---- Verification agent: what a command cannot see.
  options.onStage?.('inspection');
  const verificationResponse = ReviewResponseSchema.parse(
    (
      await context.stageRunner.run(
        VERIFICATION_STAGE,
        runId,
        {
          sdd: effectiveSdd,
          changedFiles,
          commandResults,
          agentsMd: await readAgentsMd(context, tree.value.cwd),
        },
        // §19.2: the agent reads the same tree the commands ran in. Left to
        // default it would read the project directory — the user's working tree,
        // which in worktree mode holds none of the run's work.
        { workingDirectory: tree.value.cwd },
      )
    ).data,
  );

  await context.store.writeArtifact(
    runId,
    'verification',
    `${JSON.stringify(verificationResponse, null, 2)}\n`,
  );

  // ---- Final review: the implementation against the approved SDD.
  const authors = authorsOf(await context.store.readEvents(runId));

  options.onStage?.('final-review');
  const finalResult = await context.stageRunner.run(
    FINAL_REVIEW_STAGE,
    runId,
    {
      sdd: effectiveSdd,
      plan: JSON.stringify(plan, null, 2),
      diffStat:
        tree.value.integration === undefined
          ? await git.diffStat()
          : await git.diffStatBetween(tree.value.base, tree.value.integration.head),
      changedFiles,
      commandResults,
    },
    { workingDirectory: tree.value.cwd },
  );
  const finalResponse = ReviewResponseSchema.parse(finalResult.data);

  // Judged after both sides have run, and by provider rather than by runner id:
  // two configuration entries can point at the same CLI, and a review across them
  // is independent of nothing.
  const independence = assessIndependence(
    authors,
    finalResult.execution.runner,
    context.providerOf,
  );

  if (independence === 'same-provider-fresh-context') {
    await context.store.recordDegradation(runId, {
      kind: 'single_provider',
      reason: explainIndependence(authors, finalResult.execution.runner, context.providerOf),
      impact:
        'the final review is same-provider: the model that wrote the code is also judging it',
    });
  }

  const reviewedIntegrationHead = tree.value.integration?.head;
  const finalReview = buildReview(
    finalResponse,
    {
      runner: finalResult.execution.runner,
      ...(finalResult.execution.model === undefined ? {} : { model: finalResult.execution.model }),
      reasoning: finalResult.execution.reasoning,
    },
    independence,
    reviewedIntegrationHead,
  );

  await context.store.writeArtifact(
    runId,
    'finalReview',
    `${JSON.stringify(finalReview, null, 2)}\n`,
  );

  // **Read before the gate, because the gate now depends on it.** A blocking finding
  // raised by a per-task review is a statement about this tree, and a Definition of Done
  // that cannot see it will say done while a `critical` is open (§43, I-44).
  const fromCodeReview = await codeReviewFindings(context, runId, plan);

  // ---- Definition of Done, evaluated as code (§42), over the same tree.
  const doneCheck = checkDefinitionOfDone({
    approved: state.approved,
    taskStates: state.tasks.map((task) => task.state),
    mechanicalVerification,
    finalReviewVerdict: finalReview.verdict,
    ...(fromCodeReview === undefined
      ? {}
      : { openBlockingFindings: fromCodeReview.review.findings.map(idOf) }),
  });

  await context.store.updateRun(runId, (current) => ({
    ...current,
    stage: 'final-review',
    status: doneCheck.done ? 'completed' : current.status,
  }));

  const finalState = await context.store.loadRun(runId);

  // **The per-task code reviews join the same corrective round** (§29, M6-05).
  //
  // They were unreachable before this. `correctiveSelection` existed, was tested, and had
  // no production caller; the live dogfood produced two reviews and seven findings — one
  // of them a blocking `high` — and not one corrective task, because nothing carried a
  // code-review finding to the generator. The tests could not see it: every one of them
  // called the selector directly.
  //
  // One round rather than two. The run-level verdict and the code reviews are different
  // statements about the same tree, and `--fix` is one question — "turn what is wrong into
  // work". Two rounds would mean two plan reviews, two budget draws and a second plan built
  // on the first one's output. Only the provenance differs, and `originFor` keeps that.
  const mergedReview: ReviewResult =
    fromCodeReview === undefined
      ? finalReview
      : {
          ...finalReview,
          findings: [...finalReview.findings, ...fromCodeReview.review.findings],
          // A run-level `PASS` beside a blocking finding is not a pass. The generator only
          // reads `findings`, but the value is persisted and read by people.
          verdict: 'FAIL',
        };

  const corrective =
    doneCheck.done || options.fix !== true
      ? undefined
      : await correctPlan(
          context,
          runId,
          plan,
          effectiveSdd,
          mergedReview,
          // The integration diff, which is the mechanical answer to "what has this run
          // already changed" — the first condition of the AD-46 envelope.
          changes.map((change) => change.path),
          fromCodeReview?.originFor,
          fromCodeReview?.expectationFor,
        );

  return done({
    runId,
    verification,
    mechanicalVerification,
    ...(prepared.ok
      ? {}
      : {
          environmentFailure: {
            phase: prepared.failure.phase,
            detail: prepared.failure.detail,
          },
        }),
    verificationReview: {
      verdict: verificationResponse.verdict,
      findings: verificationResponse.findings,
    },
    finalReview,
    done: doneCheck,
    degradations: finalState.degradations,
    ...(corrective === undefined ? {} : { corrective }),
    ...(tree.value.integration === undefined ? {} : { integration: tree.value.integration }),
  });
}

/**
 * Which tree this review describes, and the commit it is pinned to (§19.1).
 *
 * Two answers, and the run decides which — never the configuration (I-13).
 *
 * In **worktree mode** it is the integration worktree, opened through the
 * Integrator so the branch is confirmed to still be at the commit the run
 * recorded. Never `globals.cwd`: the user's working tree is not where the work
 * is, and it is a property of this milestone that Agent Flow did not touch it
 * (§19.3).
 *
 * In **sequential mode** it is the project directory, exactly as it has always
 * been, and no Git integration path is reached at all (§25.1).
 */
async function openReviewTree(
  context: ExecutionContext,
  state: RunState,
): Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly cwd: string;
        /** `planningBase`, when there is a range to diff. */
        readonly base: string;
        readonly integration?: { readonly branch: string; readonly head: string };
      };
    }
  | { readonly ok: false; readonly error: ActionError }
> {
  const opened = await context.integrator.openForReview(state.runId);

  if (opened.kind === 'sequential') {
    return { ok: true, value: { cwd: context.projectDir, base: state.planningBase ?? '' } };
  }

  if (opened.kind === 'refused') {
    return {
      ok: false,
      error: {
        code: opened.refusal.code,
        message:
          `${state.runId} is an isolated run and its integration tree cannot be read: ` +
          `${opened.refusal.detail}.`,
        action:
          'The integration branch is the product of the run. Restore it, or start a new run.',
      },
    };
  }

  return {
    ok: true,
    value: {
      cwd: opened.workspace.path,
      base: state.planningBase ?? '',
      integration: { branch: opened.workspace.branch, head: opened.workspace.head },
    },
  };
}

/** `AGENTS.md` of the tree under review, not of whatever the user has open. */
async function readAgentsMd(context: ExecutionContext, cwd: string): Promise<string> {
  const path = `${cwd}/AGENTS.md`;
  return (await context.fs.exists(path))
    ? context.fs.readFile(path)
    : 'No AGENTS.md in this repository.';
}

/** A finding's id when it has one — run-level findings do not. */
function idOf(finding: ReviewResult['findings'][number]): string {
  return 'id' in finding && typeof finding.id === 'string' ? finding.id : 'unidentified finding';
}

/**
 * The blocking code-review findings that still need work, in the shape the generator takes.
 *
 * Reads the projection rather than the raw records: a finding whose corrective task already
 * completed is `fixed`, and one a later review let go is `verified`. Selecting from the
 * records would regenerate work for both.
 *
 * Freshness is deliberately not a filter here. A review of an older tree may be stale as a
 * *verdict* — it cannot approve what it did not see — but a defect it observed is still a
 * defect until something addresses it, and the projection is what answers that.
 *
 * `undefined` when there is nothing blocking, which is the ordinary case.
 */
async function codeReviewFindings(
  context: ExecutionContext,
  runId: string,
  plan: Plan,
): Promise<
  | {
      review: ReviewResult;
      originFor: ReadonlyMap<string, CorrectiveOriginStage>;
      expectationFor: ReadonlyMap<string, 'pass' | 'fail' | 'none'>;
    }
  | undefined
> {
  const reviews = await new ReviewStore({
    fs: context.fs,
    projectDir: context.projectDir,
  }).readReviews(runId);
  if (reviews.length === 0) return undefined;

  const findings = projectFindings({
    reviews,
    messages: await new CollaborationStore({
      fs: context.fs,
      projectDir: context.projectDir,
    }).readMessages(runId),
    events: await context.store.readEvents(runId),
  });

  const selection = correctiveSelection({
    findings,
    quality: context.config.global.quality,
    // Whoever wrote the most recent review. Provenance on the generated task, and a member
    // id rather than a runner — which is what a team makes it.
    reviewer: reviews[reviews.length - 1]?.reviewer ?? 'reviewer',
  });
  if (selection === undefined) return undefined;

  // Which task each finding is about, so the fix inherits where that task stood in the
  // cycle. A finding on a test-first task is corrected while the suite is still red.
  const expectationOf = new Map(
    plan.tasks.map((task) => [task.id, task.validationExpectation] as const),
  );

  return {
    review: selection.review,
    originFor: new Map(selection.findings.map((held) => [held.finding.id, 'code-review'] as const)),
    expectationFor: new Map(
      selection.findings.map(
        (held) => [held.finding.id, expectationOf.get(held.taskId) ?? 'pass'] as const,
      ),
    ),
  };
}

/** `--fix`: the findings become tasks, and the corrected plan is reviewed. */
async function correctPlan(
  context: ExecutionContext,
  runId: string,
  plan: Plan,
  sdd: string,
  finalReview: ReviewResult,
  /** Every path this run has already changed, from the integration diff (AD-46). */
  touchedFiles: readonly string[],
  /** Which findings came from a code review rather than from the run-level verdict. */
  originFor?: ReadonlyMap<string, CorrectiveOriginStage>,
  /** What the corrected task expected, so a fix to a red suite is not judged as green. */
  expectationFor?: ReadonlyMap<string, 'pass' | 'fail' | 'none'>,
): Promise<CorrectiveRound | undefined> {
  const architectureImpact =
    (await context.store.readArtifact(runId, 'architectureImpact')) ??
    'None (adaptive workflow without separate architecture impact stage).';

  return runCorrectiveRound({
    store: context.store,
    stageRunner: context.stageRunner,
    providerOf: context.providerOf,
    runId,
    plan,
    finalReview,
    origin: 'final-review',
    ...(originFor === undefined ? {} : { originFor }),
    ...(expectationFor === undefined ? {} : { expectationFor }),
    sdd,
    architectureImpact,
    // The ids a corrective task may cite come from the project's own
    // configuration, never from the finding text: a fix validated by an id that
    // does not resolve fails for the wrong reason.
    validation: buildValidationRegistry(context.config.project),
    // **What this approval already covers** (AD-46, C-18, I-25).
    //
    // Every input is mechanical: the touched files come from the integration diff, the
    // requirement ids from the approved SDD, the validation ids from the project's own
    // configuration, and the budget from the run's persisted counter. Nothing here is a
    // AD-47's budget, decided by the policy table rather than compared here.
    recovery: context.config.global.recovery,
    // judgement, and nothing a model wrote reaches it.
    envelope: {
      context: {
        touchedFiles,
        declaredRequirements: extractRequirementIds(sdd),
        declaredValidationIds: buildValidationRegistry(context.config.project).ids,
        contractPaths: CONTRACT_PATHS,
      },
      budget: {
        correctiveRoundsUsed: (await context.store.loadRun(runId)).autonomy?.correctiveRoundsUsed ?? 0,
        maxCorrectiveRounds: context.config.global.recovery.maxCorrectiveRounds,
      },
    },
  });
}

/**
 * Where a contract lives.
 *
 * A new file here is a new shape everything else has to agree on, which is a change to the
 * agreement however small the diff — so AD-46 makes it its own condition rather than
 * leaving it to the file check. Editing one the run already touched stays inside.
 */
const CONTRACT_PATHS = ['src/contracts/'] as const;

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

/**
 * Whether a review still describes the code that is integrated (M6, I-41).
 *
 * One comparison, in one place. It lived in `apps/web/src/lib/review-freshness.ts` and
 * was decided in the browser from whichever fields it happened to have — the shape §59
 * names as forbidden, and the shape that let a stale verdict render as current whenever
 * the dashboard was handed one field and not the other.
 *
 * `unverifiable` rather than `stale` when either side has no commit: a plan-only run has
 * no code for a review to have gone stale against.
 */
export function reviewFreshness(
  reviewed: string | undefined,
  integrated: string | undefined,
): 'current' | 'stale' | 'unverifiable' {
  if (reviewed === undefined || integrated === undefined) return 'unverifiable';
  return reviewed === integrated ? 'current' : 'stale';
}
