import { describe, it, expect, afterEach } from 'vitest';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  renameSync,
  rmSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { GIT_HOSTILE_ENVIRONMENT } from '../../src/adapters/git/git-command.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * The inherited Git environment, against two real repositories.
 *
 * The threat is specific and unglamorous: Agent Flow is started from a user's
 * shell, and a shell with `GIT_DIR` exported is ordinary rather than exotic —
 * every Git hook runs with `GIT_DIR` and `GIT_INDEX_FILE` set, and so does
 * anything launched from `git rebase --exec`, a `filter-branch`, or a wrapper
 * script. An inherited `GIT_DIR` relocates the repository a command operates on
 * **regardless of `cwd`**, so an `update-ref` or a `worktree remove` issued with
 * a perfectly correct working directory would land somewhere else entirely.
 *
 * `GIT_DIR=''` is not a fix: probed, Git reads it as a repository path that
 * happens to be empty and fails with `not a git repository: ''`. The variables
 * have to be *removed*, which is what `unsetEnv` on `ProcessSpawnOptions` is for
 * and why the Git boundary is its only caller.
 *
 * Every test below sets the variable on `process.env` for the duration of the
 * assertion, which is the only way to reproduce inheritance faithfully — the
 * `ProcessRunner` builds the child environment from `process.env`, so injecting
 * it anywhere else would be testing the fixture rather than the defence.
 */

let repoA: TempRepo | undefined;
let repoB: TempRepo | undefined;

/**
 * A second repository whose history is genuinely different from A's.
 *
 * The extra commit is not decoration. `commitAll` takes its timestamps from the
 * clock, Git's timestamps have one-second resolution, and the two fixtures make
 * the same tree with the same message and the same author — so created back to
 * back they produce the *same commit id*, and "operated on A, not B" would be
 * unprovable because the two answers are identical.
 */
async function makeDistinctRepoB(): Promise<TempRepo> {
  const repo = await makeTempRepoWithCommit();
  repo.write('only-b.txt', 'this repository is not A\n');
  repo.commitAll('B diverges');
  return repo;
}
const saved = new Map<string, string | undefined>();

function poison(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

/**
 * Removes the poison mid-test.
 *
 * Needed because `userGit` is the *unwrapped* escape hatch — it inherits
 * `process.env` exactly as a user's shell would, which is what makes it a
 * faithful positive control and also what makes it useless for verifying a
 * result while the poison is still set.
 */
function unpoison(): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  repoA?.cleanup();
  repoB?.cleanup();
  repoA = undefined;
  repoB = undefined;
});

describe('an inherited GIT_DIR does not move the repository (S-8)', () => {
  it('reads A while GIT_DIR points at B', async () => {
    repoA = await makeTempRepoWithCommit();
    repoB = await makeDistinctRepoB();
    const headOfA = repoA.head();
    const headOfB = repoB.head();
    expect(headOfA).not.toBe(headOfB);

    poison('GIT_DIR', join(repoB.dir, '.git'));

    const head = await repoA.workspaces.revParse({ cwd: repoA.dir, rev: 'HEAD' });

    expect(head.ok).toBe(true);
    if (!head.ok) return;
    expect(head.value).toBe(headOfA);
    expect(head.value).not.toBe(headOfB);
  });

  it('reports A dirty while GIT_DIR points at a clean B', async () => {
    repoA = await makeTempRepoWithCommit();
    repoB = await makeDistinctRepoB();
    repoA.write('README.md', 'changed in A\n');

    poison('GIT_DIR', join(repoB.dir, '.git'));
    poison('GIT_WORK_TREE', repoB.dir);

    const status = await repoA.workspaces.status({ cwd: repoA.dir });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.clean).toBe(false);
    expect(status.value.unstaged).toContain('README.md');
  });

  it('writes a ref into A and leaves B untouched', async () => {
    // The one that matters. A ref write is not a read that got the wrong
    // answer — it is a change to a repository nobody pointed the tool at.
    repoA = await makeTempRepoWithCommit();
    repoB = await makeDistinctRepoB();
    const headOfA = repoA.head();
    const ref = 'refs/heads/agent-flow/AF-2026-001-0f3a91c4bd27e615/integration';

    poison('GIT_DIR', join(repoB.dir, '.git'));

    const updated = await repoA.workspaces.updateRef({ cwd: repoA.dir, ref, newOid: headOfA });

    expect(updated.ok).toBe(true);
    unpoison();
    // A got the ref…
    expect(repoA.userGit(['rev-parse', ref]).trim()).toBe(headOfA);
    // …and B has no such ref at all. `rev-parse` on a missing ref exits
    // non-zero, so `execFileSync` throws — which is the assertion.
    expect(() => repoB?.userGit(['rev-parse', '--verify', ref])).toThrow();
  });

  it('stages and writes a tree from A while GIT_INDEX_FILE points elsewhere', async () => {
    // `write-tree` records whatever index it is pointed at, so an inherited
    // `GIT_INDEX_FILE` would make the "validated tree" of §11.2 a tree nobody
    // validated — the receipt would be about content that was never checked.
    repoA = await makeTempRepoWithCommit();
    repoB = await makeDistinctRepoB();
    repoA.write('only-in-a.ts', 'export const a = 1;\n');

    poison('GIT_INDEX_FILE', join(repoB.dir, '.git', 'index'));

    expect((await repoA.workspaces.stageAll({ cwd: repoA.dir })).ok).toBe(true);
    const tree = await repoA.workspaces.writeTree({ cwd: repoA.dir });

    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    // The tree contains A's new file, which is only true if A's index was used.
    const listed = repoA.userGit(['ls-tree', '--name-only', tree.value]);
    expect(listed).toContain('only-in-a.ts');
    // And B's own status is unchanged — its index was not written through.
    expect(repoB.userGit(['status', '--porcelain=v1']).trim()).toBe('');
  });

  it('finds A objects and not B objects, with GIT_ALTERNATE_OBJECT_DIRECTORIES set', async () => {
    // `cat-file -e` is what recovery asks before trusting a validated tree
    // (§17.1). An inherited alternates list would let it answer "exists" about
    // an object this repository does not have.
    repoA = await makeTempRepoWithCommit();
    repoB = await makeDistinctRepoB();
    repoB.write('only-in-b.ts', 'export const b = 1;\n');
    const commitOnlyInB = repoB.commitAll('only in B');

    poison('GIT_ALTERNATE_OBJECT_DIRECTORIES', join(repoB.dir, '.git', 'objects'));

    const found = await repoA.workspaces.objectExists({ cwd: repoA.dir, oid: commitOnlyInB });

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toBe(false);
  });

  it('still discovers the repository with GIT_CEILING_DIRECTORIES set above it', async () => {
    // The denial-of-service direction: a ceiling stops discovery walking up, so
    // a valid `cwd` reports "not a git repository" and every worktree operation
    // refuses for a reason the message would not explain.
    repoA = await makeTempRepoWithCommit();

    poison('GIT_CEILING_DIRECTORIES', repoA.dir);

    const head = await repoA.workspaces.revParse({ cwd: repoA.dir, rev: 'HEAD' });

    expect(head.ok).toBe(true);
  });

  it('leaves the user their own git untouched — the poison still works outside the wrapper', async () => {
    // The positive control for this whole file. If `GIT_DIR` did not actually
    // redirect a plain `git` in this environment, every assertion above would be
    // green for the wrong reason.
    repoA = await makeTempRepoWithCommit();
    repoB = await makeDistinctRepoB();
    const headOfB = repoB.head();

    poison('GIT_DIR', join(repoB.dir, '.git'));

    // Issued from A's directory, and it reports B's HEAD.
    expect(repoA.userGit(['rev-parse', 'HEAD']).trim()).toBe(headOfB);
  });
});

describe('an inherited GIT_EXEC_PATH does not choose which programs Git loads', () => {
  // The environment form of `--exec-path`, which the argument denylist already
  // refuses. Refusing the flag while inheriting the variable is an asymmetry an
  // attacker only has to notice once — and unlike the repository variables, this
  // one decides which *executables* run under the name `git`.

  it('is reachable by a git outside the wrapper — the positive control', async () => {
    repoA = await makeTempRepoWithCommit();
    const execPath = join(repoA.home, 'hostile-exec');
    mkdirSync(execPath, { recursive: true });
    writeFileSync(join(execPath, 'git-sentinel'), '#!/bin/sh\necho SENTINEL-REACHED\n');
    chmodSync(join(execPath, 'git-sentinel'), 0o755);

    // Without the variable, Git has never heard of this subcommand — it exits
    // non-zero, so `execFileSync` throws, which is the assertion.
    expect(() => repoA?.userGit(['sentinel'])).toThrow(/not a git command/);

    poison('GIT_EXEC_PATH', execPath);

    // With it, Git loads and runs the script. If this stopped being true, every
    // assertion below would be green for the wrong reason.
    expect(repoA.userGit(['sentinel'])).toContain('SENTINEL-REACHED');
    // And Git says so itself.
    expect(repoA.userGit(['--exec-path']).trim()).toBe(execPath);
  });

  it('does not reach the child of an internal Git command', async () => {
    // The direct proof the brief asks for. Every subcommand `GitCommand` may
    // issue is a compiled builtin, so none of them consults the exec path — a
    // test that ran one and saw it succeed would prove nothing about whether the
    // variable was still in the environment. So the environment the child
    // actually receives is inspected, through the same adapter and the same
    // removal list the Git boundary uses.
    repoA = await makeTempRepoWithCommit();
    const execPath = join(repoA.home, 'hostile-exec');
    mkdirSync(execPath, { recursive: true });
    poison('GIT_EXEC_PATH', execPath);

    const runner = new NodeProcessRunner();
    const report = (name: string) =>
      runner.run({
        command: process.execPath,
        args: ['-e', `process.stdout.write(String(process.env['${name}'] ?? 'UNSET'))`],
        cwd: repoA?.dir ?? process.cwd(),
        unsetEnv: GIT_HOSTILE_ENVIRONMENT,
        timeoutSeconds: 30,
      });

    const removed = await report('GIT_EXEC_PATH');
    expect(removed.stdout).toBe('UNSET');

    // The removal is surgical, not a scrubbed environment: the runners depend on
    // PATH and HOME, and wiping them would break the CLI authentication §54
    // rests on.
    const path = await report('PATH');
    const home = await report('HOME');
    expect(path.stdout).not.toBe('UNSET');
    expect(home.stdout).not.toBe('UNSET');
  });

  it('leaves internal Git working normally while the hostile value is set', async () => {
    repoA = await makeTempRepoWithCommit();
    const execPath = join(repoA.home, 'hostile-exec');
    mkdirSync(execPath, { recursive: true });
    writeFileSync(join(execPath, 'git-sentinel'), '#!/bin/sh\necho SENTINEL-REACHED\n');
    chmodSync(join(execPath, 'git-sentinel'), 0o755);
    const headOfA = repoA.head();

    poison('GIT_EXEC_PATH', execPath);

    // Removing it must not cost the boundary anything: Git finds its own
    // programs at the compiled-in location, which is the point.
    const head = await repoA.workspaces.revParse({ cwd: repoA.dir, rev: 'HEAD' });
    const version = await repoA.workspaces.version(repoA.dir);
    const status = await repoA.workspaces.status({ cwd: repoA.dir });

    expect(head.ok && head.value).toBe(headOfA);
    expect(version.ok).toBe(true);
    expect(status.ok && status.value.clean).toBe(true);
  });
});

describe('worktree ownership is decided on real locations (S-4)', () => {
  it('does not own a worktree whose path escapes the root through a symlink', async () => {
    repoA = await makeTempRepoWithCommit();
    const location = { segments: ['repo-0f3a91c4bd27', 'AF-2026-001-0f3a91c4bd27e615'], relativePath: 'x' };

    // Probed first, because it narrows the threat: `git worktree add` through a
    // symlink records the *resolved* path, so a link cannot smuggle a worktree
    // in at registration time. What it can do is appear afterwards — a parent
    // directory swapped for a link, which is a thing a user or a script does.
    await repoA.workspaces.addWorktree({
      cwd: repoA.dir,
      location,
      branch: 'agent-flow/AF-2026-001-0f3a91c4bd27e615/integration',
      base: repoA.head(),
      reason: 'ours',
    });
    const registered = join(repoA.worktreeRoot, ...location.segments);
    expect(existsSync(registered)).toBe(true);

    // Move the whole thing out of the root and leave a symlink where it was.
    // The path Git recorded is now textually inside and physically outside —
    // exactly what a lexical containment check cannot see (S-4).
    const parent = join(repoA.worktreeRoot, 'repo-0f3a91c4bd27');
    const moved = join(repoA.home, 'moved-out-of-the-root');
    renameSync(parent, moved);
    symlinkSync(moved, parent);

    const listed = await repoA.workspaces.listWorktrees({ cwd: repoA.dir });
    const owned = await repoA.workspaces.ownWorktrees({ cwd: repoA.dir });

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Git still reports the path it recorded, and it still starts with the root.
    expect(listed.value.some((entry) => entry.path === registered)).toBe(true);
    // A `startsWith` check would have called this ours and handed it to
    // `git worktree remove`, which would have removed a directory outside the
    // root that Agent Flow never created.
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value).toEqual([]);
  });

  it('owns a worktree that is genuinely inside, reported at its resolved path', async () => {
    repoA = await makeTempRepoWithCommit();
    const location = { segments: ['repo-0f3a91c4bd27', 'AF-2026-001-0f3a91c4bd27e615'], relativePath: 'x' };

    const added = await repoA.workspaces.addWorktree({
      cwd: repoA.dir,
      location,
      branch: 'agent-flow/AF-2026-001-0f3a91c4bd27e615/integration',
      base: repoA.head(),
      reason: 'ours',
    });
    expect(added.ok).toBe(true);

    const owned = await repoA.workspaces.ownWorktrees({ cwd: repoA.dir });

    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value).toHaveLength(1);
    expect(owned.value[0]?.path).toBe(join(repoA.worktreeRoot, ...location.segments));
  });

  it('drops a registered worktree whose path no longer resolves', async () => {
    // Fail-closed, and in the direction that matters: an unresolvable path is
    // not ownership. The cost of wrongly excluding one is a directory left on
    // disk; the cost of wrongly including one is a removal nobody agreed to.
    repoA = await makeTempRepoWithCommit();
    const location = { segments: ['repo-0f3a91c4bd27', 'AF-2026-001-0f3a91c4bd27e615'], relativePath: 'x' };
    await repoA.workspaces.addWorktree({
      cwd: repoA.dir,
      location,
      branch: 'agent-flow/AF-2026-001-0f3a91c4bd27e615/integration',
      base: repoA.head(),
      reason: 'ours',
    });

    // Removed from underneath Git, which still has it registered.
    rmSync(join(repoA.worktreeRoot, ...location.segments), { recursive: true, force: true });

    const listed = await repoA.workspaces.listWorktrees({ cwd: repoA.dir });
    const owned = await repoA.workspaces.ownWorktrees({ cwd: repoA.dir });

    // Git still lists it (as prunable); ownership does not claim it.
    expect(listed.ok && listed.value.length).toBeGreaterThan(1);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value).toEqual([]);
  });
});

describe('a forged worktree record is refused rather than parsed (§24)', () => {
  it('fails closed when a registered path contains a newline that forges a record', async () => {
    repoA = await makeTempRepoWithCommit();

    // Probed on Git 2.52.0: the non-`-z` porcelain format cannot represent this,
    // and Git prints the bytes unescaped — so the listing contains a `worktree`
    // line that Git never emitted as a record. A parser that started a new
    // record there hands its caller a path an attacker chose, and downstream
    // that path goes to `git worktree remove`.
    const hostile = join(repoA.home, 'inj\nworktree /tmp/agent-flow-injected\nHEAD 0000000000000000000000000000000000000000');
    repoA.userGit(['worktree', 'add', '--quiet', '-b', 'hostile', hostile, 'HEAD']);

    const listed = await repoA.workspaces.listWorktrees({ cwd: repoA.dir });
    const owned = await repoA.workspaces.ownWorktrees({ cwd: repoA.dir });

    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.failure.code).toBe('git_invalid_output');
    // And the refusal propagates: nothing downstream receives a partial list it
    // could act on.
    expect(owned.ok).toBe(false);
  });

  it('still reads an ordinary listing after the hostile worktree is gone', async () => {
    // So the failure above is about the forged frame and not about the parser
    // having become unable to read anything.
    repoA = await makeTempRepoWithCommit();
    const hostile = join(repoA.home, 'inj\nworktree /tmp/agent-flow-injected');
    repoA.userGit(['worktree', 'add', '--quiet', '-b', 'hostile', hostile, 'HEAD']);
    expect((await repoA.workspaces.listWorktrees({ cwd: repoA.dir })).ok).toBe(false);

    repoA.userGit(['worktree', 'remove', '--force', hostile]);

    expect((await repoA.workspaces.listWorktrees({ cwd: repoA.dir })).ok).toBe(true);
  });

  it('leaves a plain newline path out of ownership rather than truncating it into one', async () => {
    // The case the framing check cannot see: a newline with nothing that looks
    // like an attribute after it simply arrives truncated. `realPath` is what
    // closes it — the truncated string does not name a directory that exists.
    repoA = await makeTempRepoWithCommit();
    const hostile = join(repoA.worktreeRoot, 'we\nird');
    repoA.userGit(['worktree', 'add', '--quiet', '-b', 'newline-path', hostile, 'HEAD']);

    const listed = await repoA.workspaces.listWorktrees({ cwd: repoA.dir });
    const owned = await repoA.workspaces.ownWorktrees({ cwd: repoA.dir });

    // The listing parses — there is no forged record here — and reports the
    // truncated path, which is the format's limitation showing through.
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.some((entry) => entry.path === join(repoA?.worktreeRoot ?? '', 'we'))).toBe(true);
    }

    // Ownership does not claim it, because `<root>/we` is not a directory.
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value).toEqual([]);
    expect(existsSync(join(repoA.worktreeRoot, 'we'))).toBe(false);
  });
});

describe('the hooks directory Agent Flow owns stays empty', () => {
  it('is created, and a hook dropped into it is the only way it could run', async () => {
    // Not a defence in itself — it is the reason the directory is created rather
    // than merely named. An absent `core.hooksPath` target would make isolation
    // depend on it staying absent.
    repoA = await makeTempRepoWithCommit();
    const noHooks = join(repoA.home, '.agent-flow', 'no-hooks');

    expect(existsSync(noHooks)).toBe(true);
    // Nothing Agent Flow does writes here.
    writeFileSync(join(noHooks, 'marker'), 'test-owned');
    await repoA.workspaces.status({ cwd: repoA.dir });
    expect(readFileSync(join(noHooks, 'marker'), 'utf8')).toBe('test-owned');
  });
});
