import {
  GIT_TIMEOUT_SECONDS,
  gitFailure,
  gitOk,
  type GitCommand,
  type GitOutcome,
  type GitResult,
  type GitSubcommand,
} from './git-command.js';

export interface GitChange {
  readonly path: string;
  readonly status: string;
}

export interface GitDiffChange extends GitChange {
  /** Source path for a rename or copy. The destination remains {@link path}. */
  readonly previousPath?: string;
  /** Omitted when a caller-owned raw-patch bound prevents a truthful decision. */
  readonly binary?: boolean;
}

export interface GitDiffSnapshot {
  readonly base: string;
  readonly head: string;
  readonly changes: readonly GitDiffChange[];
  /** Mechanical Git patch text only; never model-produced evidence. */
  readonly rawPatch: string;
  readonly rawPatchTruncated: boolean;
  readonly rawPatchOmittedCharacters: number;
}

export interface GitDiffSnapshotOptions {
  /** Caller-owned prompt/storage budget, counted as JavaScript string characters. */
  readonly maxRawPatchCharacters?: number;
  /** Process boundary ceiling. Hitting it is a refusal, never a partial snapshot. */
  readonly maxOutputBytes?: number;
}

/** What the old direct `ProcessRunner` call used, kept so prompts do not change size. */
const REVIEW_MAX_OUTPUT_BYTES = 256 * 1024;

const DIFF_DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DIFF_HARD_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DIFF_DEFAULT_MAX_RAW_PATCH_CHARACTERS = 256 * 1024;
const DIFF_HARD_MAX_RAW_PATCH_CHARACTERS = 1024 * 1024;
const EXACT_OBJECT_TYPE_MAX_OUTPUT_BYTES = 32;
const PORCELAIN_SCORED_DIFF_STATUS_PATTERN = /^[RC]\d{3}$/;

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

  /**
   * A bounded, fail-closed mechanical diff between two exact commit objects.
   *
   * Name/status and patch are deliberately separate Git outputs: `-z` keeps
   * filenames machine-safe while the patch stays useful as raw evidence. Since
   * neither output can authenticate the other, a refusal, non-zero exit,
   * ProcessRunner truncation, or malformed structure in either refuses the
   * entire snapshot rather than returning a plausible-looking partial truth.
   */
  async diffSnapshotBetween(
    base: string,
    head: string,
    options?: GitDiffSnapshotOptions,
  ): Promise<GitResult<GitDiffSnapshot>> {
    const range = revisionRange(base, head);
    if (range === null) {
      return gitFailure({
        code: 'git_unsafe_argument',
        message: 'diff snapshot base and head must be exact 40-character lowercase object ids',
      });
    }

    const safeOptions = readDiffSnapshotOptions(options);
    if (!safeOptions.ok) return safeOptions;
    const { maxOutputBytes, maxRawPatchCharacters } = safeOptions.value;
    const detection = ['--find-renames', '--find-copies-harder'] as const;

    for (const oid of range) {
      const verified = await this.verifyExactCommit(oid);
      if (!verified.ok) return verified;
    }

    const namesResult = await this.git.run({
      subcommand: 'diff',
      args: ['--name-status', '-z', '--no-textconv', ...detection, ...range, '--'],
      cwd: this.cwd,
      timeoutSeconds: GIT_TIMEOUT_SECONDS.read,
      maxOutputBytes,
    });
    if (!namesResult.ok) return namesResult;

    const namesFailure = diffOutcomeFailure(namesResult.value, 'name/status');
    if (namesFailure !== null) return namesFailure;

    const parsedChanges = parseNameStatusZ(namesResult.value.stdout);
    if (!parsedChanges.ok) return parsedChanges;

    const patchResult = await this.git.run({
      subcommand: 'diff',
      args: [
        '--patch',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        ...detection,
        ...range,
        '--',
      ],
      cwd: this.cwd,
      timeoutSeconds: GIT_TIMEOUT_SECONDS.read,
      maxOutputBytes,
    });
    if (!patchResult.ok) return patchResult;

    const patchFailure = diffOutcomeFailure(patchResult.value, 'patch');
    if (patchFailure !== null) return patchFailure;

    // Bound before any patch scan. If text was omitted, binary classification is
    // intentionally absent rather than guessed from an incomplete prefix.
    const fullPatch = patchResult.value.stdout;
    const rawPatch = fullPatch.slice(0, maxRawPatchCharacters);
    const rawPatchOmittedCharacters = fullPatch.length - rawPatch.length;
    const rawPatchTruncated = rawPatchOmittedCharacters > 0;
    let changes: readonly GitDiffChange[] = parsedChanges.value;

    if (!rawPatchTruncated) {
      const binaryFlags = binaryFlagsFromCompletePatch(rawPatch, changes.length);
      if (!binaryFlags.ok) return binaryFlags;
      changes = changes.map((change, index) => ({
        ...change,
        binary: binaryFlags.value[index] ?? false,
      }));
    }

    return gitOk({
      base,
      head,
      changes,
      rawPatch,
      rawPatchTruncated,
      rawPatchOmittedCharacters,
    });
  }

  private async verifyExactCommit(oid: string): Promise<GitResult<true>> {
    const result = await this.git.run({
      subcommand: 'cat-file',
      args: ['-t', oid],
      cwd: this.cwd,
      timeoutSeconds: GIT_TIMEOUT_SECONDS.quick,
      maxOutputBytes: EXACT_OBJECT_TYPE_MAX_OUTPUT_BYTES,
    });
    if (!result.ok) return result;

    const outcome = result.value;
    if (outcome.truncated) {
      return gitFailure({
        code: 'git_output_truncated',
        message: 'git cat-file object type output hit its safety ceiling',
        exitCode: outcome.exitCode,
        stderr: outcome.stderr,
      });
    }
    if (outcome.exitCode !== 0) {
      return gitFailure({
        code: 'git_command_failed',
        message: `git cat-file -t failed with exit code ${String(outcome.exitCode)}`,
        exitCode: outcome.exitCode,
        stderr: outcome.stderr,
      });
    }
    if (outcome.stdout !== 'commit\n') {
      return invalidDiffOutput('base/head object is not an exact commit object');
    }
    return gitOk(true);
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

  /** Tracked repository files (`git ls-files -z`). */
  async trackedFiles(): Promise<string[]> {
    const result = await this.run('ls-files', ['-z']);
    return result.exitCode === 0
      ? result.stdout
          .split('\0')
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
function revisionRange(base: unknown, head: unknown): [string, string] | null {
  const oid = /^[0-9a-f]{40}$/;
  return typeof base === 'string' &&
    typeof head === 'string' &&
    oid.test(base) &&
    oid.test(head)
    ? [base, head]
    : null;
}

function readDiffSnapshotOptions(options: unknown): GitResult<{
  readonly maxOutputBytes: number;
  readonly maxRawPatchCharacters: number;
}> {
  if (options === undefined) {
    return gitOk({
      maxOutputBytes: DIFF_DEFAULT_MAX_OUTPUT_BYTES,
      maxRawPatchCharacters: DIFF_DEFAULT_MAX_RAW_PATCH_CHARACTERS,
    });
  }
  if (options === null || typeof options !== 'object') {
    return invalidDiffOptions('options must be an object when supplied');
  }

  let outputValue: unknown;
  let patchValue: unknown;
  try {
    const runtime = options as Record<string, unknown>;
    // Read each untrusted property exactly once. A Proxy/getter may throw or
    // return a different value on every access; neither may escape this boundary.
    outputValue = runtime['maxOutputBytes'];
    patchValue = runtime['maxRawPatchCharacters'];
  } catch {
    return invalidDiffOptions('options could not be read safely');
  }

  const maxOutputBytes = boundedRuntimeInteger(
    outputValue,
    DIFF_DEFAULT_MAX_OUTPUT_BYTES,
    DIFF_HARD_MAX_OUTPUT_BYTES,
  );
  if (!maxOutputBytes.ok) return maxOutputBytes;
  const maxRawPatchCharacters = boundedRuntimeInteger(
    patchValue,
    DIFF_DEFAULT_MAX_RAW_PATCH_CHARACTERS,
    DIFF_HARD_MAX_RAW_PATCH_CHARACTERS,
  );
  if (!maxRawPatchCharacters.ok) return maxRawPatchCharacters;

  return gitOk({
    maxOutputBytes: maxOutputBytes.value,
    maxRawPatchCharacters: maxRawPatchCharacters.value,
  });
}

function boundedRuntimeInteger(
  value: unknown,
  fallback: number,
  hardMax: number,
): GitResult<number> {
  if (value === undefined) return gitOk(fallback);
  if (typeof value !== 'number') return invalidDiffOptions('numeric bounds must be numbers');
  if (!Number.isFinite(value)) return gitOk(fallback);

  // Floor first: 0.5 and Number.MIN_VALUE must not leak a zero process cap.
  const floored = Math.floor(value);
  if (floored < 1) return gitOk(fallback);
  return gitOk(Math.min(floored, hardMax));
}

function diffOutcomeFailure(
  outcome: GitOutcome,
  label: string,
): ReturnType<typeof gitFailure> | null {
  if (outcome.truncated) {
    return gitFailure({
      code: 'git_output_truncated',
      message: `git diff ${label} output hit its safety ceiling`,
      exitCode: outcome.exitCode,
      stderr: outcome.stderr,
    });
  }
  if (outcome.exitCode !== 0) {
    return gitFailure({
      code: 'git_command_failed',
      message: `git diff ${label} failed with exit code ${String(outcome.exitCode)}`,
      exitCode: outcome.exitCode,
      stderr: outcome.stderr,
    });
  }
  return null;
}

function parseNameStatusZ(stdout: string): GitResult<readonly GitDiffChange[]> {
  if (stdout.length === 0) return gitOk([]);
  if (!stdout.endsWith('\0')) return invalidDiffOutput('name/status output has no terminal NUL');

  const fields = stdout.split('\0');
  fields.pop();
  if (fields.some((field) => field.length === 0)) {
    return invalidDiffOutput('name/status output contains an empty field');
  }

  const changes: GitDiffChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    if (status === undefined) {
      return invalidDiffOutput('name/status output contains an unknown status');
    }
    const statusKind = status[0];
    const scored = statusKind === 'R' || statusKind === 'C';
    let normalizedStatus = status;
    if (scored) {
      const score = PORCELAIN_SCORED_DIFF_STATUS_PATTERN.test(status)
        ? Number(status.slice(1))
        : Number.NaN;
      if (!Number.isInteger(score) || score < 0 || score > 100) {
        return invalidDiffOutput('rename/copy status contains an invalid similarity score');
      }
      normalizedStatus = `${statusKind}${String(score)}`;
    } else if (status.length !== 1 || !/^[ADMTUXB]$/.test(status)) {
      return invalidDiffOutput('name/status output contains an unknown status');
    }
    index += 1;

    if (scored) {
      const previousPath = fields[index];
      const path = fields[index + 1];
      if (previousPath === undefined || path === undefined) {
        return invalidDiffOutput('rename/copy status does not have exactly two paths');
      }
      changes.push({ status: normalizedStatus, previousPath, path });
      index += 2;
      continue;
    }

    const path = fields[index];
    if (path === undefined) return invalidDiffOutput('change status does not have a path');
    changes.push({ status: normalizedStatus, path });
    index += 1;
  }

  return gitOk(changes);
}

function binaryFlagsFromCompletePatch(
  rawPatch: string,
  changeCount: number,
): GitResult<readonly boolean[]> {
  if (rawPatch.length === 0) {
    return changeCount === 0
      ? gitOk([])
      : invalidDiffOutput('patch is empty but name/status reports changes');
  }
  if (!rawPatch.startsWith('diff --git ')) {
    return invalidDiffOutput('patch does not start with a diff header');
  }

  const blocks = rawPatch.split(/^diff --git /m).slice(1);
  if (blocks.length !== changeCount) {
    return invalidDiffOutput('patch and name/status report different change counts');
  }

  return gitOk(
    blocks.map((block) => /(?:^|\n)(?:GIT binary patch|Binary files .* differ)(?:\n|$)/.test(block)),
  );
}

function invalidDiffOutput(message: string): ReturnType<typeof gitFailure> {
  return gitFailure({ code: 'git_invalid_output', message: `malformed git diff: ${message}` });
}

function invalidDiffOptions(message: string): ReturnType<typeof gitFailure> {
  return gitFailure({ code: 'git_unsafe_argument', message: `invalid diff snapshot options: ${message}` });
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
