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
 * to read.
 */
export async function discoverProjects(
  options: DiscoverOptions,
): Promise<RegisteredProject[]> {
  const depth = options.depth ?? DEFAULT_WORKSPACE_DEPTH;
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = async (dir: string, remaining: number): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);

    if (await options.fs.exists(`${dir}/.agent-flow/config.yaml`)) {
      found.push(dir);
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
      const child = `${dir}/${entry}`;
      const stat = await options.fs.stat(child);
      if (stat?.isDirectory === true) await walk(child, remaining - 1);
    }
  };

  for (const root of options.roots) await walk(normalise(root), depth);

  return assignIds(found.sort());
}

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
export function assignIds(paths: readonly string[]): RegisteredProject[] {
  const used = new Map<string, number>();

  return paths.map((path) => {
    const name = basename(path);
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

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function normalise(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
