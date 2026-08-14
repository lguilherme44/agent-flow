import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reclaimNamespace } from '../../src/app/namespace-reclaim.js';
import { runPaths } from '../../src/app/paths.js';
import { makeWorktreeRun, type PlantedAttempt, type WorktreeRun } from '../fixtures/worktree-run.js';
import { delegating, forceState } from '../fixtures/crash.js';
import type { IntegrationWorkspace } from '../../src/app/integrator.js';

/**
 * Reclaiming a namespace, against real Git (§20, §26.3, M2-09).
 *
 * This is the milestone that deletes, so the tests that matter most are the ones
 * asserting that something **survived**. A cleanup suite made only of "it is gone"
 * assertions passes just as happily when the implementation removes too much.
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

function depsOf(current: WorktreeRun) {
  return {
    workspaces: current.repo.workspaces,
    fs: current.fs,
    host: current.host,
    projectDir: current.repo.dir,
    store: current.store,
  };
}

async function readyWorkspace(current: WorktreeRun): Promise<IntegrationWorkspace> {
  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') throw new Error('expected a prepared integration workspace');
  return prepared.workspace;
}

/** Every worktree Git has registered, by path. */
function registered(current: WorktreeRun): string[] {
  return current.repo
    .userGit(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/** Every ref under this run's namespace. */
function namespaceRefs(current: WorktreeRun): string[] {
  return current.repo
    .userGit([
      'for-each-ref',
      '--format=%(refname)',
      '--',
      `refs/heads/agent-flow/${current.gitRunKey}`,
    ])
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** An integrated task, so its worktree is reclaimable by default (§20.3). */
async function integrate(
  current: WorktreeRun,
  workspace: IntegrationWorkspace,
  task: string,
): Promise<PlantedAttempt> {
  const planted = await current.plant(task, 1, { write: { [`${task}.txt`]: `${task}\n` } });
  const outcome = await current.integrator.integrate({
    runId: current.runId,
    workspace,
    dag: current.dag([{ id: task }]),
    attempts: [{ task, attempt: 1, result: current.resultFor(task) }],
  });
  if (outcome.outcomes[0]?.kind !== 'integrated') throw new Error(`${task} did not integrate`);
  return planted;
}

describe('a removed run leaves no worktree and no attempt ref (§20.1)', () => {
  it('reclaims the integration checkout and every integrated attempt', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await integrate(run, workspace, 'TASK-001');

    expect(registered(run).some((path) => path.includes('TASK-001/attempt-1'))).toBe(true);
    expect(namespaceRefs(run)).toContain(`refs/heads/${planted.branch}`);

    const outcome = await reclaimNamespace(depsOf(run), run.runId);

    expect(outcome.failures).toEqual([]);
    expect(outcome.stateRemovable).toBe(true);
    // The attempt worktree and the integration checkout are both gone.
    expect(registered(run).filter((path) => path.includes(run?.gitRunKey ?? ''))).toEqual([]);
    expect(existsSync(workspace.path)).toBe(false);
    // The attempt ref is gone, and it is the *only* ref that went.
    expect(outcome.attemptRefs).toEqual([`refs/heads/${planted.branch}`]);
    expect(namespaceRefs(run)).toEqual([`refs/heads/${run.integrationBranch}`]);
    // Workspace-relative in the report, never absolute (§7.2, §21.3).
    for (const reclaimed of outcome.worktrees) {
      expect(reclaimed.startsWith('/')).toBe(false);
      expect(reclaimed).not.toContain(run?.repo.home ?? 'unreachable');
    }
  });

  it('is safe to run twice', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await integrate(run, workspace, 'TASK-001');

    const first = await reclaimNamespace(depsOf(run), run.runId);
    const after = { registered: registered(run), refs: namespaceRefs(run) };

    const second = await reclaimNamespace(depsOf(run), run.runId);

    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);
    expect(second.stateRemovable).toBe(true);
    // Nothing left to do, and nothing broken by asking again.
    expect(second.worktrees).toEqual([]);
    expect(second.attemptRefs).toEqual([]);
    expect(registered(run)).toEqual(after.registered);
    expect(namespaceRefs(run)).toEqual(after.refs);
  });
});

describe('what reclamation refuses to touch (§20.2)', () => {
  it('leaves a foreign worktree and a foreign branch alone', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await integrate(run, workspace, 'TASK-001');

    // A worktree of the same repository, registered somewhere Agent Flow does not
    // own, on a branch outside the namespace. A user who made one made a choice.
    const foreignPath = join(run.repo.home, 'somewhere-else');
    run.repo.userGit(['branch', 'my-own-work', run.planningBase]);
    run.repo.userGit(['worktree', 'add', foreignPath, 'my-own-work']);

    await reclaimNamespace(depsOf(run), run.runId, { worktrees: true, branches: true });

    expect(existsSync(foreignPath), 'a foreign worktree was removed').toBe(true);
    expect(registered(run)).toContain(foreignPath);
    expect(
      run.repo.userGit(['rev-parse', 'refs/heads/my-own-work']).trim(),
      'a foreign branch was deleted',
    ).toBe(run.planningBase);
    // And `main`, which is the user's actual branch, is untouched.
    expect(run.repo.userGit(['rev-parse', 'refs/heads/main']).trim()).toBe(run.planningBase);
  });

  it('leaves a directory Git never registered alone, even inside the owned root', async () => {
    // Every path acted on comes from `git worktree list --porcelain` intersected with
    // trusted run state. A directory that merely *looks* like a workspace is not one,
    // and removing it would be `clean` deciding from the shape of a filename.
    run = await makeWorktreeRun();
    await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const impostor = join(
      run.repo.worktreeRoot,
      'somebody-000000000000',
      run.gitRunKey,
      'TASK-001',
      'attempt-1',
    );
    mkdirSync(impostor, { recursive: true });

    await reclaimNamespace(depsOf(run), run.runId, { worktrees: true });

    expect(existsSync(impostor)).toBe(true);
  });

  it('leaves the user’s working tree byte-for-byte unchanged', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await integrate(run, workspace, 'TASK-001');

    run.repo.write('README.md', 'the user was editing this\n');
    run.repo.write('loose.txt', 'untracked\n');

    const before = {
      head: run.repo.userGit(['rev-parse', 'HEAD']).trim(),
      branch: run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      status: run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all']),
      index: run.repo.userGit(['ls-files', '--stage']),
      readme: readFileSync(join(run.repo.dir, 'README.md'), 'utf8'),
    };

    await reclaimNamespace(depsOf(run), run.runId, { worktrees: true, branches: true });

    expect(run.repo.userGit(['rev-parse', 'HEAD']).trim()).toBe(before.head);
    expect(run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(before.branch);
    expect(run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
      before.status,
    );
    expect(run.repo.userGit(['ls-files', '--stage'])).toBe(before.index);
    expect(readFileSync(join(run.repo.dir, 'README.md'), 'utf8')).toBe(before.readme);
  });
});

describe('retention keeps what is the only copy (§20.3)', () => {
  it('keeps the worktree of an attempt that was never integrated', async () => {
    run = await makeWorktreeRun();
    await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    // The attempt failed validation, so its worktree is the only remaining copy of
    // what its agent produced (§7.4).
    forceState(run, [{ id: 'TASK-001', state: 'review_required', attempts: 1 }]);

    const kept = await reclaimNamespace(depsOf(run), run.runId);

    expect(kept.worktreesRetained.some((path) => path.includes('TASK-001/attempt-1'))).toBe(true);
    expect(existsSync(planted.workspacePath)).toBe(true);
    // Retaining is not a failure: the run's state is still removable.
    expect(kept.failures).toEqual([]);
    expect(kept.stateRemovable).toBe(true);

    // And `--worktrees` is what reclaims it, deliberately and by name.
    const reclaimed = await reclaimNamespace(depsOf(run), run.runId, { worktrees: true });
    expect(reclaimed.worktrees.some((path) => path.includes('TASK-001/attempt-1'))).toBe(true);
    expect(existsSync(planted.workspacePath)).toBe(false);
  });

  it('changes nothing under --dry-run', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await integrate(run, workspace, 'TASK-001');

    const before = { registered: registered(run), refs: namespaceRefs(run) };

    const outcome = await reclaimNamespace(depsOf(run), run.runId, {
      dryRun: true,
      worktrees: true,
      branches: true,
    });

    // It reports what it *would* do…
    expect(outcome.attemptRefs).toEqual([`refs/heads/${planted.branch}`]);
    expect(outcome.worktrees.length).toBeGreaterThan(0);
    expect(outcome.integrationBranch.kind).toBe('forced');
    // …and did none of it.
    expect(registered(run)).toEqual(before.registered);
    expect(namespaceRefs(run)).toEqual(before.refs);
    expect(existsSync(planted.workspacePath)).toBe(true);
  });
});

describe('the integration branch survives its run’s state (§20.4)', () => {
  it('keeps a branch that is merged nowhere, reports it, and still allows the state to go', async () => {
    // §19.3 told the user the product of a run is a branch and printed `git merge`
    // as the thing to do with it. A housekeeping command that deleted it weeks later
    // would be the tool taking back its own promise.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await integrate(run, workspace, 'TASK-001');
    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();

    const outcome = await reclaimNamespace(depsOf(run), run.runId);

    expect(outcome.integrationBranch).toEqual({
      kind: 'kept',
      ref: run.integrationBranch,
      head,
    });
    // Kept is **not** a failure: the state still goes, and `clean` still exits zero.
    expect(outcome.failures).toEqual([]);
    expect(outcome.stateRemovable).toBe(true);
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(head);
  });

  it('deletes the same branch once a ref outside the namespace contains it', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await integrate(run, workspace, 'TASK-001');
    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();

    // The user took the work. The branch is now a duplicate of history they own, so
    // deleting it loses nothing — which is the only thing that authorises deletion.
    run.repo.userGit(['branch', 'took-it', head]);

    const outcome = await reclaimNamespace(depsOf(run), run.runId);

    expect(outcome.integrationBranch).toEqual({
      kind: 'redundant',
      ref: run.integrationBranch,
      mergedInto: 'refs/heads/took-it',
    });
    expect(namespaceRefs(run)).toEqual([]);
    // And the ref the user owns is still there, holding the work.
    expect(run.repo.userGit(['rev-parse', 'refs/heads/took-it']).trim()).toBe(head);
  });

  it('does not treat another Agent Flow branch as somebody having taken the work', async () => {
    // `foreign` means "outside `refs/heads/agent-flow/`", and the distinction is the
    // whole rule: a *second run's* branch containing this one is not a person having
    // merged it, and deleting on that basis would lose the only copy.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await integrate(run, workspace, 'TASK-001');
    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();

    run.repo.userGit(['branch', 'agent-flow/AF-2026-999-0f3a91c4bd27e615/integration', head]);

    const outcome = await reclaimNamespace(depsOf(run), run.runId);

    expect(outcome.integrationBranch.kind).toBe('kept');
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(head);
  });

  it('deletes an unmerged branch when --branches asks for it', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    await integrate(run, workspace, 'TASK-001');

    const outcome = await reclaimNamespace(depsOf(run), run.runId, { branches: true });

    expect(outcome.integrationBranch.kind).toBe('forced');
    expect(namespaceRefs(run)).toEqual([]);
  });
});

describe('a namespace that could not be reclaimed keeps its state (§20.1)', () => {
  it('reports the failure and refuses to let the state go', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await integrate(run, workspace, 'TASK-001');

    // A removal Git will not do. Injected rather than provoked, because the
    // interesting behaviour is what §20.1 does *about* a failure — keep the state —
    // and provoking a real one now takes a repository in a state this suite would
    // have to break on purpose. The real refusals (a locked worktree, a registry
    // that cannot be read) all arrive through this same `ok: false`.
    const outcome = await reclaimNamespace(
      {
        ...depsOf(run),
        workspaces: delegating(run.repo.workspaces, {
          removeWorktree: async () => ({
            ok: false as const,
            failure: { code: 'git_command_failed' as const, message: 'refused' },
          }),
        }),
      },
      run.runId,
    );

    expect(outcome.stateRemovable).toBe(false);
    expect(outcome.failures.length).toBeGreaterThan(0);
    expect(outcome.failures.join(' ')).toContain('TASK-001 attempt 1');
    // Path-free: a failed `worktree remove` names the absolute directory it tried,
    // and this sentence reaches a terminal and an event (§7.2, §21.3).
    expect(outcome.failures.join(' ')).not.toContain(run.repo.home);
    expect(existsSync(planted.workspacePath)).toBe(true);
    // The run's own artifacts are still readable, which is what keeping the state is for.
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1))).toBe(true);
  });
});

describe('a run with no namespace has nothing to reclaim (§25)', () => {
  it('reports a removable state without asking Git anything', async () => {
    run = await makeWorktreeRun();

    // A sequential run, which is what every project that never turned worktrees on
    // has. `clean` must behave exactly as it always has for it.
    const sequential = await run.store.createRun('a sequential feature', () => ({
      isolationMode: 'none' as const,
      planningBase: run?.planningBase ?? 'a'.repeat(40),
    }));

    const outcome = await reclaimNamespace(depsOf(run), sequential.runId);

    expect(outcome).toEqual({
      runId: sequential.runId,
      worktrees: [],
      worktreesRetained: [],
      attemptRefs: [],
      integrationBranch: { kind: 'absent' },
      stateRemovable: true,
      failures: [],
    });
  });
});
