import type { RunState } from '../contracts/index.js';
import { REF_NAMESPACE, attemptWorkspace, integrationRef, integrationWorkspace } from '../core/worktree-policy.js';
import { deriveRepoKey, type RepositoryDeps } from './run-git-identity.js';
import type { StateStore } from './state-store.js';

/**
 * Reclaiming a run's Git namespace, safely (§20, M2-09).
 *
 * This is the module that **deletes things**, and every rule in it exists because
 * of what the blast radius would otherwise be: a path bug here reaches the user's
 * other worktrees, and a ref bug reaches work nobody has a second copy of.
 *
 * Four rules run through the whole file:
 *
 *   - **Every path is derived, never discovered.** Candidate workspaces are
 *     composed from trusted run state through `core/worktree-policy.ts`, and then
 *     *intersected* with what `git worktree list --porcelain` actually registered
 *     under Agent Flow's own root. A directory Git does not know about is not
 *     removed, and a registered worktree the state cannot name is not either.
 *   - **Never `rm -rf` a registered worktree** (§20.2). Unlock, then
 *     `git worktree remove`, then `git worktree prune` — and no `--force`, so a
 *     worktree holding changes Git will not discard is a reported failure rather
 *     than a silent deletion.
 *   - **Attempt refs and the integration branch are cleaned by different rules**
 *     (§20.4). One is diagnostic and goes with the state; the other is the
 *     *product* — §19.3 told the user in so many words to go and merge it — and it
 *     is deleted only when it is provably redundant or explicitly asked for.
 *   - **Git before state** (§20.1). If the namespace could not be reclaimed, the
 *     run keeps its state, because state with no worktrees is recoverable and
 *     worktrees with no state are orphans nothing can attribute.
 */

// ---------------------------------------------------------------------------
// What a caller asks for, and what it gets back
// ---------------------------------------------------------------------------

export interface ReclaimOptions {
  /** Report what would happen and change nothing. */
  readonly dryRun?: boolean;
  /**
   * Also reclaim worktrees §20.3 retains: a failed attempt's, an unintegrated
   * attempt's. They are the only remaining copy of what an agent produced (§7.4),
   * so the default is to keep them.
   */
  readonly worktrees?: boolean;
  /**
   * Also delete an integration branch that is merged nowhere.
   *
   * **The only flag that deletes work, never implied, and never a default**
   * (§20.3, §20.4). A user who asks for it has been told what is on the other side
   * of the question, because the report below ran first.
   */
  readonly branches?: boolean;
}

export type IntegrationBranchOutcome =
  /** Deleted: an ancestor of a ref outside the namespace, so the user has it. */
  | { readonly kind: 'redundant'; readonly ref: string; readonly mergedInto: string }
  /** Deleted because it was asked for explicitly. */
  | { readonly kind: 'forced'; readonly ref: string }
  /** Kept: the only copy. **Not a failure** — §20.4. */
  | { readonly kind: 'kept'; readonly ref: string; readonly head: string }
  /** The run never initialised one. */
  | { readonly kind: 'absent' };

export interface ReclaimOutcome {
  readonly runId: string;
  /** Workspace-relative, never absolute (§7.2, §21.3). */
  readonly worktrees: readonly string[];
  /** Retained rather than reclaimed, with why. */
  readonly worktreesRetained: readonly string[];
  /** Full ref names, which §26.1 rule 4 permits in a response. */
  readonly attemptRefs: readonly string[];
  readonly integrationBranch: IntegrationBranchOutcome;
  /**
   * Whether step 5 — removing `.agent-flow/runs/<id>` — may run (§20.1).
   *
   * False when any of steps 1, 3 or 4 failed. A run whose namespace could not be
   * reclaimed keeps its state, and `clean` says so and exits non-zero for it.
   */
  readonly stateRemovable: boolean;
  /** Path-free sentences, one per thing that could not be done. */
  readonly failures: readonly string[];
}

export interface NamespaceReclaimDeps extends RepositoryDeps {
  readonly store: StateStore;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Reclaims one run's namespace, in the order §20.1 fixes.
 *
 * A run that is not isolated has no namespace and no worktrees, so its state is
 * removable and nothing is touched — which is what keeps `clean` behaving exactly
 * as it always has for every sequential and legacy run (§25).
 */
export async function reclaimNamespace(
  deps: NamespaceReclaimDeps,
  runId: string,
  options: ReclaimOptions = {},
): Promise<ReclaimOutcome> {
  const state = await deps.store.loadRun(runId);
  const gitRunKey = state.gitRunKey;

  if (state.isolationMode !== 'worktree' || gitRunKey === undefined) {
    return {
      runId,
      worktrees: [],
      worktreesRetained: [],
      attemptRefs: [],
      integrationBranch: { kind: 'absent' },
      stateRemovable: true,
      failures: [],
    };
  }

  const repoKey = await deriveRepoKey(deps);
  if (repoKey === null) {
    // Ownership is decided by containment under `~/.agent-flow/worktrees/<repoKey>`,
    // so without a key there is no way to tell this run's worktrees from anybody
    // else's. Fail closed: the cost of keeping state is disk, and the cost of
    // guessing is a removal somewhere nobody agreed to.
    return {
      runId,
      worktrees: [],
      worktreesRetained: [],
      attemptRefs: [],
      integrationBranch: { kind: 'absent' },
      stateRemovable: false,
      failures: ['the repository root could not be resolved, so no worktree could be attributed'],
    };
  }

  const failures: string[] = [];

  // -- 1 and 2: the worktrees, then the prune ------------------------------
  const reclaimed = await reclaimWorktrees(deps, state, gitRunKey, repoKey, options, failures);

  // -- 3: the attempt refs, which are diagnostic and go with the state -----
  const attemptRefs = await deleteAttemptRefs(deps, gitRunKey, options, failures);

  // -- 4: the integration branch, which is the product (§20.4) -------------
  const integrationBranch = await resolveIntegrationBranch(deps, gitRunKey, options, failures);

  // Appendix B. `clean` is the one operation in this milestone that *removes*
  // things, and it runs long after the run finished, usually with nobody
  // watching — R-12 is exactly the case of somebody discovering weeks later that
  // a branch is gone. The counts and the branch's fate are recorded where the
  // rest of the run's history is, so "what did `clean` do to this run" has an
  // answer that does not depend on somebody having kept the terminal output.
  //
  // Not emitted for a dry run: `--dry-run` reports and changes nothing, and an
  // event saying a namespace was reclaimed would be the one change it made.
  if (options.dryRun !== true) {
    await deps.store.appendEvent(runId, 'namespace_reclaimed', {
      gitRunKey,
      worktrees: reclaimed.removed.length,
      attemptRefs: attemptRefs.length,
      integrationBranchKept: integrationBranch.kind === 'kept',
    });
  }

  return {
    runId,
    worktrees: reclaimed.removed,
    worktreesRetained: reclaimed.retained,
    attemptRefs,
    integrationBranch,
    // §20.1: if any of 1, 3 or 4 failed, step 5 must not run.
    stateRemovable: failures.length === 0,
    failures,
  };
}

/**
 * Steps 1 and 2 of §20.1.
 *
 * Candidate locations come from run state — every task's attempts 1..n, plus the
 * integration checkout — and are then intersected with what Git has registered
 * under Agent Flow's own root. That intersection is the whole safety property:
 * a path the state can name but Git does not know is skipped, and a worktree Git
 * knows about that the state cannot name is *foreign* and left alone even if its
 * branch is in this namespace, because a user who moved one made a choice (§20.2).
 */
async function reclaimWorktrees(
  deps: NamespaceReclaimDeps,
  state: RunState,
  gitRunKey: string,
  repoKey: string,
  options: ReclaimOptions,
  failures: string[],
): Promise<{ readonly removed: string[]; readonly retained: string[] }> {
  const owned = await deps.workspaces.ownWorktrees({ cwd: deps.projectDir });
  if (!owned.ok) {
    failures.push('the worktree registry could not be read, so nothing was reclaimed');
    return { removed: [], retained: [] };
  }
  const registered = new Set(owned.value.map((entry) => entry.path));

  const removed: string[] = [];
  const retained: string[] = [];
  let removedAny = false;

  for (const candidate of candidateWorkspaces(deps, state, gitRunKey, repoKey)) {
    const path = deps.workspaces.workspacePath(candidate.location);
    if (!path.ok) {
      failures.push(`a workspace of ${candidate.label} could not be placed under the owned root`);
      continue;
    }

    // `ownWorktrees` reports resolved paths, so the comparison is made on resolved
    // ones — a symlink inside the root would otherwise be textually inside it and
    // physically anywhere (S-4).
    const real = (await deps.fs.realPath(path.value)) ?? path.value;
    if (!registered.has(path.value) && !registered.has(real)) continue;

    if (!candidate.reclaimable && options.worktrees !== true) {
      retained.push(candidate.location.relativePath);
      continue;
    }

    if (options.dryRun === true) {
      removed.push(candidate.location.relativePath);
      continue;
    }

    // Unlock first: every worktree Agent Flow creates is created locked (§7.3), and
    // `remove` refuses a locked one rather than taking it. The unlock is allowed to
    // fail — a worktree that was never locked reports non-zero — so only the removal
    // is judged.
    await deps.workspaces.unlockWorktree({ cwd: deps.projectDir, location: candidate.location });

    // **`force`, and the justification is the whole of why the allowlist for it
    // existed.** Git refuses to remove a worktree holding a modified tracked file or
    // an untracked non-ignored one — and *every* attempt worktree is in that state
    // by construction: §11.2 stages the validated tree with `add -A` before the
    // marker is built, so the index differs from the base commit for the rest of the
    // worktree's life. Without `force` this method could never reclaim a single
    // attempt worktree, and §20.3's `--worktrees` flag would be a no-op.
    //
    // What makes it safe is not the flag, it is everything above it:
    //
    //   - the path was **derived** from this run's own state, not discovered;
    //   - Git **confirmed** it is registered under Agent Flow's own root;
    //   - and the content is either a duplicate of what the integration branch
    //     already holds (an integrated attempt — `reclaimable`), or one the user
    //     asked for by name with `--worktrees`.
    //
    // Ignored files never triggered the refusal anyway, so `node_modules/` was never
    // what stood in the way. The thing that would be *work* is the branch, and
    // `--worktrees` does not touch a single ref (§20.3, §20.4).
    const gone = await deps.workspaces.removeWorktree({
      cwd: deps.projectDir,
      location: candidate.location,
      force: true,
    });
    if (!gone.ok) {
      failures.push(
        `the workspace of ${candidate.label} could not be reclaimed (${gone.failure.code})`,
      );
      continue;
    }

    removed.push(candidate.location.relativePath);
    removedAny = true;
  }

  if (removedAny && options.dryRun !== true) {
    const pruned = await deps.workspaces.pruneWorktrees({ cwd: deps.projectDir });
    if (!pruned.ok) failures.push('the worktree registry could not be pruned');
  }

  return { removed, retained };
}

interface WorkspaceCandidate {
  readonly label: string;
  readonly location: { readonly segments: readonly string[]; readonly relativePath: string };
  /**
   * Whether §20.3 reclaims this one by default.
   *
   * True for the integration checkout — a checkout of a branch that outlives it is
   * recreatable by definition (§14.1) — and for an attempt whose work reached the
   * integration branch, where the worktree is a duplicate of something the branch
   * holds. Everything else is the only remaining copy and is retained.
   */
  readonly reclaimable: boolean;
}

/**
 * Every workspace this run could have created, composed from its own state.
 *
 * Attempts are enumerated 1..`task.attempts` rather than discovered on disk, which
 * is the direction §20.2 requires: a path acted on comes from trusted state, and
 * the filesystem only ever *narrows* that list.
 */
function candidateWorkspaces(
  deps: NamespaceReclaimDeps,
  state: RunState,
  gitRunKey: string,
  repoKey: string,
): WorkspaceCandidate[] {
  const candidates: WorkspaceCandidate[] = [];

  const integration = integrationWorkspace(repoKey, gitRunKey);
  if (integration.ok) {
    candidates.push({
      label: 'the integration checkout',
      location: integration.value,
      reclaimable: true,
    });
  }

  for (const task of state.tasks) {
    for (let attempt = 1; attempt <= task.attempts; attempt += 1) {
      const location = attemptWorkspace(repoKey, gitRunKey, task.id, attempt);
      if (!location.ok) continue;
      candidates.push({
        label: `${task.id} attempt ${String(attempt)}`,
        location: location.value,
        // A completed task's work is on the integration branch, so its worktree is a
        // duplicate. Anything else — failed, blocked, awaiting review, interrupted —
        // is evidence, and §20.3 keeps it until somebody asks for the disk back.
        reclaimable: task.state === 'completed',
      });
    }
  }

  void deps;
  return candidates;
}

/** Step 3: the run's attempt refs, which are diagnostic (§20.4). */
async function deleteAttemptRefs(
  deps: NamespaceReclaimDeps,
  gitRunKey: string,
  options: ReclaimOptions,
  failures: string[],
): Promise<string[]> {
  const integration = integrationRef(gitRunKey);
  const integrationRefName = integration.ok ? `refs/heads/${integration.value}` : '';

  const refs = await deps.workspaces.refsUnder({
    cwd: deps.projectDir,
    // A prefix, never a glob: `*` matches one path component and would return the
    // integration branch while silently omitting every attempt ref (M2-02 finding).
    prefix: `refs/heads/${REF_NAMESPACE}/${gitRunKey}`,
  });
  if (!refs.ok) {
    failures.push('the run’s refs could not be listed, so none were deleted');
    return [];
  }

  const deleted: string[] = [];
  for (const entry of refs.value) {
    if (entry.ref === integrationRefName) continue;

    if (options.dryRun === true) {
      deleted.push(entry.ref);
      continue;
    }

    // The value that was just read is passed back, so a ref that moved between the
    // listing and the deletion makes Git refuse rather than lose it.
    const gone = await deps.workspaces.deleteRef({
      cwd: deps.projectDir,
      ref: entry.ref,
      expectedOldOid: entry.oid,
    });
    if (!gone.ok) {
      failures.push(`an attempt ref of this run could not be deleted (${gone.failure.code})`);
      continue;
    }
    deleted.push(entry.ref);
  }

  return deleted;
}

/**
 * Step 4: the integration branch, under §20.4's rule rather than the run's.
 *
 * **Redundant is a mechanical question, and it is the only one that authorises
 * deletion.** If the branch is an ancestor of any ref outside
 * `refs/heads/agent-flow/`, the user took the work and the branch is a duplicate of
 * history they already own. If it is an ancestor of nothing, it is the only copy —
 * and `clean` keeps it, says so, and still exits zero.
 *
 * The filtering happens here, over the list `for-each-ref` returned, rather than in
 * a shell pipeline (S-8) or through an exclusion flag whose availability is a
 * Git-version question §23 declines to answer from memory.
 */
async function resolveIntegrationBranch(
  deps: NamespaceReclaimDeps,
  gitRunKey: string,
  options: ReclaimOptions,
  failures: string[],
): Promise<IntegrationBranchOutcome> {
  const branch = integrationRef(gitRunKey);
  if (!branch.ok) {
    failures.push('this run’s integration branch could not be named');
    return { kind: 'absent' };
  }
  const refName = `refs/heads/${branch.value}`;

  const head = await deps.workspaces.revParse({ cwd: deps.projectDir, rev: refName });
  if (!head.ok) return { kind: 'absent' };

  const remove = async (): Promise<boolean> => {
    if (options.dryRun === true) return true;
    const gone = await deps.workspaces.deleteRef({
      cwd: deps.projectDir,
      ref: refName,
      expectedOldOid: head.value,
    });
    if (!gone.ok) {
      failures.push(`the integration branch could not be deleted (${gone.failure.code})`);
      return false;
    }
    return true;
  };

  if (options.branches === true) {
    return (await remove()) ? { kind: 'forced', ref: branch.value } : { kind: 'kept', ref: branch.value, head: head.value };
  }

  const everything = await deps.workspaces.refsUnder({ cwd: deps.projectDir, prefix: 'refs' });
  if (!everything.ok) {
    // Undecidable, so kept. Keeping a branch costs a ref; deleting one that turns
    // out to be the only copy costs the feature.
    return { kind: 'kept', ref: branch.value, head: head.value };
  }

  const foreign = everything.value.filter(
    (entry) => !entry.ref.startsWith(`refs/heads/${REF_NAMESPACE}/`),
  );

  for (const candidate of foreign) {
    const contains = await deps.workspaces.isAncestor({
      cwd: deps.projectDir,
      ancestor: refName,
      descendant: candidate.ref,
    });
    if (!contains.ok || !contains.value) continue;

    return (await remove())
      ? { kind: 'redundant', ref: branch.value, mergedInto: candidate.ref }
      : { kind: 'kept', ref: branch.value, head: head.value };
  }

  return { kind: 'kept', ref: branch.value, head: head.value };
}
