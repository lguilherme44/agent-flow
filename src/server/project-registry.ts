import nodePath from 'node:path';
import { agentFlowPaths } from '../app/paths.js';
import type { FileSystem } from '../ports/index.js';

/**
 * The set of projects this server will talk about, and the only way to name one.
 *
 * Every read endpoint takes a project *id*, never a path. That is the whole
 * security model for the filesystem (§93): an id is looked up in a table this
 * process built by walking directories the operator pointed it at, so there is
 * no request shape that can address a directory outside it. Validating a
 * client-supplied path instead would mean getting normalisation, symlinks and
 * `..` right on every platform, forever, in every handler.
 */

export interface RegisteredProject {
  readonly id: string;
  readonly name: string;
  /** Absolute, and produced here rather than accepted from anywhere. */
  readonly path: string;
}

export interface DiscoverOptions {
  readonly fs: FileSystem;
  /** Directories to look in. Usually one: the directory `agent-flow ui` ran in. */
  readonly roots: readonly string[];
  /**
   * How deep to look under each root (§65).
   *
   * Bounded, and small by default. An unbounded scan of a home directory is a
   * startup that takes minutes and reads places nobody asked it to.
   */
  readonly depth?: number;
}

export const DEFAULT_WORKSPACE_DEPTH = 2;
/** The deepest a workspace scan may be configured to go. */
export const MAX_WORKSPACE_DEPTH = 6;

/** A directory that looked like a project and was left out anyway. */
export interface SkippedDirectory {
  readonly path: string;
  readonly reason: 'outside_workspace';
  /** Where it really is, which is the part that made it a refusal. */
  readonly resolved: string;
}

export interface DiscoveryResult {
  readonly projects: readonly RegisteredProject[];
  /**
   * Reported rather than logged and forgotten.
   *
   * A workspace of symlinks into repositories elsewhere is a normal way to work,
   * and somebody who arranged one will otherwise see their projects silently
   * absent and conclude the tool is broken.
   */
  readonly skipped: readonly SkippedDirectory[];
}

/** Directories never worth descending into, and expensive to get wrong. */
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'coverage',
]);

/**
 * Finds directories that have been through `agent-flow init`.
 *
 * The marker is `.agent-flow/config.yaml`, the one versioned artifact of a
 * project. A directory holding only a `runs/` folder is a leftover, not a
 * project, and listing it would offer the user something with no configuration
 * to read. A `package.json` is not a marker either: half a machine has one, and
 * a workspace listing every Node directory it can reach is not a control plane.
 *
 * **Nothing outside a root is discovered, however it is reached.** The walk
 * compares resolved paths, so a symlink inside the workspace pointing at a
 * repository elsewhere is skipped and named rather than followed. `stat` cannot
 * catch this — it follows the link and reports an ordinary directory — which is
 * why `realPath` is on the port at all. The rule is deliberately blunt: the
 * operator chose one directory when they started the server, and a link is not
 * that choice being made again.
 *
 * The resolved path is also what makes the walk terminate: a link that points
 * back up its own tree would otherwise be a new path string every time, and only
 * the depth bound would stop it.
 */
export async function discoverProjects(options: DiscoverOptions): Promise<DiscoveryResult> {
  const depth = Math.min(options.depth ?? DEFAULT_WORKSPACE_DEPTH, MAX_WORKSPACE_DEPTH);
  const found: string[] = [];
  const skipped: SkippedDirectory[] = [];
  const seen = new Set<string>();

  const walk = async (dir: string, root: string, remaining: number): Promise<void> => {
    const resolved = await options.fs.realPath(dir);
    if (resolved === null) return;

    if (!within(root, resolved)) {
      skipped.push({ path: dir, reason: 'outside_workspace', resolved });
      return;
    }

    if (seen.has(resolved)) return;
    seen.add(resolved);

    if (await options.fs.exists(nodePath.join(dir, '.agent-flow', 'config.yaml'))) {
      // The resolved path, not the one the walk arrived by. A project reached
      // through a link inside the workspace is the same project, and registering
      // it under the link would give it an id from the link's name — `current`
      // rather than `api` — and a second identity for the same run history.
      found.push(resolved);
      // Still descends: a monorepo can hold initialised sub-projects, and the
      // depth bound is what stops this rather than an early return.
    }

    if (remaining <= 0) return;

    let entries: string[];
    try {
      entries = await options.fs.readDir(dir);
    } catch {
      // An unreadable directory is not an error worth failing startup over.
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP.has(entry)) continue;
      const child = nodePath.join(dir, entry);
      const stat = await options.fs.stat(child);
      if (stat?.isDirectory === true) await walk(child, root, remaining - 1);
    }
  };

  for (const root of options.roots) {
    const start = normalise(root);
    // The root is resolved too, so both sides of every comparison came out of
    // the same function. Comparing a resolved child against a raw root would
    // reject an entire workspace reached through a symlinked home directory.
    const resolvedRoot = (await options.fs.realPath(start)) ?? start;
    await walk(start, resolvedRoot, depth);
  }

  return { projects: assignIds(found.sort()), skipped };
}

/**
 * The path primitives containment is decided with.
 *
 * A parameter because the rules differ by platform in ways that cannot be tested on
 * one: drive letters, UNC shares, two separators and case-insensitive roots are all
 * Windows facts, and a test that could only assert them by running on Windows would
 * never be run. Production passes `node:path`; the tests pass `path.posix` and
 * `path.win32` explicitly.
 */
export interface PathFlavour {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  readonly sep: string;
}

/**
 * Whether `path` is the root or sits under it (D-F02).
 *
 * This was `startsWith(`${root}/`)`, which is right on POSIX and wrong everywhere
 * else — `C:\wk` does not contain `C:\wk\api` by that rule, so a Windows workspace
 * discovered nothing at all, and `\\server\share` compared as an ordinary prefix.
 *
 * `relative` answers the question the platform's own way. What comes back is a path
 * *from* the root, so containment is a statement about that path rather than about
 * string prefixes:
 *
 *   - empty means the two are the same directory,
 *   - absolute means there is no route between them — a different drive letter, or
 *     a different UNC share, which is the one case a prefix test cannot express,
 *   - a leading `..` segment means it escapes upwards. `/wk` and `/wknight` produce
 *     `../wknight`, which is exactly why the original needed the separator.
 *
 * Case is not handled here and must not be: `path.win32.relative` already compares
 * Windows roots case-insensitively, and a `toLowerCase()` of our own would be a
 * second, worse answer that also broke case-sensitive Linux filesystems.
 */
function within(root: string, path: string, flavour: PathFlavour = nodePath): boolean {
  const relative = flavour.relative(root, path);
  if (relative === '') return true;
  if (flavour.isAbsolute(relative)) return false;

  return relative !== '..' && !relative.startsWith(`..${flavour.sep}`);
}

/** Exported for the cross-platform tests; production always uses `node:path`. */
export { within as isWithinWorkspace };

/**
 * Builds a registry from an explicit list, for a single-project server.
 */
export function registryOf(projects: readonly RegisteredProject[]): ProjectRegistry {
  const byId = new Map(projects.map((project) => [project.id, project]));

  return {
    all: () => [...projects],
    get: (id) => byId.get(id),
    /** The first registered project — what a single-project UI defaults to. */
    primary: () => projects[0],
  };
}

export interface ProjectRegistry {
  all(): RegisteredProject[];
  get(id: string): RegisteredProject | undefined;
  primary(): RegisteredProject | undefined;
}

/**
 * Slugs the directory name, and disambiguates collisions rather than merging
 * them.
 *
 * Two checkouts of the same repository under different parents are two projects
 * with the same basename. Giving them one id would show one run history for two
 * working trees — and, worse, route a write action to whichever won.
 */
export function assignIds(
  paths: readonly string[],
  /** The platform's, unless a test is asking about another one. */
  flavour: Pick<typeof nodePath, 'basename'> = nodePath,
): RegisteredProject[] {
  const used = new Map<string, number>();

  return paths.map((path) => {
    const name = basename(path, flavour);
    const base = slug(name);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);

    return { id: seen === 0 ? base : `${base}-${String(seen + 1)}`, name, path };
  });
}

export function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');

  // The id has to match `ProjectIdSchema`, and a directory named `...` or `_`
  // would otherwise produce an empty string that no route could ever match.
  return /^[a-z0-9]/.test(cleaned) ? cleaned : `project${cleaned === '' ? '' : `-${cleaned}`}`;
}

/** Where a project keeps its runs. Derived, never taken from a request. */
export function runsDirOf(project: RegisteredProject): string {
  return agentFlowPaths(project.path).runsDir;
}

/**
 * The last segment of a path, whatever separates segments here.
 *
 * `lastIndexOf('/')` named `C:\wk\api` in full, so a Windows project's id was the
 * slug of its whole path. `node:path` already handles a trailing separator, and the
 * fallback covers a root — `basename('/')` is empty, and a project with an empty id
 * is one no route can ever match.
 */
function basename(path: string, flavour: Pick<typeof nodePath, 'basename'> = nodePath): string {
  return flavour.basename(path) || path;
}

/**
 * An absolute path with no trailing separator, as the platform writes it.
 *
 * `resolve` rather than a regular expression, because the thing being removed is a
 * separator and there are two of them on Windows. It is a no-op for a root: `/` and
 * `C:\` stay as they are, which is what makes a workspace rooted at one work.
 */
function normalise(path: string, flavour: Pick<typeof nodePath, 'resolve'> = nodePath): string {
  return flavour.resolve(path);
}

/** Exported for the cross-platform tests; production always uses `node:path`. */
export { basename as workspaceBasename, normalise as normaliseWorkspaceRoot };
