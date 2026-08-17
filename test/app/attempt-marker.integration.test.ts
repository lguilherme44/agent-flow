import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { attemptRef, attemptWorkspace } from '../../src/core/worktree-policy.js';
import {
  publishMarker,
  readAttempt,
  recordAttempt,
  type AttemptDraft,
  type AttemptEvidenceDeps,
} from '../../src/app/attempt-receipt.js';
import { runPaths } from '../../src/app/paths.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * The marker, against real Git (§26.3).
 *
 * **Nothing here may be mocked**, and the reason is not thoroughness: every
 * claim below is a claim about Git's behaviour rather than about this code.
 * That `commit-tree` is content-addressed and therefore idempotent, that a tree
 * equal to its parent's needs no `--allow-empty`, that `update-ref` moves a
 * checked-out branch without touching the working tree, that an inherited
 * `GIT_AUTHOR_NAME` outranks `-c user.name` — each was probed, and a fake would
 * only ever confirm what the fake was told.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const RUN = 'AF-2026-001';
const KEY = 'AF-2026-001-0f3a91c4bd27e615';
const REPO_KEY = 'temp-repo-0f3a91c4bd27';

function locationOf(taskId: string, attempt: number) {
  const location = attemptWorkspace(REPO_KEY, KEY, taskId, attempt);
  if (!location.ok) throw new Error(location.refusal.reason);
  return location.value;
}

function branchOf(taskId: string, attempt: number): string {
  const ref = attemptRef(KEY, taskId, attempt);
  if (!ref.ok) throw new Error(ref.refusal.reason);
  return ref.value;
}

/**
 * A real attempt worktree, cut from HEAD, exactly as M2-04 prepares one.
 *
 * `git worktree add -b` in one command, which is what makes the attempt branch
 * exist *before* the marker does — the state the ref update has to survive.
 */
async function attemptWorkspaceOn(
  current: TempRepo,
  taskId: string,
  attempt: number,
): Promise<{ readonly path: string; readonly base: string; readonly branch: string }> {
  const base = current.head();
  const branch = branchOf(taskId, attempt);

  const added = await current.workspaces.addWorktree({
    cwd: current.dir,
    location: locationOf(taskId, attempt),
    branch,
    base,
    reason: `agent-flow ${KEY} ${taskId} attempt-${String(attempt)}`,
  });
  if (!added.ok) throw new Error(added.failure.message);

  return { path: added.value, base, branch };
}

function depsOn(current: TempRepo): AttemptEvidenceDeps {
  return {
    workspaces: current.workspaces,
    fs: new NodeFileSystem(),
    clock: new FixedClock(),
    host: new FakeHost(),
    projectDir: current.dir,
  };
}

function draftFor(
  workspace: { readonly base: string; readonly branch: string },
  taskId: string,
  attempt: number,
  overrides: Partial<AttemptDraft> = {},
): AttemptDraft {
  return {
    run: RUN,
    task: taskId,
    attempt,
    base: workspace.base,
    branch: workspace.branch,
    workspace: `${REPO_KEY}/${KEY}/${taskId}/attempt-${String(attempt)}`,
    runner: 'claude',
    reasoning: 'high',
    reasoningClamped: false,
    startedAt: '2026-08-09T19:59:00.000Z',
    finishedAt: '2026-08-09T20:00:00.000Z',
    filesChanged: ['feature.txt'],
    agentReport: { status: 'COMPLETED', notes: [], deviations: [], claimedFilesChanged: [] },
    validation: { expectation: 'pass', passed: true, ids: ['lint', 'test'], commands: [] },
    validationJudgement: 'satisfied',
    ...overrides,
  };
}

function fired(sentinel: string): boolean {
  return existsSync(sentinel) && readFileSync(sentinel, 'utf8').includes('fired');
}

describe('the marker is the validated tree on the attempt base (§12.1)', () => {
  it('captures what the agent left, and binds the marker to it', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);

    // The agent's work: a tracked change and a new file, neither committed.
    writeFileSync(join(workspace.path, 'README.md'), 'changed by the agent\n');
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    const outcome = await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const marker = outcome.value.marker;
    const tree = outcome.value.attempt.receipt?.validatedTree;
    expect(marker).toBeDefined();
    expect(tree).toMatch(/^[0-9a-f]{40}$/);

    // The binding I-6 rests on: the marker's tree *is* the receipt's tree, asked
    // of Git rather than of the object this process is holding.
    expect(repo.userGit(['rev-parse', `${marker?.oid ?? ''}^{tree}`]).trim()).toBe(tree);
    // One parent, and it is the base the worktree was cut from.
    expect(repo.userGit(['rev-parse', `${marker?.oid ?? ''}^`]).trim()).toBe(workspace.base);
    expect(
      repo.userGit(['rev-list', '--count', '--merges', `${marker?.oid ?? ''}`]).trim(),
    ).toBe('0');

    // And the tree really is what the worktree held: both files are in it.
    const listed = repo.userGit(['ls-tree', '--name-only', tree ?? '']).trim().split('\n');
    expect(listed.sort()).toEqual(['README.md', 'feature.txt']);
  });

  it('points the attempt branch at the marker', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    const outcome = await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });
    if (!outcome.ok) throw new Error(outcome.failure.detail);

    expect(repo.userGit(['rev-parse', `refs/heads/${workspace.branch}`]).trim()).toBe(
      outcome.value.marker?.oid,
    );
    // The branch was checked out in the attempt worktree when the ref moved, and
    // the working tree is now clean against it — because the marker's tree is
    // exactly what that worktree holds.
    expect(repo.userGit(['status', '--porcelain=v1'], workspace.path).trim()).toBe('');
  });

  it('carries the §12.4 trailers into the commit object', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 2);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    const outcome = await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-003', 2),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });
    if (!outcome.ok) throw new Error(outcome.failure.detail);

    const object = repo.userGit(['cat-file', 'commit', outcome.value.marker?.oid ?? '']);

    expect(object).toContain('author Agent Flow <agent-flow@local>');
    expect(object).toContain('committer Agent Flow <agent-flow@local>');
    expect(object).toContain(`Agent-Flow-Run: ${RUN}`);
    expect(object).toContain(`Agent-Flow-Run-Key: ${KEY}`);
    expect(object).toContain('Agent-Flow-Attempt: 2');
    expect(object).toContain(`Agent-Flow-Receipt: ${outcome.value.attempt.receipt?.nonce ?? ''}`);
    expect(object).toContain('Agent-Flow-Validation: satisfied');
    expect(object).toContain('Agent-Flow-Validation-Ids: lint,test');
  });
});

describe('a task that changed nothing still gets a marker (§12.1)', () => {
  it('creates it with no --allow-empty, and its tree is the base tree', async () => {
    // The `validationExpectation: none` task, and the task whose work was
    // already done. `commit-tree` has no emptiness check at all, which is why
    // the flag `git commit` would need is not merely unused but unnecessary.
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-004', 1);

    const outcome = await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-004', 1, {
        filesChanged: [],
        validation: { expectation: 'none', passed: true, ids: [], commands: [] },
      }),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const baseTree = repo.userGit(['rev-parse', `${workspace.base}^{tree}`]).trim();
    expect(outcome.value.attempt.receipt?.validatedTree).toBe(baseTree);
    expect(repo.userGit(['rev-parse', `${outcome.value.marker?.oid ?? ''}^{tree}`]).trim()).toBe(
      baseTree,
    );
    expect(repo.userGit(['rev-parse', `${outcome.value.marker?.oid ?? ''}^`]).trim()).toBe(
      workspace.base,
    );
  });
});

describe('the marker is a deterministic function of the artifact (§12.2)', () => {
  it('yields the same commit id when rebuilt from what is on disk', async () => {
    // The property windows 3 and 4 of §17.3 rest on: a crash between
    // `commit-tree` and `update-ref` needs no bookkeeping, because running
    // `commit-tree` again produces the *same* object.
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    const deps = depsOn(repo);
    const first = await recordAttempt(deps, {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });
    if (!first.ok) throw new Error(first.failure.detail);

    // Nothing from the first run's memory: the artifact is read back off disk,
    // exactly as a resumed process would have to.
    const persisted = await readAttempt(deps, RUN, 'TASK-003', 1);
    expect(persisted).not.toBeNull();
    if (persisted === null) return;

    const again = await publishMarker(deps, persisted, KEY);
    expect(again.ok).toBe(true);
    expect(again.ok && again.value.oid).toBe(first.value.marker?.oid);

    // Git stored it once, so the second run created no second object.
    expect(repo.userGit(['cat-file', '-t', first.value.marker?.oid ?? '']).trim()).toBe('commit');
    expect(repo.userGit(['rev-parse', `refs/heads/${workspace.branch}`]).trim()).toBe(
      first.value.marker?.oid,
    );
  });

  it('is unmoved by a hostile Git identity in the environment', async () => {
    // Probed: `GIT_AUTHOR_NAME` outranks `-c user.name`, so without the removal
    // at the Git boundary the marker would be a function of the shell Agent Flow
    // was started from — two machines, two commit ids, and recovery unable to
    // recognise its own marker.
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    const deps = depsOn(repo);
    const clean = await recordAttempt(deps, {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });
    if (!clean.ok) throw new Error(clean.failure.detail);

    const persisted = await readAttempt(deps, RUN, 'TASK-003', 1);
    if (persisted === null) throw new Error('the attempt did not read back');

    const hostile = {
      GIT_AUTHOR_NAME: 'Evil',
      GIT_AUTHOR_EMAIL: 'evil@example.invalid',
      GIT_COMMITTER_NAME: 'Evil',
      GIT_COMMITTER_EMAIL: 'evil@example.invalid',
      GIT_AUTHOR_DATE: '2001-01-01T00:00:00.000Z',
      GIT_COMMITTER_DATE: '2001-01-01T00:00:00.000Z',
    } as const;
    const saved = new Map(Object.keys(hostile).map((name) => [name, process.env[name]]));

    try {
      Object.assign(process.env, hostile);
      const under = await publishMarker(deps, persisted, KEY);

      expect(under.ok).toBe(true);
      expect(under.ok && under.value.oid).toBe(clean.value.marker?.oid);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const object = repo.userGit(['cat-file', 'commit', clean.value.marker?.oid ?? '']);
    expect(object).toContain('author Agent Flow <agent-flow@local>');
    expect(object).not.toContain('Evil');
  });
});

describe('the coding agent’s own commits are not provenance (§12.5)', () => {
  it('keeps them out of the marker’s ancestry', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);

    // An agent that commits habitually: two commits of its own, on the attempt
    // branch, before the orchestrator ever looks at the worktree.
    writeFileSync(join(workspace.path, 'feature.txt'), 'first pass\n');
    repo.userGit(['add', '-A'], workspace.path);
    repo.userGit(['commit', '--quiet', '--no-verify', '-m', 'agent: wip'], workspace.path);
    const agentCommit = repo.userGit(['rev-parse', 'HEAD'], workspace.path).trim();

    writeFileSync(join(workspace.path, 'feature.txt'), 'second pass\n');
    repo.userGit(['add', '-A'], workspace.path);
    repo.userGit(['commit', '--quiet', '--no-verify', '-m', 'agent: more wip'], workspace.path);
    const agentHead = repo.userGit(['rev-parse', 'HEAD'], workspace.path).trim();

    // And one uncommitted change on top, because agents are inconsistent about
    // this and the validated unit is the tree either way.
    writeFileSync(join(workspace.path, 'extra.txt'), 'uncommitted\n');

    const outcome = await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });
    if (!outcome.ok) throw new Error(outcome.failure.detail);

    const marker = outcome.value.marker?.oid ?? '';

    // A logical squash: one parent, and it is the base — not the agent's head.
    expect(repo.userGit(['rev-parse', `${marker}^`]).trim()).toBe(workspace.base);
    const ancestry = repo.userGit(['rev-list', marker]).trim().split('\n');
    expect(ancestry).not.toContain(agentCommit);
    expect(ancestry).not.toContain(agentHead);

    // The tree, though, is everything the worktree held — committed by the agent
    // or not, which is the point of capturing a tree rather than a history.
    const listed = repo
      .userGit(['ls-tree', '--name-only', outcome.value.attempt.receipt?.validatedTree ?? ''])
      .trim()
      .split('\n');
    expect(listed.sort()).toEqual(['README.md', 'extra.txt', 'feature.txt']);
    expect(
      repo.userGit(['show', `${marker}:feature.txt`]).trim(),
    ).toBe('second pass');
  });
});

describe('an unsatisfied attempt leaves no receipt, no nonce and no marker', () => {
  it('writes evidence and touches no ref', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'broken\n');

    const before = repo.userGit(['rev-parse', `refs/heads/${workspace.branch}`]).trim();

    const outcome = await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-003', 1, {
        validationJudgement: 'unsatisfied',
        validation: { expectation: 'pass', passed: false, ids: ['test'], commands: [] },
      }),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.marker).toBeUndefined();
    expect(outcome.ok && outcome.value.attempt.receipt).toBeUndefined();

    // The branch is exactly where `worktree add -b` left it: at the base.
    expect(repo.userGit(['rev-parse', `refs/heads/${workspace.branch}`]).trim()).toBe(before);
    expect(before).toBe(workspace.base);

    // And the artifact on disk carries no nonce anywhere in its bytes.
    const raw = readFileSync(runPaths(repo.dir, RUN).taskAttempt('TASK-003', 1), 'utf8');
    expect(raw).not.toContain('receipt');
    expect(raw).not.toContain('nonce');
  });
});

describe('the artifact is outside every worktree (§11.2)', () => {
  it('is written under the run, not under the checkout the agent had', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });

    const path = runPaths(repo.dir, RUN).taskAttempt('TASK-003', 1);
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(repo.worktreeRoot)).toBe(false);
    expect(existsSync(join(workspace.path, '.agent-flow'))).toBe(false);

    // Nothing on this machine is named in it — not the worktree root, not the
    // project directory (§7.2, §21.3).
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(repo.worktreeRoot);
    expect(raw).not.toContain(repo.dir);
  });
});

describe('no Git hook runs while a marker is built (S-12, §12.3)', () => {
  it('fires for a user commit and not for commit-tree or update-ref', async () => {
    repo = await makeTempRepoWithCommit();
    const sentinels = {
      preCommit: repo.installSentinelHook('pre-commit'),
      postCommit: repo.installSentinelHook('post-commit'),
      referenceTransaction: repo.installSentinelHook('reference-transaction'),
    };

    // --- positive control. Without it, "the sentinel was not written" is green
    // when the hook is broken, when it was never installed, and when isolation
    // works — three very different things.
    mkdirSync(join(repo.dir, 'control'), { recursive: true });
    writeFileSync(join(repo.dir, 'control', 'file.txt'), 'user\n');
    repo.userGit(['add', '-A']);
    repo.userGit(['commit', '-m', 'a commit the user made']);

    expect(fired(sentinels.preCommit), 'pre-commit never fired — the control is broken').toBe(true);
    expect(fired(sentinels.postCommit), 'post-commit never fired — the control is broken').toBe(
      true,
    );
    expect(
      fired(sentinels.referenceTransaction),
      'reference-transaction never fired — the control is broken',
    ).toBe(true);

    // --- the assertion. The hooks stay installed and the *sentinels* are
    // cleared, so what follows is measured against an empty slate produced by
    // the same scripts that just proved they work.
    for (const sentinel of Object.values(sentinels)) rmSync(sentinel, { force: true });

    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    const outcome = await recordAttempt(depsOn(repo), {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });
    expect(outcome.ok).toBe(true);

    expect(fired(sentinels.preCommit)).toBe(false);
    expect(fired(sentinels.postCommit)).toBe(false);
    // The one `--no-verify` could never have covered: it does not exist for
    // `update-ref`, and a plain ref update fires this hook (probed on 2.52.0).
    expect(fired(sentinels.referenceTransaction)).toBe(false);
  });
});

/**
 * The two ways publication fails against a real repository.
 *
 * Both are reached by making Git genuinely refuse — a parent that is not an
 * object, a ref whose name collides with an existing one — rather than by
 * telling a fake to return non-zero. The distinction matters here because the
 * claims are about what Git *leaves behind* when it refuses, and a fake has
 * nothing to leave.
 */
describe('a marker that Git refuses to publish (§17.3 windows 3 and 4)', () => {
  /** Every commit object in the repository, reachable from a ref or not. */
  function commitsIn(current: TempRepo): { readonly all: string[]; readonly unreachable: string[] } {
    const all = current
      .userGit(['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)'])
      .split('\n')
      .filter((line) => line.startsWith('commit '))
      .map((line) => line.slice('commit '.length).trim());

    const reachable = new Set(
      current.userGit(['rev-list', '--all']).trim().split('\n').filter(Boolean),
    );

    return { all, unreachable: all.filter((commit) => !reachable.has(commit)) };
  }

  it('leaves the artifact and the branch untouched when commit-tree refuses', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    // A base that is 40 hex characters and is not an object — the shape §17.3
    // window 10 describes, where the tree or the base was pruned between the
    // capture and the commit. `commit-tree` refuses outright.
    const missing = 'b'.repeat(40);
    const deps = depsOn(repo);
    const outcome = await recordAttempt(deps, {
      draft: draftFor({ base: missing, branch: workspace.branch }, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failure.code).toBe('attempt_marker_unpublishable');

    // The evidence stands. It was written before the marker was attempted, and
    // this is exactly window 3: a receipt with no marker, which recovery
    // resolves by re-running `commit-tree` — impossible if the artifact had been
    // deleted or downgraded "to keep things consistent".
    const persisted = await readAttempt(deps, RUN, 'TASK-003', 1);
    expect(persisted?.validationJudgement).toBe('satisfied');
    expect(persisted?.receipt?.validatedTree).toMatch(/^[0-9a-f]{40}$/);
    expect(persisted?.base).toBe(missing);

    // The branch is where `worktree add -b` left it, and no commit was created.
    expect(repo.userGit(['rev-parse', `refs/heads/${workspace.branch}`]).trim()).toBe(
      workspace.base,
    );
    expect(commitsIn(repo).unreachable).toEqual([]);
  });

  it('leaves an unreachable commit and no ref when update-ref refuses', async () => {
    // Bound locally as well as to the suite's `repo`, because the assertions
    // below run Git inside `expect(() => …)` and a module-level `let` is not
    // narrowed inside a closure.
    const current = (repo = await makeTempRepoWithCommit());

    // A directory/file conflict in the ref namespace: with `…/TASK-009` existing
    // as a ref, Git cannot create `…/TASK-009/attempt-1` — the first is a file
    // where the second needs a directory. A real refusal, from real Git, with
    // the marker already written to the object database.
    const occupied = `agent-flow/${KEY}/TASK-009`;
    current.userGit(['update-ref', `refs/heads/${occupied}`, current.head()]);

    // The repository itself is the workspace here, because the attempt branch
    // cannot be created at all under a name Git refuses.
    writeFileSync(join(current.dir, 'feature.txt'), 'new\n');

    const deps = depsOn(current);
    const outcome = await recordAttempt(deps, {
      draft: draftFor(
        { base: current.head(), branch: `${occupied}/attempt-1` },
        'TASK-009',
        1,
      ),
      workspacePath: current.dir,
      gitRunKey: KEY,
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failure.code).toBe('attempt_marker_unpublishable');
    // Git's stderr names the refs it could not lock; what a person reads does
    // not carry it, and carries no path either (§7.2, §21.3).
    expect(!outcome.ok && outcome.failure.detail).not.toContain(current.dir);

    // The artifact survives with its receipt, unrewritten.
    const persisted = await readAttempt(deps, RUN, 'TASK-009', 1);
    expect(persisted?.validationJudgement).toBe('satisfied');
    const tree = persisted?.receipt?.validatedTree ?? '';
    expect(tree).toMatch(/^[0-9a-f]{40}$/);

    // The ref does not exist, so nothing points at the unpublished marker.
    expect(() => current.userGit(['rev-parse', '--verify', `refs/heads/${occupied}/attempt-1`])).toThrow();

    // The marker object *does* exist and is unreachable, and that is acceptable
    // — a dangling commit costs disk until `gc`, never correctness. What would
    // not be acceptable is a ref pointing at it, and there is none: this commit
    // is reachable from nothing.
    const { unreachable } = commitsIn(current);
    expect(unreachable).toHaveLength(1);
    expect(current.userGit(['rev-parse', `${unreachable[0] ?? ''}^{tree}`]).trim()).toBe(tree);
    // Recovery's window 3 handling still applies to it unchanged: re-running
    // `commit-tree` from this artifact yields that same object.
    expect(unreachable[0]).toBeDefined();
  });

  it('does not corrupt the repository by failing', async () => {
    const current = (repo = await makeTempRepoWithCommit());
    const occupied = `agent-flow/${KEY}/TASK-009`;
    current.userGit(['update-ref', `refs/heads/${occupied}`, current.head()]);
    writeFileSync(join(current.dir, 'feature.txt'), 'new\n');

    await recordAttempt(depsOn(current), {
      draft: draftFor({ base: current.head(), branch: `${occupied}/attempt-1` }, 'TASK-009', 1),
      workspacePath: current.dir,
      gitRunKey: KEY,
    });

    // `--connectivity-only` so the dangling commit the previous step left is not
    // read as damage: it is expected, and `fsck` reports it as an observation.
    expect(() => current.userGit(['fsck', '--no-progress', '--connectivity-only'])).not.toThrow();
    expect(current.userGit(['rev-parse', 'HEAD']).trim()).toBe(current.head());
  });
});

describe('the evidence is written once, against a real filesystem', () => {
  it('refuses the second write and leaves the first marker in place', async () => {
    repo = await makeTempRepoWithCommit();
    const workspace = await attemptWorkspaceOn(repo, 'TASK-003', 1);
    writeFileSync(join(workspace.path, 'feature.txt'), 'new\n');

    const deps = depsOn(repo);
    const first = await recordAttempt(deps, {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });
    if (!first.ok) throw new Error(first.failure.detail);

    // A second attempt at the same file, with the worktree changed underneath —
    // which is what makes an overwrite dangerous rather than merely untidy: the
    // receipt would point at a tree the validation never ran against.
    writeFileSync(join(workspace.path, 'feature.txt'), 'changed after the fact\n');
    const second = await recordAttempt(deps, {
      draft: draftFor(workspace, 'TASK-003', 1),
      workspacePath: workspace.path,
      gitRunKey: KEY,
    });

    expect(second.ok).toBe(false);
    expect(!second.ok && second.failure.code).toBe('attempt_artifact_exists');

    const persisted = await readAttempt(deps, RUN, 'TASK-003', 1);
    expect(persisted?.receipt?.nonce).toBe(first.value.attempt.receipt?.nonce);
    expect(persisted?.receipt?.validatedTree).toBe(first.value.attempt.receipt?.validatedTree);
    expect(repo.userGit(['rev-parse', `refs/heads/${workspace.branch}`]).trim()).toBe(
      first.value.marker?.oid,
    );
  });
});
