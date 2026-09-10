import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../fixtures/temp-repo.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { FakeHost } from '../fakes/fake-host.js';
import { openReadOnlyTree } from '../../src/app/read-only-workspace.js';

/**
 * §6.1b — a read-only stage gets a tree it may ruin.
 *
 * **Real Git, and it has to be.** The claim is about a checkout: that it holds what the
 * working tree holds, that writing in it leaves the source untouched, and that it is gone
 * afterwards. An in-memory fake would let all three pass while `git worktree add` did
 * something else entirely, which is the shape of green that §6.1 was written to undo — a
 * test asserting `supportsReadOnly === true` under prose explaining it was false.
 *
 * The positive control is the last test: a stage that writes *into the source* is caught
 * by the same comparison, so the earlier assertions cannot be green because the
 * comparison is blind.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function twinOf(source: TempRepo, label = 'discovery') {
  const outcome = await openReadOnlyTree(
    { fs: new NodeFileSystem(), workspaces: source.workspaces, host: new FakeHost(4242) },
    { source: source.dir, label },
  );
  if (!outcome.ok) throw new Error(`expected a tree, got ${outcome.reason}: ${outcome.detail}`);
  return outcome.tree;
}

/** Every path Git can see, and what it holds — the comparison the acceptance turns on. */
function snapshot(source: TempRepo): string {
  return source.userGit(['status', '--porcelain=v1', '--untracked-files=all']);
}

describe('a read-only stage runs in a twin of the tree, not in the tree', () => {
  it('carries the committed content across', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.write('README.md', '# demo\n');
    repo.commitAll('first');

    const tree = await twinOf(repo);
    try {
      expect(readFileSync(join(tree.cwd, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(readFileSync(join(tree.cwd, 'README.md'), 'utf8')).toBe('# demo\n');
    } finally {
      await tree.release();
    }
  });

  it('carries uncommitted work across, which is the whole reason it is not a checkout of HEAD', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.write('doomed.ts', 'export const doomed = true;\n');
    repo.commitAll('first');

    // The three states §6.2's deviation allows a planning stage to describe: a tracked
    // file edited, a file that is not tracked at all, and a file the author deleted.
    repo.write('src/a.ts', 'export const a = 2;\n');
    repo.write('src/new.ts', 'export const brandNew = true;\n');
    repo.userGit(['rm', '--quiet', 'doomed.ts']);

    const tree = await twinOf(repo);
    try {
      expect(readFileSync(join(tree.cwd, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(readFileSync(join(tree.cwd, 'src/new.ts'), 'utf8')).toBe(
        'export const brandNew = true;\n',
      );
      // The case a naive copy gets wrong: a checkout of HEAD still has it.
      expect(existsSync(join(tree.cwd, 'doomed.ts'))).toBe(false);
    } finally {
      await tree.release();
    }
  });

  it('leaves the source identical when the stage writes into the twin', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('first');
    repo.write('src/a.ts', 'export const a = 2;\n');

    const before = snapshot(repo);
    const contents = readFileSync(join(repo.dir, 'src/a.ts'), 'utf8');

    const tree = await twinOf(repo);
    // What §6.1 measured an `agy` read-only stage actually doing: a directory of its own
    // making, and an edit to a file it was asked only to read.
    writeFileSync(join(tree.cwd, 'src/a.ts'), 'export const a = 999;\n');
    writeFileSync(join(tree.cwd, 'STOWAWAY.md'), 'written by a read-only stage\n');
    await tree.release();

    expect(snapshot(repo)).toBe(before);
    expect(readFileSync(join(repo.dir, 'src/a.ts'), 'utf8')).toBe(contents);
    expect(existsSync(join(repo.dir, 'STOWAWAY.md'))).toBe(false);
  });

  it('takes the twin away, dirty or not', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('first');

    const tree = await twinOf(repo);
    writeFileSync(join(tree.cwd, 'STOWAWAY.md'), 'dirty\n');

    await tree.release();

    // Removed through Git rather than with `rm -rf` (§20.2), and forced — a worktree
    // holding an untracked non-ignored file is one Git otherwise refuses to reclaim, which
    // is exactly the state a contained stage is expected to leave.
    expect(existsSync(tree.cwd)).toBe(false);
    expect(repo.userGit(['worktree', 'list'])).not.toContain('read-only-discovery');
  });

  it('takes the ignored files too, which git worktree remove leaves behind', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.write('.gitignore', 'dist/\n');
    repo.commitAll('first');

    const tree = await twinOf(repo);
    // Measured leaking in the wild: `doctor`'s install probe left three directories in
    // the owned root holding nothing but `node_modules`, after a `worktree remove --force`
    // that reported success. `--force` discards tracked modifications and untracked
    // non-ignored files; what `.gitignore` covers stays, and the directory with it.
    mkdirSync(join(tree.cwd, 'dist'), { recursive: true });
    writeFileSync(join(tree.cwd, 'dist/bundle.js'), 'built by a read-only stage\n');

    await tree.release();

    expect(existsSync(tree.cwd)).toBe(false);
  });

  it('reports a cleanup it could not finish, rather than throwing out of a finally', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.write('.gitignore', 'dist/\n');
    repo.commitAll('first');

    // Measured in a live run: the removal threw `EBUSY: resource busy or locked, rmdir` on
    // Windows, the throw left a `finally`, and a plan revision that had already succeeded
    // was reported as `no_run` — fourteen minutes of model work lost to a directory that
    // would not go away.
    //
    // The throw is injected rather than provoked, because a Windows file lock is not
    // reproducible on demand and a test that waited for one would be a test that passes on
    // Linux and flakes here. What is under test is the *contract*: whatever fails inside,
    // `release` reports it.
    const outcome = await openReadOnlyTree(
      {
        fs: new NodeFileSystem(),
        // `Object.create` rather than a spread: the adapter's methods live on its
        // prototype, and a spread would have produced an object with none of them.
        workspaces: Object.assign(Object.create(repo.workspaces) as typeof repo.workspaces, {
          removeWorktree: () => Promise.reject(new Error('EBUSY: resource busy or locked, rmdir')),
        }),
        host: new FakeHost(4242),
      },
      { source: repo.dir, label: 'planning' },
    );
    if (!outcome.ok) throw new Error(`expected a tree, got ${outcome.reason}`);

    const released = await outcome.tree.release();

    expect(released.removed).toBe(false);
    expect(released.detail).toContain('EBUSY');

    // And the directory is still there, which is the honest consequence: a leak is a disk
    // cost, and `agent-flow clean` reclaims it. `afterEach` removes the whole temp root,
    // so nothing survives this test either way.
    expect(existsSync(outcome.tree.cwd)).toBe(true);
  });

  it('gives two concurrent stages two trees', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('first');

    // Parallel tasks each run their own `code-review`, so the pid alone cannot name a
    // directory: the second `worktree add` would refuse on a path that already exists.
    const [first, second] = await Promise.all([twinOf(repo, 'code-review'), twinOf(repo, 'code-review')]);
    try {
      expect(first.cwd).not.toBe(second.cwd);
      expect(existsSync(first.cwd)).toBe(true);
      expect(existsSync(second.cwd)).toBe(true);
    } finally {
      await first.release();
      await second.release();
    }
  });

  it('refuses rather than guessing when there is no commit to cut from', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');

    const outcome = await openReadOnlyTree(
      { fs: new NodeFileSystem(), workspaces: repo.workspaces, host: new FakeHost(4242) },
      { source: repo.dir, label: 'discovery' },
    );

    // An unborn HEAD is a repository a twin cannot be cut from. The caller falls back and
    // records a degradation — a stage that cannot run at all would be a worse outcome than
    // one that runs where it always did.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('no_head');
  });

  it('positive control: the comparison notices a write into the source', async () => {
    repo = await makeTempRepo();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('first');

    const before = snapshot(repo);
    // The assertion the tests above depend on is worth nothing if `status --porcelain`
    // reads the same before and after a stage has written into the repository.
    writeFileSync(join(repo.dir, 'STOWAWAY.md'), 'as an uncontained stage would\n');

    expect(snapshot(repo)).not.toBe(before);
  });
});
