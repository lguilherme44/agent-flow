import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { createGitCommand, type GitCommand } from '../../src/adapters/git/git-command.js';
import { createGitWorkspaces, type GitWorkspaces } from '../../src/adapters/git/git-workspaces.js';

/**
 * A real Git repository in a temporary directory, plus the adapter under test.
 *
 * **Nothing here touches the developer's repository or home directory, and that
 * is a hard requirement rather than good manners** (M2-02 brief §12). These tests
 * create branches, create and destroy worktrees, and abort merges; run against
 * `agent-flow` itself, a single mistake would leave the working copy of this
 * project holding somebody else's branches. So:
 *
 *   - the repository lives under `mkdtemp` in the OS temp directory;
 *   - `homeDir` is a directory *inside* that same temp tree, so
 *     `~/.agent-flow/worktrees` and `~/.agent-flow/no-hooks` are created there;
 *   - `cleanup()` removes the whole tree, which takes the repository, every
 *     worktree and every ref with it — so a failing assertion cannot leave a
 *     registered worktree behind anywhere that matters.
 *
 * `realpathSync` on the root is not decoration: on macOS `mkdtemp` returns a path
 * under `/var`, which is a symlink to `/private/var`, and `git worktree list`
 * reports the resolved form. A containment check between the two spellings would
 * fail on a path that is genuinely inside the root.
 */
export interface TempRepo {
  /** The repository's working directory. */
  readonly dir: string;
  /** Stands in for `~`. `.agent-flow/` is created under it. */
  readonly home: string;
  readonly git: GitCommand;
  readonly workspaces: GitWorkspaces;
  readonly worktreeRoot: string;
  /**
   * Runs `git` **as the user would** — outside the wrapper, with the
   * repository's own hooks in play.
   *
   * This is what makes the hook-isolation tests meaningful. A test asserting
   * "the sentinel file was not written" is green when the hook is broken, when
   * the hook was never installed, and when isolation works — three very
   * different things. The positive control tells them apart (§38).
   */
  userGit(args: readonly string[], cwd?: string): string;
  /** Writes an executable hook into `.git/hooks` that appends to a sentinel file. */
  installSentinelHook(name: string): string;
  /** Commits everything currently in the working tree and returns the new commit. */
  commitAll(message: string): string;
  write(relativePath: string, contents: string): void;
  head(): string;
  cleanup(): void;
}

export async function makeTempRepo(): Promise<TempRepo> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-flow-git-')));
  const dir = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(dir);
  mkdirSync(home);

  const userGit = (args: readonly string[], cwd: string = dir): string =>
    execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Temp',
        GIT_AUTHOR_EMAIL: 'temp@example.invalid',
        GIT_COMMITTER_NAME: 'Temp',
        GIT_COMMITTER_EMAIL: 'temp@example.invalid',
      },
    });

  userGit(['init', '--quiet', '--initial-branch=main', '.']);
  userGit(['config', 'user.name', 'Temp']);
  userGit(['config', 'user.email', 'temp@example.invalid']);
  // Pinned so that a developer with a global `core.hooksPath` cannot make the
  // positive control silently stop firing — which would turn the isolation test
  // green for the wrong reason. It also makes the isolation claim stronger: the
  // wrapper's `-c` now has to beat a *repository-level* setting, which outranks
  // any global one.
  userGit(['config', 'core.hooksPath', join(dir, '.git', 'hooks')]);

  const processRunner = new NodeProcessRunner();
  const fs = new NodeFileSystem();
  const git = await createGitCommand({ processRunner, fs, homeDir: home });
  const workspaces = await createGitWorkspaces({ git, fs, homeDir: home });
  const worktreeRoot = workspaces.worktreeRoot;

  return {
    dir,
    home,
    git,
    worktreeRoot,
    workspaces,
    userGit,

    installSentinelHook(name: string): string {
      const hooks = join(dir, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      const sentinel = join(root, `sentinel-${name}.txt`);
      const script = join(hooks, name);
      // `cat > /dev/null` so hooks fed on stdin (reference-transaction) do not
      // die on a closed pipe and turn into a spurious command failure.
      writeFileSync(script, `#!/bin/sh\ncat > /dev/null 2>&1\necho fired >> "${sentinel}"\n`);
      chmodSync(script, 0o755);
      return sentinel;
    },

    write(relativePath: string, contents: string): void {
      writeFileSync(join(dir, relativePath), contents);
    },

    commitAll(message: string): string {
      userGit(['add', '-A']);
      userGit(['commit', '--quiet', '--no-verify', '-m', message]);
      return userGit(['rev-parse', 'HEAD']).trim();
    },

    head(): string {
      return userGit(['rev-parse', 'HEAD']).trim();
    },

    cleanup(): void {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A repository with one commit, which every worktree operation needs. */
export async function makeTempRepoWithCommit(): Promise<TempRepo> {
  const repo = await makeTempRepo();
  repo.write('README.md', 'base\n');
  repo.commitAll('base');
  return repo;
}
