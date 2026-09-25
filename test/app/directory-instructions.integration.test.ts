import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import {
  gitIgnoredDirectory,
  readDirectoryInstructions,
  type DirectoryInstructions,
} from '../../src/app/directory-instructions.js';

/**
 * FR-005 against real Git (AC-05).
 *
 * The fast lane fakes Git's answer, so it can only prove the reader *obeys* one. Whether
 * `check-ignore --no-index -q -- <dir>/` gives the answer FR-005 needs — a parent rule
 * closes its children, a force-added file does not reopen its directory, a name-only rule
 * does not close the directory holding that name — is a fact about Git, and is measured
 * here, on the platform the suite runs on.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const seed = (r: TempRepo, relativePath: string, contents: string): void => {
  mkdirSync(join(r.dir, relativePath, '..'), { recursive: true });
  r.write(relativePath, contents);
};

const readIn = (r: TempRepo, likely: readonly string[]): Promise<DirectoryInstructions> =>
  readDirectoryInstructions(
    { fs: new NodeFileSystem(), isIgnoredDirectory: gitIgnoredDirectory(r.workspaces) },
    { treeRoot: r.dir, likely },
  );

describe('ignored directories, as real Git decides them (FR-005)', () => {
  it('does not read a directory whose parent is ignored, and records no warning', async () => {
    repo = await makeTempRepoWithCommit();
    seed(repo, '.gitignore', '/pkg/\n');
    seed(repo, 'pkg/sub/AGENTS.md', 'pkg sub rules\n');
    seed(repo, 'lib/AGENTS.md', 'lib rules\n');
    repo.commitAll('ignore pkg');

    const got = await readIn(repo, ['pkg/sub/x.ts', 'lib/y.ts']);

    expect(got.block).not.toContain('pkg sub rules');
    expect(got.block).not.toContain('### pkg/');
    expect(got.skipped).toEqual([]);
    // Positive control: the unignored sibling is read, so the empty `pkg` result is the
    // ignore rule and not a reader that read nothing.
    expect(got.block).toContain('### lib/AGENTS.md\n\nlib rules');
  });

  it('does not read a force-added, committed AGENTS.md inside an ignored directory', async () => {
    repo = await makeTempRepoWithCommit();
    seed(repo, '.gitignore', 'sub/\n');
    seed(repo, 'sub/AGENTS.md', 'tracked but ignored rules\n');
    seed(repo, 'lib/AGENTS.md', 'lib rules\n');
    repo.userGit(['add', '.gitignore', 'lib/AGENTS.md']);
    repo.userGit(['add', '-f', 'sub/AGENTS.md']);
    repo.userGit(['commit', '--quiet', '--no-verify', '-m', 'force-add sub/AGENTS.md']);
    expect(repo.userGit(['ls-files', '--', 'sub/AGENTS.md']).trim()).toBe('sub/AGENTS.md');

    // Positive control for `--no-index`: without it, the tracked file makes Git call the
    // directory open, so a reader that dropped the flag would read these rules.
    const asked = (noIndex: boolean) => repo?.workspaces.isIgnored({ cwd: repo.dir, path: 'sub/', noIndex });
    expect(await asked(false)).toEqual({ ok: true, value: false });
    expect(await asked(true)).toEqual({ ok: true, value: true });

    const got = await readIn(repo, ['sub/x.ts', 'lib/y.ts']);

    expect(got.block).not.toContain('tracked but ignored rules');
    expect(got.skipped).toEqual([]);
    expect(got.block).toContain('### lib/AGENTS.md\n\nlib rules');
  });

  it('reads a directory whose AGENTS.md only a name rule matches, because FR-005 judges the directory', async () => {
    repo = await makeTempRepoWithCommit();
    seed(repo, '.gitignore', 'AGENTS.md\n');
    seed(repo, 'docs/AGENTS.md', 'docs rules\n');
    repo.commitAll('ignore every AGENTS.md by name');
    // Premise: the file itself is ignored, so reading it proves the rule looked at `docs/`.
    expect(await repo.workspaces.isIgnored({ cwd: repo.dir, path: 'docs/AGENTS.md' })).toEqual({
      ok: true,
      value: true,
    });

    const got = await readIn(repo, ['docs/guide.md']);

    expect(got.block).toContain('### docs/AGENTS.md\n\ndocs rules');
    expect(got.skipped).toEqual([]);
  });
});
