import { describe, it, expect } from 'vitest';
import { win32, posix } from 'node:path';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { testGitCommand } from '../fakes/test-git-command.js';
import {
  GitWorkspaces,
  MINIMUM_SUPPORTED_GIT_VERSION,
  compareGitVersions,
  formatGitVersion,
  parseGitVersion,
  parseStatus,
  parseWorktreeList,
  resolveWithinRoot,
  isWithinRoot,
} from '../../src/adapters/git/git-workspaces.js';

/**
 * The parts of the workspace adapter that are pure: version arithmetic, path
 * containment, and the two output parsers. Everything that needs a repository is
 * in `git-workspaces.integration.test.ts`, against real Git.
 */

describe('the Git version floor (§16, §17, §23, §49)', () => {
  it('is 2.33.0, the version that introduced worktree add --reason', () => {
    // Determined empirically, not asserted from memory. Release notes 2.33.0:
    // "git worktree add --lock" learned to record why the worktree is locked
    // with a custom message. The synopsis carries `[--lock [--reason <string>]]`
    // from 2.33.0 and does not in 2.31.0 (2.32.0's page redirects to 2.31.0's,
    // meaning the document did not change between them).
    expect(formatGitVersion(MINIMUM_SUPPORTED_GIT_VERSION)).toBe('2.33.0');
  });

  it('reads the plain form', () => {
    expect(parseGitVersion('git version 2.52.0')).toMatchObject({
      major: 2,
      minor: 52,
      patch: 0,
    });
  });

  it('reads the Windows build suffix', () => {
    expect(parseGitVersion('git version 2.43.0.windows.1')).toMatchObject({
      major: 2,
      minor: 43,
      patch: 0,
    });
  });

  it('reads the Apple build suffix', () => {
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toMatchObject({
      major: 2,
      minor: 39,
      patch: 5,
    });
  });

  it('reads a two-component version as patch zero', () => {
    expect(parseGitVersion('git version 2.33')).toMatchObject({ major: 2, minor: 33, patch: 0 });
  });

  it('tolerates surrounding whitespace, because stdout has a trailing newline', () => {
    expect(parseGitVersion('git version 2.33.0\n')).not.toBeNull();
  });

  it('refuses what is not a version', () => {
    for (const bad of ['garbage', 'git version', '2', '', 'version 2.33.0', 'git 2.33.0']) {
      expect(parseGitVersion(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('orders numerically rather than lexically', () => {
    // The defect this exists to prevent, in one line: "2.9" > "2.40" as strings.
    const older = parseGitVersion('git version 2.9.5');
    const newer = parseGitVersion('git version 2.40.0');
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    if (older === null || newer === null) return;

    expect(compareGitVersions(older, newer)).toBeLessThan(0);
    expect(compareGitVersions(newer, older)).toBeGreaterThan(0);
  });

  it('places each side of the floor where it belongs', () => {
    const at = (raw: string) => parseGitVersion(raw) ?? MINIMUM_SUPPORTED_GIT_VERSION;

    // Below: the flag that sets the floor does not exist there.
    expect(compareGitVersions(at('git version 2.32.0'), MINIMUM_SUPPORTED_GIT_VERSION)).toBeLessThan(0);
    expect(compareGitVersions(at('git version 2.9.5'), MINIMUM_SUPPORTED_GIT_VERSION)).toBeLessThan(0);
    // Exactly at the floor.
    expect(compareGitVersions(at('git version 2.33.0'), MINIMUM_SUPPORTED_GIT_VERSION)).toBe(0);
    // Above, including the vendor-suffixed spellings.
    expect(compareGitVersions(at('git version 2.33.1'), MINIMUM_SUPPORTED_GIT_VERSION)).toBeGreaterThan(0);
    expect(compareGitVersions(at('git version 2.43.0.windows.1'), MINIMUM_SUPPORTED_GIT_VERSION)).toBeGreaterThan(0);
    expect(compareGitVersions(at('git version 2.39.5 (Apple Git-154)'), MINIMUM_SUPPORTED_GIT_VERSION)).toBeGreaterThan(0);
  });
});

describe('a worktree path is derived and contained (§20, S-3)', () => {
  const ROOT = '/home/dev/.agent-flow/worktrees';

  it('joins validated segments under the root', () => {
    const result = resolveWithinRoot(ROOT, ['repo-0f3a91c4bd27', 'AF-2026-001-0f3a91c4bd27e615'], posix);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(`${ROOT}/repo-0f3a91c4bd27/AF-2026-001-0f3a91c4bd27e615`);
  });

  it('refuses a traversal segment', () => {
    for (const segment of ['..', '../etc', '.', 'a/b', 'a\\b']) {
      const result = resolveWithinRoot(ROOT, ['repo-abc123456789', segment], posix);
      expect(result.ok, segment).toBe(false);
    }
  });

  it('refuses an absolute segment', () => {
    expect(resolveWithinRoot(ROOT, ['/etc/passwd'], posix).ok).toBe(false);
    expect(resolveWithinRoot(ROOT, ['repo-abc123456789', '/tmp/elsewhere'], posix).ok).toBe(false);
  });

  it('refuses the root itself', () => {
    // A worktree operation on the root would act on every run at once, so the
    // empty relative path is a refusal rather than a permitted edge.
    expect(resolveWithinRoot(ROOT, [], posix).ok).toBe(false);
  });

  it('refuses a relative root', () => {
    expect(resolveWithinRoot('worktrees', ['repo-abc123456789'], posix).ok).toBe(false);
  });

  it('is not fooled by a sibling with a shared prefix (D-F02)', () => {
    // The reason the check is `relative` and not `startsWith`: "/foo/bar2"
    // starts with "/foo/bar" and is not inside it.
    expect(isWithinRoot('/foo/bar', '/foo/bar2')).toBe(false);
    expect(isWithinRoot('/foo/bar', '/foo/bar/x')).toBe(true);
    expect(isWithinRoot('/foo/bar', '/foo/bar')).toBe(false);
    expect(isWithinRoot('/foo/bar', '/foo')).toBe(false);
  });

  it('applies the win32 rules, asserted here on whatever CI runs (§26.2)', () => {
    // No CI job runs on Windows, so these rules are only ever exercised by
    // passing the win32 implementation explicitly. Without this, "the path
    // logic is correct on Windows" would be a claim nothing checks.
    const root = 'C:\\Users\\dev\\.agent-flow\\worktrees';

    const ok = resolveWithinRoot(root, ['repo-0f3a91c4bd27', 'AF-2026-001-0f3a91c4bd27e615'], win32);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toBe(`${root}\\repo-0f3a91c4bd27\\AF-2026-001-0f3a91c4bd27e615`);
    }

    // Drive-letter injection: on win32 `resolve` would discard the root.
    expect(resolveWithinRoot(root, ['D:\\evil'], win32).ok).toBe(false);
    // A UNC payload, for the same reason.
    expect(resolveWithinRoot(root, ['\\\\server\\share'], win32).ok).toBe(false);
    // A backslash inside a segment is a separator there, so it is refused as a
    // component before `resolve` ever sees it.
    expect(resolveWithinRoot(root, ['a\\..\\..\\evil'], win32).ok).toBe(false);
  });
});

/** Unwraps a successful parse, failing the test loudly when it refused. */
function parsedWorktrees(stdout: string) {
  const result = parseWorktreeList(stdout);
  if (!result.ok) throw new Error(`expected a parse, got ${result.failure.code}`);
  return result.value;
}

describe('parsing git worktree list --porcelain (§24)', () => {
  it('reads the main worktree and a locked attempt worktree', () => {
    const entries = parsedWorktrees(
      [
        'worktree /repo',
        'HEAD 681dc8a649616e3fcf6fdb34ecca397cfaf23be8',
        'branch refs/heads/main',
        '',
        'worktree /home/dev/.agent-flow/worktrees/repo-abc/AF-2026-001-0f3a/TASK-001/attempt-1',
        'HEAD 681dc8a649616e3fcf6fdb34ecca397cfaf23be8',
        'branch refs/heads/agent-flow/AF-2026-001-0f3a/TASK-001/attempt-1',
        'locked agent-flow AF-2026-001-0f3a TASK-001 attempt-1',
        '',
      ].join('\n'),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: '/repo', branch: 'refs/heads/main', locked: false });
    expect(entries[1]).toMatchObject({
      locked: true,
      lockReason: 'agent-flow AF-2026-001-0f3a TASK-001 attempt-1',
      branch: 'refs/heads/agent-flow/AF-2026-001-0f3a/TASK-001/attempt-1',
    });
  });

  it('reads a lock with no reason, a detached head, a bare entry and a prunable one', () => {
    const entries = parsedWorktrees(
      [
        'worktree /a',
        'bare',
        '',
        'worktree /b',
        'HEAD 0000000000000000000000000000000000000001',
        'detached',
        'locked',
        '',
        'worktree /c',
        'HEAD 0000000000000000000000000000000000000002',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );

    expect(entries[0]).toMatchObject({ path: '/a', bare: true, locked: false });
    expect(entries[1]).toMatchObject({ detached: true, locked: true });
    expect(entries[1]?.lockReason).toBeUndefined();
    expect(entries[2]).toMatchObject({ prunable: true });
  });

  it('ignores an attribute a newer Git added', () => {
    // A parser that refused an entry over an unknown key would make a Git
    // upgrade look like a corrupt repository.
    const entries = parsedWorktrees(
      ['worktree /a', 'HEAD 0000000000000000000000000000000000000003', 'something-new yes', ''].join('\n'),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('/a');
  });

  it('closes the last record even without a trailing blank line', () => {
    expect(parsedWorktrees('worktree /a\nHEAD 0000000000000000000000000000000000000004')).toHaveLength(1);
  });

  it('reads nothing out of nothing', () => {
    expect(parsedWorktrees('')).toEqual([]);
  });
});

describe('parsing git status --porcelain=v1 -z (§25, §8.2)', () => {
  it('calls empty output clean, and only empty output', () => {
    const status = parseStatus('');

    expect(status.clean).toBe(true);
    expect(status.entries).toEqual([]);
  });

  it('separates staged, unstaged and untracked', () => {
    const status = parseStatus('A  added.ts\0 M modified.ts\0?? new.ts\0');

    expect(status.clean).toBe(false);
    expect(status.staged).toEqual(['added.ts']);
    expect(status.unstaged).toEqual(['modified.ts']);
    expect(status.untracked).toEqual(['new.ts']);
  });

  it('consumes a rename source rather than reading it as another entry', () => {
    // Probed shape: `RM h.txt\0f.txt\0`. Without consuming the second field, the
    // source path would be parsed as an entry whose status letters are its own
    // first two characters — a file called `f.` with status `f`.
    const status = parseStatus('RM h.txt\0f.txt\0');

    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]).toMatchObject({
      index: 'R',
      worktree: 'M',
      path: 'h.txt',
      originalPath: 'f.txt',
    });
  });

  it('keeps a path containing " -> " intact', () => {
    // The reason `-z` is used rather than the newline format: there, this file
    // and a rename are the same bytes.
    const status = parseStatus('?? a -> b.txt\0');

    expect(status.untracked).toEqual(['a -> b.txt']);
  });

  it('keeps a path containing a newline intact', () => {
    const status = parseStatus('?? weird\nname.txt\0');

    expect(status.entries).toHaveLength(1);
    expect(status.untracked).toEqual(['weird\nname.txt']);
  });
});

describe('truncated output is an incomplete result, never a partial truth (§37)', () => {
  // These use a fake process, because producing 4 MiB of `worktree list` output
  // from a real repository would mean creating thousands of worktrees to assert
  // something about a ceiling. What is faked is the volume; the refusal is real.
  const truncating = (): GitWorkspaces =>
    new GitWorkspaces({
      git: testGitCommand(
        new FakeProcessRunner().always({ exitCode: 0, stdout: 'worktree /a\n', truncated: true }),
      ),
      fs: new InMemoryFileSystem(),
      worktreeRoot: '/home/dev/.agent-flow/worktrees',
    });

  it('refuses to parse a truncated worktree listing', async () => {
    const result = await truncating().listWorktrees({ cwd: '/repo' });

    // A listing cut off halfway reports a subset of what is registered, and a
    // caller deciding what to remove from that subset would be deciding from a
    // fact that is not one.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('git_output_truncated');
  });

  it('refuses to parse a truncated status', async () => {
    const result = await truncating().status({ cwd: '/repo' });

    // Worse here than elsewhere: the missing tail is what would have made the
    // tree dirty, so believing the prefix means calling a dirty tree clean.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('git_output_truncated');
  });

  it('refuses to parse a truncated ref listing', async () => {
    const result = await truncating().refsUnder({ cwd: '/repo', prefix: 'refs/heads/agent-flow' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('git_output_truncated');
  });
});

describe('an unavailable git surfaces as itself, through every operation', () => {
  const unavailable = (): GitWorkspaces =>
    new GitWorkspaces({
      git: testGitCommand(new FakeProcessRunner().always({ spawnFailed: true, stderr: 'ENOENT' })),
      fs: new InMemoryFileSystem(),
      worktreeRoot: '/home/dev/.agent-flow/worktrees',
    });

  it('does not disguise it as a negative answer', async () => {
    const workspaces = unavailable();
    const oid = '0'.repeat(39) + '1';

    // The dangerous shape: `objectExists` returning `false` and `isAncestor`
    // returning `false` when git is simply not installed. Recovery would then
    // conclude "the tree is gone" and "this was never merged".
    const exists = await workspaces.objectExists({ cwd: '/repo', oid });
    const ancestor = await workspaces.isAncestor({ cwd: '/repo', ancestor: oid, descendant: oid });
    const version = await workspaces.version('/repo');

    for (const result of [exists, ancestor, version]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('git_unavailable');
    }
  });
});
