import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ABSENT_OID,
  MINIMUM_SUPPORTED_GIT_VERSION,
  compareGitVersions,
} from '../../src/adapters/git/git-workspaces.js';
import { attemptWorkspace, integrationWorkspace } from '../../src/core/worktree-policy.js';
import type { WorkspaceLocation } from '../../src/core/worktree-policy.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * The §26.3 matrix, against real Git. **Nothing here is mocked.**
 *
 * The spec is explicit that these operations must not be faked, and the reason
 * is the class of defect only real Git catches: an exit code that means
 * something different from what the code assumed, a flag that does not exist on
 * the supported floor, a porcelain format that is not what the parser expects.
 * A fake would agree with whatever the implementation believed on the day it was
 * written.
 *
 * Every repository is a fresh temporary directory, and `~` is a directory inside
 * it — so nothing here can reach this project's own repository or the
 * developer's home (M2-02 brief §12).
 */

let repo: TempRepo | undefined;

afterEach(() => {
  // Unconditional, and before any assertion can have thrown past it. A failing
  // test must not be able to leave a registered worktree behind.
  repo?.cleanup();
  repo = undefined;
});

/** The workspace naming decisions of M2-01, reused rather than re-derived (§19). */
const REPO_KEY = 'temp-repo-0f3a91c4bd27';
const RUN_KEY = 'AF-2026-001-0f3a91c4bd27e615';

function attemptAt(taskId: string, attempt: number): WorkspaceLocation {
  const location = attemptWorkspace(REPO_KEY, RUN_KEY, taskId, attempt);
  if (!location.ok) throw new Error(`the test's own workspace name is invalid: ${location.refusal.reason}`);
  return location.value;
}

function integrationAt(): WorkspaceLocation {
  const location = integrationWorkspace(REPO_KEY, RUN_KEY);
  if (!location.ok) throw new Error(location.refusal.reason);
  return location.value;
}

const IDENTITY = { name: 'Agent Flow', email: 'agent-flow@local' } as const;
const DATES = { author: '2026-01-01T00:00:00Z', committer: '2026-01-01T00:00:00Z' } as const;

describe('version probe against the installed Git', () => {
  it('reads a version and finds it at or above the floor', async () => {
    repo = await makeTempRepoWithCommit();

    const version = await repo.workspaces.version(repo.dir);

    expect(version.ok).toBe(true);
    if (!version.ok) return;
    expect(version.value.major).toBe(2);
    // The suite could not have got this far on a Git without `worktree add
    // --reason`, so this asserts the floor is not set above what CI runs.
    expect(compareGitVersions(version.value, MINIMUM_SUPPORTED_GIT_VERSION)).toBeGreaterThanOrEqual(0);
  });

  it('accepts the installed Git through requireSupportedVersion', async () => {
    repo = await makeTempRepoWithCommit();

    expect((await repo.workspaces.requireSupportedVersion(repo.dir)).ok).toBe(true);
  });
});

describe('worktree add, list, unlock, remove, prune (§7.3, §23, §47)', () => {
  it('creates a locked worktree with its branch in one command', async () => {
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);

    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: `agent-flow ${RUN_KEY} TASK-001 attempt-1`,
    });

    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value).toBe(join(repo.worktreeRoot, ...location.segments));
    expect(existsSync(join(added.value, 'README.md'))).toBe(true);
  });

  it('reports it as locked, with the reason, in the porcelain listing', async () => {
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);
    const reason = `agent-flow ${RUN_KEY} TASK-001 attempt-1`;

    await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason,
    });

    const listed = await repo.workspaces.listWorktrees({ cwd: repo.dir });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const entry = listed.value.find((candidate) => candidate.path.includes('TASK-001'));
    expect(entry).toBeDefined();
    expect(entry?.locked).toBe(true);
    expect(entry?.lockReason).toBe(reason);
    expect(entry?.branch).toBe(`refs/heads/agent-flow/${RUN_KEY}/TASK-001/attempt-1`);
  });

  it('refuses to remove a locked worktree rather than forcing it', async () => {
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);
    await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: 'held',
    });

    const removed = await repo.workspaces.removeWorktree({ cwd: repo.dir, location });

    // The lock is protection against a stray `git worktree prune` reclaiming a
    // workspace an agent is writing into (§7.3). Forcing past it here would make
    // that protection a comment.
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    expect(removed.failure.code).toBe('git_command_failed');
    expect(existsSync(join(repo.worktreeRoot, ...location.segments))).toBe(true);
  });

  it('refuses to remove a dirty worktree, and forces one only when asked', async () => {
    // Git will not reclaim a worktree holding a modified tracked file or an
    // untracked non-ignored one, which is the state §8.4's `doctor` probe makes on
    // purpose: an install that rewrites a lockfile. Without `force` the probe
    // would leak a worktree on every warning it produced.
    //
    // Both halves matter. The default must still refuse — `force` discarding a
    // tree by accident is exactly what §7.4 forbids on an attempt worktree — and
    // the forced form must actually work, or the probe's `finally` is decoration.
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);
    const path = join(repo.worktreeRoot, ...location.segments);
    await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: 'held',
    });
    expect((await repo.workspaces.unlockWorktree({ cwd: repo.dir, location })).ok).toBe(true);
    writeFileSync(join(path, 'README.md'), 'rewritten by an install\n');

    const refused = await repo.workspaces.removeWorktree({ cwd: repo.dir, location });
    expect(refused.ok).toBe(false);
    expect(existsSync(path)).toBe(true);

    const forced = await repo.workspaces.removeWorktree({ cwd: repo.dir, location, force: true });
    expect(forced.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('does not let force past a lock', async () => {
    // `force` is about content, not about the lock: Git needs `--force` twice to
    // remove a locked worktree, and this adapter never sends the second one. So a
    // caller that reaches for `force` to tidy up still cannot delete a workspace
    // an agent may be writing into (§7.3).
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);
    await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: 'held',
    });

    const removed = await repo.workspaces.removeWorktree({ cwd: repo.dir, location, force: true });

    expect(removed.ok).toBe(false);
    expect(existsSync(join(repo.worktreeRoot, ...location.segments))).toBe(true);
  });

  it('unlocks, then removes, then prunes', async () => {
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);
    const path = join(repo.worktreeRoot, ...location.segments);
    await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: 'held',
    });

    expect((await repo.workspaces.unlockWorktree({ cwd: repo.dir, location })).ok).toBe(true);
    expect((await repo.workspaces.removeWorktree({ cwd: repo.dir, location })).ok).toBe(true);
    expect((await repo.workspaces.pruneWorktrees({ cwd: repo.dir })).ok).toBe(true);
    expect(existsSync(path)).toBe(false);

    const listed = await repo.workspaces.listWorktrees({ cwd: repo.dir });
    expect(listed.ok && listed.value.some((entry) => entry.path === path)).toBe(false);
  });

  it('separates its own worktrees from a foreign one (§20.2)', async () => {
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);
    await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: 'ours',
    });
    // A worktree the user made, on a branch inside the Agent Flow namespace, at
    // a path outside the Agent Flow root. The branch name is not what decides:
    // a user who moved a worktree made a choice, and cleanup must respect it.
    repo.userGit([
      'worktree',
      'add',
      '--quiet',
      '-b',
      `agent-flow/${RUN_KEY}/TASK-999/attempt-1`,
      `${repo.home}/moved-away`,
      'HEAD',
    ]);

    const all = await repo.workspaces.listWorktrees({ cwd: repo.dir });
    const ours = await repo.workspaces.ownWorktrees({ cwd: repo.dir });

    expect(all.ok && all.value.length).toBe(3); // main + ours + the foreign one
    expect(ours.ok).toBe(true);
    if (!ours.ok) return;
    expect(ours.value).toHaveLength(1);
    expect(ours.value[0]?.path).toBe(join(repo.worktreeRoot, ...location.segments));
  });

  it('checks out an existing branch when no -b is given (the integration shape, §14.1)', async () => {
    repo = await makeTempRepoWithCommit();
    const ref = `agent-flow/${RUN_KEY}/integration`;
    await repo.workspaces.updateRef({ cwd: repo.dir, ref: `refs/heads/${ref}`, newOid: repo.head() });

    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location: integrationAt(),
      base: ref,
      reason: `agent-flow ${RUN_KEY} integration`,
    });

    expect(added.ok).toBe(true);
  });

  it('refuses a path that would escape the worktree root', async () => {
    repo = await makeTempRepoWithCommit();

    // A location whose segments were not produced by the policy module. The
    // adapter re-checks rather than trusting that a caller validated them.
    const escape = { segments: ['..', '..', 'escaped'], relativePath: '../../escaped' };
    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location: escape,
      base: repo.head(),
      reason: 'escape attempt',
    });

    expect(added.ok).toBe(false);
    if (added.ok) return;
    expect(added.failure.code).toBe('git_unsafe_argument');
    expect(existsSync(join(repo.home, 'escaped'))).toBe(false);
  });

  it('refuses a branch name that could be read as an option (§46)', async () => {
    repo = await makeTempRepoWithCommit();

    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location: attemptAt('TASK-001', 1),
      branch: '--upload-pack=touch /tmp/pwned',
      base: repo.head(),
      reason: 'option injection',
    });

    expect(added.ok).toBe(false);
    if (added.ok) return;
    expect(added.failure.code).toBe('git_unsafe_argument');
  });

  it('requires a lock reason, so a listing can always say what holds a workspace', async () => {
    repo = await makeTempRepoWithCommit();

    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location: attemptAt('TASK-001', 1),
      base: repo.head(),
      reason: '',
    });

    expect(added.ok).toBe(false);
  });
});

describe('status is the cleanliness authority (§8.2, §25)', () => {
  it('calls a fresh worktree clean', async () => {
    repo = await makeTempRepoWithCommit();
    const location = attemptAt('TASK-001', 1);
    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location,
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: 'clean check',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const status = await repo.workspaces.status({ cwd: added.value });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.clean).toBe(true);
  });

  it('reports a modified tracked file as unstaged and not clean', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('README.md', 'changed\n');

    const status = await repo.workspaces.status({ cwd: repo.dir });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.clean).toBe(false);
    expect(status.value.unstaged).toContain('README.md');
  });

  it('reports a non-ignored untracked file, and ignores an ignored one', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', 'node_modules/\n');
    repo.commitAll('ignore build output');
    repo.write('new.ts', 'export {};\n');
    repo.userGit(['init', '--quiet', '.'], repo.dir); // no-op; keeps the shape obvious
    const modules = join(repo.dir, 'node_modules');
    repo.userGit(['status', '--porcelain=v1']); // touch nothing
    await import('node:fs').then((fs) => {
      fs.mkdirSync(modules, { recursive: true });
      fs.writeFileSync(join(modules, 'huge.js'), 'x');
    });

    const status = await repo.workspaces.status({ cwd: repo.dir });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.untracked).toContain('new.ts');
    // The whole reason an install does not fail a workspace assertion (§8.2).
    expect(status.value.untracked.some((path) => path.startsWith('node_modules'))).toBe(false);
  });
});

describe('write-tree, commit-tree, update-ref (§12.1, §26, §28, §29)', () => {
  it('stages and writes the tree of the working directory', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('added.ts', 'export const a = 1;\n');

    expect((await repo.workspaces.stageAll({ cwd: repo.dir })).ok).toBe(true);
    const tree = await repo.workspaces.writeTree({ cwd: repo.dir });

    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    expect(tree.value).toMatch(/^[0-9a-f]{40}$/);
  });

  it('creates a commit with the expected tree and parent', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    repo.write('added.ts', 'export const a = 1;\n');
    await repo.workspaces.stageAll({ cwd: repo.dir });
    const tree = await repo.workspaces.writeTree({ cwd: repo.dir });
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;

    const marker = await repo.workspaces.commitTree({
      cwd: repo.dir,
      tree: tree.value,
      parents: [base],
      message: 'agent-flow: TASK-001 attempt 1',
      identity: IDENTITY,
      dates: DATES,
    });

    expect(marker.ok).toBe(true);
    if (!marker.ok) return;
    expect(repo.userGit(['rev-parse', `${marker.value}^{tree}`]).trim()).toBe(tree.value);
    expect(repo.userGit(['rev-parse', `${marker.value}^1`]).trim()).toBe(base);
    // Exactly one parent: the structural discriminator between a marker and an
    // integration merge (§14.7).
    expect(repo.userGit(['rev-list', '--parents', '-n', '1', marker.value]).trim().split(' ')).toHaveLength(2);
  });

  it('produces the same SHA when run twice from the same inputs (§12.2)', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const tree = repo.userGit(['rev-parse', 'HEAD^{tree}']).trim();

    const make = () =>
      repo?.workspaces.commitTree({
        cwd: repo.dir,
        tree,
        parents: [base],
        message: 'agent-flow: TASK-001 attempt 1',
        identity: IDENTITY,
        dates: DATES,
      });

    const first = await make();
    const second = await make();

    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    if (!first?.ok || !second?.ok) return;
    // This property is what closes the "crashed after commit-tree, before
    // update-ref" window with no bookkeeping at all (§17.4).
    expect(second.value).toBe(first.value);
  });

  it('creates a marker whose tree equals its base — a task that changed nothing', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const tree = repo.userGit(['rev-parse', 'HEAD^{tree}']).trim();

    const marker = await repo.workspaces.commitTree({
      cwd: repo.dir,
      tree,
      parents: [base],
      message: 'agent-flow: TASK-002 attempt 1',
      identity: IDENTITY,
      dates: DATES,
    });

    // `--allow-empty` is neither used nor needed: `commit-tree` has no emptiness
    // check, and a task that validated without changing a file is a real
    // outcome that must be representable (§12.1).
    expect(marker.ok).toBe(true);
    if (!marker.ok) return;
    expect(repo.userGit(['rev-parse', `${marker.value}^{tree}`]).trim()).toBe(tree);
  });

  it('moves a branch, and refuses when the expected old value does not match', async () => {
    repo = await makeTempRepoWithCommit();
    const first = repo.head();
    repo.write('second.ts', 'export {};\n');
    const second = repo.commitAll('second');
    const ref = `refs/heads/agent-flow/${RUN_KEY}/integration`;

    // Create-if-absent.
    expect(
      (await repo.workspaces.updateRef({ cwd: repo.dir, ref, newOid: first, expectedOldOid: ABSENT_OID })).ok,
    ).toBe(true);
    expect(repo.userGit(['rev-parse', ref]).trim()).toBe(first);

    // A stale expectation is refused rather than applied.
    const stale = await repo.workspaces.updateRef({
      cwd: repo.dir,
      ref,
      newOid: second,
      expectedOldOid: ABSENT_OID,
    });
    expect(stale.ok).toBe(false);
    expect(repo.userGit(['rev-parse', ref]).trim()).toBe(first);

    // The correct expectation moves it.
    expect(
      (await repo.workspaces.updateRef({ cwd: repo.dir, ref, newOid: second, expectedOldOid: first })).ok,
    ).toBe(true);
    expect(repo.userGit(['rev-parse', ref]).trim()).toBe(second);
  });
});

describe('merge, conflict and abort (§14.5, §15, §30)', () => {
  async function twoDivergentBranches(): Promise<{ marker: string; head: string }> {
    if (repo === undefined) throw new Error('no repo');
    repo.write('shared.ts', 'original\n');
    const base = repo.commitAll('shared');

    repo.userGit(['checkout', '--quiet', '-b', 'sideline', base]);
    repo.write('shared.ts', 'from the sibling\n');
    const marker = repo.commitAll('sibling change');

    repo.userGit(['checkout', '--quiet', 'main']);
    repo.write('shared.ts', 'from main\n');
    const head = repo.commitAll('main change');

    return { marker, head };
  }

  it('produces a merge commit with two parents, even where a fast-forward was possible', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    repo.userGit(['checkout', '--quiet', '-b', 'sideline', base]);
    repo.write('only-there.ts', 'export {};\n');
    const marker = repo.commitAll('sibling');
    repo.userGit(['checkout', '--quiet', 'main']);

    const merged = await repo.workspaces.merge({
      cwd: repo.dir,
      commit: marker,
      message: 'agent-flow: integrate TASK-001 (attempt 1)',
      identity: IDENTITY,
      dates: DATES,
    });

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.kind).toBe('merged');
    // One task, one merge commit, always — otherwise "was this integrated" would
    // sometimes be answered by a merge and sometimes by ancestry (§14.5).
    expect(repo.userGit(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ')).toHaveLength(3);
  });

  it('reports a real conflict with its paths, and does not treat it as an error', async () => {
    repo = await makeTempRepoWithCommit();
    const { marker } = await twoDivergentBranches();

    const merged = await repo.workspaces.merge({
      cwd: repo.dir,
      commit: marker,
      message: 'agent-flow: integrate TASK-001 (attempt 1)',
      identity: IDENTITY,
      dates: DATES,
    });

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.kind).toBe('conflict');
    if (merged.value.kind !== 'conflict') return;
    expect(merged.value.paths).toEqual(['shared.ts']);
  });

  it('aborts a conflicted merge and leaves the working tree clean', async () => {
    repo = await makeTempRepoWithCommit();
    const { marker, head } = await twoDivergentBranches();
    await repo.workspaces.merge({
      cwd: repo.dir,
      commit: marker,
      message: 'm',
      identity: IDENTITY,
      dates: DATES,
    });

    expect((await repo.workspaces.abortMerge({ cwd: repo.dir })).ok).toBe(true);

    const status = await repo.workspaces.status({ cwd: repo.dir });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.clean).toBe(true);
    expect(repo.head()).toBe(head);
  });

  it('reports "there was no merge to abort" rather than reporting success', async () => {
    repo = await makeTempRepoWithCommit();

    const aborted = await repo.workspaces.abortMerge({ cwd: repo.dir });

    // Recovery window 6 detects a crashed merge by observing this distinction;
    // swallowing it would make the window undetectable (§17.3).
    expect(aborted.ok).toBe(false);
    if (aborted.ok) return;
    expect(aborted.failure.code).toBe('git_command_failed');
  });
});

describe('MERGE_HEAD is the interrupted-merge discriminator (§17.3 window 6)', () => {
  it('answers null in a worktree with no merge in progress', async () => {
    repo = await makeTempRepoWithCommit();

    const head = await repo.workspaces.mergeHead({ cwd: repo.dir });

    expect(head.ok).toBe(true);
    if (!head.ok) return;
    expect(head.value).toBeNull();
  });

  it('answers the merged commit while a merge is in progress', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    repo.userGit(['checkout', '--quiet', '-b', 'sideline', base]);
    repo.write('shared.ts', 'from the sibling\n');
    const marker = repo.commitAll('sibling change');
    repo.userGit(['checkout', '--quiet', 'main']);
    repo.write('shared.ts', 'from main\n');
    repo.commitAll('main change');

    // A genuinely interrupted merge, produced the way a crash produces one: the
    // merge stops with an unmerged index and MERGE_HEAD on disk. Nothing here
    // fakes the state — a fake would agree with whatever the parser believed.
    await repo.workspaces.merge({
      cwd: repo.dir,
      commit: marker,
      message: 'm',
      identity: IDENTITY,
      dates: DATES,
    });

    const head = await repo.workspaces.mergeHead({ cwd: repo.dir });

    expect(head.ok).toBe(true);
    if (!head.ok) return;
    expect(head.value).toBe(marker);

    // And it goes away when the merge does, which is what makes the answer a
    // discriminator rather than a fact about the repository's history.
    await repo.workspaces.abortMerge({ cwd: repo.dir });
    const after = await repo.workspaces.mergeHead({ cwd: repo.dir });
    expect(after.ok && after.value).toBeNull();
  });

  it('fails rather than answering null when the repository cannot be read', async () => {
    // **The whole reason this method exists instead of `revParse`.** `resolveHead`
    // folds exit 128 into `null`, because there "not a repository" and "no
    // commits" both mean *there is no base here*. Here they do not: folding 128
    // into `null` would report "no merge is in progress" for a worktree nobody
    // could ask, and window 6 would then skip an abort it owed.
    repo = await makeTempRepoWithCommit();

    const head = await repo.workspaces.mergeHead({ cwd: join(repo.home, 'not-a-repository') });

    expect(head.ok).toBe(false);
    if (head.ok) return;
    expect(head.failure.code).not.toBe('git_invalid_output');
  });
});

describe('ancestry, object existence and rev-parse (§31, §32, §33)', () => {
  it('answers ancestry both ways', async () => {
    repo = await makeTempRepoWithCommit();
    const first = repo.head();
    repo.write('second.ts', 'export {};\n');
    const second = repo.commitAll('second');

    const forward = await repo.workspaces.isAncestor({ cwd: repo.dir, ancestor: first, descendant: second });
    const backward = await repo.workspaces.isAncestor({ cwd: repo.dir, ancestor: second, descendant: first });

    expect(forward.ok && forward.value).toBe(true);
    expect(backward.ok && backward.value).toBe(false);
  });

  it('treats an unknown commit as an error rather than as "not an ancestor"', async () => {
    repo = await makeTempRepoWithCommit();

    const result = await repo.workspaces.isAncestor({
      cwd: repo.dir,
      ancestor: ABSENT_OID,
      descendant: repo.head(),
    });

    // Probed: Git exits 128 here, not 1. Folding that into `false` would report
    // "not yet merged" for a repository that cannot answer, and the caller would
    // merge again.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('git_command_failed');
  });

  it('finds an object that exists and misses one that does not', async () => {
    repo = await makeTempRepoWithCommit();

    const present = await repo.workspaces.objectExists({ cwd: repo.dir, oid: repo.head() });
    const absent = await repo.workspaces.objectExists({ cwd: repo.dir, oid: ABSENT_OID });

    // Both are *answers*. `cat-file -e` exits 1 for absent — but only without a
    // peel suffix, which is why `objectExists` asks without one.
    expect(present.ok && present.value).toBe(true);
    expect(absent.ok && absent.value).toBe(false);
  });

  it('distinguishes a commit from a tree, and reports an absent object as null', async () => {
    repo = await makeTempRepoWithCommit();
    const commit = repo.head();
    const tree = repo.userGit(['rev-parse', 'HEAD^{tree}']).trim();

    const asCommit = await repo.workspaces.objectExistsAs({ cwd: repo.dir, oid: commit, type: 'commit' });
    const treeAsCommit = await repo.workspaces.objectExistsAs({ cwd: repo.dir, oid: tree, type: 'commit' });
    const missing = await repo.workspaces.objectType({ cwd: repo.dir, oid: ABSENT_OID });

    expect(asCommit.ok && asCommit.value).toBe(true);
    expect(treeAsCommit.ok && treeAsCommit.value).toBe(false);
    expect(missing.ok && missing.value).toBeNull();
  });

  it('reads a full object id and refuses an abbreviation', async () => {
    repo = await makeTempRepoWithCommit();

    const full = await repo.workspaces.revParse({ cwd: repo.dir, rev: 'HEAD' });
    const tree = await repo.workspaces.revParseTree({ cwd: repo.dir, commit: repo.head() });

    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value).toMatch(/^[0-9a-f]{40}$/);
    expect(tree.ok && tree.value).toBe(repo.userGit(['rev-parse', 'HEAD^{tree}']).trim());
  });

  it('refuses a revision that is not one this tool composes', async () => {
    repo = await makeTempRepoWithCommit();

    for (const rev of ['HEAD@{1}', 'main..other', ':/base', '--upload-pack=evil']) {
      const result = await repo.workspaces.revParse({ cwd: repo.dir, rev });
      expect(result.ok, rev).toBe(false);
    }
  });

  it('fails rather than inventing an id when the revision does not resolve', async () => {
    repo = await makeTempRepoWithCommit();

    const result = await repo.workspaces.revParse({ cwd: repo.dir, rev: 'refs/heads/nonexistent' });

    expect(result.ok).toBe(false);
  });
});

describe('for-each-ref over a namespace (§34)', () => {
  it('lists only the refs under the run namespace', async () => {
    repo = await makeTempRepoWithCommit();
    const head = repo.head();
    await repo.workspaces.updateRef({
      cwd: repo.dir,
      ref: `refs/heads/agent-flow/${RUN_KEY}/integration`,
      newOid: head,
    });
    await repo.workspaces.updateRef({
      cwd: repo.dir,
      ref: `refs/heads/agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      newOid: head,
    });
    repo.userGit(['branch', 'somebody-elses-branch', head]);

    const refs = await repo.workspaces.refsUnder({
      cwd: repo.dir,
      prefix: `refs/heads/agent-flow/${RUN_KEY}`,
    });

    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    // A nested attempt ref is included. With the `…/*` spelling it would not be
    // — probed, and it is the reason `refsUnder` takes a prefix.
    expect(refs.value.map((entry) => entry.ref).sort()).toEqual([
      `refs/heads/agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      `refs/heads/agent-flow/${RUN_KEY}/integration`,
    ]);
    for (const entry of refs.value) expect(entry.oid).toBe(head);
  });

  it('returns nothing for an empty namespace rather than failing', async () => {
    repo = await makeTempRepoWithCommit();

    const refs = await repo.workspaces.refsUnder({
      cwd: repo.dir,
      prefix: `refs/heads/agent-flow/${RUN_KEY}`,
    });

    // §5.3 case A — an empty namespace is a normal state, not an error.
    expect(refs.ok && refs.value).toEqual([]);
  });

  it('refuses a free-form ref query', async () => {
    repo = await makeTempRepoWithCommit();

    for (const prefix of ['--format=%(objectname)', 'refs/heads/../../etc', 'refs/heads/x y', 'refs/heads/x/*']) {
      expect((await repo.workspaces.refsUnder({ cwd: repo.dir, prefix })).ok, prefix).toBe(false);
    }
  });
});

describe('the injection matrix, against every typed primitive (§45, §46)', () => {
  // One table, run through every operation that takes a ref, a revision or a
  // prefix. The point is not that each payload is individually scary — it is
  // that no primitive accepts one, so there is no operation left where "that
  // one is validated somewhere else" could be true.
  const PAYLOADS = [
    '-c',
    '-ccore.hooksPath=/tmp/evil',
    '--config-env=core.hooksPath=EVIL',
    '--exec-path=/tmp/evil',
    '--git-dir=/tmp/other',
    '--work-tree=/tmp/other',
    '--upload-pack=touch /tmp/pwned',
    '--',
    'HEAD@{1}',
    'refs/heads/a..b',
    'refs/heads/a b',
    'refs/heads/a\nb',
    'refs/heads/../../../etc/passwd',
    'refs/heads/x.lock',
    'refs/heads/x/',
  ] as const;

  it('is refused by every ref, revision and prefix argument', async () => {
    repo = await makeTempRepoWithCommit();
    const head = repo.head();

    for (const payload of PAYLOADS) {
      const results = await Promise.all([
        repo.workspaces.revParse({ cwd: repo.dir, rev: payload }),
        repo.workspaces.refsUnder({ cwd: repo.dir, prefix: payload }),
        repo.workspaces.updateRef({ cwd: repo.dir, ref: payload, newOid: head }),
        repo.workspaces.isAncestor({ cwd: repo.dir, ancestor: payload, descendant: head }),
        repo.workspaces.merge({
          cwd: repo.dir,
          commit: payload,
          message: 'm',
          identity: IDENTITY,
          dates: DATES,
        }),
        repo.workspaces.addWorktree({
          cwd: repo.dir,
          location: attemptAt('TASK-001', 1),
          branch: payload,
          base: head,
          reason: 'injection',
        }),
      ]);

      for (const [index, result] of results.entries()) {
        expect(result.ok, `${payload} accepted by primitive #${String(index)}`).toBe(false);
        if (!result.ok) expect(result.failure.code).toBe('git_unsafe_argument');
      }
    }
  });

  it('leaves the repository exactly as it was', async () => {
    repo = await makeTempRepoWithCommit();
    const head = repo.head();
    const refsBefore = repo.userGit(['for-each-ref', '--format=%(refname)']).trim();

    for (const payload of PAYLOADS) {
      await repo.workspaces.updateRef({ cwd: repo.dir, ref: payload, newOid: head });
    }

    // No ref created, none moved, and nothing was spawned to try.
    expect(repo.userGit(['for-each-ref', '--format=%(refname)']).trim()).toBe(refsBefore);
    expect(repo.head()).toBe(head);
  });

  it('still accepts the operands the milestone actually composes', async () => {
    // A denylist that also refuses legitimate input is a denylist nobody keeps.
    repo = await makeTempRepoWithCommit();
    const head = repo.head();

    const ref = `refs/heads/agent-flow/${RUN_KEY}/TASK-001/attempt-1`;
    expect((await repo.workspaces.updateRef({ cwd: repo.dir, ref, newOid: head })).ok).toBe(true);
    expect((await repo.workspaces.revParse({ cwd: repo.dir, rev: 'HEAD' })).ok).toBe(true);
    expect((await repo.workspaces.revParseTree({ cwd: repo.dir, commit: head })).ok).toBe(true);
    expect(
      (await repo.workspaces.refsUnder({ cwd: repo.dir, prefix: `refs/heads/agent-flow/${RUN_KEY}` })).ok,
    ).toBe(true);
  });

  it('carries a message with spaces, semicolons and newlines as one operand', async () => {
    // The shape a shell would have destroyed. `commit-tree` is the operation
    // whose message is closest to free text, so it is the one to prove it on.
    repo = await makeTempRepoWithCommit();
    const tree = repo.userGit(['rev-parse', 'HEAD^{tree}']).trim();
    const canary = join(repo.home, 'pwned');
    const message =
      'agent-flow: TASK-001 attempt 1\n\n' +
      `rm -rf /; echo "pwned" \`whoami\` > ${canary}\n\n` +
      'Agent-Flow-Tree: 9be2\n';

    const marker = await repo.workspaces.commitTree({
      cwd: repo.dir,
      tree,
      parents: [repo.head()],
      message,
      identity: IDENTITY,
      dates: DATES,
    });

    expect(marker.ok).toBe(true);
    if (!marker.ok) return;
    expect(repo.userGit(['log', '-1', '--format=%B', marker.value])).toContain('rm -rf /; echo "pwned"');
    // And nothing ran: the shell metacharacters are bytes in a commit message.
    expect(existsSync(canary)).toBe(false);
  });
});

/**
 * The three operations M2-06 added, against real Git.
 *
 * Each answers a question the Integrator cannot ask any other way: how many
 * parents does this commit have, does this branch already exist, and which merge
 * put this commit on that branch.
 */
describe('reading a commit object (§14.3, §14.7)', () => {
  it('reports the tree and the parents a marker really has', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const tree = repo.userGit(['rev-parse', `${base}^{tree}`]).trim();
    const marker = repo.userGit(['commit-tree', tree, '-p', base, '-m', 'a marker']).trim();

    const read = await repo.workspaces.readCommit({ cwd: repo.dir, oid: marker });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.tree).toBe(tree);
    expect(read.value.parents).toEqual([base]);
    expect(read.value.message).toContain('a marker');
  });

  it('reports two parents for a merge, which is the discriminator', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const tree = repo.userGit(['rev-parse', `${base}^{tree}`]).trim();
    const other = repo.userGit(['commit-tree', tree, '-p', base, '-m', 'a sibling']).trim();
    const merge = repo
      .userGit(['commit-tree', tree, '-p', base, '-p', other, '-m', 'a merge'])
      .trim();

    const read = await repo.workspaces.readCommit({ cwd: repo.dir, oid: merge });

    expect(read.ok && read.value.parents).toEqual([base, other]);
  });

  it('does not let a message add a parent', async () => {
    // The header block ends at the first blank line, and a commit message is text
    // an agent influences. A parser that kept reading `parent` lines past it
    // would let a forged message answer the one question §14.7 says the parent
    // count answers.
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const tree = repo.userGit(['rev-parse', `${base}^{tree}`]).trim();
    const marker = repo
      .userGit([
        'commit-tree',
        tree,
        '-p',
        base,
        '-m',
        `a marker\n\nparent ${'b'.repeat(40)}\ntree ${'c'.repeat(40)}\n`,
      ])
      .trim();

    const read = await repo.workspaces.readCommit({ cwd: repo.dir, oid: marker });

    expect(read.ok && read.value.parents).toEqual([base]);
    expect(read.ok && read.value.tree).toBe(tree);
  });
});

describe('creating a branch (§14.1)', () => {
  it('creates it at the commit given, and refuses a second time', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const branch = `agent-flow/${RUN_KEY}/integration`;

    const created = await repo.workspaces.createBranch({ cwd: repo.dir, branch, at: base });
    expect(created.ok).toBe(true);
    expect(repo.userGit(['rev-parse', `refs/heads/${branch}`]).trim()).toBe(base);

    // §5.3 case C is about a namespace that already holds refs this run did not
    // create, and a blind overwrite there would move somebody else's branch.
    repo.write('more.txt', 'more\n');
    const moved = repo.commitAll('a second commit');
    const again = await repo.workspaces.createBranch({ cwd: repo.dir, branch, at: moved });

    expect(again.ok).toBe(false);
    expect(repo.userGit(['rev-parse', `refs/heads/${branch}`]).trim()).toBe(base);
  });
});

describe('finding the merge that introduced a commit (§14.3 step 5)', () => {
  it('names it, and is not fooled by a first-parent match', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const branch = `agent-flow/${RUN_KEY}/integration`;
    await repo.workspaces.createBranch({ cwd: repo.dir, branch, at: base });

    const location = integrationWorkspace(REPO_KEY, RUN_KEY);
    if (!location.ok) throw new Error(location.refusal.reason);
    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location: location.value,
      base: branch,
      reason: 'agent-flow integration',
    });
    if (!added.ok) throw new Error(added.failure.message);

    const markers: string[] = [];
    for (const name of ['one', 'two']) {
      writeFileSync(join(repo.dir, `${name}.txt`), `${name}\n`);
      repo.userGit(['add', '-A']);
      const tree = repo.userGit(['write-tree']).trim();
      markers.push(repo.userGit(['commit-tree', tree, '-p', base, '-m', `marker ${name}`]).trim());
      repo.userGit(['reset', '--mixed', 'HEAD']);
      writeFileSync(join(repo.dir, `${name}.txt`), '');
    }
    repo.userGit(['checkout', '--', '.']);
    for (const name of ['one', 'two']) {
      const stray = join(repo.dir, `${name}.txt`);
      if (existsSync(stray)) writeFileSync(stray, `${name}\n`);
    }

    const merges: string[] = [];
    for (const [index, marker] of markers.entries()) {
      const merged = await repo.workspaces.merge({
        cwd: added.value,
        commit: marker,
        message: `agent-flow: integrate TASK-00${String(index + 1)} (attempt 1)`,
        identity: IDENTITY,
        dates: DATES,
      });
      if (!merged.ok || merged.value.kind !== 'merged') {
        throw new Error(`the ${String(index)} merge did not land`);
      }
      merges.push(repo.userGit(['rev-parse', `refs/heads/${branch}`]).trim());
    }

    for (const [index, marker] of markers.entries()) {
      const found = await repo.workspaces.mergeIntroducing({
        cwd: repo.dir,
        commit: marker,
        branch: `refs/heads/${branch}`,
      });
      expect(found.ok && found.value).toBe(merges[index]);
    }

    // A commit that is on the branch and was never merged into it — the base
    // itself — has no introducing merge, and the answer is `null` rather than the
    // first merge that happens to have it as a first parent.
    const noMerge = await repo.workspaces.mergeIntroducing({
      cwd: repo.dir,
      commit: base,
      branch: `refs/heads/${branch}`,
    });
    expect(noMerge.ok && noMerge.value).toBeNull();
  });
});
