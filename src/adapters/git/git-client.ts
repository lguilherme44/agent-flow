import {
  GIT_TIMEOUT_SECONDS,
  type GitCommand,
  type GitOutcome,
  type GitSubcommand,
} from './git-command.js';

export interface GitChange {
  readonly path: string;
  readonly status: string;
}

/** What the old direct `ProcessRunner` call used, kept so prompts do not change size. */
const REVIEW_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * The bits of git the workflow needs.
 *
 * Deliberately no full diff. Without worktrees every task writes to the same
 * tree, so by review time the accumulated diff can be thousands of lines — and
 * pasting that into a prompt is how a reviewer runs out of context before it
 * reaches the interesting part (R-12). The reviewer gets a summary and the file
 * list, and reads what it needs: it has the repository, read-only.
 *
 * **Routed through `GitCommand` since M2-02.** It used to build
 * `{ command: 'git' }` for `ProcessRunner` itself, which made it a second place
 * where an internal Git invocation could be issued without hook isolation (I-7)
 * — the exact shape §26.1 rule 1 now forbids. Nothing about what it reports
 * changed, and the regression tests in `test/adapters/git-client.test.ts` are
 * what say so.
 *
 * Truncated output is tolerated here, unlike in `GitWorkspaces`. This produces
 * prose for a prompt, not a decision: a `diff --stat` over an enormous change
 * being cut short costs the reviewer some context, whereas a truncated
 * `worktree list` would cost the cleanup code its notion of what exists.
 */
export class GitClient {
  constructor(
    private readonly git: GitCommand,
    private readonly cwd: string,
  ) {}

  async isRepository(): Promise<boolean> {
    const result = await this.run('rev-parse', ['--is-inside-work-tree']);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  /** `git diff --stat` against HEAD, including untracked files. */
  async diffStat(): Promise<string> {
    const result = await this.run('diff', ['--stat', 'HEAD']);
    const tracked = result.exitCode === 0 ? result.stdout.trim() : '';

    const untracked = await this.untrackedFiles();
    if (untracked.length === 0) return tracked || 'No changes against HEAD.';

    return [tracked, '', 'Untracked files:', ...untracked.map((path) => `  ${path}`)]
      .filter((line) => line !== '')
      .join('\n');
  }

  /**
   * `git diff --stat <base> <head>` — the feature's diff, not the tree's state.
   *
   * The worktree-mode half of {@link diffStat} (§19.2). Two revisions rather than
   * one, and that is the property: `diff --stat <base>` alone would compare the
   * base against whatever the checkout happens to hold *now*, so a stray file in
   * the integration worktree would enter the reviewer's picture of a commit. Named
   * explicitly, both sides describe exactly `planningBase..integrationHead`.
   */
  async diffStatBetween(base: string, head: string): Promise<string> {
    const range = revisionRange(base, head);
    if (range === null) return 'No changes against the base of this run.';

    const result = await this.run('diff', ['--stat', ...range, '--']);
    const stat = result.exitCode === 0 ? result.stdout.trim() : '';
    return stat.length > 0 ? stat : 'No changes against the base of this run.';
  }

  /**
   * Changed paths between two commits, with their status letters (§19.2).
   *
   * `-z`, because the newline-separated form cannot represent a rename
   * unambiguously and a path containing a newline would be read as two entries.
   * A rename or copy carries two paths and the *destination* is reported: that is
   * the file a reviewer opens.
   *
   * Untracked files are deliberately absent, unlike {@link changedFiles}. This
   * compares two commits, and a commit has no untracked files — anything sitting
   * in the integration worktree is not part of what was integrated, so listing it
   * would describe something the reviewer is not judging.
   */
  async changedFilesBetween(base: string, head: string): Promise<GitChange[]> {
    const range = revisionRange(base, head);
    if (range === null) return [];

    const result = await this.run('diff', ['--name-status', '-z', ...range, '--']);
    if (result.exitCode !== 0) return [];

    const fields = result.stdout.split('\0').filter((field) => field.length > 0);
    const changes: GitChange[] = [];

    for (let index = 0; index < fields.length; index += 1) {
      const status = fields[index] ?? '';
      // `R100`, `C75`: a similarity score, and two paths follow rather than one.
      const renamed = status.startsWith('R') || status.startsWith('C');
      const path = fields[index + (renamed ? 2 : 1)];
      index += renamed ? 2 : 1;
      if (path === undefined) break;
      changes.push({ status, path });
    }

    return changes;
  }

  /** Changed paths with their status letters, plus untracked files. */
  async changedFiles(): Promise<GitChange[]> {
    const result = await this.run('status', ['--porcelain=v1']);
    if (result.exitCode !== 0) return [];

    return result.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
  }

  /** True when nothing has been modified — used to prove a read-only stage behaved. */
  async isClean(): Promise<boolean> {
    return (await this.changedFiles()).length === 0;
  }

  /** Tracked repository files (`git ls-files`). */
  async trackedFiles(): Promise<string[]> {
    const result = await this.run('ls-files', []);
    return result.exitCode === 0
      ? result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
  }

  private async untrackedFiles(): Promise<string[]> {
    const result = await this.run('ls-files', ['--others', '--exclude-standard']);
    return result.exitCode === 0
      ? result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      : [];
  }

  /**
   * Every method here treats "git could not run" the same way it treated a
   * non-zero exit before M2-02: as no information rather than as an exception.
   * `review` is expected to work in a directory that is not a repository, and a
   * throw from here would turn that into a crash.
   */
  private async run(subcommand: GitSubcommand, args: string[]): Promise<GitOutcome> {
    const result = await this.git.run({
      subcommand,
      args,
      cwd: this.cwd,
      timeoutSeconds: GIT_TIMEOUT_SECONDS.read,
      maxOutputBytes: REVIEW_MAX_OUTPUT_BYTES,
    });

    if (result.ok) return result.value;

    return {
      exitCode: null,
      stdout: '',
      stderr: result.failure.message,
      durationMs: 0,
      truncated: false,
      argv: [],
    };
  }
}

/**
 * The two commits, or `null` when either is not an object id.
 *
 * `GitCommand` refuses configuration smuggled into `args` and never touches a
 * shell, so this is not an injection defence — it is a correctness one. Both
 * revisions reach here from `state.json`, where `CommitOidSchema` already
 * validates them; a value that is not forty hex characters means the caller is
 * holding something other than a commit, and asking Git about it would turn that
 * into a diff of the wrong thing rather than into nothing.
 */
function revisionRange(base: string, head: string): [string, string] | null {
  const oid = /^[0-9a-f]{40}$/;
  return oid.test(base) && oid.test(head) ? [base, head] : null;
}

/** Compact rendering of a change list for a prompt. */
export function renderChanges(changes: readonly GitChange[]): string {
  return annotateScaffold(changes);
}

/** Paths `init` writes. Not a feature's doing, whatever the diff says. */
const SCAFFOLD = ['.agent-flow/', '.gitignore', 'AGENTS.md'];

/**
 * The changed-file list, with agent-flow's own scaffolding marked as such.
 *
 * `init` appends to .gitignore and writes AGENTS.md, and it runs before the
 * first feature — so unless the user commits in between, those files are in the
 * working tree when `review` reads the diff. Both reviewers, in both live
 * stacks, spent findings saying the change was out of scope. They were right,
 * and the change was the tool's, not the feature's.
 *
 * Marked rather than filtered. A hand-edited AGENTS.md changes how every future
 * agent behaves and is squarely the reviewer's business; hiding it to reduce
 * noise would be trading a wrong finding for a missing one.
 */
export function annotateScaffold(changes: readonly GitChange[]): string {
  if (changes.length === 0) return 'No files were changed.';

  return changes
    .map((change) => {
      const scaffold = SCAFFOLD.some(
        (path) => change.path === path || change.path.startsWith(path),
      );
      const note = scaffold ? '   (written by agent-flow itself, not by this feature)' : '';
      return `- ${change.status.padEnd(2)} ${change.path}${note}`;
    })
    .join('\n');
}
