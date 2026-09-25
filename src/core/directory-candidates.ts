/**
 * The directories whose own instructions a task should receive (N1, FR-003).
 *
 * A task's `files.likely` names what it expects to touch; the rules that bind those files
 * live in the `AGENTS.md` or `CLAUDE.md` of every directory above them. The runner's
 * isolation flags stop the CLI from loading those itself — measured 24/09/2026: a
 * `sub/CLAUDE.md` rule was obeyed without the flags and ignored with them — so the
 * orchestrator has to name the directories, and this is where they are named.
 *
 * Pure, and it touches no filesystem: whether an entry without a trailing `/` is a
 * directory is a fact about a machine, so the caller looks and passes the entries it
 * found to be directories.
 *
 * **The repository root is never a candidate.** Its instructions already reach every stage
 * through the root readers, and a second copy here would hand a stage the same rule twice.
 */

/** Characters that make a segment a pattern rather than a name. */
const WILDCARD = /[*?[]/;

/**
 * Whether `entry` is one this derivation will look at at all.
 *
 * An absolute path, a drive letter, a `..`, a backslash or an empty string names
 * something that is not a repository-relative path — and a candidate derived from one
 * would send the reader outside the tree it was asked about. Refused whole rather than
 * repaired, because a repair is a guess about what a planner meant.
 */
function usable(entry: string): boolean {
  return (
    entry.length > 0 &&
    !entry.startsWith('/') &&
    !/^[A-Za-z]:/.test(entry) &&
    !entry.includes('\\') &&
    !entry.includes('..')
  );
}

/**
 * The segments of `entry` that name directories, root first.
 *
 * `.` and empty segments (`./a`, `a//b`) are dropped rather than refused: they name no
 * directory of their own, and keeping `.` would make the repository root a candidate.
 */
function directorySegments(entry: string, existingDirectories: ReadonlySet<string>): string[] {
  const segments = entry.split('/').filter((segment) => segment !== '' && segment !== '.');

  const wildcard = segments.findIndex((segment) => WILDCARD.test(segment));
  if (wildcard !== -1) return segments.slice(0, wildcard);

  const namesDirectory = entry.endsWith('/') || existingDirectories.has(entry);
  return namesDirectory ? segments : segments.slice(0, -1);
}

/**
 * Whether the caller should ask the filesystem if `entry` is a directory.
 *
 * Only an entry whose answer changes the result: usable, no wildcard, and not already
 * marked a directory by its trailing `/`. Exported so the caller stats exactly these and
 * never a path this module would have refused.
 */
export function mayNameDirectory(entry: string): boolean {
  return usable(entry) && !entry.endsWith('/') && !WILDCARD.test(entry);
}

/**
 * Every candidate directory, deduplicated, ordered by depth and then by ordinal path.
 *
 * Depth first so a directory's rules precede those of the directories inside it — the
 * order a person reads a monorepo in. Ordinal rather than locale comparison, so the order
 * of a prompt does not depend on the machine that built it.
 */
export function directoryCandidates(
  likely: readonly string[],
  existingDirectories: readonly string[] = [],
): readonly string[] {
  const directories = new Set(existingDirectories);
  const found = new Set<string>();

  for (const entry of likely) {
    if (!usable(entry)) continue;
    const segments = directorySegments(entry, directories);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      found.add(segments.slice(0, depth).join('/'));
    }
  }

  return [...found].sort((left, right) => {
    const byDepth = left.split('/').length - right.split('/').length;
    if (byDepth !== 0) return byDepth;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
