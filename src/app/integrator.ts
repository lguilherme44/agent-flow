import {
  RunnerErrorCodeSchema,
  TaskResultSchema,
  type RunState,
  type TaskAttemptResult,
  type TaskResult,
  type TaskState,
} from '../contracts/index.js';
import type { Clock } from '../ports/index.js';
import type { CommitObject } from '../adapters/git/git-workspaces.js';
import { topologicalOrder, type Dag } from '../core/dag.js';
import { attemptRef, integrationRef, integrationWorkspace } from '../core/worktree-policy.js';
import { MARKER_IDENTITY, readAttempt } from './attempt-receipt.js';
import { runPaths } from './paths.js';
import { decideNamespace, deriveRepoKey, type RepositoryDeps } from './run-git-identity.js';
import type { StateStore } from './state-store.js';

/**
 * Where a validated attempt becomes a completed task (§14).
 *
 * The whole of MVP 2 turns on one sentence, and this module is where it is
 * enforced:
 *
 * > **In worktree mode a validated attempt is not a completed task.** It becomes
 * > one when — and only when — its marker has been merged into the run's
 * > integration branch.
 *
 * So this module owns exactly six things: the run's integration branch and its
 * checkout (§5.3, §14.1), the order merges happen in (§14.2), the mechanical
 * checks that bind an attempt's evidence to a marker (§14.3), the merge itself
 * (§14.5), the conflict path (§15), and the single `StateStore` write that
 * completes a task and advances `integrationHead` together (§14.3 step 7).
 *
 * It deliberately owns nothing else. It does not run an agent, does not run a
 * validation command, does not plan, does not retry, does not clean up, and does
 * not decide how many tasks may run at once. The shape to watch for in review is
 * a function here that takes a runner, a prompt or a concurrency number.
 *
 * **No validation command runs anywhere in this file, and that is not an
 * omission** (§13.2). The RED/GREEN expectation was judged exactly once, by
 * `judgeValidation`, inside the task's own worktree against that task's own base
 * (I-4). Re-running it here would either contradict a `validationExpectation:
 * 'fail'` task that behaved exactly as planned, or need a per-id exception table
 * that reimplements the expectation model at a layer that cannot see the task.
 * Integration checks *mechanical Git integrity* — receipt, marker structure, tree
 * binding, ancestry, merge — and nothing else. Whether the finished tree is green
 * is decided once, by the final `runVerification` over the integration tree
 * (§13.3, §19).
 *
 * The trust order never inverts (§11, §17.1):
 *
 * ```text
 * attempt-<n>.json        ← the authority
 *         ↓
 * receipt (nonce + validated tree)
 *         ↓
 * marker  (exactly one parent, and it is the attempt's base)
 *         ↓
 * Git confirms the tree binding
 * ```
 *
 * Never the other way round. "A ref exists and looks like an Agent Flow marker"
 * is a statement about text a coding agent can write; the trailers are for people
 * and for `git log`, and a marker whose trailers are perfect and whose tree does
 * not match the receipt is refused without repair (I-6, S-9).
 */

// ---------------------------------------------------------------------------
// Refusal vocabulary
// ---------------------------------------------------------------------------

/**
 * Why integration could not proceed.
 *
 * **Every code here is an Appendix A code, and a test enforces that** —
 * `test/app/integration-vocabulary.test.ts` parses the appendix and compares it
 * with this list in both directions. Adding a code here without documenting it
 * fails the suite, which is the point: `integration_unreadable` used to be
 * undocumented, and an undocumented refusal is one a person cannot look up.
 *
 * The grouping below is by *what a person does about it*, not by severity.
 * Contrast `ATTEMPT_EVIDENCE_FAILURES` in `attempt-receipt.ts`, which stays
 * module-local for a reason that survives inspection: those codes are carried in
 * a demoted task's notes, never returned as a run-level refusal, so a person
 * meets them beside the task they belong to rather than looking them up. Every
 * code below halts the run; none is repaired automatically.
 */
export const INTEGRATION_REFUSAL_CODES = [
  // §5.3 — the namespace, before anything is merged.
  'git_identity_missing',
  'git_run_key_collision',
  'namespace_missing',
  'integration_head_diverged',
  'integration_head_missing',
  'integration_worktree_unavailable',
  // §14.3 — one attempt's evidence.
  'attempt_evidence_missing',
  'attempt_evidence_unsatisfied',
  'attempt_marker_missing',
  'attempt_marker_mismatch',
  'integration_history_unrecognised',
  // §15.
  'integration_conflict',
  // Git could not answer a question this sequence depends on.
  'integration_unreadable',
] as const;

export type IntegrationRefusalCode = (typeof INTEGRATION_REFUSAL_CODES)[number];

export interface IntegrationRefusal {
  readonly code: IntegrationRefusalCode;
  /**
   * What went wrong, for a person — and **path-free by construction** (§7.2,
   * §21.3).
   *
   * Assembled from object ids, task ids and this module's own vocabulary, never
   * from Git's stderr: a failed merge names the absolute worktree it ran in, and
   * this sentence reaches a halt reason, a task note and the terminal.
   */
  readonly detail: string;
  /** The conflicting paths, repository-relative, for `integration_conflict`. */
  readonly paths?: readonly string[];
}

// ---------------------------------------------------------------------------
// What the scheduler sees
// ---------------------------------------------------------------------------

/**
 * The run's integration branch and the checkout the merges happen in.
 *
 * **The branch and the worktree are not interchangeable, and the asymmetry is
 * load-bearing** (§14.1). The branch is the *product* — §19.3 tells the user to
 * go and merge it — and it persists for the life of the run. The worktree is only
 * a checkout: pruned, deleted by hand or lost with a cleaned home directory, it is
 * re-created from the branch with nothing lost. A missing *branch* is
 * `namespace_missing` and the run halts, because a worktree is a checkout and a
 * branch is the work.
 */
export interface IntegrationWorkspace {
  /** Absolute, on this machine, and never persisted anywhere (§7.2). */
  readonly path: string;
  /** `agent-flow/<gitRunKey>/integration`. */
  readonly branch: string;
  /** The branch's commit as Git reports it right now. */
  readonly head: string;
}

export type IntegrationPreparation =
  /** Not a worktree run: nothing is integrated and no ref is created (§25.1). */
  | { readonly kind: 'sequential' }
  | { readonly kind: 'ready'; readonly workspace: IntegrationWorkspace }
  | { readonly kind: 'refused'; readonly refusal: IntegrationRefusal };

/** One satisfied attempt, offered for integration. */
export interface WaveAttempt {
  readonly task: string;
  /** The attempt that actually ran, as the dispatch spent it. */
  readonly attempt: number;
  /**
   * What the executor produced. Gains an `integration` block and is persisted.
   *
   * **Absent when the attempt is being recovered** (§17.3): no executor ran in
   * this process, so there is no `TaskResult` in memory and the attempt artifact
   * is the only honest source. {@link resultFromAttempt} reconstructs one — here,
   * in the module that already owns writing `result.json`, so there is still
   * exactly one place that composes one (§26.1, the M2-04/M2-06 rule).
   *
   * Reconstructing rather than reading the previous `result.json` back is also
   * what keeps a repeated conflict idempotent: `abortConflict` appends to
   * `result.notes`, so a recovery pass that fed the file back in would grow the
   * same five notes on every attempt.
   */
  readonly result?: TaskResult;
}

export interface WaveIntegrationRequest {
  readonly runId: string;
  readonly workspace: IntegrationWorkspace;
  /**
   * The plan's graph, so the order comes from `core/dag.ts` and from nothing
   * else (I-2, I-9). This module implements no ordering of its own — see
   * {@link Integrator.integrate}.
   */
  readonly dag: Dag;
  readonly attempts: readonly WaveAttempt[];
}

export type TaskIntegration =
  | {
      readonly kind: 'integrated';
      readonly task: string;
      /** Always `completed`. Returned rather than assumed, so the scheduler
       *  copies a value instead of naming one (§14.4). */
      readonly state: TaskState;
      readonly result: TaskResult;
    }
  | {
      readonly kind: 'refused';
      readonly task: string;
      readonly state: TaskState;
      readonly refusal: IntegrationRefusal;
    }
  /**
   * Offered, and never reached: the wave stopped at an earlier refusal.
   *
   * Reported rather than omitted, so the scheduler is not left holding a task in
   * `running` that nothing is running. Its attempt is valid and its marker exists
   * — what is missing is a decision about the plan, which is what
   * `review_required` says. Unreachable while effective concurrency is one,
   * because a wave then holds a single task (I-11).
   */
  | {
      readonly kind: 'not_reached';
      readonly task: string;
      readonly state: TaskState;
      readonly reason: string;
    };

export interface WaveIntegrationOutcome {
  /** In integration order. Stops at the first refusal (§15). */
  readonly outcomes: readonly TaskIntegration[];
  /** Set when integration refused, with the reason the run halts. */
  readonly haltedBy?: string;
}

/**
 * The narrow view the scheduler holds.
 *
 * Declared here and consumed as a type, so `app/scheduler.ts` keeps importing
 * nothing from `src/adapters/git/` (§26.1 rule 2) and a test can drive the wave
 * loop without a repository.
 */
export interface WaveIntegrator {
  /** §5.3, once, before the first wave. */
  prepare(runId: string): Promise<IntegrationPreparation>;
  /** §9.1 step 1: the commit every task of the next wave is cut from. */
  waveBase(workspace: IntegrationWorkspace): Promise<string | undefined>;
  /** §14.2, §14.3: serial, ordered, mechanically verified. */
  integrate(request: WaveIntegrationRequest): Promise<WaveIntegrationOutcome>;
}

/**
 * The narrower view crash recovery holds (M2-07).
 *
 * Recovery decides *what durable evidence authorises*; it does not merge, does
 * not write `completed` and does not know what a merge commit looks like. So it
 * is handed the two operations §17.3 needs from this module and nothing else —
 * which is also what keeps `git merge` and `git merge --abort` inside the one
 * module §26.1 allows them in.
 */
export interface RecoveryIntegrator {
  integrate(request: WaveIntegrationRequest): Promise<WaveIntegrationOutcome>;
  /** §17.3 window 6. */
  clearInterruptedMerge(workspace: IntegrationWorkspace): Promise<MergeClearance>;
}

export type MergeClearance =
  /** `aborted` is false when there was no merge to abort — not a failure (W6). */
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly refusal: IntegrationRefusal };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface IntegratorDeps extends RepositoryDeps {
  readonly store: StateStore;
  /** Stamps the merge's author and committer dates, and `integratedAt`. */
  readonly clock: Clock;
}

/**
 * Every trailer §12.4 specifies — all ten, compared against the artifact.
 *
 * There is no normative reason to check a subset. An earlier version checked the
 * eight that carry identity and left `Agent-Flow-Validation-Expectation` and
 * `Agent-Flow-Validation-Ids` alone as "informational", which is a judgement this
 * layer has no business making: they are the two trailers that say *what was
 * asked of the validation*, and a marker whose expectation reads `pass` over an
 * artifact that recorded `fail` describes a different task than the one that ran.
 *
 * **They are still not the trust binding.** The receipt's nonce and the tree
 * remain what a marker is believed on (I-5, I-6); these confirm, and a marker
 * whose ten trailers are perfect and whose tree does not match the receipt is
 * refused all the same.
 */
export const MARKER_TRAILERS = [
  'Agent-Flow-Run',
  'Agent-Flow-Run-Key',
  'Agent-Flow-Task',
  'Agent-Flow-Attempt',
  'Agent-Flow-Base',
  'Agent-Flow-Tree',
  'Agent-Flow-Receipt',
  'Agent-Flow-Validation',
  'Agent-Flow-Validation-Expectation',
  'Agent-Flow-Validation-Ids',
] as const;

export class Integrator implements WaveIntegrator, RecoveryIntegrator {
  /**
   * Integration is serial within this process, and this is the whole mechanism.
   *
   * **An in-process promise chain, never a second filesystem lock** (§18.2). The
   * process already holds the run execution lease, so the only thing left to
   * order is two callbacks in one event loop — and a `createExclusive` to do that
   * would be a syscall standing in for a promise, plus a second locking mechanism
   * to keep in step with AF-L01. An architecture test forbids `createExclusive`
   * outside the lock module and must keep forbidding it.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: IntegratorDeps) {}

  // -- §5.3 initialisation and resume -------------------------------------

  /**
   * Brings the run's namespace into the state §5.3 case A, B or D describes.
   *
   * Four states on disk, three of which look alike, and the discriminator is
   * `state.integrationHead` — not `events.jsonl`, which would make the audit trail
   * a second source of truth (I-1), and not `isolationMode`, which is present from
   * the run's first moment and says nothing about whether a ref exists.
   *
   * The decision itself is `decideNamespace`, the pure function M2-03 already
   * tested exhaustively. This performs the *actions* those cases name, which is
   * the half M2-03 deliberately left out.
   */
  async prepare(runId: string): Promise<IntegrationPreparation> {
    const state = await this.deps.store.loadRun(runId);
    if (state.isolationMode !== 'worktree') return { kind: 'sequential' };

    const named = this.namesOf(state);
    if (!named.ok) return { kind: 'refused', refusal: named.refusal };
    const { gitRunKey, branch, refName } = named.value;

    const planningBase = state.planningBase;
    if (planningBase === undefined) {
      return refusePreparation(
        'git_identity_missing',
        'this run records no planning base, so there is no commit to cut its integration branch from',
      );
    }

    const refs = await this.deps.workspaces.refsUnder({
      cwd: this.deps.projectDir,
      // A prefix, never a glob: `…/<key>/*` matches one path component and would
      // silently omit every attempt ref, reporting an empty namespace that is not.
      prefix: `refs/heads/agent-flow/${gitRunKey}`,
    });
    if (!refs.ok) return unreadable(refs.failure.message);

    const decision = decideNamespace({
      integrationHead: state.integrationHead,
      planningBase,
      integrationBranch: refs.value.find((ref) => ref.ref === refName)?.oid,
      otherRefs: refs.value.filter((ref) => ref.ref !== refName).map((ref) => ref.ref),
    });

    if (decision.kind === 'refuse') {
      // `decideNamespace` answers with the §6.3 vocabulary, and every code it can
      // produce here — a collision, a missing namespace — is one this module
      // reports unchanged rather than renaming into something of its own.
      return refusePreparation(decision.code as IntegrationRefusalCode, decision.detail);
    }

    if (decision.kind === 'initialise') {
      const created = await this.deps.workspaces.createBranch({
        cwd: this.deps.projectDir,
        branch,
        at: planningBase,
      });
      if (!created.ok) {
        return refusePreparation(
          'git_run_key_collision',
          `the integration branch for ${gitRunKey} could not be created (${created.failure.code})`,
        );
      }
    }

    // Case D. `integrationHead` being *behind* the branch is not a failure — that
    // is §17.3 window 7, a merge that landed before the state write, and it is
    // reconciled forward rather than refused. Not being an ancestor at all is: the
    // branch was rewound, reset or replaced under a running run, and the state's
    // claim and the repository cannot both be true.
    if (decision.kind === 'resume') {
      const recorded = state.integrationHead;
      if (recorded !== undefined) {
        const contains = await this.deps.workspaces.isAncestor({
          cwd: this.deps.projectDir,
          ancestor: recorded,
          descendant: refName,
        });
        if (!contains.ok) return unreadable(contains.failure.message);
        if (!contains.value) {
          return refusePreparation(
            'integration_head_diverged',
            `the integration branch no longer contains ${recorded.slice(0, 8)}, which this run recorded as integrated`,
          );
        }
      }
    }

    const opened = await this.openWorkspace(state, gitRunKey, branch, refName);
    if (!opened.ok) return { kind: 'refused', refusal: opened.refusal };

    if (decision.kind !== 'resume') {
      // The state write is what makes the run stop asking. Both commands above
      // are safe to repeat — `createBranch` on an existing branch at the same
      // commit is refused harmlessly and case B adopts it, and a worktree is
      // recreatable by definition — so the sequence is safe to interrupt anywhere.
      await this.deps.store.updateRun(runId, (current) => ({
        ...current,
        integrationHead: planningBase,
      }));
      await this.deps.store.appendEvent(runId, 'integration_branch_created', {
        branch,
        base: planningBase,
        adopted: decision.kind === 'adopt',
      });
    }

    return { kind: 'ready', workspace: opened.value };
  }

  /**
   * §9.1 step 1, read from Git rather than from run state.
   *
   * The branch is the durable fact; `integrationHead` is this run's record of it.
   * They agree by construction — the Integrator advances both, Git first — and
   * asking Git is what makes the wave base correct even in the window where a
   * merge landed and the state write did not.
   */
  async waveBase(workspace: IntegrationWorkspace): Promise<string | undefined> {
    const head = await this.deps.workspaces.revParse({
      cwd: this.deps.projectDir,
      rev: `refs/heads/${workspace.branch}`,
    });
    return head.ok ? head.value : undefined;
  }

  // -- §14.2, §14.3 -------------------------------------------------------

  /**
   * Integrates one wave's satisfied attempts, serially, in topological order.
   *
   * **The order is `topologicalOrder(dag)` restricted to this wave, and never
   * completion time** (§14.2, I-2). Two runs of the same plan with the same agent
   * outputs produce the same branch shape: the same markers — identical SHAs,
   * because every input to `commit-tree` comes from the artifact (§12.2) — merged
   * in the same order, producing the same trees. A design that merged in
   * completion order would make the resulting tree a function of how fast each CLI
   * happened to respond that afternoon.
   *
   * **It stops at the first refusal.** A conflict halts the run (§15), and
   * carrying on would merge a dependent onto a branch that does not contain the
   * work it depends on — silent, and only visible three tasks later.
   */
  async integrate(request: WaveIntegrationRequest): Promise<WaveIntegrationOutcome> {
    return this.serialise(() => this.integrateWave(request));
  }

  private async integrateWave(
    request: WaveIntegrationRequest,
  ): Promise<WaveIntegrationOutcome> {
    const offered = new Map(request.attempts.map((attempt) => [attempt.task, attempt]));
    // The plan's stable order, restricted to the tasks of this wave that produced
    // a satisfied attempt. Never completion time, never event timestamps, never a
    // second sort of its own (§14.2, I-2, I-9).
    const scheduled = topologicalOrder(request.dag).filter((id) => offered.has(id));

    const outcomes: TaskIntegration[] = [];
    /** The sibling whose merge moved the head — usually the answer to "why". */
    let previouslyIntegrated: string | undefined;

    for (const [index, taskId] of scheduled.entries()) {
      const attempt = offered.get(taskId);
      if (attempt === undefined) continue;

      const outcome = await this.integrateOne(request, attempt, previouslyIntegrated);
      outcomes.push(outcome);

      if (outcome.kind === 'refused') {
        const reason =
          `${taskId} could not be integrated: ${outcome.refusal.code} — ${outcome.refusal.detail}`;

        // Everything after it is left unmerged, deliberately. In topological
        // order the remainder is either downstream of the refusal or a peer of
        // it, and merging a dependent onto a branch its dependency's work is not
        // on is the failure that stays invisible for three more tasks.
        for (const skipped of scheduled.slice(index + 1)) {
          outcomes.push({
            kind: 'not_reached',
            task: skipped,
            state: 'review_required',
            reason: `the wave stopped before ${skipped} was integrated: ${reason}`,
          });
        }

        return { outcomes, haltedBy: reason };
      }

      previouslyIntegrated = taskId;
    }

    return { outcomes };
  }

  private async integrateOne(
    request: WaveIntegrationRequest,
    offered: WaveAttempt,
    previouslyIntegrated: string | undefined,
  ): Promise<TaskIntegration> {
    const { runId, workspace } = request;
    const refName = `refs/heads/${workspace.branch}`;

    // 1 and 2 — the artifact first, always. Absent or unparseable means the
    // attempt produced no evidence, and evidence is not inferred from a ref.
    const attempt = await readAttempt(this.deps, runId, offered.task, offered.attempt);
    if (attempt === null) {
      return this.refuseTask(
        offered,
        'attempt_evidence_missing',
        `attempt ${String(offered.attempt)} of ${offered.task} left no evidence that parses, ` +
          'so there is nothing bound to a marker',
      );
    }

    const receipt = attempt.receipt;
    if (attempt.validationJudgement !== 'satisfied' || receipt === undefined) {
      return this.refuseTask(
        offered,
        'attempt_evidence_unsatisfied',
        `attempt ${String(offered.attempt)} of ${offered.task} is recorded as ` +
          `${attempt.validationJudgement}, and only a satisfied attempt is integrated`,
      );
    }

    // 3 — the marker must exist as a commit. A branch that never moved off its
    // base is an attempt that was never marked.
    //
    // **The ref is derived, not read.** `attempt.branch` is a field of the
    // artifact, and §11.1 makes the artifact the authority — but the authority
    // over *what was validated*, not over which ref this module then asks Git
    // about. Those are separable, and separating them costs one function call:
    // the run's own identity already decides the ref, through the same
    // `attemptRef` that `TaskWorkspaces` composed it with and that recovery
    // re-derives (§7.3). There is no second ref policy here, only the existing
    // one asked a second time.
    //
    // The recorded value is then required to agree. It is diagnostic — an
    // artifact naming a different branch is an artifact describing a different
    // attempt, and merging what it points at would put work on the integration
    // branch under another attempt's evidence.
    const expected = attemptRef(this.gitRunKeyOf(workspace.branch), offered.task, offered.attempt);
    if (!expected.ok) {
      return this.refuseTask(offered, 'attempt_marker_missing', expected.refusal.reason);
    }
    if (attempt.branch !== expected.value) {
      return this.refuseTask(
        offered,
        'attempt_marker_mismatch',
        `the evidence for ${offered.task} names branch "${attempt.branch}" and attempt ` +
          `${String(offered.attempt)} of this run is "${expected.value}"`,
      );
    }

    const marker = await this.deps.workspaces.revParse({
      cwd: this.deps.projectDir,
      rev: `refs/heads/${expected.value}`,
    });
    if (!marker.ok) {
      return this.refuseTask(
        offered,
        'attempt_marker_missing',
        `the attempt branch for ${offered.task} does not resolve to a commit ` +
          `(${marker.failure.code})`,
      );
    }

    const commit = await this.deps.workspaces.readCommit({
      cwd: this.deps.projectDir,
      oid: marker.value,
    });
    if (!commit.ok) return this.unreadableTask(offered, commit.failure.message);

    const structural = this.checkMarker(attempt, commit.value, marker.value, workspace);
    if (structural !== null) return this.refuseTask(offered, 'attempt_marker_mismatch', structural);

    // 4 — the tree binding (I-6), asked of Git rather than of the object this
    // process is holding. A marker whose trailers are perfect and whose tree does
    // not match the receipt is refused, and never repaired.
    const tree = await this.deps.workspaces.revParseTree({
      cwd: this.deps.projectDir,
      commit: marker.value,
    });
    if (!tree.ok) return this.unreadableTask(offered, tree.failure.message);
    if (tree.value !== receipt.validatedTree) {
      return this.refuseTask(
        offered,
        'attempt_marker_mismatch',
        `the marker for ${offered.task} holds tree ${tree.value.slice(0, 8)} and its receipt ` +
          `names ${receipt.validatedTree.slice(0, 8)}`,
      );
    }

    // 5 — ancestry before the merge. A marker already on the branch was merged by
    // a process that may not have survived to record it; merging again would put
    // a second merge commit on the branch for one task.
    const already = await this.deps.workspaces.isAncestor({
      cwd: this.deps.projectDir,
      ancestor: marker.value,
      descendant: refName,
    });
    if (!already.ok) return this.unreadableTask(offered, already.failure.message);

    if (already.value) {
      return this.reconcile(request, offered, attempt, marker.value);
    }

    // What the task produced, from the executor when it ran in this process and
    // from the artifact when this is a recovery pass (§17.3). Resolved once, here,
    // so the two writers below cannot disagree about which it was.
    const produced = offered.result ?? resultFromAttempt(attempt);

    // 6 — the merge (§14.5).
    const at = this.deps.clock.now();
    const merged = await this.deps.workspaces.merge({
      cwd: workspace.path,
      commit: marker.value,
      message: integrationMessage(attempt, this.gitRunKeyOf(workspace.branch), marker.value),
      // The same fixed identity §12.2 gives a marker: a machine-made commit
      // attributed to a person is a statement that is not true. The dates come
      // from the injected `Clock` rather than from the artifact, because a merge
      // is not reproducible across runs and §14.2 declines to claim it is.
      identity: MARKER_IDENTITY,
      dates: { author: at, committer: at },
    });
    if (!merged.ok) {
      return this.refuseTask(
        offered,
        'integration_worktree_unavailable',
        `the integration worktree could not merge ${offered.task} (${merged.failure.code})`,
      );
    }

    if (merged.value.kind === 'conflict') {
      return this.abortConflict(request, offered, produced, {
        paths: merged.value.paths,
        base: attempt.base,
        marker: marker.value,
        ...(previouslyIntegrated === undefined ? {} : { previouslyIntegrated }),
      });
    }

    const mergeCommit = await this.confirmMerge(workspace, marker.value);
    if (!mergeCommit.ok) return this.refuseTask(offered, mergeCommit.code, mergeCommit.detail);

    return this.complete(request, offered, attempt, {
      marker: marker.value,
      mergeCommit: mergeCommit.value,
      integratedAt: at,
      advanceTo: mergeCommit.value,
    });
  }

  /**
   * §17.3 window 6: leaves the integration worktree in a known state.
   *
   * The presence of `MERGE_HEAD` is the discriminator, asked before anything is
   * done — because `merge --abort` exits non-zero when there is no merge to abort
   * (deliberately, so that "there was one and it is undone" and "there never was
   * one" stay apart), and a caller that just tried it and ignored the failure
   * would make the window undetectable.
   *
   * **Never forced.** If the abort itself fails, the worktree is not in a state
   * this module can describe, and the run halts rather than resetting over it.
   */
  async clearInterruptedMerge(workspace: IntegrationWorkspace): Promise<MergeClearance> {
    const head = await this.deps.workspaces.mergeHead({ cwd: workspace.path });
    if (!head.ok) {
      return {
        ok: false,
        refusal: {
          code: 'integration_unreadable',
          detail:
            'the integration worktree could not be asked whether a merge is in progress: ' +
            head.failure.message,
        },
      };
    }
    if (head.value === null) return { ok: true, aborted: false };

    const aborted = await this.deps.workspaces.abortMerge({ cwd: workspace.path });
    if (!aborted.ok) {
      return {
        ok: false,
        refusal: {
          code: 'integration_worktree_unavailable',
          detail:
            `an interrupted merge of ${head.value.slice(0, 8)} could not be aborted ` +
            `(${aborted.failure.code}), so the integration worktree is not in a known state`,
        },
      };
    }

    return { ok: true, aborted: true };
  }

  /**
   * §14.3 step 5's other branch: the merge already happened.
   *
   * Named rather than skipped, because a task whose marker is on the branch but
   * whose state does not say `completed` is §17.3 window 7 — the merge landed and
   * the process died before the state write. The resolution is to *record* what
   * Git already did, never to do it again.
   *
   * The merge commit is found by walking the branch for a merge whose second
   * parent is this marker. Finding none means the marker reached the branch some
   * other way — a reset, a rebuilt branch — and that is refused rather than
   * guessed at: writing a `TaskResult` naming a merge that does not exist would be
   * the artifact lying about the repository.
   */
  private async reconcile(
    request: WaveIntegrationRequest,
    offered: WaveAttempt,
    attempt: TaskAttemptResult,
    marker: string,
  ): Promise<TaskIntegration> {
    const found = await this.deps.workspaces.mergeIntroducing({
      cwd: this.deps.projectDir,
      commit: marker,
      branch: `refs/heads/${request.workspace.branch}`,
    });
    if (!found.ok) return this.unreadableTask(offered, found.failure.message);

    if (found.value === null) {
      return this.refuseTask(
        offered,
        'integration_history_unrecognised',
        `the marker for ${offered.task} is already on the integration branch, and no merge ` +
          'commit on that branch introduced it',
      );
    }

    // The same structural check a fresh merge gets (§14.7): exactly two parents,
    // and the second is this marker. `mergeIntroducing` already filters on that
    // shape, and it is asserted again here from the commit object itself — "the
    // marker appears somewhere in the ancestry" is not what step 5 is allowed to
    // conclude from, and the two readings must not be able to drift apart.
    const introducing = await this.deps.workspaces.readCommit({
      cwd: this.deps.projectDir,
      oid: found.value,
    });
    if (!introducing.ok) return this.unreadableTask(offered, introducing.failure.message);

    if (introducing.value.parents.length !== 2 || introducing.value.parents[1] !== marker) {
      return this.refuseTask(
        offered,
        'integration_history_unrecognised',
        `the commit that appears to have integrated ${offered.task} has ` +
          `${String(introducing.value.parents.length)} parent(s) and does not name the marker ` +
          'as its second, so it is not the merge this task was integrated by',
      );
    }

    // Only forward. In the window this path exists for, the reconciled merge *is*
    // the branch head; if later merges have landed since, the recorded head is
    // already ahead of it and moving it back would make the run's state describe
    // an earlier repository than the one on disk.
    const recorded = (await this.deps.store.loadRun(request.runId)).integrationHead;
    const advanceTo = await this.laterOf(recorded, found.value);
    if (advanceTo === null) {
      return this.unreadableTask(offered, 'the recorded integration head could not be compared');
    }

    return this.complete(request, offered, attempt, {
      marker,
      mergeCommit: found.value,
      integratedAt: this.deps.clock.now(),
      advanceTo,
    });
  }

  /**
   * §15: collect the paths, abort, halt.
   *
   * The abort comes *after* the paths are read, because `git merge --abort`
   * returns the worktree to its pre-merge state and takes the unmerged index with
   * it — and those paths are usually the actual answer to "why did this conflict".
   *
   * **Nothing here resolves anything.** No LLM is asked, no corrective task is
   * generated, no other model is tried, no merge is forced. Two independent tasks
   * touching the same lines is not a bug in the merge; it is a plan whose
   * independence analysis was wrong, and all three of those would make a wrong
   * plan look like it worked.
   */
  private async abortConflict(
    request: WaveIntegrationRequest,
    offered: WaveAttempt,
    produced: TaskResult,
    conflict: {
      readonly paths: readonly string[];
      readonly base: string;
      readonly marker: string;
      readonly previouslyIntegrated?: string;
    },
  ): Promise<TaskIntegration> {
    // Read before the abort: `merge --abort` returns the worktree to its
    // pre-merge state, and after it the branch head is the answer to "what did
    // this conflict against". Reading it first would give the same value, and
    // reading it here keeps the two facts adjacent in the record.
    const head = await this.deps.workspaces.revParse({
      cwd: this.deps.projectDir,
      rev: `refs/heads/${request.workspace.branch}`,
    });

    const aborted = await this.deps.workspaces.abortMerge({ cwd: request.workspace.path });
    if (!aborted.ok) {
      return this.refuseTask(
        offered,
        'integration_worktree_unavailable',
        `the conflicted merge of ${offered.task} could not be aborted ` +
          `(${aborted.failure.code}), so the integration worktree is not in a known state`,
      );
    }

    // Exactly the keys Appendix B specifies: no absolute path, and no free-text
    // detail either. The richer record — the base, the marker, the head at the
    // moment of the attempted merge — belongs on the task's `TaskResult` (§15),
    // where a person reads it about one task rather than anything consuming an
    // event contract.
    await this.deps.store.appendEvent(request.runId, 'integration_conflict', {
      task: offered.task,
      attempt: offered.attempt,
      paths: conflict.paths,
      ...(conflict.previouslyIntegrated === undefined
        ? {}
        : { previouslyIntegrated: conflict.previouslyIntegrated }),
    });

    const refusal: IntegrationRefusal = {
      code: 'integration_conflict',
      detail:
        `${offered.task} conflicts with work already on the integration branch in ` +
        `${String(conflict.paths.length)} file(s): ${conflict.paths.slice(0, 5).join(', ')}`,
      paths: conflict.paths,
    };

    await this.writeResult(request.runId, {
      ...produced,
      status: 'review_required',
      notes: [
        ...produced.notes,
        refusal.detail,
        `attempt ${String(offered.attempt)} was validated on base ${conflict.base}`,
        `its marker ${conflict.marker} was not merged`,
        `the integration head at the attempted merge was ${head.ok ? head.value : 'unreadable'}`,
        ...(conflict.previouslyIntegrated === undefined
          ? []
          : [
              `the sibling integrated immediately before it was ${conflict.previouslyIntegrated}, ` +
                'whose merge moved that head',
            ]),
      ],
    });

    return { kind: 'refused', task: offered.task, state: 'review_required', refusal };
  }

  /**
   * §14.3 step 7 — the Git fact first, then the durable state, in one write.
   *
   * The ordering is the invariant: the merge exists in the repository before
   * anything claims it does. A state file that named a merge Git had not made
   * would be a claim recovery believes, and recovery has no way to disbelieve it.
   *
   * **`completed` and `integrationHead` move in a single `StateStore` write.**
   * Splitting them would create a second version of §17.3 window 7 for every
   * merge — a task marked done on a branch whose recorded head does not contain
   * it, or the reverse — and the single-writer queue makes one write the cheaper
   * option anyway.
   */
  private async complete(
    request: WaveIntegrationRequest,
    offered: WaveAttempt,
    attempt: TaskAttemptResult,
    landed: {
      readonly marker: string;
      readonly mergeCommit: string;
      readonly integratedAt: string;
      readonly advanceTo: string;
    },
  ): Promise<TaskIntegration> {
    const receipt = attempt.receipt;
    const result = TaskResultSchema.parse({
      ...(offered.result ?? resultFromAttempt(attempt)),
      status: 'completed',
      integration: {
        attempt: attempt.attempt,
        branch: request.workspace.branch,
        marker: landed.marker,
        mergeCommit: landed.mergeCommit,
        base: attempt.base,
        validatedTree: receipt?.validatedTree ?? '',
        integratedAt: landed.integratedAt,
      },
    });

    // The artifact before the state, for the same reason the merge comes before
    // both: a run whose state says `completed` and whose `result.json` is absent
    // is a run that lost the only record of what the task produced.
    await this.writeResult(request.runId, result);

    await this.deps.store.updateRun(request.runId, (current) => ({
      ...current,
      integrationHead: landed.advanceTo,
      tasks: current.tasks.map((task) =>
        task.id === offered.task ? { ...task, state: 'completed' as const } : task,
      ),
    }));

    await this.deps.store.appendEvent(request.runId, 'task_integrated', {
      task: offered.task,
      attempt: attempt.attempt,
      marker: landed.marker,
      mergeCommit: landed.mergeCommit,
    });

    return { kind: 'integrated', task: offered.task, state: 'completed', result };
  }

  // -- §19: the tree final verification and final review both observe -----

  /**
   * The integration worktree, pinned to the commit the run recorded (§19.2).
   *
   * One tree, one commit, three consumers: `runVerification`, the reviewer's
   * `GitClient` and the Definition of Done. `state.integrationHead` is read once
   * and the branch is required to still be there, because a run cannot honestly
   * be reviewed against a commit its own state does not name — and "verified tree
   * A, reviewed tree B" is the failure that would make a green run mean nothing.
   */
  async openForReview(runId: string): Promise<IntegrationPreparation> {
    const state = await this.deps.store.loadRun(runId);
    if (state.isolationMode !== 'worktree') return { kind: 'sequential' };

    const named = this.namesOf(state);
    if (!named.ok) return { kind: 'refused', refusal: named.refusal };
    const { gitRunKey, branch, refName } = named.value;

    const recorded = state.integrationHead;
    if (recorded === undefined) {
      return refusePreparation(
        'integration_head_missing',
        'this run has not initialised its integration branch, so there is no tree to review',
      );
    }

    const head = await this.deps.workspaces.revParse({ cwd: this.deps.projectDir, rev: refName });
    if (!head.ok) {
      return refusePreparation(
        'namespace_missing',
        `the integration branch for ${gitRunKey} is gone from the repository`,
      );
    }
    if (head.value !== recorded) {
      return refusePreparation(
        'integration_head_diverged',
        `this run recorded ${recorded.slice(0, 8)} as its integration head and the branch is at ` +
          `${head.value.slice(0, 8)}`,
      );
    }

    const opened = await this.openWorkspace(state, gitRunKey, branch, refName);
    if (!opened.ok) return { kind: 'refused', refusal: opened.refusal };

    return { kind: 'ready', workspace: { ...opened.value, head: recorded } };
  }

  // -- plumbing -----------------------------------------------------------

  /**
   * Ensures the integration branch is checked out, re-creating the checkout when
   * it is gone (§14.1).
   *
   * A worktree whose directory was removed by hand leaves its registration
   * behind, and a *locked* registration is not pruned — probed on 2.52.0:
   * `worktree add` then refuses with "missing but locked worktree". So the
   * recreation is unlock, prune, add, in that order. None of it is destructive:
   * every step acts on a registration whose directory has already gone.
   */
  private async openWorkspace(
    state: RunState,
    gitRunKey: string,
    branch: string,
    refName: string,
  ): Promise<
    { readonly ok: true; readonly value: IntegrationWorkspace }
    | { readonly ok: false; readonly refusal: IntegrationRefusal }
  > {
    const repoKey = await deriveRepoKey(this.deps);
    if (repoKey === null) {
      return unavailable('the repository root could not be resolved');
    }

    const location = integrationWorkspace(repoKey, gitRunKey);
    if (!location.ok) return unavailable(location.refusal.reason);

    const path = this.deps.workspaces.workspacePath(location.value);
    if (!path.ok) return unavailable(`the integration workspace could not be placed`);

    const listed = await this.deps.workspaces.listWorktrees({ cwd: this.deps.projectDir });
    if (!listed.ok) return unavailable(`the worktree registry could not be read`);

    const real = (await this.deps.fs.realPath(path.value)) ?? path.value;
    const registered = listed.value.find(
      (entry) => entry.path === path.value || entry.path === real,
    );

    if (await this.deps.fs.exists(path.value)) {
      if (registered === undefined || registered.branch !== refName) {
        return unavailable(
          'a directory is already at the integration workspace and it is not this run’s checkout',
        );
      }
      return { ok: true, value: await this.describe(branch, path.value, state) };
    }

    if (registered !== undefined) {
      // Clear the stale registration the removed directory left behind. Both
      // calls act on a worktree that no longer exists on disk, so neither can
      // discard anything: `unlock` edits an administrative file and `prune`
      // removes exactly the records whose directories are gone.
      await this.deps.workspaces.unlockWorktree({
        cwd: this.deps.projectDir,
        location: location.value,
      });
      const pruned = await this.deps.workspaces.pruneWorktrees({ cwd: this.deps.projectDir });
      if (!pruned.ok) return unavailable('a stale integration checkout could not be cleared');
    }

    const added = await this.deps.workspaces.addWorktree({
      cwd: this.deps.projectDir,
      location: location.value,
      // No `-b`: the branch is the product and already exists. This is a checkout
      // of it, which is the whole of what a worktree is here.
      base: branch,
      reason: `agent-flow ${gitRunKey} integration`,
    });
    if (!added.ok) {
      return unavailable(`the integration checkout could not be created (${added.failure.code})`);
    }

    return { ok: true, value: await this.describe(branch, added.value, state) };
  }

  private async describe(
    branch: string,
    path: string,
    state: RunState,
  ): Promise<IntegrationWorkspace> {
    const head = await this.deps.workspaces.revParse({
      cwd: this.deps.projectDir,
      rev: `refs/heads/${branch}`,
    });
    return {
      path,
      branch,
      head: head.ok ? head.value : (state.integrationHead ?? state.planningBase ?? ''),
    };
  }

  /** The run's namespace names, or the refusal that says it has none. */
  private namesOf(
    state: RunState,
  ):
    | {
        readonly ok: true;
        readonly value: { gitRunKey: string; branch: string; refName: string };
      }
    | { readonly ok: false; readonly refusal: IntegrationRefusal } {
    const gitRunKey = state.gitRunKey;
    if (gitRunKey === undefined) {
      return {
        ok: false,
        refusal: {
          code: 'git_identity_missing',
          detail: 'this run has no Git namespace, so it has no integration branch',
        },
      };
    }

    const branch = integrationRef(gitRunKey);
    if (!branch.ok) {
      return {
        ok: false,
        refusal: { code: 'git_identity_missing', detail: branch.refusal.reason },
      };
    }

    return {
      ok: true,
      value: { gitRunKey, branch: branch.value, refName: `refs/heads/${branch.value}` },
    };
  }

  /**
   * The marker's structure and its trailers, against the artifact (§14.3 step 3).
   *
   * **Exactly one parent, not "the first parent is the base"** (§14.7). The
   * parent count is the structural discriminator between a marker and a merge, so
   * a forged merge commit whose first parent happens to be correct is refused
   * here rather than merged and discovered later.
   *
   * The trailers are checked last and are a *confirmation*, never the authority:
   * everything above them already bound the marker to the artifact, and a marker
   * that passes them and fails the tree binding is still refused (I-6).
   */
  private checkMarker(
    attempt: TaskAttemptResult,
    commit: CommitObject,
    marker: string,
    workspace: IntegrationWorkspace,
  ): string | null {
    if (commit.parents.length !== 1) {
      return (
        `the marker for ${attempt.task} has ${String(commit.parents.length)} parent(s); a marker ` +
        'has exactly one, and a commit with two is an integration merge'
      );
    }

    if (commit.parents[0] !== attempt.base) {
      return (
        `the marker for ${attempt.task} sits on ${(commit.parents[0] ?? '').slice(0, 8)} and its ` +
        `evidence names ${attempt.base.slice(0, 8)} as the base it was validated against`
      );
    }

    const trailers = parseTrailers(commit.message);
    const expected = new Map<string, string>([
      ['Agent-Flow-Run', attempt.run],
      ['Agent-Flow-Run-Key', this.gitRunKeyOf(workspace.branch)],
      ['Agent-Flow-Task', attempt.task],
      ['Agent-Flow-Attempt', String(attempt.attempt)],
      ['Agent-Flow-Base', attempt.base],
      ['Agent-Flow-Tree', attempt.receipt?.validatedTree ?? ''],
      ['Agent-Flow-Receipt', attempt.receipt?.nonce ?? ''],
      ['Agent-Flow-Validation', attempt.validationJudgement],
      ['Agent-Flow-Validation-Expectation', attempt.validation.expectation],
      // Comma-separated, no spaces, exactly as `markerMessage` composes it. An
      // attempt that named no validation ids produces an empty value, which is a
      // trailer with nothing after the colon — see {@link parseTrailers}.
      ['Agent-Flow-Validation-Ids', attempt.validation.ids.join(',')],
    ]);

    for (const name of MARKER_TRAILERS) {
      const found = trailers.get(name);
      if (found === undefined) {
        return `the marker ${marker.slice(0, 8)} for ${attempt.task} carries no ${name} trailer`;
      }
      if (found !== expected.get(name)) {
        return `the ${name} trailer of ${marker.slice(0, 8)} disagrees with the attempt's evidence`;
      }
    }

    return null;
  }

  /**
   * The commit the merge produced, proved to be one (§14.5, §14.7).
   *
   * Two parents and the second is the marker: that is what `--no-ff` guarantees
   * and what a fast-forward would not. Checked rather than assumed, because "one
   * task, one merge commit" is the property that makes "was this integrated"
   * answerable by looking at the branch.
   */
  private async confirmMerge(
    workspace: IntegrationWorkspace,
    marker: string,
  ): Promise<
    { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly code: IntegrationRefusalCode; readonly detail: string }
  > {
    const head = await this.deps.workspaces.revParse({ cwd: workspace.path, rev: 'HEAD' });
    if (!head.ok) {
      return {
        ok: false,
        code: 'integration_unreadable',
        detail: `the integration branch head could not be read (${head.failure.code})`,
      };
    }

    const commit = await this.deps.workspaces.readCommit({
      cwd: this.deps.projectDir,
      oid: head.value,
    });
    if (!commit.ok) {
      return {
        ok: false,
        code: 'integration_unreadable',
        detail: `the merge commit could not be read (${commit.failure.code})`,
      };
    }

    if (commit.value.parents.length !== 2 || commit.value.parents[1] !== marker) {
      return {
        ok: false,
        code: 'integration_history_unrecognised',
        detail:
          `merging ${marker.slice(0, 8)} did not produce a merge commit with it as the second ` +
          'parent, so the branch does not have one merge per task',
      };
    }

    return { ok: true, value: head.value };
  }

  /** The later of two commits by ancestry, or `null` when Git cannot say. */
  private async laterOf(recorded: string | undefined, candidate: string): Promise<string | null> {
    if (recorded === undefined) return candidate;
    if (recorded === candidate) return candidate;

    const behind = await this.deps.workspaces.isAncestor({
      cwd: this.deps.projectDir,
      ancestor: recorded,
      descendant: candidate,
    });
    if (!behind.ok) return null;
    return behind.value ? candidate : recorded;
  }

  /**
   * `<taskId>/result.json`, written by this module and by no other in worktree
   * mode (§10.1, §10.3).
   *
   * The executor writes one only for a sequential run. Here it is written *after*
   * the merge, because in worktree mode a task's outcome is decided at
   * integration — a file on disk saying `"status": "completed"` for work that has
   * not reached the integration branch is a lie recovery would believe (I-3).
   */
  private async writeResult(runId: string, result: unknown): Promise<void> {
    const parsed = TaskResultSchema.parse(result);
    const path = runPaths(this.deps.projectDir, runId).taskResult(parsed.task);
    await this.deps.fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
    await this.deps.fs.writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  /** `agent-flow/<gitRunKey>/integration` → `<gitRunKey>`. */
  private gitRunKeyOf(branch: string): string {
    return branch.split('/')[1] ?? '';
  }

  private refuseTask(
    offered: WaveAttempt,
    code: IntegrationRefusalCode,
    detail: string,
  ): TaskIntegration {
    return {
      kind: 'refused',
      task: offered.task,
      // Never `failed`: something *did* run and produced a validated tree. What
      // failed is the claim that it can be integrated, and that needs a person.
      state: 'review_required',
      refusal: { code, detail },
    };
  }

  private unreadableTask(offered: WaveAttempt, message: string): TaskIntegration {
    return this.refuseTask(
      offered,
      'integration_unreadable',
      `the repository could not answer a question integration depends on: ${message}`,
    );
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ---------------------------------------------------------------------------
// Reconstruction (§17.3 window 7)
// ---------------------------------------------------------------------------

/**
 * The `TaskResult` an attempt's own evidence supports.
 *
 * Used when no executor ran in this process — a recovery pass over an attempt
 * that finished before the crash (§17.3). **Nothing here is invented.** Every
 * field is read out of `attempt-<n>.json`: the runner, the model, the reasoning
 * level and the validation commands are what actually ran, recorded by the
 * process that ran them. `status` is deliberately absent — this module decides
 * it, as it always has, and the artifact has no `status` field precisely so that
 * nothing can mistake an attempt for an outcome (§10.2).
 *
 * It lives here rather than in the recovery module because §26.1 keeps the set of
 * modules that may compose a `TaskResult` at two, and "only the module that
 * actually ran something can fill those in honestly" is satisfied by reading the
 * record that module wrote.
 *
 * `errorCode` is filtered rather than copied: the artifact types it as a free
 * string and `TaskResult` types it as a `RunnerErrorCode`, so a value outside
 * that enum would make this throw — inside a recovery pass, where a throw costs
 * the run its chance to report anything at all.
 */
export function resultFromAttempt(attempt: TaskAttemptResult): TaskResult {
  const errorCode = RunnerErrorCodeSchema.safeParse(attempt.errorCode);

  return TaskResultSchema.parse({
    task: attempt.task,
    // Replaced by every caller. Present because the schema requires one, and
    // `review_required` is the honest placeholder: an attempt whose outcome this
    // module has not decided yet is one a person would have to look at.
    status: 'review_required',
    runner: attempt.runner,
    ...(attempt.model === undefined ? {} : { model: attempt.model }),
    reasoning: attempt.reasoning,
    reasoningClamped: attempt.reasoningClamped,
    ...(attempt.fallback === undefined ? {} : { fallback: attempt.fallback }),
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    filesChanged: attempt.filesChanged,
    validation: {
      passed: attempt.validation.passed,
      expectation: attempt.validation.expectation,
      commands: attempt.validation.commands,
    },
    notes: [
      ...attempt.agentReport.notes,
      ...attempt.agentReport.deviations.map((deviation) => `deviation: ${deviation}`),
    ],
    ...(errorCode.success ? { errorCode: errorCode.data } : {}),
  });
}

// ---------------------------------------------------------------------------
// Messages and trailers
// ---------------------------------------------------------------------------

/**
 * §14.6's message, verbatim in shape.
 *
 * Structurally distinguishable from a marker's message by construction (§14.7):
 * the subject says `integrate`, `Agent-Flow-Marker` is present and
 * `Agent-Flow-Tree` is absent. None of that is what code decides on — the parent
 * count is — but a person reading `git log` on the integration branch deserves to
 * know which kind of commit each one is.
 */
export function integrationMessage(
  attempt: TaskAttemptResult,
  gitRunKey: string,
  marker: string,
): string {
  const attemptNumber = String(attempt.attempt);

  const trailers = [
    ['Agent-Flow-Run', attempt.run],
    ['Agent-Flow-Run-Key', gitRunKey],
    ['Agent-Flow-Task', attempt.task],
    ['Agent-Flow-Attempt', attemptNumber],
    ['Agent-Flow-Marker', marker],
    ['Agent-Flow-Receipt', attempt.receipt?.nonce ?? ''],
    ['Agent-Flow-Wave-Base', attempt.base],
  ] as const;

  return [
    `agent-flow: integrate ${attempt.task} (attempt ${attemptNumber})`,
    '',
    ...trailers.map(([name, value]) => `${name}: ${value}`),
  ].join('\n');
}

/**
 * The `Agent-Flow-*` trailers of a commit message.
 *
 * A repeated name is recorded as unusable rather than resolved to one of its
 * values: the message is the one part of a marker a coding agent can influence,
 * and picking the first or the last occurrence would let a forgery decide which
 * one the check reads.
 */
export function parseTrailers(message: string): Map<string, string> {
  const trailers = new Map<string, string>();
  const seen = new Set<string>();

  for (const line of message.split('\n')) {
    // The separating space is optional, and that is not tolerance for sloppy
    // input — it is the empty value. A task that named no validation ids gets
    // `Agent-Flow-Validation-Ids: ` from §12.4's composition, and whether that
    // trailing space survives depends on how the message reached `commit-tree`
    // (probed: through stdin it does, and message normalisation may strip it).
    // A pattern that required the space would read a legitimately empty trailer
    // as an absent one and refuse a marker that is perfectly correct.
    const match = /^(Agent-Flow-[A-Za-z-]+):[ \t]?(.*)$/.exec(line.replace(/\s+$/, ''));
    if (match === null) continue;

    const [, name] = match;
    if (name === undefined) continue;
    const value = match[2] ?? '';

    if (seen.has(name)) {
      trailers.set(name, DUPLICATE_TRAILER);
      continue;
    }
    seen.add(name);
    trailers.set(name, value);
  }

  return trailers;
}

/**
 * The value a repeated trailer collapses to.
 *
 * It contains a newline, and that is what makes it impossible rather than merely
 * unlikely: a parsed trailer value comes from inside one line, so no marker any
 * agent can write produces this string and no comparison against the artifact can
 * accidentally succeed. A sentinel that merely looked improbable would be a value
 * somebody could eventually supply.
 */
const DUPLICATE_TRAILER = '\nrepeated';

// ---------------------------------------------------------------------------
// Refusal helpers
// ---------------------------------------------------------------------------

function refusePreparation(
  code: IntegrationRefusalCode,
  detail: string,
): IntegrationPreparation {
  return { kind: 'refused', refusal: { code, detail } };
}

function unreadable(message: string): IntegrationPreparation {
  return refusePreparation(
    'integration_unreadable',
    `the repository could not answer a question the integration branch depends on: ${message}`,
  );
}

function unavailable(
  detail: string,
): { readonly ok: false; readonly refusal: IntegrationRefusal } {
  return { ok: false, refusal: { code: 'integration_worktree_unavailable', detail } };
}
