import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { attemptWorkspace } from '../../src/core/worktree-policy.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * S-12: no Git hook runs inside an Agent Flow Git operation (I-7, §12.3).
 *
 * **Every case here is paired with a positive control, and that pairing is the
 * test.** "The sentinel file was not written" is green when isolation works,
 * when the hook script is broken, when the hook was never installed, and when
 * the operation did not run at all. Only a control that makes the *same* hook
 * fire for a *user-issued* command tells those apart — so each `it` asserts the
 * hook fires for the user and does not fire for Agent Flow, in that order.
 *
 * The repository's own `core.hooksPath` is pinned by the fixture, so what the
 * wrapper's `-c` has to beat here is a repository-level setting — which outranks
 * any global one a developer might have.
 *
 * **On Windows.** The sentinel hooks are `#!/bin/sh` scripts, which Git for
 * Windows executes through the `sh` it ships — so these are expected to run
 * there, and nothing here is skipped by platform. If a Windows CI job is ever
 * added and this file fails on it, the thing to check first is whether the hook
 * ran at all: the positive control failing means the shim did not fire, which is
 * a fixture problem, while the control passing and the isolation assertion
 * failing would be a genuine platform difference in how `core.hooksPath` is
 * resolved. Worktree mode on Windows is `UNVALIDATED` either way (§23), and this
 * comment exists so that whoever gets there is not left guessing which half
 * broke.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const RUN_KEY = 'AF-2026-001-0f3a91c4bd27e615';
const REPO_KEY = 'temp-repo-0f3a91c4bd27';

function attemptAt(taskId: string, attempt: number) {
  const location = attemptWorkspace(REPO_KEY, RUN_KEY, taskId, attempt);
  if (!location.ok) throw new Error(location.refusal.reason);
  return location.value;
}

function fired(sentinel: string): boolean {
  return existsSync(sentinel) && readFileSync(sentinel, 'utf8').includes('fired');
}

describe('post-checkout, which git worktree add runs', () => {
  it('fires for a user worktree and not for an Agent Flow one', async () => {
    repo = await makeTempRepoWithCommit();
    const sentinel = repo.installSentinelHook('post-checkout');

    // --- positive control: the user creates a worktree themselves.
    repo.userGit(['worktree', 'add', '--quiet', '-b', 'user-branch', `${repo.home}/user-wt`, 'HEAD']);
    expect(fired(sentinel), 'the hook never fired for the user — the control is broken').toBe(true);

    // --- the claim: the same hook, the same repository, our operation.
    repo.userGit(['worktree', 'remove', `${repo.home}/user-wt`]);
    const { rmSync } = await import('node:fs');
    rmSync(sentinel, { force: true });

    const added = await repo.workspaces.addWorktree({
      cwd: repo.dir,
      location: attemptAt('TASK-001', 1),
      branch: `agent-flow/${RUN_KEY}/TASK-001/attempt-1`,
      base: repo.head(),
      reason: `agent-flow ${RUN_KEY} TASK-001 attempt-1`,
    });

    expect(added.ok).toBe(true);
    expect(fired(sentinel)).toBe(false);
  });
});

describe('reference-transaction, which git update-ref runs', () => {
  it('fires for a user update-ref and not for an Agent Flow one', async () => {
    // `--no-verify` does not exist for `update-ref` at all, which is exactly why
    // §12.3 rejects it as the mechanism and uses `core.hooksPath` instead.
    repo = await makeTempRepoWithCommit();
    const sentinel = repo.installSentinelHook('reference-transaction');
    const head = repo.head();

    repo.userGit(['update-ref', 'refs/heads/user-ref', head]);
    expect(fired(sentinel), 'the hook never fired for the user — the control is broken').toBe(true);

    const { rmSync } = await import('node:fs');
    rmSync(sentinel, { force: true });

    const updated = await repo.workspaces.updateRef({
      cwd: repo.dir,
      ref: `refs/heads/agent-flow/${RUN_KEY}/integration`,
      newOid: head,
    });

    expect(updated.ok).toBe(true);
    // And the ref really did move — a hook that did not fire because nothing
    // happened would be a green test proving nothing.
    expect(repo.userGit(['rev-parse', `refs/heads/agent-flow/${RUN_KEY}/integration`]).trim()).toBe(head);
    expect(fired(sentinel)).toBe(false);
  });
});

describe('pre-merge-commit and post-merge, which git merge runs', () => {
  it('fire for a user merge and not for an Agent Flow one', async () => {
    repo = await makeTempRepoWithCommit();
    const preMerge = repo.installSentinelHook('pre-merge-commit');
    const postMerge = repo.installSentinelHook('post-merge');
    const base = repo.head();

    // Two siblings off the same base, touching different files, so both merges
    // are clean and the only difference between them is who issued the command.
    repo.userGit(['checkout', '--quiet', '-b', 'sibling-a', base]);
    repo.write('a.ts', 'export const a = 1;\n');
    const markerA = repo.commitAll('a');

    repo.userGit(['checkout', '--quiet', '-b', 'sibling-b', base]);
    repo.write('b.ts', 'export const b = 1;\n');
    const markerB = repo.commitAll('b');

    repo.userGit(['checkout', '--quiet', 'main']);

    // --- positive control.
    repo.userGit(['merge', '--no-ff', '--no-edit', '-m', 'user merge', markerA]);
    expect(fired(preMerge), 'pre-merge-commit never fired for the user').toBe(true);
    expect(fired(postMerge), 'post-merge never fired for the user').toBe(true);

    const { rmSync } = await import('node:fs');
    rmSync(preMerge, { force: true });
    rmSync(postMerge, { force: true });

    // --- the claim.
    const merged = await repo.workspaces.merge({
      cwd: repo.dir,
      commit: markerB,
      message: 'agent-flow: integrate TASK-002 (attempt 1)',
      identity: { name: 'Agent Flow', email: 'agent-flow@local' },
      dates: { author: '2026-01-01T00:00:00Z', committer: '2026-01-01T00:00:00Z' },
    });

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.kind).toBe('merged');
    // The merge really produced a merge commit, so the hooks had every chance.
    expect(repo.userGit(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ')).toHaveLength(3);
    expect(fired(preMerge)).toBe(false);
    expect(fired(postMerge)).toBe(false);
  });
});

describe('the isolation is per command, and changes nothing durable', () => {
  it('leaves the repository configuration untouched (I-7)', async () => {
    repo = await makeTempRepoWithCommit();
    const before = repo.userGit(['config', '--local', 'core.hooksPath']).trim();

    await repo.workspaces.status({ cwd: repo.dir });
    await repo.workspaces.updateRef({
      cwd: repo.dir,
      ref: `refs/heads/agent-flow/${RUN_KEY}/integration`,
      newOid: repo.head(),
    });

    // Agent Flow never writes to `git config`. The user's hooks keep working
    // for the user, which is the whole point of doing this per invocation.
    expect(repo.userGit(['config', '--local', 'core.hooksPath']).trim()).toBe(before);
  });

  it('keeps the user hooks working immediately afterwards', async () => {
    repo = await makeTempRepoWithCommit();
    const sentinel = repo.installSentinelHook('reference-transaction');

    await repo.workspaces.updateRef({
      cwd: repo.dir,
      ref: `refs/heads/agent-flow/${RUN_KEY}/integration`,
      newOid: repo.head(),
    });
    expect(fired(sentinel)).toBe(false);

    repo.userGit(['update-ref', 'refs/heads/after', repo.head()]);

    // §19.3 prints `git merge agent-flow/…/integration` as the thing for the
    // user to do next, and their hooks have to run on it.
    expect(fired(sentinel)).toBe(true);
  });
});
