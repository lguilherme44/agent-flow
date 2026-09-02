/**
 * Whether one path is inside another, decided with the platform's own primitives.
 *
 * **Moved here from `server/project-registry.ts` rather than copied.** It answers a
 * security question — is this resolved path really under the root the operator chose —
 * and a second implementation of it is a second chance to get `/wk` versus `/wknight`
 * wrong. The server has asked it since the workspace registry existed; M4's outbox harvest
 * has to ask it too, about a different root, and `src/app` may not import `src/server`.
 *
 * Pure, and parameterised rather than importing `node:path`, which is what lets it live in
 * the core at all. The flavour is also what makes the Windows rules testable: drive
 * letters, UNC shares, two separators and case-insensitive roots are all facts a test
 * running on Linux could otherwise only assert by not running.
 */

export interface PathFlavour {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  readonly sep: string;
}

/**
 * Whether `path` is `root` **or** sits under it (D-F02).
 *
 * **Named for the root case on purpose**, because `git-workspaces.ts` exports an
 * `isWithinRoot` that answers the opposite there: a worktree must be strictly *under*
 * the Agent Flow worktree root and may never be the root itself. Two functions with one
 * name and two answers about the boundary case is how a security decision becomes a
 * coin toss, so the name says which case it includes.
 *
 * A project *may* be the workspace root the operator pointed the server at, and an outbox
 * may not be the workspace directory itself — but that second question is "is this a
 * file", not "is this contained", and the caller asks it separately.
 *
 * This was `startsWith(`${root}/`)`, which is right on POSIX and wrong everywhere else —
 * `C:\wk` does not contain `C:\wk\api` by that rule, so a Windows workspace discovered
 * nothing at all, and `\\server\share` compared as an ordinary prefix.
 *
 * `relative` answers the question the platform's own way. What comes back is a path *from*
 * the root, so containment is a statement about that path rather than about string
 * prefixes:
 *
 *   - empty means the two are the same directory,
 *   - absolute means there is no route between them — a different drive letter, or a
 *     different UNC share, which is the one case a prefix test cannot express,
 *   - a leading `..` segment means it escapes upwards. `/wk` and `/wknight` produce
 *     `../wknight`, which is exactly why the original needed the separator.
 *
 * Case is not handled here and must not be: `path.win32.relative` already compares Windows
 * roots case-insensitively, and a `toLowerCase()` of our own would be a second, worse
 * answer that also broke case-sensitive Linux filesystems.
 *
 * **Both arguments must already be resolved.** `stat` follows a symlink and reports an
 * ordinary file, so a caller that has not resolved its paths is asking this function a
 * question about strings rather than about the filesystem.
 */
export function isAtOrUnderRoot(root: string, path: string, flavour: PathFlavour): boolean {
  const relative = flavour.relative(root, path);
  if (relative === '') return true;
  if (flavour.isAbsolute(relative)) return false;

  return relative !== '..' && !relative.startsWith(`..${flavour.sep}`);
}
