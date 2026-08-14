import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { runPaths } from '../../src/app/paths.js';
import {
  RECOVERY_REFUSAL_CODES,
  RECOVERY_WINDOWS,
  type RunRecoveryOutcome,
  type TaskRecovery,
} from '../../src/app/worktree-recovery.js';
import { makeWorktreeRun, type PlantedAttempt, type WorktreeRun } from '../fixtures/worktree-run.js';
import { delegating, forceState, recoveryFor } from '../fixtures/crash.js';
import type { IntegrationWorkspace } from '../../src/app/integrator.js';

/**
 * Every window of §17.3, against real Git (§26.5).
 *
 * **Nothing is mocked except where a failure has to be forced**, and the reason is
 * the same one M2-06's suite gives: every claim here is a claim about Git rather
 * than about this code. That a deleted ref leaves its commit reachable, that
 * `commit-tree` from the same artifact yields the same object, that a conflicted
 * merge leaves `MERGE_HEAD` a `merge --abort` undoes — each was probed, and a fake
 * would only ever confirm what the fake was told.
 *
 * Each test states **what was durable before recovery ran**, not only what the
 * world looks like afterwards. A recovery test that asserts the final state alone
 * passes when the fault landed in a different window than the one it names, and
 * §28 says so in as many words: "a recovery test that passes because the fault did
 * not land where it claimed is a green test proving nothing."
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

async function readyWorkspace(current: WorktreeRun): Promise<IntegrationWorkspace> {
  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') {
    throw new Error(`expected a prepared integration workspace, got ${prepared.kind}`);
  }
  return prepared.workspace;
}

/** The recovery request shape, for a plan of independent tasks. */
function requestOf(
  current: WorktreeRun,
  workspace: IntegrationWorkspace,
  tasks: readonly string[],
  states: Readonly<Record<string, string>> = {},
) {
  return {
    runId: current.runId,
    workspace,
    dag: current.dag(tasks.map((id) => ({ id }))),
    states: Object.fromEntries(
      tasks.map((id) => [id, (states[id] ?? 'running') as 'running']),
    ),
  };
}

function only(outcome: RunRecoveryOutcome): TaskRecovery {
  const [first] = outcome.outcomes;
  if (first === undefined) throw new Error('recovery reported no outcome at all');
  return first;
}

/** How many merge commits the integration branch holds. */
function merges(current: WorktreeRun): string {
  return current.repo
    .userGit(['rev-list', '--count', '--merges', `refs/heads/${current.integrationBranch}`])
    .trim();
}

function head(current: WorktreeRun): string {
  return current.repo.userGit(['rev-parse', `refs/heads/${current.integrationBranch}`]).trim();
}

/** Deletes the attempt ref, leaving the marker commit unreferenced (windows 3, 4). */
function unpublishMarker(current: WorktreeRun, planted: PlantedAttempt): void {
  current.repo.userGit(['update-ref', '-d', `refs/heads/${planted.branch}`]);
}

// ---------------------------------------------------------------------------
// Windows 1 and 2 — no evidence
// ---------------------------------------------------------------------------

describe('an attempt whose work was never observed (§17.3 windows 1, 2)', () => {
  it('requeues without touching Git when there is no artifact', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    // Durable before recovery: a dispatched attempt and nothing else. No
    // artifact, no marker, no merge — which is the whole of windows 1 and 2.
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1))).toBe(false);
    const before = { head: head(run), merges: merges(run) };

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('requeue');
    expect(first.kind === 'requeue' && first.window).toBe(RECOVERY_WINDOWS.attemptUnobserved);
    // No code: Appendix A names no refusal for "there was no evidence", because
    // there is nothing to refuse (§17.3 windows 1, 2).
    expect(first.kind === 'requeue' && first.code).toBeUndefined();
    expect(outcome.haltedBy).toBeUndefined();

    expect(head(run)).toBe(before.head);
    expect(merges(run)).toBe(before.merges);
    expect((await run.store.loadRun(run.runId)).tasks[0]?.state).toBe('running');
  });

  it('requeues an artifact that does not parse rather than repairing it', async () => {
    // An artifact nothing wrote correctly is not a weaker form of evidence. It is
    // collapsed with "absent" on purpose: treating it as partial truth is how a
    // forged half gets believed.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    const artifact = runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1);
    const original = readFileSync(artifact, 'utf8');
    run.fs.writeFileAtomic(artifact, '{ not json');

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));

    expect(only(outcome).kind).toBe('requeue');
    expect(merges(run)).toBe('0');
    // And the file was not rewritten in the course of refusing it.
    expect(readFileSync(artifact, 'utf8')).not.toBe(original);
  });

  it('requeues a task marked running whose attempt counter never moved', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    forceState(run, [{ id: 'TASK-001', state: 'running', attempts: 0 }]);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));

    expect(only(outcome).kind).toBe('requeue');
    expect(merges(run)).toBe('0');
  });

  it('reads the attempt the state names, never the newest artifact on disk', async () => {
    // The case a retry creates, and the one a directory scan gets wrong: attempt 1
    // left evidence, a person retried, and the crash happened before attempt 2
    // wrote anything. Adopting attempt 1's evidence would finish work a human had
    // already decided to redo.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const first = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    forceState(run, [{ id: 'TASK-001', state: 'running', attempts: 2 }]);
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 2))).toBe(false);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const only1 = only(outcome);

    expect(only1.kind).toBe('requeue');
    expect(only1.attempt).toBe(2);
    // Attempt 1's marker is untouched and unmerged: its evidence was not adopted.
    expect(merges(run)).toBe('0');
    expect(run.repo.userGit(['rev-parse', `refs/heads/${first.branch}`]).trim()).toBe(first.marker);
  });
});

// ---------------------------------------------------------------------------
// Windows 3 and 4 — a receipt with no published marker
// ---------------------------------------------------------------------------

describe('a receipt whose marker was never published (§17.3 windows 3, 4)', () => {
  it('rebuilds the marker at the same commit id and integrates it', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    unpublishMarker(run, planted);

    // Durable before recovery: the artifact, and a ref that does not resolve.
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1))).toBe(true);
    expect(
      (await run.repo.workspaces.revParse({
        cwd: run.repo.dir,
        rev: `refs/heads/${planted.branch}`,
      })).ok,
    ).toBe(false);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('recovered');
    expect(first.kind === 'recovered' && first.window).toBe(RECOVERY_WINDOWS.markerUnpublished);
    expect(first.kind === 'recovered' && first.state).toBe('completed');

    // **The same commit id, not a new one.** Every input to `commit-tree` comes
    // out of the artifact, so Git stores the object once and the ref update is
    // idempotent for free (§12.2) — which is why windows 3 and 4 need no
    // bookkeeping to tell apart.
    expect(run.repo.userGit(['rev-parse', `refs/heads/${planted.branch}`]).trim()).toBe(
      planted.marker,
    );
    expect(merges(run)).toBe('1');

    const result = await run.store.readTaskResult(run.runId, 'TASK-001');
    expect(result?.integration?.marker).toBe(planted.marker);
    expect(result?.integration?.validatedTree).toBe(planted.validatedTree);
  });

  it('recognises a branch that never moved off its base, not just a deleted ref', async () => {
    // **The regression this window actually needs.** §7.3 creates the attempt
    // branch in the same command as the worktree, at the wave base, so after a
    // crash between the receipt and the marker the ref *resolves* — to the base.
    // A recovery that asked only "does the ref resolve" would read that as "the
    // marker is here", hand a base commit to the Integrator and refuse an attempt
    // whose evidence is perfect. This is the shape a real crash leaves.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    run.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, planted.base]);

    const before = await run.repo.workspaces.revParse({
      cwd: run.repo.dir,
      rev: `refs/heads/${planted.branch}`,
    });
    expect(before.ok && before.value).toBe(planted.base);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('recovered');
    expect(first.kind === 'recovered' && first.window).toBe(RECOVERY_WINDOWS.markerUnpublished);
    expect(run.repo.userGit(['rev-parse', `refs/heads/${planted.branch}`]).trim()).toBe(
      planted.marker,
    );
    expect(merges(run)).toBe('1');
  });

  it('refuses a ref pointing at neither the base nor the marker', async () => {
    // The adjacent case, and §17.3 window 11 decides it: a marker that exists and
    // does not bind to the receipt "MUST NOT be repaired automatically". A commit
    // the agent made inside its worktree is exactly that — the branch moved, and
    // not to the marker — so recovery hands it over and the Integrator refuses,
    // rather than overwriting a value nobody has looked at.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const agentCommit = run.repo
      .userGit(['commit-tree', treeOf(run, run.planningBase), '-p', planted.base, '-m', 'wip'])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, agentCommit]);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('refused');
    expect(first.kind === 'refused' && first.refusal.code).toBe('attempt_marker_mismatch');
    // Not repaired: the ref was not moved to the marker recovery could have built.
    expect(run.repo.userGit(['rev-parse', `refs/heads/${planted.branch}`]).trim()).toBe(agentCommit);
    expect(merges(run)).toBe('0');
  });

  it('records integration_recovered with the window it found', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    unpublishMarker(run, planted);

    await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));

    const event = (await run.store.readEvents(run.runId)).find(
      (entry) => entry.type === 'integration_recovered',
    );
    // Exactly the keys Appendix B specifies, and no absolute path among them.
    expect(event?.detail).toEqual({
      task: 'TASK-001',
      attempt: 1,
      window: RECOVERY_WINDOWS.markerUnpublished,
    });
  });
});

// ---------------------------------------------------------------------------
// Window 5 — a valid marker that was never merged
// ---------------------------------------------------------------------------

describe('a valid marker that was never merged (§17.3 window 5)', () => {
  it('merges it, writes the result and completes the task in one state write', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    // Durable before recovery: artifact, marker, and no merge.
    expect(merges(run)).toBe('0');
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('recovered');
    expect(first.kind === 'recovered' && first.window).toBe(RECOVERY_WINDOWS.markerUnmerged);
    expect(merges(run)).toBe('1');

    const state = await run.store.loadRun(run.runId);
    expect(state.tasks[0]?.state).toBe('completed');
    expect(state.integrationHead).toBe(head(run));
    expect((await run.store.readTaskResult(run.runId, 'TASK-001'))?.integration?.mergeCommit).toBe(
      head(run),
    );
    // The work is on the branch, and the marker's tree is what landed.
    expect(run.repo.userGit(['show', `refs/heads/${run.integrationBranch}:a.txt`]).trim()).toBe('a');
  });

  it('integrates several recovered tasks in the plan’s order, never in state order', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    // Planted in reverse, so "the order they were found in" and "the plan's order"
    // cannot be the same accident.
    const second = await run.plant('TASK-002', 1, { write: { 'two.txt': '2\n' } });
    const first = await run.plant('TASK-001', 1, { write: { 'one.txt': '1\n' } });

    const outcome = await recoveryFor(run).recoverRun(
      requestOf(run, workspace, ['TASK-001', 'TASK-002']),
    );

    expect(outcome.outcomes.map((entry) => entry.task)).toEqual(['TASK-001', 'TASK-002']);
    expect(merges(run)).toBe('2');

    // The branch's own history, read from Git: the second parents are the markers,
    // in the plan's order.
    const merged = run.repo
      .userGit([
        'rev-list',
        '--parents',
        '--merges',
        `refs/heads/${run.integrationBranch}`,
      ])
      .trim()
      .split('\n')
      .map((line) => line.trim().split(' ')[2]);
    expect(merged).toEqual([second.marker, first.marker]);
  });
});

// ---------------------------------------------------------------------------
// Window 6 — the worktree left mid-merge
// ---------------------------------------------------------------------------

describe('an integration worktree left mid-merge (§17.3 window 6)', () => {
  it('aborts the merge, then integrates the attempt that was being merged', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    // A real interrupted merge of this very marker, left exactly as a dead
    // process leaves one. `--no-commit` stops after the merge succeeds, so
    // MERGE_HEAD is on disk with a clean index — the non-conflicting shape of
    // window 6, which a conflict-only test would never reach.
    run.repo.userGit(['merge', '--no-commit', '--no-ff', planted.marker], workspace.path);

    const before = await run.repo.workspaces.mergeHead({ cwd: workspace.path });
    expect(before.ok && before.value).toBe(planted.marker);
    expect(merges(run)).toBe('0');

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('recovered');
    expect(first.kind === 'recovered' && first.window).toBe(RECOVERY_WINDOWS.mergeInterrupted);
    // One merge, made by recovery rather than half-made by the dead process.
    expect(merges(run)).toBe('1');
    const after = await run.repo.workspaces.mergeHead({ cwd: workspace.path });
    expect(after.ok && after.value).toBeNull();
    expect(run.repo.userGit(['status', '--porcelain=v1'], workspace.path).trim()).toBe('');
  });

  it('halts without merging anything when the interrupted merge cannot be cleared', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    run.repo.userGit(['merge', '--no-commit', '--no-ff', planted.marker], workspace.path);

    const recovery = recoveryFor(run, {
      integrator: delegating(run.integrator, {
        clearInterruptedMerge: async () => ({
          ok: false as const,
          refusal: {
            code: 'integration_worktree_unavailable' as const,
            detail: 'the abort was refused',
          },
        }),
      }),
    });

    const outcome = await recovery.recoverRun(requestOf(run, workspace, ['TASK-001']));

    expect(outcome.haltedBy).toContain('integration_worktree_unavailable');
    // Not a single task was looked at: the worktree is not in a state anything
    // can be merged into, and pressing on would merge into a half-merged tree.
    expect(outcome.outcomes).toEqual([]);
    expect(merges(run)).toBe('0');
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Window 7 — the merge landed and the state write did not
// ---------------------------------------------------------------------------

describe('a merge that landed before the state write (§17.3 window 7)', () => {
  async function mergedButUnrecorded(
    options: { readonly keepResult: boolean },
  ): Promise<{ workspace: IntegrationWorkspace; planted: PlantedAttempt; head: string }> {
    if (run === undefined) throw new Error('no run');
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    await run.integrator.integrate({
      runId: run.runId,
      workspace,
      dag: run.dag([{ id: 'TASK-001' }]),
      attempts: [{ task: 'TASK-001', attempt: 1, result: run.resultFor('TASK-001') }],
    });

    const landed = head(run);
    if (!options.keepResult) {
      rmSync(runPaths(run.repo.dir, run.runId).taskResult('TASK-001'));
    }
    // The state as the crash left it: the merge is in Git, the run does not know.
    forceState(run, [{ id: 'TASK-001', state: 'running', attempts: 1 }], {
      integrationHead: run.planningBase,
    });

    return { workspace, planted, head: landed };
  }

  it('reconciles without merging again when result.json is absent (case 1)', async () => {
    run = await makeWorktreeRun();
    const { workspace, planted, head: landed } = await mergedButUnrecorded({ keepResult: false });

    expect(merges(run)).toBe('1');
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
    expect((await run.store.loadRun(run.runId)).integrationHead).toBe(run.planningBase);

    const outcome = await recoveryFor(run!).recoverRun(requestOf(run!, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('recovered');
    expect(first.kind === 'recovered' && first.window).toBe(RECOVERY_WINDOWS.completionUnrecorded);
    // **No second merge**, and the branch did not move.
    expect(merges(run!)).toBe('1');
    expect(head(run!)).toBe(landed);

    const state = await run!.store.loadRun(run!.runId);
    expect(state.tasks[0]?.state).toBe('completed');
    expect(state.integrationHead).toBe(landed);

    const result = await run!.store.readTaskResult(run!.runId, 'TASK-001');
    expect(result?.integration?.mergeCommit).toBe(landed);
    expect(result?.integration?.marker).toBe(planted.marker);
    // The reconstruction is structural: two parents, and the second is the marker.
    const parents = run!.repo
      .userGit(['rev-list', '--parents', '-n', '1', landed])
      .trim()
      .split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(planted.marker);
  });

  it('reconciles when result.json is already there (case 2)', async () => {
    run = await makeWorktreeRun();
    const { workspace, head: landed } = await mergedButUnrecorded({ keepResult: true });

    const before = await run.store.readTaskResult(run.runId, 'TASK-001');
    expect(merges(run)).toBe('1');

    const outcome = await recoveryFor(run!).recoverRun(requestOf(run!, workspace, ['TASK-001']));

    expect(only(outcome).kind).toBe('recovered');
    expect(merges(run!)).toBe('1');
    expect(head(run!)).toBe(landed);
    expect((await run!.store.loadRun(run!.runId)).tasks[0]?.state).toBe('completed');

    // Rewritten rather than appended to, and rewritten **from the artifact** —
    // which §17.3 window 7 says in as many words. So the claim asserted here is
    // that the reconciled record describes the same integration and the same
    // evidence, not that it is byte-identical to the file the executor's own
    // `TaskResult` produced before the crash. Those two differ only where the
    // artifact is the better source: it records what the agent actually changed,
    // and the pre-crash file records whatever the caller passed in.
    const after = await run!.store.readTaskResult(run!.runId, 'TASK-001');
    expect(after?.status).toBe('completed');
    expect(after?.integration).toEqual(before?.integration);
    const evidence = JSON.parse(
      readFileSync(runPaths(run!.repo.dir, run!.runId).taskAttempt('TASK-001', 1), 'utf8'),
    ) as { filesChanged: string[]; runner: string; startedAt: string };
    expect(after?.filesChanged).toEqual(evidence.filesChanged);
    expect(after?.runner).toBe(evidence.runner);
    expect(after?.startedAt).toBe(evidence.startedAt);
  });

  it('refuses a branch that contains the marker without a merge introducing it', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    // Ancestry alone is not integration: a branch rebuilt linearly on top of the
    // marker contains it and no merge commit names it.
    const linear = run.repo
      .userGit(['commit-tree', planted.validatedTree, '-p', planted.marker, '-m', 'rebuilt'])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${run.integrationBranch}`, linear]);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('refused');
    expect(first.kind === 'refused' && first.refusal.code).toBe('integration_history_unrecognised');
    expect(outcome.haltedBy).toContain('integration_history_unrecognised');
    // Halted, not repaired: nothing was written and the branch is where it was.
    expect(head(run)).toBe(linear);
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Window 10 — the validated tree is gone
// ---------------------------------------------------------------------------

describe('a validated tree that is no longer in the repository (§17.3 window 10)', () => {
  it('requeues with attempt_tree_missing and fabricates nothing', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    unpublishMarker(run, planted);

    // Reaching this window takes more than deleting the ref, and the reason is
    // worth recording: **the attempt worktree's own index still references the
    // validated tree**, so `gc` will not reclaim it while that worktree is
    // registered. Probed on Git 2.52.0. Window 10 therefore describes a narrow
    // real situation — a resume on a machine whose `~/.agent-flow` was cleaned
    // (§14.1 names that case) and where a `gc` then ran — rather than an ordinary
    // crash. Producing it faithfully means removing the worktree first, as a
    // person or a cleanup would, and only then collecting.
    run.repo.userGit(['worktree', 'unlock', planted.workspacePath]);
    run.repo.userGit(['worktree', 'remove', '--force', planted.workspacePath]);
    run.repo.userGit(['worktree', 'prune']);
    run.repo.userGit(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
    run.repo.userGit(['gc', '--prune=now', '--quiet']);

    const gone = await run.repo.workspaces.objectExistsAs({
      cwd: run.repo.dir,
      oid: planted.validatedTree,
      type: 'tree',
    });
    expect(gone.ok && gone.value).toBe(false);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('requeue');
    expect(first.kind === 'requeue' && first.code).toBe('attempt_tree_missing');
    expect(first.kind === 'requeue' && first.window).toBe(RECOVERY_WINDOWS.treePruned);
    // Requeued rather than halted: Appendix A marks this one "no — requeues".
    expect(outcome.haltedBy).toBeUndefined();
    // **Never fabricate a tree**: no marker was rebuilt and nothing was merged.
    expect(
      (await run.repo.workspaces.revParse({
        cwd: run.repo.dir,
        rev: `refs/heads/${planted.branch}`,
      })).ok,
    ).toBe(false);
    expect(merges(run)).toBe('0');

    const event = (await run.store.readEvents(run.runId)).find(
      (entry) => entry.type === 'attempt_tree_missing',
    );
    expect(event?.detail['task']).toBe('TASK-001');
    expect(event?.detail['attempt']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Window 11 — the marker does not bind
// ---------------------------------------------------------------------------

describe('a marker that does not bind to its receipt (§17.3 window 11)', () => {
  it('refuses a marker whose tree is not the receipt’s, however good its trailers', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    // A forgery with the artifact's own message and a different tree — the S-9
    // case. The trailers are perfect by construction, because they are copied.
    const message = run.repo.userGit(['log', '-1', '--format=%B', planted.marker]);
    const forged = run.repo
      .userGit(['commit-tree', treeOf(run, run.planningBase), '-p', planted.base, '-m', message])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, forged]);

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('refused');
    expect(first.kind === 'refused' && first.refusal.code).toBe('attempt_marker_mismatch');
    expect(outcome.haltedBy).toContain('attempt_marker_mismatch');
    // Refused, never repaired (I-6): no merge, no result, and the forged ref was
    // not overwritten either — recovery republishes only a ref that does not
    // resolve, so it cannot move a value it has not looked at.
    expect(merges(run)).toBe('0');
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
    expect(run.repo.userGit(['rev-parse', `refs/heads/${planted.branch}`]).trim()).toBe(forged);
  });

  it('refuses when the evidence names a branch outside this run’s namespace', async () => {
    // The ref name is re-derived from policy rather than read out of the artifact
    // (S-2). Legitimately the two always agree, which is the shape a defence
    // should have: unreachable in a healthy run, and closed if the artifact is
    // ever the thing that is wrong.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    const artifact = runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1);
    const evidence = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
    await run.fs.writeFileAtomic(
      artifact,
      `${JSON.stringify({ ...evidence, branch: 'agent-flow/somebody-else/TASK-001/attempt-1' }, null, 2)}\n`,
    );

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('refused');
    expect(first.kind === 'refused' && first.refusal.code).toBe('attempt_marker_mismatch');
    expect(merges(run)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// A verdict the artifact already carries (§10.2, §23)
// ---------------------------------------------------------------------------

describe('an attempt that reached a verdict before the crash', () => {
  it('records review_required for an unsatisfied artifact rather than retrying it', async () => {
    // Requeuing here would be an automatic retry of a *failed validation*, which
    // §23 forbids and which `judgeValidation` already decided once (I-4). The
    // state is read back out of the artifact, not derived again.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await run.plant('TASK-001', 1, { judgement: 'unsatisfied' });

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('concluded');
    expect(first.kind === 'concluded' && first.state).toBe('review_required');
    expect(outcome.haltedBy).toContain('review_required');
    expect(merges(run)).toBe('0');
  });

  it('records blocked when the agent reported BLOCKED', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await run.plant('TASK-001', 1, { judgement: 'not_reached', reported: 'BLOCKED' });

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind === 'concluded' && first.state).toBe('blocked');
  });

  it('records review_required for not_reached without a BLOCKED report', async () => {
    // The executor's other `not_reached` provenance: the plan named a validation
    // id the configuration no longer resolves. Two provenances, one field apart —
    // and the field is structural, not a sentence.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await run.plant('TASK-001', 1, { judgement: 'not_reached' });

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    const first = only(outcome);

    expect(first.kind).toBe('concluded');
    expect(first.kind === 'concluded' && first.state).toBe('review_required');
  });
});

// ---------------------------------------------------------------------------
// Scope, ordering and the user's tree
// ---------------------------------------------------------------------------

describe('what recovery leaves alone', () => {
  it('considers no task that is not running', async () => {
    // `failed`, `blocked` and `review_required` are decisions, not crashes, and
    // reopening one would be recovery overruling a person. `completed` is
    // terminal, and its leftover worktree is §17.3 window 8 — cleanup, M2-09's.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    // Planted once, and perfectly: the evidence is there, the marker is there, and
    // recovery would integrate it in a heartbeat if the task were `running`. So
    // what each iteration below proves is that the *state* is what holds it back,
    // not a missing artifact.
    await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    for (const state of ['failed', 'blocked', 'review_required', 'completed', 'queued'] as const) {
      forceState(run, [{ id: 'TASK-001', state, attempts: 1 }]);

      const outcome = await recoveryFor(run).recoverRun(
        requestOf(run, workspace, ['TASK-001'], { 'TASK-001': state }),
      );

      expect(outcome.outcomes, state).toEqual([]);
      expect(outcome.haltedBy, state).toBeUndefined();
      expect(merges(run), state).toBe('0');
    }
  });

  it('stops at the first refusal and does not integrate what comes after it', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    // TASK-001 refuses; TASK-002 is perfectly integrable and must not be merged,
    // because a dependent cut from a branch missing its dependency's work is the
    // failure that stays invisible for three more tasks.
    const broken = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const forged = run.repo
      .userGit(['commit-tree', treeOf(run, run.planningBase), '-p', broken.base, '-m', 'forged'])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${broken.branch}`, forged]);
    await run.plant('TASK-002', 1, { write: { 'b.txt': 'b\n' } });

    const outcome = await recoveryFor(run).recoverRun(
      requestOf(run, workspace, ['TASK-001', 'TASK-002']),
    );

    expect(outcome.outcomes).toHaveLength(1);
    expect(outcome.outcomes[0]?.task).toBe('TASK-001');
    expect(merges(run)).toBe('0');
    expect(await run.store.readTaskResult(run.runId, 'TASK-002')).toBeNull();
  });

  it('leaves the user’s working tree byte-for-byte unchanged, dirty or not', async () => {
    // Called directly rather than through `start`, deliberately: §6.3 check 9
    // refuses a dirty tree before the scheduler exists, so a test that went
    // through the CLI would be proving the gate rather than recovery's safety.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await run.plant('TASK-001', 1, { write: { 'README.md': 'rewritten\n' } });
    unpublishMarker(run, planted);

    run.repo.userGit(['checkout', '--quiet', '-b', 'the-user-was-here']);
    run.repo.write('README.md', 'the user was editing this\n');
    run.repo.write('scratch.txt', 'untracked\n');
    run.repo.userGit(['add', 'scratch.txt']);
    run.repo.write('loose.txt', 'also untracked\n');

    const before = {
      head: run.repo.userGit(['rev-parse', 'HEAD']).trim(),
      branch: run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      status: run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all']),
      index: run.repo.userGit(['ls-files', '--stage']),
      readme: readFileSync(`${run.repo.dir}/README.md`, 'utf8'),
    };

    const outcome = await recoveryFor(run).recoverRun(requestOf(run, workspace, ['TASK-001']));
    expect(only(outcome).kind).toBe('recovered');

    expect(run.repo.userGit(['rev-parse', 'HEAD']).trim()).toBe(before.head);
    expect(run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(before.branch);
    expect(run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
      before.status,
    );
    expect(run.repo.userGit(['ls-files', '--stage'])).toBe(before.index);
    expect(readFileSync(`${run.repo.dir}/README.md`, 'utf8')).toBe(before.readme);
    // The recovered work is on the branch, which is the product — and nowhere else.
    expect(
      run.repo.userGit(['show', `refs/heads/${run.integrationBranch}:README.md`]).trim(),
    ).toBe('rewritten');
  });
});

// ---------------------------------------------------------------------------
// Idempotency (§28 acceptance)
// ---------------------------------------------------------------------------

describe('running recovery twice changes nothing the first run did not do', () => {
  async function twice(
    prepare: (current: WorktreeRun, workspace: IntegrationWorkspace) => Promise<void>,
  ): Promise<{ first: RunRecoveryOutcome; second: RunRecoveryOutcome; delta: boolean }> {
    if (run === undefined) throw new Error('no run');
    const workspace = await readyWorkspace(run);
    await prepare(run, workspace);

    const recovery = recoveryFor(run);
    const request = requestOf(run, workspace, ['TASK-001']);

    const first = await recovery.recoverRun(request);
    const snapshot = {
      head: head(run),
      merges: merges(run),
      state: JSON.stringify((await run.store.loadRun(run.runId)).tasks),
      events: (await run.store.readEvents(run.runId)).length,
      result: JSON.stringify(await run.store.readTaskResult(run.runId, 'TASK-001')),
    };

    // The second pass sees the world the first pass left, which is what a
    // re-entered `start` sees. The states map carries the first pass's answer.
    const after = Object.fromEntries(
      first.outcomes.map((entry) => [
        entry.task,
        entry.kind === 'requeue' ? 'running' : entry.state,
      ]),
    );
    const second = await recovery.recoverRun({ ...request, states: after as never });

    const delta =
      head(run) !== snapshot.head ||
      merges(run) !== snapshot.merges ||
      JSON.stringify((await run.store.loadRun(run.runId)).tasks) !== snapshot.state ||
      (await run.store.readEvents(run.runId)).length !== snapshot.events ||
      JSON.stringify(await run.store.readTaskResult(run.runId, 'TASK-001')) !== snapshot.result;

    return { first, second, delta };
  }

  it('is a no-op over a task it already completed (window 5)', async () => {
    run = await makeWorktreeRun();
    const { first, second, delta } = await twice(async (current) => {
      await current.seed(['TASK-001']);
      await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    });

    expect(only(first).kind).toBe('recovered');
    // The task is `completed` now, so the second pass does not consider it at all.
    expect(second.outcomes).toEqual([]);
    expect(delta, 'the second recovery changed something').toBe(false);
  });

  it('is a no-op over a marker it already republished (windows 3, 4)', async () => {
    run = await makeWorktreeRun();
    const { first, delta } = await twice(async (current) => {
      await current.seed(['TASK-001']);
      const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
      unpublishMarker(current, planted);
    });

    expect(only(first).kind).toBe('recovered');
    expect(delta).toBe(false);
    expect(merges(run)).toBe('1');
  });

  it('is a no-op over a reconciliation it already recorded (window 7)', async () => {
    run = await makeWorktreeRun();
    const { first, delta } = await twice(async (current, workspace) => {
      await current.seed(['TASK-001']);
      await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
      await current.integrator.integrate({
        runId: current.runId,
        workspace,
        dag: current.dag([{ id: 'TASK-001' }]),
        attempts: [{ task: 'TASK-001', attempt: 1, result: current.resultFor('TASK-001') }],
      });
      rmSync(runPaths(current.repo.dir, current.runId).taskResult('TASK-001'));
      forceState(current, [{ id: 'TASK-001', state: 'running', attempts: 1 }], {
        integrationHead: current.planningBase,
      });
    });

    expect(only(first).kind).toBe('recovered');
    expect(delta).toBe(false);
    expect(merges(run)).toBe('1');
  });

  it('repeats a refusal rather than turning it into a repair (window 11)', async () => {
    run = await makeWorktreeRun();
    const { first, second, delta } = await twice(async (current) => {
      await current.seed(['TASK-001']);
      const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
      const forged = current.repo
        .userGit([
          'commit-tree',
          treeOf(current, current.planningBase),
          '-p',
          planted.base,
          '-m',
          'forged',
        ])
        .trim();
      current.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, forged]);
    });

    expect(only(first).kind).toBe('refused');
    // `review_required` now, so the second pass does not consider it — and the
    // refusal did not become a repair in the meantime.
    expect(second.outcomes).toEqual([]);
    expect(delta).toBe(false);
    expect(merges(run)).toBe('0');
  });

  it('does not requeue twice or spend an attempt (windows 1, 2)', async () => {
    run = await makeWorktreeRun();
    const { first, second, delta } = await twice(async (current) => {
      await current.seed(['TASK-001']);
    });

    expect(only(first).kind).toBe('requeue');
    expect(only(second).kind).toBe('requeue');
    // A requeue is the caller's to perform, so a second observation of the same
    // absence is the same answer — and neither pass moved the attempt counter.
    expect(delta).toBe(false);
    expect((await run.store.loadRun(run.runId)).tasks[0]?.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('the refusal vocabulary', () => {
  it('names five codes and no more', () => {
    // Pinned as a count as well as a set, so adding one is a deliberate edit that
    // also has to reach Appendix A — which `integration-vocabulary.test.ts`
    // enforces from the other side.
    expect([...RECOVERY_REFUSAL_CODES]).toEqual([
      'attempt_tree_missing',
      'attempt_marker_missing',
      'attempt_marker_mismatch',
      'integration_worktree_unavailable',
      'integration_unreadable',
    ]);
  });
});

/** The tree of a commit, for building a marker that binds to nothing. */
function treeOf(current: WorktreeRun, commit: string): string {
  return current.repo.userGit(['rev-parse', `${commit}^{tree}`]).trim();
}
