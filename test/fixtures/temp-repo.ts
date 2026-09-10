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
  /**
   * Writes the one file that makes a directory an initialised Agent Flow project.
   *
   * Named for what it means rather than for the path it writes, because AR-01's C-01
   * turns "this file is absent" into a refusal: a test that seeds it by hand states a
   * precondition, and a test that forgets to gets a refusal it did not ask about.
   */
  initAgentFlow(contents?: string): void;
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
  /**
   * Pinned for the same reason as `core.hooksPath` above: a machine setting must not
   * decide what these tests measure.
   *
   * Git for Windows defaults `core.autocrlf` to `true`, which rewrites every line ending
   * on checkout. This suite creates worktrees and then asserts on `status --porcelain`,
   * so with the default the very first `assert clean` of an isolated run refuses a tree
   * nothing had touched — a preparation failure that describes the developer's Git
   * installation and gets read as a verdict on the run. Repository-level, so it outranks
   * whatever the machine says and changes nothing outside the temp directory.
   */
  userGit(['config', 'core.autocrlf', 'false']);

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

    initAgentFlow(contents = 'project:\n  name: temp-repo\n  type: node\n'): void {
      mkdirSync(join(dir, '.agent-flow'), { recursive: true });
      writeFileSync(join(dir, '.agent-flow', 'config.yaml'), contents);
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

/**
 * The name of the file `bornDirty` leaves modified in every fresh checkout.
 *
 * Exported so a test can assert the refusal names it without spelling the string twice.
 */
export const BORN_DIRTY_FILE = 'content.txt';

/**
 * A repository whose *fresh* checkout is dirty before anything has run in it.
 *
 * The case §8.3 and §8.4 both need: a working tree that does not match the index the
 * instant Git finishes writing it, so "the install dirtied the tree" and "the checkout
 * was already dirty" can be told apart.
 *
 * **No external filter, and that is the whole point of this helper.** Both call sites
 * used to do it with `.gitattributes` plus `filter.dirtier.smudge = sed s/original/…/`,
 * and that fixture is silently conditional on `sed` starting. Measured, because the gate
 * failed on it once and the message blamed the probe:
 *
 * ```
 * error: cannot fork to run external filter 'this-command-does-not-exist'
 * $ git status --porcelain     # (nothing)
 * ```
 *
 * A non-required filter that cannot start is *ignored* — Git warns on stderr, writes the
 * unfiltered blob, and reports the checkout clean. So under a loaded parallel lane, where
 * a spawn can fail, the fixture stopped producing the condition under test and the
 * assertion failed as though the product had regressed.
 *
 * What replaces it is Git's own line-ending asymmetry, which spawns nothing. The blob is
 * committed with CRLF *before* `.gitattributes` declares the path `text`; from then on
 * checkout writes those bytes unchanged while `git status` cleans them to LF before
 * comparing — so the file is modified in every fresh worktree, on Windows and on Linux.
 *
 * **The second commit stages one path, and that is not tidiness.** The first version used
 * `commitAll`, and the gate failed on it exactly as the filter had. Measured:
 *
 * ```
 * $ git add -A && git commit -m 'declare text'      # content.txt looked stat-dirty
 * $ git cat-file -p :content.txt | od -c
 * 0000000   o   r   i   g   i   n   a   l  \n       # renormalised, and the premise gone
 * ```
 *
 * `add -A` re-reads a file whose stat looks dirty, applies the attribute *it has just
 * declared*, and stages the normalisation — so whether the index kept its CRLF depended
 * on how the clock fell between two commits. Staging `.gitattributes` by name cannot
 * touch the other file.
 *
 * And the premise is **asserted** rather than assumed, because both of this fixture's
 * failures reached the suite as "the product regressed" when the truth was "the fixture
 * produced nothing to test".
 */
export function bornDirty(repo: TempRepo): void {
  repo.write(BORN_DIRTY_FILE, 'original\r\n');
  repo.commitAll('a file committed with CRLF');

  // Declared after the commit, and staged by name: `add -A` here would renormalise the
  // file this fixture exists to leave un-normalised.
  repo.write('.gitattributes', '*.txt text\n');
  repo.userGit(['add', '.gitattributes']);
  repo.userGit(['commit', '--quiet', '--no-verify', '-m', 'declare *.txt text']);

  const staged = repo.userGit(['cat-file', '-p', `:${BORN_DIRTY_FILE}`]);
  if (!staged.includes('\r\n')) {
    throw new Error(
      `bornDirty: the index no longer holds CRLF for ${BORN_DIRTY_FILE}, so a fresh checkout would be clean and the test below would be asserting nothing.`,
    );
  }
}
