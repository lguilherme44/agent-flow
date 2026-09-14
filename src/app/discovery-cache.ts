import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FileSystem } from '../ports/file-system.js';
import { GIT_TIMEOUT_SECONDS, type GitCommand } from '../adapters/git/git-command.js';
import { agentFlowPaths } from './paths.js';

/**
 * Fingerprint of the repository state a cached discovery describes.
 *
 * Discovery is feature-agnostic, which is why its output is cached at all — it
 * saves one expensive call per feature. But "the file exists" was the entire
 * cache decision, so a repository could be rewritten and every later feature
 * would still be planned against a map of what it used to be. That failure is
 * silent and expensive: the SDD and the plan look reasonable and describe a
 * codebase that is gone.
 *
 * What goes into the fingerprint is a trade-off. Hashing the whole working tree
 * would be correct and would also invalidate on every save, which turns the
 * most expensive stage into one that runs constantly. These three inputs cover
 * the changes that actually alter the answer:
 *
 *   - `head` — the commit the map was built from
 *   - `agentsMd` — the standing rules, which shape what discovery reports
 *   - `projectConfig` — stack, commands and architecture rules
 *
 * **`dirty` was the fourth, and the repository map is why it is gone.** It hashed the
 * names of tracked files modified since the commit, which meant touching one file in a
 * branch you were working in invalidated the most expensive stage in the product — so on
 * an active working tree the amortisation this cache exists for barely happened. It was
 * the right conservative choice while the cached prose was the *only* thing a later stage
 * knew about the repository.
 *
 * It no longer is. `discovery` now opens with a ranked index built by parsing the working
 * tree at the moment the stage runs, so "what exists right now" arrives fresh every time
 * and is never served from here. What this cache holds is the other half — the prose about
 * how the codebase is organised, what its conventions are, where its seams are — and three
 * modified files do not change any of that. Splitting the artifact by what it costs to
 * rebuild is the whole point: structure is seconds and is always current; synthesis is
 * minutes and is cached against the things that actually change it.
 *
 * The residual risk is named rather than dismissed: an uncommitted refactor large enough
 * to change the conventions themselves will be described by prose written before it. `head`
 * catches it the moment it is committed, the fresh index contradicts it before that, and
 * `--no-cache` is the lever for anyone who knows they are in the middle of one.
 */
export const CacheFingerprintSchema = z.object({
  head: z.string(),
  agentsMd: z.string(),
  projectConfig: z.string(),
});
export type CacheFingerprint = z.infer<typeof CacheFingerprintSchema>;

const EMPTY = 'none';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export interface FingerprintInputs {
  readonly fs: FileSystem;
  /**
   * The hook-isolated Git wrapper (M2-02).
   *
   * This used to be a `ProcessRunner` and a local helper that built
   * `{ command: 'git' }` — a second internal Git spawner, and the known offender
   * §26.1 rule 1 was written against. Nothing about the fingerprint changed with
   * it: `HEAD` and the dirty-file list are read the same way, and a directory
   * that is not a repository still produces a usable fingerprint rather than an
   * error, which is what keeps sequential mode working where it always has.
   */
  readonly git: GitCommand;
  readonly projectDir: string;
  /** Serialised project configuration, as the pipeline renders it for prompts. */
  readonly projectConfig: string;
}

export async function computeFingerprint(
  inputs: FingerprintInputs,
): Promise<CacheFingerprint> {
  const { fs, projectDir } = inputs;

  const git = async (
    subcommand: 'rev-parse' | 'status',
    args: string[],
  ): Promise<string> => {
    const result = await inputs.git.run({
      subcommand,
      args,
      cwd: projectDir,
      timeoutSeconds: GIT_TIMEOUT_SECONDS.quick,
      maxOutputBytes: 256 * 1024,
    });
    // A failure to run git at all reads as "no git answer", exactly as a
    // non-zero exit did before. Git is not a requirement for planning.
    return result.ok && result.value.exitCode === 0 ? result.value.stdout.trim() : '';
  };

  // A repository without git still gets a usable fingerprint: head falls back to empty,
  // and the other two inputs carry the signal.
  const head = (await git('rev-parse', ['HEAD'])) || EMPTY;

  const agentsMdPath = `${projectDir}/AGENTS.md`;
  const agentsMd = (await fs.exists(agentsMdPath))
    ? digest(await fs.readFile(agentsMdPath))
    : EMPTY;

  return { head, agentsMd, projectConfig: digest(inputs.projectConfig) };
}

export function fingerprintsMatch(a: CacheFingerprint, b: CacheFingerprint): boolean {
  return (
    a.head === b.head && a.agentsMd === b.agentsMd && a.projectConfig === b.projectConfig
  );
}

/** Names which inputs changed, for a message the user can act on. */
export function fingerprintDifferences(
  cached: CacheFingerprint,
  current: CacheFingerprint,
): string[] {
  const labels: Record<keyof CacheFingerprint, string> = {
    head: 'the checked-out commit',
    agentsMd: 'AGENTS.md',
    projectConfig: 'the project configuration',
  };

  return (Object.keys(labels) as (keyof CacheFingerprint)[])
    .filter((key) => cached[key] !== current[key])
    .map((key) => labels[key]);
}

function metadataPath(projectDir: string): string {
  return `${agentFlowPaths(projectDir).cacheDir}/architecture.fingerprint.json`;
}

/** The fingerprint stored beside the cached map, or null when there is none. */
export async function readFingerprint(
  fs: FileSystem,
  projectDir: string,
): Promise<CacheFingerprint | null> {
  const path = metadataPath(projectDir);
  if (!(await fs.exists(path))) return null;

  // An unreadable fingerprint means the cache cannot be trusted, which is the
  // same position as having none. That was the intent before, but `JSON.parse`
  // ran outside the guard: a truncated file — a crash mid-write, a bad merge —
  // threw out of here and took the whole command with it, when the correct
  // response is simply to re-run discovery.
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path));
  } catch {
    return null;
  }

  const parsed = CacheFingerprintSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function writeFingerprint(
  fs: FileSystem,
  projectDir: string,
  fingerprint: CacheFingerprint,
): Promise<void> {
  await fs.mkdirp(agentFlowPaths(projectDir).cacheDir);
  await fs.writeFileAtomic(
    metadataPath(projectDir),
    `${JSON.stringify(fingerprint, null, 2)}\n`,
  );
}
