import { dirname, join } from 'node:path';
import type { FileSystem } from '../ports/index.js';
import { samePath } from '../core/path-containment.js';

/**
 * The project hub — every directory `agent-flow ui` shows, wherever it is started from.
 *
 * **Why it exists.** The dashboard used to show the directory it was started in and what
 * lay under it, so seeing a project meant `cd` into it first and starting a server there.
 * For somebody working across a dozen repositories — and across several agent sessions at
 * once — that is the chore that makes a dashboard not worth opening. The hub is a list of
 * directories that outlives any one server: every command run in a project adds it, `ui`
 * reads it, and a server started from anywhere lists them all.
 *
 * **It is a list of scan roots, not of ids.** The browser still names a project only by
 * the id the registry issues after walking these directories (§93): a path written here is
 * one the operator put there — by running a command in it, or by `agent-flow projects add`
 * — which is the same "the operator chose what this server can see" the workspace argument
 * already was. Nothing on the HTTP side can write to it.
 *
 * `<dir of the global config>/projects.json`, a plain JSON array of absolute paths. Next to
 * the configuration so `--config` relocates both together — which is also what keeps a test
 * that passes a temporary config from writing into the operator's real hub.
 */

export const PROJECT_HUB_FILE = 'projects.json';

export function projectHubPath(globalConfigPath: string): string {
  return join(dirname(globalConfigPath), PROJECT_HUB_FILE);
}

/** Re-exported: the rule lives in `core/path-containment.ts`, next to its sibling. */
export { samePath };

/**
 * Whether `dir` is a project: it has `.agent-flow/config.yaml`, and that file is not the
 * global configuration.
 *
 * **The second half was found the first time the dashboard started from a home directory.**
 * `~/.agent-flow/config.yaml` is the global configuration and also, byte for byte, the path
 * a project is recognised by — so the home directory was listed as a project and written
 * into the hub, and every dashboard after that walked the whole home directory as a root.
 */
export async function isProjectDirectory(fs: FileSystem, dir: string, globalConfigPath: string): Promise<boolean> {
  const marker = join(dir, '.agent-flow', 'config.yaml');
  return !ownsGlobalConfig(dir, globalConfigPath) && (await fs.exists(marker));
}

/** Whether `dir/.agent-flow/config.yaml` is the global configuration file. */
export function ownsGlobalConfig(dir: string, globalConfigPath: string): boolean {
  return samePath(join(dir, '.agent-flow', 'config.yaml'), globalConfigPath);
}

/**
 * The hub's directories that still exist, in the order they were added.
 *
 * Never throws: a hub that will not parse is an empty hub, because `ui` is often opened
 * precisely when something is wrong and must not refuse over its own bookkeeping.
 *
 * A directory that no longer exists is dropped — a deleted worktree would otherwise sit in
 * the list forever. One that exists without `.agent-flow/config.yaml` is kept: it is a scan
 * root, and a folder of repositories handed over with `projects add` is exactly that.
 */
export async function readProjectHub(fs: FileSystem, globalConfigPath: string): Promise<string[]> {
  const entries = await readRaw(fs, globalConfigPath);
  const alive: string[] = [];
  for (const entry of entries) {
    // The home directory is dropped as well — see `isProjectDirectory`. A hub written
    // before that was known heals on its next read instead of needing a hand edit.
    if (!ownsGlobalConfig(entry, globalConfigPath) && (await fs.exists(entry))) alive.push(entry);
  }
  return alive;
}

/**
 * Adds `dir` to the hub. True when it was added, false when it was already there or
 * does not exist.
 *
 * Writes only when the list changes, so running `status` in a project a hundred times
 * leaves the file as it was after the first.
 */
export async function rememberProject(fs: FileSystem, globalConfigPath: string, dir: string): Promise<boolean> {
  if (ownsGlobalConfig(dir, globalConfigPath) || !(await fs.exists(dir))) return false;

  const current = await readProjectHub(fs, globalConfigPath);
  if (current.some((entry) => samePath(entry, dir))) {
    // Still rewritten when the read pruned something, so the file converges on the truth.
    if (current.length !== (await readRaw(fs, globalConfigPath)).length) await write(fs, globalConfigPath, current);
    return false;
  }

  await write(fs, globalConfigPath, [...current, dir]);
  return true;
}

/** {@link rememberProject} for several directories, in one write. True when any was added. */
export async function rememberProjects(
  fs: FileSystem,
  globalConfigPath: string,
  dirs: readonly string[],
): Promise<boolean> {
  const current = await readProjectHub(fs, globalConfigPath);
  const next = [...current];
  for (const dir of dirs) {
    if (ownsGlobalConfig(dir, globalConfigPath) || next.some((entry) => samePath(entry, dir))) continue;
    if (await fs.exists(dir)) next.push(dir);
  }
  const pruned = current.length !== (await readRaw(fs, globalConfigPath)).length;
  if (next.length === current.length && !pruned) return false;

  await write(fs, globalConfigPath, next);
  return next.length !== current.length;
}

/** Removes `dir` from the hub. True when it was there. The directory itself is untouched. */
export async function forgetProject(fs: FileSystem, globalConfigPath: string, dir: string): Promise<boolean> {
  const raw = await readRaw(fs, globalConfigPath);
  const kept = raw.filter((entry) => !samePath(entry, dir));
  if (kept.length === raw.length) return false;

  await write(fs, globalConfigPath, kept);
  return true;
}

async function readRaw(fs: FileSystem, globalConfigPath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(projectHubPath(globalConfigPath)));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

async function write(fs: FileSystem, globalConfigPath: string, entries: readonly string[]): Promise<void> {
  const path = projectHubPath(globalConfigPath);
  await fs.mkdirp(dirname(path));
  await fs.writeFileAtomic(path, `${JSON.stringify(entries, null, 2)}\n`);
}
