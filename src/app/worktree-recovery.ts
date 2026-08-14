import type { TaskState } from '../contracts/index.js';
import type { Clock } from '../ports/index.js';
import { topologicalOrder, type Dag } from '../core/dag.js';
import { attemptRef } from '../core/worktree-policy.js';
import { publishMarker, readAttempt } from './attempt-receipt.js';
import type {
  IntegrationRefusalCode,
  IntegrationWorkspace,
  RecoveryIntegrator,
} from './integrator.js';
import type { RepositoryDeps } from './run-git-identity.js';
import type { StateStore } from './state-store.js';

/**
 * What durable evidence a crashed run left, and what that evidence authorises
 * (§17).
 *
 * This module answers one question per task — *what is on disk, and what may be
 * done about it* — and then hands the work to whoever already owns it. It
 * deliberately owns nothing else. It does not merge, does not write `completed`,
 * does not run a validation command, does not invoke a coding agent, does not
 * decide when a retry is allowed, and does not reclaim a worktree. The shape to
 * watch for in review is a function here that takes a runner, a prompt, a
 * concurrency number, or a `TaskResult`.
 *
 * **Receipt-first, and the direction never inverts** (I-5, §17.1):
 *
 * ```text
 * state.tasks[<task>].attempts        ← which attempt existed
 *         ↓
 * attempt-<n>.json parses             ← THE authority
 *         ↓
 * validationJudgement === satisfied ∧ receipt present
 *         ↓
 * the validated tree object exists here
 *         ↓
 * the attempt ref, re-derived from policy rather than read from the artifact
 *         ↓
 * the Integrator confirms the marker binds, and merges or reconciles
 * ```
 *
 * The forbidden shape, written out so it is recognisable in review:
 *
 * ```text
 * FORBIDDEN:
 *   the ref exists and its message looks like a marker → trust it
 * ```
 *
 * That trusts a ref, and a ref is something an agent with a shell in a worktree
 * can create. Git *confirms* evidence here; it never stands in for it.
 *
 * **Nothing here is a repair by guessing.** Two operations mutate anything, and
 * both are idempotent by construction: re-running `commit-tree` from the
 * persisted artifact yields the same commit id (§12.2), and `merge --abort`
 * returns a worktree to the state it was already in. Everything else is a read.
 */

// ---------------------------------------------------------------------------
// Windows (§17.3)
// ---------------------------------------------------------------------------

/**
 * The §17.3 window a task was found in, as the number Appendix B's
 * `integration_recovered` event carries.
 *
 * Named rather than inlined because the number reaches an audit trail, and a
 * literal at a call site is a number nobody can look up. Windows 1 and 2 share a
 * value on purpose — §17.3 says they are indistinguishable, and correctly so:
 * with no artifact there is no evidence, and this milestone does not infer
 * evidence from a worktree's contents. Windows 3 and 4 share one for the same
 * kind of reason: `commit-tree` is idempotent by SHA, so "the ref was never
 * written" and "the commit exists and the ref was never written" need no
 * distinction.
 */
export const RECOVERY_WINDOWS = {
  /** §17.3 windows 1 and 2 — the attempt's work was never observed. */
  attemptUnobserved: 1,
  /** §17.3 windows 3 and 4 — a receipt with no published marker. */
  markerUnpublished: 3,
  /** §17.3 window 5 — a valid marker that is not on the integration branch. */
  markerUnmerged: 5,
  /** §17.3 window 6 — the integration worktree was left mid-merge. */
  mergeInterrupted: 6,
  /** §17.3 window 7 — the merge landed and the state write did not. */
  completionUnrecorded: 7,
  /** §17.3 window 10 — the validated tree object is gone. */
  treePruned: 10,
  /** §17.3 window 11 — the marker does not bind to the receipt. */
  markerMismatched: 11,
} as const;

export type RecoveryWindow = (typeof RECOVERY_WINDOWS)[keyof typeof RECOVERY_WINDOWS];

// ---------------------------------------------------------------------------
// Refusal vocabulary
// ---------------------------------------------------------------------------

/**
 * Every code recovery can originate.
 *
 * **All five are Appendix A codes, and M2-07 adds none** — which is the point
 * rather than a coincidence: recovery meets the same world the Integrator does,
 * and a second vocabulary for it would mean a person looking up a refusal found
 * it described twice or not at all. `test/app/integration-vocabulary.test.ts`
 * pins this list against the appendix in both directions.
 *
 * Codes that reach a caller *through* this module without being decided by it —
 * `integration_conflict`, `integration_history_unrecognised` — are the
 * Integrator's, and are propagated unchanged rather than renamed.
 */
export const RECOVERY_REFUSAL_CODES = [
  /** The validated tree object is gone. Requeues rather than halting. */
  'attempt_tree_missing',
  /** The evidence is sound and the marker could not be published. */
  'attempt_marker_missing',
  /** The evidence names a ref outside this attempt's own namespace. */
  'attempt_marker_mismatch',
  /** An interrupted merge could not be cleared. */
  'integration_worktree_unavailable',
  /** Git could not answer a question this sequence depends on. */
  'integration_unreadable',
] as const;

export type RecoveryRefusalCode = (typeof RECOVERY_REFUSAL_CODES)[number];

export interface RecoveryRefusal {
  /**
   * Recovery's own vocabulary, **or** a code the Integrator decided and this
   * module propagates unchanged.
   *
   * Both are Appendix A codes, and the union is the honest shape: a conflict or
   * an unrecognised history is the Integrator's answer, and renaming it on the way
   * through would tell a person their marker was forged when the truth is that
   * two tasks touched the same lines.
   */
  readonly code: RecoveryRefusalCode | IntegrationRefusalCode;
  /** What went wrong, for a person — and path-free by construction (§7.2). */
  readonly detail: string;
  /** The conflicting paths, when the propagated refusal is a conflict. */
  readonly paths?: readonly string[];
}

// ---------------------------------------------------------------------------
// What the scheduler sees
// ---------------------------------------------------------------------------

export type TaskRecovery =
  /**
   * No durable evidence finished this attempt, so it starts over.
   *
   * The caller performs the requeue — this module does not, because the
   * transition through `interrupted` and the `maxAttempts` bound already live in
   * `Scheduler.recoverInterrupted` and a second implementation of them would be a
   * second retry policy (§16, M2-08).
   */
  | {
      readonly kind: 'requeue';
      readonly task: string;
      readonly attempt: number;
      readonly window: RecoveryWindow;
      readonly reason: string;
      /** Present when Appendix A names the state that produced the requeue. */
      readonly code?: RecoveryRefusalCode;
    }
  /**
   * Durable evidence finished the attempt, and the Integrator recorded it.
   *
   * `state` is copied out of the Integrator's answer rather than named here: this
   * module is not allowed to decide that a task is `completed` (I-3, §14.4).
   */
  | {
      readonly kind: 'recovered';
      readonly task: string;
      readonly attempt: number;
      readonly window: RecoveryWindow;
      readonly state: TaskState;
    }
  /**
   * The attempt reached a verdict of its own before the crash.
   *
   * Not a requeue, and that is the whole distinction: re-running the agent over a
   * task whose validation was judged and not met would be an automatic retry of a
   * failure, which §23 forbids and which `judgeValidation` already decided once
   * (I-4). The verdict is *read back* from the artifact, never re-derived.
   */
  | {
      readonly kind: 'concluded';
      readonly task: string;
      readonly attempt: number;
      readonly state: TaskState;
      readonly reason: string;
    }
  /** The evidence cannot be trusted or reconciled. The run halts. */
  | {
      readonly kind: 'refused';
      readonly task: string;
      readonly attempt: number;
      readonly window: RecoveryWindow;
      readonly state: TaskState;
      readonly refusal: RecoveryRefusal;
    };

export interface RunRecoveryOutcome {
  /** In the plan's stable topological order (I-9). */
  readonly outcomes: readonly TaskRecovery[];
  /** Set when nothing further may be dispatched, with the reason a person reads. */
  readonly haltedBy?: string;
}

export interface RecoveryRequest {
  readonly runId: string;
  readonly workspace: IntegrationWorkspace;
  /** The plan's graph, so the order comes from `core/dag.ts` (I-2, I-9). */
  readonly dag: Dag;
  /**
   * The states this invocation is working from.
   *
   * Taken from the caller rather than read again, so the scheduler's view of what
   * is running and this module's cannot disagree — the attempt *count* still comes
   * from the store, because that is the field that says which attempt existed.
   */
  readonly states: Readonly<Record<string, TaskState>>;
}

/**
 * The narrow view the scheduler holds.
 *
 * Declared here and consumed as a type, so `app/scheduler.ts` keeps importing
 * nothing from `src/adapters/git/` (§26.1 rule 2) and a test can drive the wave
 * loop without a repository.
 */
export interface RunRecovery {
  recoverRun(request: RecoveryRequest): Promise<RunRecoveryOutcome>;
}

export interface WorktreeRecoveryDeps extends RepositoryDeps {
  readonly store: StateStore;
  /** For `publishMarker`'s dependency shape. The marker's dates come from the
   *  artifact, never from a clock (§12.2). */
  readonly clock: Clock;
  /** Integration stays in one module, and so does `git merge` (§26.1). */
  readonly integrator: RecoveryIntegrator;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class WorktreeRecovery implements RunRecovery {
  constructor(private readonly deps: WorktreeRecoveryDeps) {}

  /**
   * Brings every task a dead process left in flight to a state that is true.
   *
   * Runs once, at the start of `start`, under the run execution lock and after
   * the namespace has been prepared — so no other process is touching this run
   * (§17.2, §18.2), the integration branch and its checkout exist (§5.3, §14.1),
   * and nothing is executing.
   *
   * **Only `running` tasks are considered, and the restriction is load-bearing.**
   * `running` is what a killed process leaves behind. `failed`, `blocked` and
   * `review_required` are *decisions*, and reopening one would be recovery
   * overruling a person. `completed` is terminal (§17.3 window 8 is cleanup, which
   * M2-09 owns). And `interrupted` is what an earlier pass of
   * `Scheduler.recoverInterrupted` left — which this method runs *before*, so a
   * task with durable evidence never reaches it.
   */
  async recoverRun(request: RecoveryRequest): Promise<RunRecoveryOutcome> {
    const state = await this.deps.store.loadRun(request.runId);
    const gitRunKey = state.gitRunKey;
    if (gitRunKey === undefined) {
      // Unreachable behind §6.3 check 7, which refuses the run before the
      // scheduler exists. Named rather than assumed, because the alternative is
      // composing a ref name out of `undefined`.
      return halted('this run has no Git namespace, so no attempt ref can be named');
    }

    const attempts = new Map(state.tasks.map((task) => [task.id, task.attempts]));

    // §17.3 window 6, asked once. `MERGE_HEAD` is a property of the integration
    // worktree rather than of a task, so reading it per task would be N reads of
    // one fact — and the *task* it belongs to is knowable from the commit it
    // names, which is what makes the window attributable at all.
    const interrupted = await this.deps.integrator.clearInterruptedMerge(request.workspace);
    if (!interrupted.ok) {
      return halted(`${interrupted.refusal.code} — ${interrupted.refusal.detail}`);
    }
    const clearedMerge = interrupted.aborted;

    const outcomes: TaskRecovery[] = [];

    for (const taskId of topologicalOrder(request.dag)) {
      if (request.states[taskId] !== 'running') continue;

      const outcome = await this.recoverTask({
        request,
        taskId,
        attempt: attempts.get(taskId) ?? 0,
        gitRunKey,
        clearedMerge,
      });
      outcomes.push(outcome);

      // A refusal or a verdict stops the run before anything is dispatched. In
      // topological order the remainder is either downstream of it or a peer, and
      // cutting a dependent's workspace from a branch that does not hold its
      // dependency's work is the failure that stays invisible for three more
      // tasks.
      const stopping = haltReasonOf(outcome);
      if (stopping !== undefined) return { outcomes, haltedBy: stopping };
    }

    return { outcomes };
  }

  private async recoverTask(context: {
    readonly request: RecoveryRequest;
    readonly taskId: string;
    readonly attempt: number;
    readonly gitRunKey: string;
    readonly clearedMerge: boolean;
  }): Promise<TaskRecovery> {
    const { request, taskId, attempt, gitRunKey } = context;

    if (attempt < 1) {
      // A task marked `running` whose attempt counter never moved. The dispatch
      // that spends an attempt is persisted before the work starts (M2-00.2), so
      // this is a state nothing this tool writes — and with no attempt number
      // there is no artifact to name.
      return unobserved(taskId, attempt, 'no attempt was ever dispatched for this task');
    }

    // 1 — the artifact first, always. Absent or unparseable means the attempt
    // produced no evidence, and evidence is not inferred from a ref (I-5).
    const evidence = await readAttempt(this.deps, request.runId, taskId, attempt);
    if (evidence === null) {
      return unobserved(
        taskId,
        attempt,
        `attempt ${String(attempt)} left no evidence that parses, so its work was never observed`,
      );
    }

    // 2 — the judgement the artifact carries. A satisfied attempt is the only one
    // that can be integrated; the others already reached a verdict, and reading it
    // back is not re-judging it (I-4).
    if (evidence.validationJudgement !== 'satisfied') {
      return {
        kind: 'concluded',
        task: taskId,
        attempt,
        state: concludedStateOf(evidence.validationJudgement, evidence.agentReport.status),
        reason:
          `attempt ${String(attempt)} of ${taskId} was recorded as ` +
          `${evidence.validationJudgement} before the process ended, so it reached a verdict ` +
          'rather than being interrupted',
      };
    }

    const receipt = evidence.receipt;
    if (receipt === undefined) {
      // Unreachable behind the `.refine` of §10.2 — a satisfied artifact without a
      // receipt does not parse — and checked anyway, because the alternative is
      // reading `validatedTree` off `undefined`.
      return this.refuse(
        taskId,
        attempt,
        RECOVERY_WINDOWS.markerMismatched,
        'attempt_marker_mismatch',
        `the evidence for ${taskId} records a satisfied validation and carries no receipt`,
      );
    }

    // 3 — the validated tree object must still be here. A `git gc` between the
    // crash and the resume can take a tree nothing referenced, and a marker
    // cannot be rebuilt without it. **Never fabricate a tree** (§17.3 window 10).
    const tree = await this.deps.workspaces.objectExistsAs({
      cwd: this.deps.projectDir,
      oid: receipt.validatedTree,
      type: 'tree',
    });
    if (!tree.ok) {
      return this.refuse(
        taskId,
        attempt,
        RECOVERY_WINDOWS.treePruned,
        'integration_unreadable',
        `the repository could not be asked whether the validated tree of ${taskId} exists: ` +
          tree.failure.message,
      );
    }
    if (!tree.value) {
      await this.deps.store.appendEvent(request.runId, 'attempt_tree_missing', {
        task: taskId,
        attempt,
        tree: receipt.validatedTree,
      });
      return {
        kind: 'requeue',
        task: taskId,
        attempt,
        window: RECOVERY_WINDOWS.treePruned,
        code: 'attempt_tree_missing',
        reason:
          `the tree attempt ${String(attempt)} of ${taskId} was validated against is no longer ` +
          'in the repository, so its marker cannot be rebuilt',
      };
    }

    // 4 — the ref name is **re-derived from policy**, never taken from the
    // artifact. The artifact types `branch` as a string, and the one thing it must
    // not be able to do is point recovery at a ref this run does not own (S-2).
    // Legitimately the two always agree, which is the shape a defence should have.
    const ref = attemptRef(gitRunKey, taskId, attempt);
    if (!ref.ok) {
      return this.refuse(
        taskId,
        attempt,
        RECOVERY_WINDOWS.markerMismatched,
        'attempt_marker_mismatch',
        `no attempt ref can be named for ${taskId}: ${ref.refusal.reason}`,
      );
    }
    if (ref.value !== evidence.branch) {
      return this.refuse(
        taskId,
        attempt,
        RECOVERY_WINDOWS.markerMismatched,
        'attempt_marker_mismatch',
        `the evidence for ${taskId} names the branch "${evidence.branch}", and this run's own ` +
          `namespace would name "${ref.value}"`,
      );
    }
    const refName = `refs/heads/${ref.value}`;

    // 5 — was the marker ever published? §17.3 windows 3 and 4.
    //
    // **"The ref does not resolve" is the wrong question, and getting it wrong is
    // silent.** §7.3 creates the attempt branch in the same command as the
    // worktree, at the wave base — so the ref exists from the moment the workspace
    // does, and a crash between the receipt and the marker leaves it resolving to
    // `attempt.base`. A check on resolvability alone would read that as "the
    // marker is here", hand a base commit to the Integrator, and get
    // `attempt_marker_mismatch` for an attempt whose evidence is perfect.
    //
    // So the question is whether the branch ever moved off its base. It cannot
    // have become the marker without moving: a marker's parent *is* the base, and
    // no commit is its own parent. Rebuilding from there is free, because every
    // input to `commit-tree` comes out of the artifact and Git stores the resulting
    // object once (§12.2).
    //
    // A ref that resolves to anything *else* is not republished, and that is
    // §17.3 window 11 in as many words: a marker that exists and does not bind to
    // the receipt "MUST NOT be repaired automatically". The Integrator decides it,
    // because the binding rules are its own — and this path deliberately does not
    // second-guess them.
    const existing = await this.deps.workspaces.revParse({
      cwd: this.deps.projectDir,
      rev: refName,
    });

    let window: RecoveryWindow;

    if (!existing.ok || existing.value === evidence.base) {
      const published = await publishMarker(this.deps, evidence, gitRunKey);
      if (!published.ok) {
        return this.refuse(
          taskId,
          attempt,
          RECOVERY_WINDOWS.markerUnpublished,
          'attempt_marker_missing',
          `the marker for ${taskId} could not be rebuilt from its evidence ` +
            `(${published.failure.code})`,
        );
      }
      window = RECOVERY_WINDOWS.markerUnpublished;
    } else {
      // 6 — which of the remaining windows this is. Asked so the audit trail can
      // say what was found, **not** so anything is decided here: the Integrator
      // asks ancestry again and owns the answer (§14.3 step 5).
      const already = await this.deps.workspaces.isAncestor({
        cwd: this.deps.projectDir,
        ancestor: existing.value,
        descendant: `refs/heads/${request.workspace.branch}`,
      });
      if (!already.ok) {
        return this.refuse(
          taskId,
          attempt,
          RECOVERY_WINDOWS.markerUnmerged,
          'integration_unreadable',
          `the repository could not say whether the marker for ${taskId} is already integrated: ` +
            already.failure.message,
        );
      }

      window = already.value
        ? RECOVERY_WINDOWS.completionUnrecorded
        : context.clearedMerge
          ? RECOVERY_WINDOWS.mergeInterrupted
          : RECOVERY_WINDOWS.markerUnmerged;
    }

    // 7 — hand it to the module that owns integration. Recovery offers the task
    // and the attempt; it passes no `TaskResult`, because no executor ran in this
    // process and the artifact is the only honest source (§17.3 window 7).
    const integrated = await this.deps.integrator.integrate({
      runId: request.runId,
      workspace: request.workspace,
      dag: request.dag,
      attempts: [{ task: taskId, attempt }],
    });

    const outcome = integrated.outcomes.find((entry) => entry.task === taskId);
    if (outcome === undefined || outcome.kind === 'not_reached') {
      return this.refuse(
        taskId,
        attempt,
        window,
        'integration_unreadable',
        `integration returned no outcome for ${taskId}`,
      );
    }

    if (outcome.kind === 'refused') {
      return {
        kind: 'refused',
        task: taskId,
        attempt,
        window,
        state: outcome.state,
        refusal: outcome.refusal,
      };
    }

    await this.deps.store.appendEvent(request.runId, 'integration_recovered', {
      task: taskId,
      attempt,
      window,
    });

    return { kind: 'recovered', task: taskId, attempt, window, state: outcome.state };
  }

  private refuse(
    task: string,
    attempt: number,
    window: RecoveryWindow,
    code: RecoveryRefusalCode,
    detail: string,
  ): TaskRecovery {
    return {
      kind: 'refused',
      task,
      attempt,
      window,
      // Never `failed`: something did run and left evidence. What failed is the
      // claim that it can be finished, and that needs a person.
      state: 'review_required',
      refusal: { code, detail },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unobserved(task: string, attempt: number, reason: string): TaskRecovery {
  return {
    kind: 'requeue',
    task,
    attempt,
    window: RECOVERY_WINDOWS.attemptUnobserved,
    reason,
  };
}

/**
 * The state a non-satisfied artifact already records.
 *
 * **Read back, never re-derived.** `judgeValidation` returns only `completed` or
 * `review_required` (`core/validation-outcome.ts`), so an `unsatisfied` artifact
 * carries a decision that was already `review_required`. `not_reached` has
 * exactly two provenances, because the executor's stage-failure path writes no
 * artifact at all: the agent reported BLOCKED, or the plan named a validation id
 * the configuration no longer resolves. `agentReport.status` tells them apart —
 * a structural field of the artifact, not a sentence in it.
 */
function concludedStateOf(
  judgement: 'unsatisfied' | 'not_reached',
  reported: 'COMPLETED' | 'BLOCKED',
): TaskState {
  if (judgement === 'not_reached' && reported === 'BLOCKED') return 'blocked';
  return 'review_required';
}

/** Whether this outcome stops the run, and the sentence a person reads. */
function haltReasonOf(outcome: TaskRecovery): string | undefined {
  if (outcome.kind === 'refused') {
    return (
      `${outcome.task} could not be recovered: ${outcome.refusal.code} — ` +
      `${outcome.refusal.detail}`
    );
  }
  if (outcome.kind === 'concluded') {
    return `${outcome.task} ended as ${outcome.state}: ${outcome.reason}`;
  }
  return undefined;
}

function halted(reason: string): RunRecoveryOutcome {
  return { outcomes: [], haltedBy: `recovery could not proceed: ${reason}` };
}
