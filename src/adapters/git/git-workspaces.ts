import { isAbsolute, relative, resolve, type PlatformPath } from 'node:path';
import * as nodePath from 'node:path';
import { CommitOidSchema } from '../../contracts/common.schema.js';
import type { FileSystem } from '../../ports/file-system.js';
import type { WorkspaceLocation } from '../../core/worktree-policy.js';
import { provisionGitHome } from './agent-flow-git-home.js';
import {
  GIT_TIMEOUT_SECONDS,
  gitFailure,
  gitOk,
  type GitCommand,
  type GitDates,
  type GitIdentity,
  type GitOutcome,
  type GitRefusal,
  type GitResult,
} from './git-command.js';

/**
 * Every Git operation MVP 2 needs, typed, over one hook-isolated spawner
 * (§26.1 rule 1, work item M2-02).
 *
 * **This is an adapter, not an orchestrator.** It knows how to run a Git
 * operation and what its exit code means. It does not know which task is ready,
 * which wave is active, which attempt produced a receipt, or when integration may
 * begin — all of that belongs to `src/app` and to later milestones. The shape to
 * watch for in review is a method here that takes a run state or a plan.
 *
 * Two rules run through the whole file:
 *
 *   - **A known non-zero exit is an answer, not an error.** `merge` exits 1 on a
 *     conflict, `merge-base --is-ancestor` exits 1 for "no", `cat-file -e` exits 1
 *     for "absent" — and all three exit 128 when the repository itself is the
 *     problem. Mapping every non-zero to `false` would report a corrupt
 *     repository as a clean negative, which is how a run finishes green over a
 *     tree that lost work.
 *   - **A path is derived, never accepted.** Worktree operations take a
 *     `WorkspaceLocation` from `core/worktree-policy.ts` and resolve it under a
 *     canonical root this adapter holds. There is no method that takes an
 *     absolute path from a caller, so S-3 is closed by the shape of the API
 *     rather than by a check somebody has to remember.
 */

// ---------------------------------------------------------------------------
// Version (§16, §17, §23, §49)
// ---------------------------------------------------------------------------

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Exactly what `git version` printed, for a message a person can act on. */
  readonly raw: string;
}

/**
 * The oldest Git this milestone runs on, **determined empirically rather than
 * asserted from memory** — which §23 requires in so many words, because this
 * project's Findings document exists because of a version claim nobody probed.
 *
 * The floor is set by one flag, and it is the newest thing MVP 2 needs:
 *
 * | Operation | Introduced | Evidence |
 * |---|---|---|
 * | `worktree add --lock --reason <string>` | **2.33.0** | Release notes 2.33.0: *"`git worktree add --lock` learned to record why the worktree is locked with a custom message."* The `add` synopsis carries `[--lock [--reason <string>]]` from 2.33.0 and does not in 2.31.0 (2.32.0's page is byte-identical to 2.31.0's). |
 * | `worktree add --lock` | 2.30.0 or earlier | Present in the 2.30.0 synopsis, absent in 2.9.5. |
 * | `worktree list --porcelain` | 2.7.0 | Present in the 2.9.5 synopsis. |
 * | `status --porcelain=v1` | 2.11.0 | Added with `=v2`. |
 * | `rev-parse --path-format=absolute` | 2.31.0 | Needed by M2-03 for `repoKey`; below this floor, so it does not move it. |
 * | `commit-tree`, `update-ref`, `merge --no-ff --no-edit`, `merge --abort`, `merge-base --is-ancestor`, `cat-file -e`, `for-each-ref`, `write-tree` | long predate 2.33 | — |
 *
 * **`worktree list --porcelain -z` is the flag that was deliberately not used.**
 * It arrived in 2.36.0 (absent from the 2.35.0 synopsis, present in 2.36.0's), and
 * adopting it would move the floor three minor versions. The exposure it would
 * close was probed rather than assumed, and it is real: without `-z` a registered
 * path containing `"\nworktree /elsewhere"` makes Git print a record it never
 * emitted (see {@link parseWorktreeList}). Two things close it here instead:
 *
 *   - {@link parseWorktreeList} **fails the whole listing** when a `worktree`
 *     line appears inside an open record, which is the signature of a forged
 *     frame and cannot occur in genuine output;
 *   - {@link GitWorkspaces.ownWorktrees} resolves every path with `realPath` and
 *     drops what does not resolve, so the undetectable case — a path merely
 *     truncated at a newline — cannot become something Agent Flow removes.
 *
 * That is a defence with two independent layers rather than a version bump, and
 * both have regression tests. `docs/engineering/findings.md` records the
 * trade-off so M2-09 can reopen it if cleanup turns out to need the stronger
 * format after all.
 *
 * Probed locally on Git 2.52.0.
 */
export const MINIMUM_SUPPORTED_GIT_VERSION: GitVersion = {
  major: 2,
  minor: 33,
  patch: 0,
  raw: 'git version 2.33.0',
};

/**
 * Parses `git version …` into numbers.
 *
 * String comparison is not an option and the reason is one line long: `"2.9"` is
 * greater than `"2.40"` lexically and older than it in every way that matters.
 *
 * Real-world shapes this must survive, all of which carry trailing material after
 * the three numbers:
 *
 * ```text
 * git version 2.52.0
 * git version 2.43.0.windows.1
 * git version 2.39.5 (Apple Git-154)
 * ```
 *
 * The trailing part is deliberately discarded rather than modelled. A vendor
 * suffix orders against nothing — there is no sense in which `windows.1` is
 * before or after `(Apple Git-154)` — so keeping it would invite a comparison
 * that has no meaning. A missing patch is read as `0`, which is what
 * `git version 2.33` means.
 */
export function parseGitVersion(output: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:[^\d].*)?$/.exec(output.trim());
  if (match === null) return null;

  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined) return null;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: patch === undefined ? 0 : Number(patch),
    raw: output.trim(),
  };
}

/** Negative when `a` is older, zero when equal, positive when newer. */
export function compareGitVersions(a: GitVersion, b: GitVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatGitVersion(version: GitVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One entry of `git worktree list --porcelain`. Only the facts MVP 2 acts on. */
export interface WorktreeEntry {
  /** Absolute, as Git recorded it. */
  readonly path: string;
  /** The commit checked out, absent for a bare entry. */
  readonly head?: string;
  /** Full ref name, absent when detached or bare. */
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  /** The `--reason` string, when the lock carries one. */
  readonly lockReason?: string;
  readonly prunable: boolean;
}

export interface StatusEntry {
  /** Index status letter; `?` for untracked. */
  readonly index: string;
  /** Working-tree status letter. */
  readonly worktree: string;
  /** The path as it stands now — the destination of a rename. */
  readonly path: string;
  /** The source of a rename or copy, when there is one. */
  readonly originalPath?: string;
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all` (§8.2).
 *
 * "Clean" is defined exactly once, and it is `entries.length === 0`. Ignored
 * files never appear, which is the whole reason `node_modules/` after an install
 * does not fail a workspace assertion.
 */
export interface WorkingTreeStatus {
  readonly clean: boolean;
  readonly entries: readonly StatusEntry[];
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export interface RefEntry {
  readonly ref: string;
  readonly oid: string;
}

export type MergeOutcome =
  | { readonly kind: 'merged'; readonly stdout: string }
  /** The merge stopped with unmerged paths. The worktree is mid-merge (§15). */
  | { readonly kind: 'conflict'; readonly paths: readonly string[] };

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

// ---------------------------------------------------------------------------
// Path containment (§20, S-3)
// ---------------------------------------------------------------------------

/**
 * The component shape a path or ref segment must have, re-checked here.
 *
 * The same allowlist `core/worktree-policy.ts` applies. Re-checking is not
 * paranoia about that module — it is that "the caller validated it" is not a
 * property this one can observe, and the operation on the other side of it
 * deletes directories.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Resolves validated segments under a root and proves the result stayed inside.
 *
 * **`relative`, never `startsWith`** (D-F02, S-3). `"/foo/bar2".startsWith("/foo/bar")`
 * is true and `/foo/bar2` is not inside `/foo/bar`; the same rule fails the other
 * way on Windows, where `C:\wk` does contain `C:\wk\api` and no amount of
 * separator arithmetic says so. `relative` answers the question the check is
 * actually asking, and the empty result — the root itself — is refused too,
 * because a worktree operation on the root would act on every run at once.
 *
 * `impl` is a parameter so the win32 rules can be asserted on Linux (§26.2),
 * which is the only way this stays correct on a platform CI does not run.
 */
export function resolveWithinRoot(
  root: string,
  segments: readonly string[],
  impl: PlatformPath = nodePath,
): GitResult<string> {
  if (!impl.isAbsolute(root)) {
    return gitFailure({
      code: 'git_unsafe_argument',
      message: `the worktree root must be absolute, got "${root}"`,
    });
  }

  if (segments.length === 0) {
    return gitFailure({
      code: 'git_unsafe_argument',
      message: 'a workspace location must have at least one segment',
    });
  }

  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)) {
      return gitFailure({
        code: 'git_unsafe_argument',
        message: `"${segment}" cannot be used as a path component`,
      });
    }
  }

  const candidate = impl.resolve(root, ...segments);
  const inside = impl.relative(root, candidate);

  if (inside === '' || inside.startsWith('..') || impl.isAbsolute(inside)) {
    return gitFailure({
      code: 'git_unsafe_argument',
      message: `"${candidate}" is not inside the Agent Flow worktree root`,
    });
  }

  return gitOk(candidate);
}

/** Whether a path Git reported sits under a root Agent Flow owns. */
export function isWithinRoot(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const inside = relative(resolve(root), resolve(candidate));
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

// ---------------------------------------------------------------------------
// Operand validation (§46)
// ---------------------------------------------------------------------------

/**
 * Refs this adapter will put on a command line.
 *
 * Narrow on purpose: a full ref path or a bare branch name, no leading dash, no
 * `..`, no `@{`, no whitespace. Composed ref names arrive from
 * `core/worktree-policy.ts`, which produces `agent-flow/<gitRunKey>/…` and
 * nothing else; this pattern also admits the `refs/heads/…` form a caller reads
 * back out of `for-each-ref`. Anything that could be read as an option is
 * structurally excluded rather than escaped, and `--` is used as well wherever
 * the subcommand accepts it (probed: `worktree add`, `update-ref`, `merge`,
 * `merge-base` and `for-each-ref` all do).
 */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const REF_HOSTILE = /\.\.|@\{|\.lock$|\/\/|\/$|\.$/;

function validRef(ref: string): GitResult<string> {
  if (!SAFE_REF.test(ref) || REF_HOSTILE.test(ref)) {
    return gitFailure({
      code: 'git_unsafe_argument',
      message: `"${ref}" is not a ref name this tool composes`,
    });
  }
  return gitOk(ref);
}

/** A 40-character lowercase object id, or a refusal. Never an abbreviation (§33). */
function validOid(oid: string, what: string): GitResult<string> {
  const parsed = CommitOidSchema.safeParse(oid);
  if (!parsed.success) {
    return gitFailure({
      code: 'git_invalid_output',
      message: `${what} is not a 40-character lowercase Git object id: "${oid}"`,
    });
  }
  return gitOk(parsed.data);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface GitWorkspacesDeps {
  readonly git: GitCommand;
  /**
   * Needed for `realPath` alone, and only when deciding ownership (S-4).
   *
   * A worktree adapter that took a whole filesystem to do its job would be a
   * smell; this one takes it to answer one question — *where is this path
   * really* — which is the question a lexical check cannot answer and a
   * destructive operation depends on.
   */
  readonly fs: FileSystem;
  /**
   * Canonical absolute path of `~/.agent-flow/worktrees` (§7.1).
   *
   * Canonical because `git worktree list` reports resolved paths, and a
   * containment check between two spellings of one directory answers the wrong
   * question. Provisioned by `provisionGitHome`.
   */
  readonly worktreeRoot: string;
}

/** Where a worktree operation runs. Always a real repository path. */
export interface RepoContext {
  readonly cwd: string;
}

export interface AddWorktreeOptions extends RepoContext {
  readonly location: WorkspaceLocation;
  /** Created in the same command as the worktree (§7.3). Omit to check out `base`. */
  readonly branch?: string;
  /** The commit-ish the worktree starts at. */
  readonly base: string;
  /** Diagnostic text recorded with the lock. Trusted, never model-authored. */
  readonly reason: string;
}

export interface CommitTreeOptions extends RepoContext {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly identity: GitIdentity;
  readonly dates: GitDates;
}

export interface UpdateRefOptions extends RepoContext {
  readonly ref: string;
  readonly newOid: string;
  /**
   * Compare-and-swap. When given, Git refuses unless the ref currently holds
   * this value — which is how M2-03 and M2-05 avoid a blind overwrite of a
   * namespace they do not own. The all-zero id means "must not exist yet".
   */
  readonly expectedOldOid?: string;
}

export interface MergeOptions extends RepoContext {
  readonly commit: string;
  readonly message: string;
  readonly identity: GitIdentity;
  readonly dates: GitDates;
}

/** The all-zero object id: `update-ref`'s "this ref must not exist" (§29). */
export const ABSENT_OID = '0'.repeat(40);

export class GitWorkspaces {
  private readonly git: GitCommand;
  private readonly fs: FileSystem;
  readonly worktreeRoot: string;

  constructor(deps: GitWorkspacesDeps) {
    this.git = deps.git;
    this.fs = deps.fs;
    this.worktreeRoot = deps.worktreeRoot;
  }

  // -- version ------------------------------------------------------------

  async version(cwd: string): Promise<GitResult<GitVersion>> {
    const outcome = await this.run({ subcommand: 'version', cwd, timeout: 'quick' });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git version');
    if (failed !== null) return failed;

    const parsed = parseGitVersion(outcome.value.stdout);
    if (parsed === null) {
      return gitFailure({
        code: 'git_invalid_output',
        message: `could not read a version out of "${outcome.value.stdout.trim()}"`,
      });
    }
    return gitOk(parsed);
  }

  /**
   * Whether the installed Git meets {@link MINIMUM_SUPPORTED_GIT_VERSION}.
   *
   * Returns the version on success so a caller can report it, and
   * `git_version_unsupported` — the code §6.3 check 5 and §23 both name — when it
   * does not. **M2-02 only provides this.** No run refuses worktree mode because
   * of it yet: `createRun` is untouched, and wiring the refusal in is M2-03.
   */
  async requireSupportedVersion(cwd: string): Promise<GitResult<GitVersion>> {
    const found = await this.version(cwd);
    if (!found.ok) return found;

    if (compareGitVersions(found.value, MINIMUM_SUPPORTED_GIT_VERSION) < 0) {
      return gitFailure({
        code: 'git_version_unsupported',
        message:
          `worktree mode needs Git ${formatGitVersion(MINIMUM_SUPPORTED_GIT_VERSION)} or newer ` +
          `for "worktree add --lock --reason"; this machine has ${formatGitVersion(found.value)}`,
      });
    }

    return found;
  }

  // -- repository shape (§6.3 checks 1-4, 8) ------------------------------

  /**
   * `rev-parse --is-inside-work-tree` — is this directory a working tree at all.
   *
   * Answers `false` rather than failing when the directory is not a repository,
   * because §6.3 check 1 is a question with a legitimate negative answer: Agent
   * Flow has always run in directories that are not repositories, and §25
   * promises that stays true for sequential runs.
   */
  async isWorkTree(cwd: string): Promise<GitResult<boolean>> {
    const outcome = await this.run({
      subcommand: 'rev-parse',
      cwd,
      timeout: 'quick',
      args: ['--is-inside-work-tree'],
    });
    if (!outcome.ok) return outcome;
    if (outcome.value.exitCode === 0) return gitOk(outcome.value.stdout.trim() === 'true');
    // 128 here means "not a repository", which is an answer.
    if (outcome.value.exitCode === 128) return gitOk(false);
    return gitFailure(commandFailed(outcome.value, 'git rev-parse --is-inside-work-tree'));
  }

  /** `rev-parse --is-bare-repository` (§6.3 check 2). */
  async isBareRepository(cwd: string): Promise<GitResult<boolean>> {
    const outcome = await this.run({
      subcommand: 'rev-parse',
      cwd,
      timeout: 'quick',
      args: ['--is-bare-repository'],
    });
    if (!outcome.ok) return outcome;
    if (outcome.value.exitCode === 0) return gitOk(outcome.value.stdout.trim() === 'true');
    if (outcome.value.exitCode === 128) return gitOk(false);
    return gitFailure(commandFailed(outcome.value, 'git rev-parse --is-bare-repository'));
  }

  /**
   * The commit `HEAD` names, or `null` when HEAD is unborn (§6.3 check 3).
   *
   * `null` and a failure are different answers and are kept apart: a repository
   * with no commits is a state §23 refuses early *by name*, while a repository
   * that cannot be read is `git_command_failed`. Collapsing them would make
   * "you have not committed yet" and "your repository is broken" the same
   * message.
   */
  async resolveHead(cwd: string): Promise<GitResult<string | null>> {
    const outcome = await this.run({
      subcommand: 'rev-parse',
      cwd,
      timeout: 'quick',
      args: ['--verify', '--quiet', '--end-of-options', 'HEAD'],
    });
    if (!outcome.ok) return outcome;
    // `--quiet` turns "no such ref" into a silent exit 1, which is what an
    // unborn HEAD looks like. 128 is "not a repository" and is also not a commit.
    if (outcome.value.exitCode === 1 || outcome.value.exitCode === 128) return gitOk(null);

    const failed = expectSuccess(outcome.value, 'git rev-parse HEAD');
    if (failed !== null) return failed;

    return validOid(outcome.value.stdout.trim(), 'the commit HEAD names');
  }

  /**
   * `rev-parse --path-format=absolute --git-common-dir` (§5.1).
   *
   * The *common* directory rather than the toplevel, and the distinction is the
   * whole reason `repoKey` is stable: started from a linked worktree, the
   * toplevel is that worktree while the common dir points at the main
   * repository, so two invocations from two worktrees of one repository agree.
   * It is used to **identify** a repository and never as a place to write into.
   */
  async commonDir(cwd: string): Promise<GitResult<string>> {
    const outcome = await this.run({
      subcommand: 'rev-parse',
      cwd,
      timeout: 'quick',
      args: ['--path-format=absolute', '--git-common-dir'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectParsableSuccess(outcome.value, 'git rev-parse --git-common-dir');
    if (failed !== null) return failed;

    const path = outcome.value.stdout.trim();
    if (path.length === 0) {
      return gitFailure({
        code: 'git_invalid_output',
        message: 'git rev-parse --git-common-dir produced no path',
      });
    }
    return gitOk(path);
  }

  /**
   * `git submodule status` — non-empty output means this repository has them.
   *
   * §23 refuses submodules early because `git worktree add` does not populate
   * them, so the worktree would build against missing code and fail validation
   * for a reason the failure message would not explain. The caller pairs this
   * with a `.gitmodules` check, as the spec requires both.
   */
  async hasSubmodules(cwd: string): Promise<GitResult<boolean>> {
    const outcome = await this.run({
      subcommand: 'submodule',
      cwd,
      timeout: 'read',
      args: ['status'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectParsableSuccess(outcome.value, 'git submodule status');
    if (failed !== null) return failed;

    return gitOk(outcome.value.stdout.trim().length > 0);
  }

  /**
   * `git check-ignore -q -- <path>` (§6.3 check 8).
   *
   * Exit 0 means ignored, 1 means not ignored, and anything else is an error —
   * the same three-way shape as `cat-file -e`, and refused the same way rather
   * than folded into `false`. Without this check the run refuses *itself*: its
   * own state files make the tree dirty and check 9 then names files Agent Flow
   * just wrote.
   */
  async isIgnored(options: RepoContext & { readonly path: string }): Promise<GitResult<boolean>> {
    if (options.path.length === 0 || options.path.startsWith('-')) {
      return gitFailure({
        code: 'git_unsafe_argument',
        message: `"${options.path}" is not a path this tool asks about`,
      });
    }

    const outcome = await this.run({
      subcommand: 'check-ignore',
      cwd: options.cwd,
      timeout: 'quick',
      args: ['-q', '--', options.path],
    });
    if (!outcome.ok) return outcome;

    if (outcome.value.exitCode === 0) return gitOk(true);
    if (outcome.value.exitCode === 1) return gitOk(false);
    return gitFailure(commandFailed(outcome.value, 'git check-ignore'));
  }

  /**
   * The length of the longest path Git tracks here, in characters.
   *
   * §23 projects the worst-case worktree path as *root + repoKey + gitRunKey +
   * taskId + attempt-<n> + **the repository's own deepest tracked path***, so
   * this is the last term. It is a length rather than the path itself because
   * that is all the projection needs, and returning the path would put a
   * repository-relative filename into a refusal message for no gain.
   *
   * `-z`, so a filename containing a newline is one record rather than two —
   * and a repository whose deepest path contains one is exactly the repository
   * that would under-report without it. `--cached` because the question is what
   * a fresh checkout would write, which is the index, not the working tree.
   *
   * `measure` is supplied rather than assumed, because the unit is a platform
   * fact this adapter has no business deciding: `PATH_MAX` bounds bytes on
   * POSIX and UTF-16 units on Windows, and `String.length` is only right for one
   * of them. Zero for a repository that tracks nothing; a truncated listing is
   * refused rather than measured, because a partial answer here is an
   * under-estimate and the check it feeds exists to refuse.
   */
  async deepestTrackedPathLength(
    cwd: string,
    measure: (path: string) => number,
  ): Promise<GitResult<number>> {
    const outcome = await this.run({
      subcommand: 'ls-files',
      cwd,
      timeout: 'read',
      args: ['--cached', '-z'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectParsableSuccess(outcome.value, 'git ls-files');
    if (failed !== null) return failed;

    let deepest = 0;
    for (const path of outcome.value.stdout.split('\0')) {
      const length = measure(path);
      if (length > deepest) deepest = length;
    }
    return gitOk(deepest);
  }

  // -- worktrees ----------------------------------------------------------

  /** The absolute path a location resolves to, proven to be under the root. */
  workspacePath(location: WorkspaceLocation): GitResult<string> {
    return resolveWithinRoot(this.worktreeRoot, location.segments);
  }

  /**
   * `git worktree add --lock --reason … [-b <branch>] -- <path> <base>` (§7.3).
   *
   * Locked in the same command that creates it, because the lock is not
   * concurrency control — the run execution lock is — it is protection against a
   * `git worktree prune` in another terminal reclaiming a workspace an agent is
   * writing into.
   *
   * `-b` in the same command rather than `git branch` followed by `worktree add`:
   * two commands leave a window where the branch exists and nothing is checked
   * out, which after a crash is indistinguishable from a pruned worktree and
   * would need a recovery window of its own.
   */
  async addWorktree(options: AddWorktreeOptions): Promise<GitResult<string>> {
    const path = this.workspacePath(options.location);
    if (!path.ok) return path;

    const base = validRef(options.base);
    if (!base.ok) return base;

    if (options.reason.length === 0) {
      return gitFailure({
        code: 'git_unsafe_argument',
        message: 'a locked worktree must carry a reason, so a person can tell what holds it',
      });
    }

    const branchArgs: string[] = [];
    if (options.branch !== undefined) {
      const branch = validRef(options.branch);
      if (!branch.ok) return branch;
      branchArgs.push('-b', branch.value);
    }

    const outcome = await this.run({
      subcommand: 'worktree',
      cwd: options.cwd,
      timeout: 'checkout',
      args: [
        'add',
        '--lock',
        '--reason',
        options.reason,
        ...branchArgs,
        '--',
        path.value,
        base.value,
      ],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git worktree add');
    if (failed !== null) return failed;

    return gitOk(path.value);
  }

  /**
   * `git worktree remove -- <path>`.
   *
   * Never `rm -rf` (§20.2). A locked worktree is refused by Git with a message
   * naming the lock, and that refusal is passed through rather than forced: the
   * caller unlocks deliberately, or leaves the workspace alone.
   */
  async removeWorktree(
    options: RepoContext & { readonly location: WorkspaceLocation },
  ): Promise<GitResult<void>> {
    const path = this.workspacePath(options.location);
    if (!path.ok) return path;

    const outcome = await this.run({
      subcommand: 'worktree',
      cwd: options.cwd,
      timeout: 'checkout',
      args: ['remove', '--', path.value],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git worktree remove');
    return failed ?? gitOk(undefined);
  }

  /** `git worktree unlock -- <path>`. Exits non-zero when it was not locked. */
  async unlockWorktree(
    options: RepoContext & { readonly location: WorkspaceLocation },
  ): Promise<GitResult<void>> {
    const path = this.workspacePath(options.location);
    if (!path.ok) return path;

    const outcome = await this.run({
      subcommand: 'worktree',
      cwd: options.cwd,
      timeout: 'read',
      args: ['unlock', '--', path.value],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git worktree unlock');
    return failed ?? gitOk(undefined);
  }

  async pruneWorktrees(options: RepoContext): Promise<GitResult<void>> {
    const outcome = await this.run({
      subcommand: 'worktree',
      cwd: options.cwd,
      timeout: 'checkout',
      args: ['prune'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git worktree prune');
    return failed ?? gitOk(undefined);
  }

  /**
   * `git worktree list --porcelain`, parsed.
   *
   * The machine-readable format rather than the aligned human one, which is
   * whitespace-separated and reflows as paths get longer. `-z` would be stronger
   * still and is not used — see {@link MINIMUM_SUPPORTED_GIT_VERSION} for why the
   * floor is worth more than that edge case.
   */
  async listWorktrees(options: RepoContext): Promise<GitResult<readonly WorktreeEntry[]>> {
    const outcome = await this.run({
      subcommand: 'worktree',
      cwd: options.cwd,
      timeout: 'read',
      args: ['list', '--porcelain'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectParsableSuccess(outcome.value, 'git worktree list');
    if (failed !== null) return failed;

    return parseWorktreeList(outcome.value.stdout);
  }

  /**
   * The registered worktrees that really live under Agent Flow's own root.
   *
   * §20.2's rule, as a primitive rather than as a reminder: *a worktree whose
   * registered path is not under `~/.agent-flow/worktrees/` is foreign and MUST
   * be left alone, even if its branch is in the Agent Flow namespace* — a user
   * who moved one made a choice. Branch names are not the filter, because a
   * branch name is a thing anything can create.
   *
   * **Containment is judged on resolved paths, not on the strings Git printed
   * (S-4).** A lexical check is not enough and the counter-example is one
   * `ln -s` long: a symlink at `~/.agent-flow/worktrees/<repoKey>/escape`
   * pointing at `/etc` produces a registered path that is textually inside the
   * root and physically anywhere. Since the only thing this answer is used for
   * is deciding what may be removed, "textually inside" is the wrong question.
   *
   * Three properties, and each is a separate way this could have been wrong:
   *
   *   - the root is canonicalised once, here, rather than trusted from the
   *     constructor — `createGitWorkspaces` resolves it, but a caller could
   *     construct the class directly;
   *   - each entry's path is resolved with `realPath` before it is judged;
   *   - **failure to resolve is not ownership.** A path that does not exist, or
   *     that `realPath` cannot follow, is dropped rather than kept. That is the
   *     fail-closed direction: the cost of wrongly excluding a worktree is a
   *     directory left on disk, and the cost of wrongly including one is a
   *     removal somewhere nobody agreed to.
   */
  async ownWorktrees(options: RepoContext): Promise<GitResult<readonly WorktreeEntry[]>> {
    const listed = await this.listWorktrees(options);
    if (!listed.ok) return listed;

    const root = (await this.fs.realPath(this.worktreeRoot)) ?? null;
    if (root === null) {
      // The root itself is unresolvable — it has not been provisioned, or it was
      // removed underneath us. Reporting "nothing is ours" would be a licence to
      // treat every worktree as foreign, which is safe; reporting a failure says
      // why, and lets a caller tell that apart from "there are none".
      return gitFailure({
        code: 'git_invalid_output',
        message: `the Agent Flow worktree root "${this.worktreeRoot}" could not be resolved`,
      });
    }

    const owned: WorktreeEntry[] = [];
    for (const entry of listed.value) {
      const real = await this.fs.realPath(entry.path);
      if (real === null) continue;
      if (isWithinRoot(root, real)) owned.push({ ...entry, path: real });
    }

    return gitOk(owned);
  }

  // -- working tree -------------------------------------------------------

  /**
   * The cleanliness authority (§8.2): `status --porcelain=v1 -z
   * --untracked-files=all`.
   *
   * `-z` because the newline-separated form cannot represent a rename
   * unambiguously — `R  old -> new` is indistinguishable from a file literally
   * called `old -> new` — and because a path with a newline in it would otherwise
   * be read as two entries. Unlike `worktree list -z`, this one has been in Git
   * far longer than the floor, so it costs nothing.
   */
  async status(options: RepoContext): Promise<GitResult<WorkingTreeStatus>> {
    const outcome = await this.run({
      subcommand: 'status',
      cwd: options.cwd,
      timeout: 'read',
      args: ['--porcelain=v1', '-z', '--untracked-files=all'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectParsableSuccess(outcome.value, 'git status');
    if (failed !== null) return failed;

    return gitOk(parseStatus(outcome.value.stdout));
  }

  /**
   * `git add -A` — stages everything the worktree's `.gitignore` does not exclude.
   *
   * **Named for what it does to the index, deliberately.** `writeTree` below
   * records whatever the index currently holds, so a method that quietly staged
   * on the way in would hide a mutation inside something that reads like a query.
   * The §11.2 sequence is `stageAll` then `writeTree`, in that order, by the
   * caller.
   */
  async stageAll(options: RepoContext): Promise<GitResult<void>> {
    const outcome = await this.run({
      subcommand: 'add',
      cwd: options.cwd,
      timeout: 'write',
      args: ['-A'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git add -A');
    return failed ?? gitOk(undefined);
  }

  /**
   * `git write-tree` — the tree object for the index **as it currently stands**.
   *
   * This reads the index and does not touch it. Callers that mean "the tree of
   * everything in this worktree" must call {@link stageAll} first; that is stated
   * here rather than done here, because the two operations have different failure
   * modes and hiding one inside the other makes only one of them reportable.
   */
  async writeTree(options: RepoContext): Promise<GitResult<string>> {
    const outcome = await this.run({
      subcommand: 'write-tree',
      cwd: options.cwd,
      timeout: 'write',
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git write-tree');
    if (failed !== null) return failed;

    return validOid(outcome.value.stdout.trim(), 'the tree written by git write-tree');
  }

  // -- objects and refs ---------------------------------------------------

  /**
   * `git rev-parse <rev>`, validated as a full object id (§33).
   *
   * Every read that is *used* as an object id goes through here: trimmed, then
   * through `CommitOidSchema`, so an abbreviation, an empty line or a stray
   * warning is a refusal rather than a 7-character string travelling onwards as
   * if it identified a commit.
   */
  async revParse(options: RepoContext & { readonly rev: string }): Promise<GitResult<string>> {
    const rev = validRevision(options.rev);
    if (!rev.ok) return rev;

    const outcome = await this.run({
      subcommand: 'rev-parse',
      cwd: options.cwd,
      timeout: 'quick',
      args: ['--verify', '--end-of-options', rev.value],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, `git rev-parse ${options.rev}`);
    if (failed !== null) return failed;

    return validOid(outcome.value.stdout.trim(), `the id of "${options.rev}"`);
  }

  /** `git rev-parse <commit>^{tree}` — the structural tree identity of I-6. */
  async revParseTree(
    options: RepoContext & { readonly commit: string },
  ): Promise<GitResult<string>> {
    return this.revParse({ cwd: options.cwd, rev: `${options.commit}^{tree}` });
  }

  /**
   * `git cat-file -e <oid>` — does this object exist here.
   *
   * **Without a peel suffix, and that is load-bearing.** Probed on 2.52.0:
   * `cat-file -e <missing>` exits **1**, while `cat-file -e <missing>^{commit}`
   * exits **128**, because the peel fails during revision parsing before
   * `cat-file` ever runs. Asking with the suffix therefore makes "absent" and
   * "this repository is broken" the same answer — which §32 forbids. Existence
   * and type are two questions, so they are two methods.
   */
  async objectExists(options: RepoContext & { readonly oid: string }): Promise<GitResult<boolean>> {
    const oid = validOid(options.oid, 'the object id to check');
    if (!oid.ok) return oid;

    const outcome = await this.run({
      subcommand: 'cat-file',
      cwd: options.cwd,
      timeout: 'quick',
      args: ['-e', oid.value],
    });
    if (!outcome.ok) return outcome;

    if (outcome.value.exitCode === 0) return gitOk(true);
    if (outcome.value.exitCode === 1) return gitOk(false);

    return gitFailure(commandFailed(outcome.value, 'git cat-file -e'));
  }

  /** `git cat-file -t <oid>` — the type, or `null` when the object is absent. */
  async objectType(
    options: RepoContext & { readonly oid: string },
  ): Promise<GitResult<GitObjectType | null>> {
    const exists = await this.objectExists(options);
    if (!exists.ok) return exists;
    if (!exists.value) return gitOk(null);

    const outcome = await this.run({
      subcommand: 'cat-file',
      cwd: options.cwd,
      timeout: 'quick',
      args: ['-t', options.oid],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git cat-file -t');
    if (failed !== null) return failed;

    const type = outcome.value.stdout.trim();
    if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
      return gitFailure({
        code: 'git_invalid_output',
        message: `git cat-file -t reported an unknown object type "${type}"`,
      });
    }
    return gitOk(type);
  }

  /** Whether `oid` exists here **and** is of the expected type. */
  async objectExistsAs(
    options: RepoContext & { readonly oid: string; readonly type: GitObjectType },
  ): Promise<GitResult<boolean>> {
    const type = await this.objectType(options);
    if (!type.ok) return type;
    return gitOk(type.value === options.type);
  }

  /**
   * `git commit-tree <tree> [-p <parent>…] -m <message>` (§12.1).
   *
   * **Never `git commit`.** That reads a checked-out worktree's index, runs
   * hooks, and would make the commit a function of whatever the index held at
   * that instant rather than of the tree it was handed. `--allow-empty` is not
   * used and is not needed: `commit-tree` has no emptiness check, so a commit
   * whose tree equals its parent's is representable — which a task that validated
   * without changing a file requires.
   *
   * Identity and both dates are explicit parameters rather than defaults, because
   * that is what makes the result reproducible: given the same artifact, re-running
   * this yields the *same SHA*, Git stores it once, and the update that follows
   * becomes idempotent for free (§12.2, §17.4). Probed — two invocations with the
   * same inputs produce one object id.
   *
   * The message is passed as the value of `-m`, so a message beginning with `-`
   * is an operand and never an option.
   */
  async commitTree(options: CommitTreeOptions): Promise<GitResult<string>> {
    const tree = validOid(options.tree, 'the tree to commit');
    if (!tree.ok) return tree;

    const parents: string[] = [];
    for (const parent of options.parents) {
      const checked = validOid(parent, 'a parent commit');
      if (!checked.ok) return checked;
      parents.push('-p', checked.value);
    }

    if (options.message.length === 0) {
      return gitFailure({
        code: 'git_unsafe_argument',
        message: 'a commit message must not be empty',
      });
    }

    const outcome = await this.run({
      subcommand: 'commit-tree',
      cwd: options.cwd,
      timeout: 'write',
      args: [tree.value, ...parents, '-m', options.message],
      identity: options.identity,
      dates: options.dates,
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git commit-tree');
    if (failed !== null) return failed;

    return validOid(outcome.value.stdout.trim(), 'the commit created by git commit-tree');
  }

  /**
   * `git update-ref -- <ref> <new> [<expected old>]`.
   *
   * `update-ref` rather than `git branch`, so the operation is one reference
   * transaction with no working-tree implications (§12.1).
   *
   * `expectedOldOid` is compare-and-swap, and it is offered here so the
   * milestones above can avoid a blind overwrite before they need to think about
   * it. {@link ABSENT_OID} means "must not exist yet" — probed: creating an
   * already-existing ref that way fails rather than silently moving it.
   */
  async updateRef(options: UpdateRefOptions): Promise<GitResult<void>> {
    const ref = validRef(options.ref);
    if (!ref.ok) return ref;

    const newOid = validOid(options.newOid, 'the new value of the ref');
    if (!newOid.ok) return newOid;

    const expected: string[] = [];
    if (options.expectedOldOid !== undefined) {
      const old = validOid(options.expectedOldOid, 'the expected current value of the ref');
      if (!old.ok) return old;
      expected.push(old.value);
    }

    const outcome = await this.run({
      subcommand: 'update-ref',
      cwd: options.cwd,
      timeout: 'write',
      args: ['--', ref.value, newOid.value, ...expected],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git update-ref');
    return failed ?? gitOk(undefined);
  }

  /**
   * Every ref under a namespace prefix:
   * `git for-each-ref --format='%(objectname) %(refname)' -- <prefix>`.
   *
   * **A prefix, deliberately not a glob.** The obvious spelling —
   * `refs/heads/agent-flow/<gitRunKey>/*` — is wrong, and wrong in the direction
   * that looks right: probed on Git 2.52.0, `*` matches a single path component,
   * so that pattern returns `…/integration` and silently omits every
   * `…/<taskId>/attempt-<n>`. A namespace-collision check built on it (§5.3 case
   * C) would have reported an empty namespace while attempt refs sat in it. A
   * bare prefix matches everything beneath, recursively, which is the question
   * being asked.
   *
   * Refusing the glob rather than translating it also closes S-6 by shape: there
   * is no free-form ref query here, so nothing a model, a plan or an HTTP request
   * supplied can reach this argument. Filtering happens in TypeScript over the
   * returned list, never in a shell pipeline (S-8).
   */
  async refsUnder(
    options: RepoContext & { readonly prefix: string },
  ): Promise<GitResult<readonly RefEntry[]>> {
    const prefix = validRef(options.prefix);
    if (!prefix.ok) return prefix;

    const outcome = await this.run({
      subcommand: 'for-each-ref',
      cwd: options.cwd,
      timeout: 'quick',
      args: ['--format=%(objectname) %(refname)', '--', prefix.value],
    });
    if (!outcome.ok) return outcome;

    const failed = expectParsableSuccess(outcome.value, 'git for-each-ref');
    if (failed !== null) return failed;

    const entries: RefEntry[] = [];
    for (const line of outcome.value.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const [oid, ref] = line.split(' ', 2);
      if (oid === undefined || ref === undefined || !CommitOidSchema.safeParse(oid).success) {
        return gitFailure({
          code: 'git_invalid_output',
          message: `git for-each-ref produced a line this code cannot read: "${line}"`,
        });
      }
      entries.push({ oid, ref });
    }

    return gitOk(entries);
  }

  /**
   * `git merge-base --is-ancestor -- <ancestor> <descendant>` (§31).
   *
   * Exit 0 is true and exit 1 is false; **anything else is an error**, and
   * probing confirms the distinction is real — a bogus id exits 128, not 1.
   * Collapsing 128 into `false` would report "this marker has not been merged
   * yet" for a repository that cannot answer the question, and the caller would
   * merge again.
   */
  async isAncestor(
    options: RepoContext & { readonly ancestor: string; readonly descendant: string },
  ): Promise<GitResult<boolean>> {
    const ancestor = validRevision(options.ancestor);
    if (!ancestor.ok) return ancestor;
    const descendant = validRevision(options.descendant);
    if (!descendant.ok) return descendant;

    const outcome = await this.run({
      subcommand: 'merge-base',
      cwd: options.cwd,
      timeout: 'quick',
      args: ['--is-ancestor', '--', ancestor.value, descendant.value],
    });
    if (!outcome.ok) return outcome;

    if (outcome.value.exitCode === 0) return gitOk(true);
    if (outcome.value.exitCode === 1) return gitOk(false);

    return gitFailure(commandFailed(outcome.value, 'git merge-base --is-ancestor'));
  }

  /**
   * `git merge --no-ff --no-edit -m <message> -- <commit>` (§14.5), hooks isolated.
   *
   * `--no-ff` always, including where a fast-forward is possible: otherwise the
   * shape of the integration branch would depend on how many tasks were in a
   * wave, and "was this integrated" would sometimes be answered by a merge commit
   * and sometimes by ancestry alone.
   *
   * A conflict is an outcome, not a failure — exit 1, probed — and it is returned
   * with the unmerged paths already read out of the index, because those paths
   * are usually the actual answer to "why did this conflict" and the worktree is
   * about to be aborted out from under them.
   */
  async merge(options: MergeOptions): Promise<GitResult<MergeOutcome>> {
    const commit = validRevision(options.commit);
    if (!commit.ok) return commit;

    if (options.message.length === 0) {
      return gitFailure({
        code: 'git_unsafe_argument',
        message: 'a merge message must not be empty',
      });
    }

    const outcome = await this.run({
      subcommand: 'merge',
      cwd: options.cwd,
      timeout: 'checkout',
      args: ['--no-ff', '--no-edit', '-m', options.message, '--', commit.value],
      identity: options.identity,
      dates: options.dates,
    });
    if (!outcome.ok) return outcome;

    if (outcome.value.exitCode === 0) {
      return gitOk({ kind: 'merged', stdout: outcome.value.stdout });
    }

    if (outcome.value.exitCode === 1) {
      const paths = await this.unmergedPaths(options);
      if (!paths.ok) return paths;
      return gitOk({ kind: 'conflict', paths: paths.value });
    }

    return gitFailure(commandFailed(outcome.value, 'git merge'));
  }

  /** `git diff --name-only --diff-filter=U` — the conflicting paths (§15). */
  async unmergedPaths(options: RepoContext): Promise<GitResult<readonly string[]>> {
    const outcome = await this.run({
      subcommand: 'diff',
      cwd: options.cwd,
      timeout: 'read',
      args: ['--name-only', '--diff-filter=U', '-z'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectParsableSuccess(outcome.value, 'git diff --diff-filter=U');
    if (failed !== null) return failed;

    return gitOk(outcome.value.stdout.split('\0').filter((path) => path.length > 0));
  }

  /**
   * `git merge --abort` — back to the last consistent state (§17.4).
   *
   * Exits non-zero when there is no merge to abort, which is passed through
   * rather than swallowed: recovery distinguishes "there was a merge and it is
   * now undone" from "there was never one", and a method that reported both as
   * success would make window 6 of §17.3 undetectable.
   */
  async abortMerge(options: RepoContext): Promise<GitResult<void>> {
    const outcome = await this.run({
      subcommand: 'merge',
      cwd: options.cwd,
      timeout: 'checkout',
      args: ['--abort'],
    });
    if (!outcome.ok) return outcome;

    const failed = expectSuccess(outcome.value, 'git merge --abort');
    return failed ?? gitOk(undefined);
  }

  // -- plumbing -----------------------------------------------------------

  private async run(options: {
    subcommand: Parameters<GitCommand['run']>[0]['subcommand'];
    cwd: string;
    timeout: keyof typeof GIT_TIMEOUT_SECONDS;
    args?: readonly string[];
    identity?: GitIdentity;
    dates?: GitDates;
  }): Promise<GitResult<GitOutcome>> {
    return this.git.run({
      subcommand: options.subcommand,
      cwd: options.cwd,
      timeoutSeconds: GIT_TIMEOUT_SECONDS[options.timeout],
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      ...(options.dates === undefined ? {} : { dates: options.dates }),
    });
  }
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

function commandFailed(outcome: GitOutcome, what: string) {
  return {
    code: 'git_command_failed' as const,
    message: `${what} exited ${String(outcome.exitCode)}: ${outcome.stderr.trim() || '(no stderr)'}`,
    exitCode: outcome.exitCode,
    stderr: outcome.stderr,
  };
}

/** Returns a refusal when the command did not exit 0, and null when it did. */
function expectSuccess(outcome: GitOutcome, what: string): GitRefusal | null {
  return outcome.exitCode === 0 ? null : gitFailure(commandFailed(outcome, what));
}

/**
 * As {@link expectSuccess}, plus §37: truncated output is an incomplete result,
 * never a partial truth.
 *
 * Used by every operation that parses stdout. A `worktree list` cut off halfway
 * would report a subset of the registered worktrees, and a caller deciding what
 * to remove from that subset would be deciding from a fact that is not one.
 */
function expectParsableSuccess(outcome: GitOutcome, what: string): GitRefusal | null {
  const failed = expectSuccess(outcome, what);
  if (failed !== null) return failed;

  if (outcome.truncated) {
    return gitFailure({
      code: 'git_output_truncated',
      message: `${what} produced more output than could be read, so it cannot be parsed`,
    });
  }

  return null;
}

/**
 * A revision this adapter will place on a command line: a ref name, an object id,
 * or either with a `^{tree}` / `^{commit}` peel.
 *
 * Narrower than what Git accepts, deliberately — `@{upstream}`, `HEAD@{2}` and
 * `:/text` are all legal revisions and none of them is something MVP 2 composes.
 * `HEAD` is admitted because reading it is how `planningBase` is captured.
 */
const SAFE_REVISION = /^(?:[A-Za-z0-9][A-Za-z0-9._\-/]*)(?:\^\{(?:tree|commit)\})?$/;

function validRevision(revision: string): GitResult<string> {
  // The same hostile-sequence list `validRef` applies, rather than a shorter one
  // written from memory. They had drifted: a revision ending in `.lock` or `/`
  // passed here and was refused by Git instead, which turned a rejection this
  // layer should own into a `git_command_failed` from the other side of a spawn.
  if (!SAFE_REVISION.test(revision) || REF_HOSTILE.test(revision)) {
    return gitFailure({
      code: 'git_unsafe_argument',
      message: `"${revision}" is not a revision this tool composes`,
    });
  }
  return gitOk(revision);
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * `git worktree list --porcelain` — blank-line-separated records of
 * `<attribute> [value]` lines.
 *
 * Only the attributes MVP 2 acts on are modelled. An unknown attribute is
 * ignored rather than rejected: Git adds them over time, and a parser that
 * refused an entry because a newer Git mentioned something it had not heard of
 * would make an upgrade look like a corrupt repository.
 *
 * **The framing check is the important part, and it is there because of a probe
 * rather than a hunch.** Without `-z` the format cannot represent a path
 * containing a newline, and Git does not escape one — it prints the bytes. So a
 * worktree registered at a path whose name contains
 * `"\nworktree /somewhere/else"` produces output in which a *second* record
 * appears inside the first one's block:
 *
 * ```text
 * worktree /tmp/inj            ← the real path, truncated at the newline
 * worktree /tmp/injected       ← a record Git never emitted
 * HEAD 0000000000000000000000000000000000000000
 * HEAD 12500d21…               ← the real one
 * branch refs/heads/hostile2
 * ```
 *
 * A parser that started a new record on the second `worktree` line — which the
 * obvious one does, and this one did — would hand its caller a registered
 * worktree that does not exist, at a path an attacker chose. Downstream that is
 * a path handed to `git worktree remove`.
 *
 * It is detectable, because Git separates records with a blank line and never
 * emits two `worktree` lines inside one: a second one **is** the signature of a
 * forged frame. So it fails the whole listing rather than any part of it, which
 * is the fail-closed direction — cleanup that cannot read the registry does
 * nothing, and cleanup that reads a forged registry removes the wrong thing.
 *
 * What this cannot detect is the plain case: a path containing a newline and
 * nothing that looks like an attribute simply arrives truncated. That is closed
 * one layer up instead — {@link GitWorkspaces.ownWorktrees} resolves every path
 * with `realPath` and drops what does not resolve, and a truncated path does not
 * name a directory that exists. The two together are why the floor stays at
 * 2.33.0 rather than moving to 2.36.0 for `-z`; see
 * {@link MINIMUM_SUPPORTED_GIT_VERSION}.
 */
export function parseWorktreeList(stdout: string): GitResult<readonly WorktreeEntry[]> {
  const entries: WorktreeEntry[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string;
    detached?: boolean;
    bare?: boolean;
    locked?: boolean;
    lockReason?: string;
    prunable?: boolean;
  } | null = null;

  const flush = (): void => {
    if (current?.path === undefined) return;
    entries.push({
      path: current.path,
      ...(current.head === undefined ? {} : { head: current.head }),
      ...(current.branch === undefined ? {} : { branch: current.branch }),
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      locked: current.locked ?? false,
      ...(current.lockReason === undefined ? {} : { lockReason: current.lockReason }),
      prunable: current.prunable ?? false,
    });
    current = null;
  };

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) {
      flush();
      continue;
    }

    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);

    if (key === 'worktree') {
      // Inside an open block this is not a new record — it is a forged frame,
      // because Git ends every record with a blank line before starting the
      // next. See the note above; probed on Git 2.52.0.
      if (current !== null) {
        return gitFailure({
          code: 'git_invalid_output',
          message:
            'git worktree list produced a record inside another record, which means a ' +
            'registered worktree path contains a newline; the listing cannot be trusted',
        });
      }
      current = { path: value };
      continue;
    }
    if (current === null) continue;

    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') {
      current.locked = true;
      if (value.length > 0) current.lockReason = value;
    } else if (key === 'prunable') current.prunable = true;
  }

  flush();
  return gitOk(entries);
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * NUL-separated records of `XY <path>`; a rename or copy is followed by a second
 * NUL-terminated field holding the original path — probed: `RM h.txt\0f.txt\0`.
 * That second field is why this is parsed rather than split on lines: with the
 * newline format, a file called `a -> b` and a rename from `a` to `b` are the
 * same bytes.
 */
export function parseStatus(stdout: string): WorkingTreeStatus {
  const fields = stdout.split('\0');
  const entries: StatusEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length < 4) continue;

    const codes = field.slice(0, 2);
    const path = field.slice(3);
    const indexStatus = codes[0] ?? ' ';
    const worktreeStatus = codes[1] ?? ' ';

    // A rename or copy carries its source in the next field, which must be
    // consumed here or it would be read as an entry with a two-character status.
    let originalPath: string | undefined;
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      index += 1;
      originalPath = fields[index];
    }

    entries.push({
      index: indexStatus,
      worktree: worktreeStatus,
      path,
      ...(originalPath === undefined ? {} : { originalPath }),
    });
  }

  const untracked = entries.filter((entry) => entry.index === '?').map((entry) => entry.path);
  const staged = entries
    .filter((entry) => entry.index !== ' ' && entry.index !== '?')
    .map((entry) => entry.path);
  const unstaged = entries
    .filter((entry) => entry.worktree !== ' ' && entry.worktree !== '?')
    .map((entry) => entry.path);

  return { clean: entries.length === 0, entries, staged, unstaged, untracked };
}

export interface CreateGitWorkspacesDeps {
  readonly git: GitCommand;
  readonly fs: FileSystem;
  /** From the `Host` port. Never `process.env.HOME` (§7.1). */
  readonly homeDir: string;
}

/**
 * Builds a `GitWorkspaces` whose root exists and is canonical.
 *
 * Constructing the class directly is possible and takes whatever root it is
 * given — which is how the `doctor` probe ended up holding an *unresolved* one,
 * a bug this factory exists to make unrepresentable at every call site that uses
 * it. Canonical matters because `git worktree list` reports resolved paths, and
 * on macOS the temporary directories the tests run under sit behind
 * `/var` → `/private/var`.
 */
export async function createGitWorkspaces(
  deps: CreateGitWorkspacesDeps,
): Promise<GitWorkspaces> {
  const home = await provisionGitHome(deps.fs, deps.homeDir);
  return new GitWorkspaces({ git: deps.git, fs: deps.fs, worktreeRoot: home.worktrees });
}
