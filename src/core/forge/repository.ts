import { ForgeRepositorySchema, type ForgeRepository } from '../../contracts/index.js';

/**
 * Which repository a remote URL names (M7 §7, §25).
 *
 * **Mechanical, and pure.** Three spellings of one repository —
 *
 * ```text
 * https://github.com/owner/repo.git
 * git@github.com:owner/repo.git
 * ssh://git@github.com/owner/repo.git
 * ```
 *
 * — collapse to the same three fields, so "is this the repository we were configured for"
 * is answered by comparison rather than by matching strings a human typed two different
 * ways. No model is asked, and nothing here reaches a shell or a network.
 *
 * `undefined` for anything it does not recognise, which the caller must treat as "refuse a
 * mutation" rather than as "probably fine". A URL this cannot parse is a URL nobody should
 * be pushing to on the strength of a guess.
 */
export function parseRepositoryUrl(url: string): ForgeRepository | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2_000) return undefined;

  // **A dot segment is refused before anything normalises it away.** `URL` resolves
  // `https://github.com/../etc/passwd` to the path `/etc/passwd`, which then reads as a
  // perfectly ordinary `owner/repo` — so the identity returned would be a repository
  // nobody wrote down. Not a filesystem traversal; a URL silently meaning a different
  // repository than it says, which is the thing this function exists to prevent.
  if (/(^|[/:])\.{1,2}([/]|$)/.test(trimmed)) return undefined;

  const parts = scpLike(trimmed) ?? urlLike(trimmed);
  if (parts === undefined) return undefined;

  // The schema is the validator, not the regexes below: an owner or a name that would be a
  // path traversal, a flag or an empty string fails here rather than reaching a caller.
  const parsed = ForgeRepositorySchema.safeParse({
    host: parts.host.toLowerCase(),
    owner: parts.owner,
    repo: parts.repo.replace(/\.git$/, ''),
  });

  return parsed.success ? parsed.data : undefined;
}

/**
 * `git@github.com:owner/repo.git`, the form Git invented and no URL parser accepts.
 *
 * Anchored end to end. A pattern that merely *found* `owner/repo` somewhere in the string
 * would happily read `git@evil.example:x/y#github.com/o/r` as GitHub.
 */
function scpLike(url: string): { host: string; owner: string; repo: string } | undefined {
  const match = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(
    url,
  );
  if (match === null) return undefined;

  const [, host, owner, repo] = match;
  if (host === undefined || owner === undefined || repo === undefined) return undefined;
  return { host, owner, repo };
}

/**
 * Anything `URL` understands, restricted to the schemes Git actually uses for a remote.
 *
 * **`file:` and `ftp:` are refused rather than parsed.** They are legal Git remotes and
 * they are not a forge, and a caller that accepted one would be deciding that a local
 * directory has an owner and a repository name.
 */
function urlLike(url: string): { host: string; owner: string; repo: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined;

  // Exactly two segments. A repository under a group of groups is not GitHub, and guessing
  // which two of three segments are the owner and the name is how the wrong repository gets
  // written to.
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2) return undefined;

  const [owner, repo] = segments;
  if (owner === undefined || repo === undefined) return undefined;
  return { host: parsed.hostname, owner, repo };
}

/** Whether two repositories are the same one. Field by field, never by string. */
export function sameRepository(a: ForgeRepository, b: ForgeRepository): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}
