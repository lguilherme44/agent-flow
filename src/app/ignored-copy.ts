import nodePath from 'node:path';
import type { GitErrorCode } from '../adapters/git/git-command.js';
import type { GitWorkspaces } from '../adapters/git/git-workspaces.js';
import { isAtOrUnderRoot } from '../core/path-containment.js';
import type { FileSystem } from '../ports/file-system.js';

/**
 * The ignored files an operator declared, carried from their checkout into a fresh tree (N2).
 *
 * `git worktree add` checks out tracked content only, so a test that reads an ignored
 * `.env.test` failed in every attempt for a reason that had nothing to do with the change.
 * This puts the declared files back: listed by Git's own `:(glob)` semantics
 * (`GitWorkspaces.listIgnoredFiles`), copied byte for byte, and then proven still ignored
 * where they landed.
 *
 * **Every check runs before anything is written** (FR-015). A listed source that a symlink
 * carries outside `from`, and a destination that is already there, each refuse the whole
 * copy — and because every source and destination is judged first, neither refusal leaves
 * a half-populated tree behind it. Checking inside the copy loop would have written the
 * files that came before the bad one, into a worktree that is retained (§7.4) and read.
 *
 * **Then each destination must be ignored in `to`** (SEC-005, FR-019). The ignore rules
 * that made the file ignorable were read in `from`, and nothing guarantees `to` has them: a
 * rule in an untracked `.gitignore` of the operator's checkout, or in a `.gitignore` the
 * attempt's base predates, is not in the worktree. There the copied file is untracked and
 * *not* ignored, and `stageAll`'s `add -A` would commit it. So the answer is asked of Git
 * in `to`, after the copy, where it is the one that decides what enters a commit.
 *
 * **A refusal carries a code and a count, never a path.** The caller persists it, and the
 * listed paths are the operator's ignored file names — `.env.production` is itself worth
 * not publishing — and every absolute path names this machine (§21.3, SEC-008).
 */

export type IgnoredCopyCode =
  /** `ls-files` failed or was refused; `git` names why. */
  | 'list_failed'
  /** A source, or `from` itself, could not be resolved, so containment cannot be decided. */
  | 'source_unresolvable'
  /** A listed source resolves outside `from` (SEC-006). */
  | 'source_outside'
  /** Something already occupies a destination, and it is not overwritten (SEC-006). */
  | 'destination_exists'
  /** Creating a directory or copying a file threw. */
  | 'copy_failed'
  /** `check-ignore` in `to` failed; `git` names why. */
  | 'ignore_check_failed'
  /** A copied file is not ignored in `to`, so a commit would take it (SEC-005). */
  | 'not_ignored';

/** The two refusals a Git failure is behind, and which that failure was. */
type GitBackedCode = Extract<IgnoredCopyCode, 'list_failed' | 'ignore_check_failed'>;

export type IgnoredCopyFailure = {
  readonly ok: false;
  /** How many files were copied before the refusal. Zero for every pre-copy check. */
  readonly count: number;
} & (
  | { readonly code: GitBackedCode; readonly git: GitErrorCode }
  | { readonly code: Exclude<IgnoredCopyCode, GitBackedCode> }
);

export type IgnoredCopyOutcome = { readonly ok: true; readonly count: number } | IgnoredCopyFailure;

export interface IgnoredCopyDeps {
  readonly fs: FileSystem;
  readonly workspaces: Pick<GitWorkspaces, 'listIgnoredFiles' | 'isIgnored'>;
}

export interface IgnoredCopyRequest {
  /** The checkout the files are read from. Absolute. */
  readonly from: string;
  /** The tree they are copied into. Absolute. */
  readonly to: string;
  /** `worktree.copy`, already validated by the config schema (FR-013). */
  readonly patterns: readonly string[];
}

export async function copyIgnoredFiles(
  deps: IgnoredCopyDeps,
  request: IgnoredCopyRequest,
): Promise<IgnoredCopyOutcome> {
  // No patterns, no Git call (FR-020). The adapter would answer `[]` without spawning too,
  // but this is the promise the caller's "no key, no cost" rests on, so it is kept here.
  if (request.patterns.length === 0) return { ok: true, count: 0 };

  const listed = await deps.workspaces.listIgnoredFiles({ cwd: request.from, patterns: request.patterns });
  if (!listed.ok) return { ok: false, code: 'list_failed', count: 0, git: listed.failure.code };
  // A pattern that matches nothing is a declaration that does not apply today (FR-016).
  if (listed.value.length === 0) return { ok: true, count: 0 };

  const root = await resolveQuietly(deps.fs, request.from);
  if (root === null) return { ok: false, code: 'source_unresolvable', count: 0 };

  for (const path of listed.value) {
    const resolved = await resolveQuietly(deps.fs, `${request.from}/${path}`);
    if (resolved === null) return { ok: false, code: 'source_unresolvable', count: 0 };
    // The root itself is outside too: a link to the checkout is a directory, not a file
    // anybody declared.
    if (resolved === root || !isAtOrUnderRoot(root, resolved, nodePath)) {
      return { ok: false, code: 'source_outside', count: 0 };
    }

    let occupied: boolean;
    try {
      occupied = await deps.fs.exists(`${request.to}/${path}`);
    } catch {
      return { ok: false, code: 'copy_failed', count: 0 };
    }
    if (occupied) return { ok: false, code: 'destination_exists', count: 0 };
  }

  let count = 0;
  for (const path of listed.value) {
    const destination = `${request.to}/${path}`;
    const parent = destination.slice(0, destination.lastIndexOf('/'));
    try {
      await deps.fs.mkdirp(parent);
      // Byte for byte, through the port's own copy: `readFile` and `writeFileAtomic` are
      // string members, and a round trip through them would rewrite a CRLF `.env.test`.
      await deps.fs.copyFile(`${request.from}/${path}`, destination);
    } catch {
      return { ok: false, code: 'copy_failed', count };
    }
    count += 1;
  }

  for (const path of listed.value) {
    const ignored = await deps.workspaces.isIgnored({ cwd: request.to, path });
    if (!ignored.ok) return { ok: false, code: 'ignore_check_failed', count, git: ignored.failure.code };
    if (!ignored.value) return { ok: false, code: 'not_ignored', count };
  }

  return { ok: true, count };
}

/**
 * A sentence for the refusal, from the code and the count alone (FR-016).
 *
 * Here beside the codes rather than at the caller, so the one place that could put a path
 * into a persisted string has no path in scope to put there.
 */
export function describeIgnoredCopyFailure(failure: IgnoredCopyFailure): string {
  const copied = `${String(failure.count)} ${failure.count === 1 ? 'file' : 'files'} copied before it`;
  switch (failure.code) {
    case 'list_failed':
      return `the declared ignored files could not be listed (${failure.git})`;
    case 'source_unresolvable':
      return 'a declared ignored file could not be resolved, so it was not copied';
    case 'source_outside':
      return 'a declared ignored file resolves outside the repository, so nothing was copied';
    case 'destination_exists':
      return 'a declared ignored file already exists in the workspace, so nothing was copied';
    case 'copy_failed':
      return `a declared ignored file could not be copied (${copied})`;
    case 'ignore_check_failed':
      return `a copied file's ignore status could not be checked (${failure.git}, ${copied})`;
    case 'not_ignored':
      return `a copied file is not ignored in the workspace, so a commit would take it (${copied})`;
  }
}

async function resolveQuietly(fs: FileSystem, path: string): Promise<string | null> {
  try {
    return await fs.realPath(path);
  } catch {
    return null;
  }
}
