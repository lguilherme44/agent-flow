import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FileSystem } from '../ports/file-system.js';
import type { ProcessRunner } from '../ports/process-runner.js';
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
 * most expensive stage into one that runs constantly. These four inputs cover
 * the changes that actually alter the answer:
 *
 *   - `head` — the commit the map was built from
 *   - `dirty` — tracked files modified since, by name; content is left out so
 *     that editing the same file twice does not thrash the cache
 *   - `agentsMd` — the standing rules, which shape what discovery reports
 *   - `projectConfig` — stack, commands and architecture rules
 */
export const CacheFingerprintSchema = z.object({
  head: z.string(),
  dirty: z.string(),
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
  readonly processRunner: ProcessRunner;
  readonly projectDir: string;
  /** Serialised project configuration, as the pipeline renders it for prompts. */
  readonly projectConfig: string;
}

export async function computeFingerprint(
  inputs: FingerprintInputs,
): Promise<CacheFingerprint> {
  const { fs, processRunner, projectDir } = inputs;

  const git = async (args: string[]): Promise<string> => {
    const result = await processRunner.run({
      command: 'git',
      args,
      cwd: projectDir,
      timeoutSeconds: 30,
      maxOutputBytes: 256 * 1024,
    });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  };

  // A repository without git still gets a usable fingerprint: head and dirty
  // fall back to empty, and the other two inputs carry the signal.
  const head = (await git(['rev-parse', 'HEAD'])) || EMPTY;
  const status = await git(['status', '--porcelain=v1', '--untracked-files=no']);

  const agentsMdPath = `${projectDir}/AGENTS.md`;
  const agentsMd = (await fs.exists(agentsMdPath))
    ? digest(await fs.readFile(agentsMdPath))
    : EMPTY;

  return {
    head,
    dirty: status.length > 0 ? digest(status) : EMPTY,
    agentsMd,
    projectConfig: digest(inputs.projectConfig),
  };
}

export function fingerprintsMatch(a: CacheFingerprint, b: CacheFingerprint): boolean {
  return (
    a.head === b.head &&
    a.dirty === b.dirty &&
    a.agentsMd === b.agentsMd &&
    a.projectConfig === b.projectConfig
  );
}

/** Names which inputs changed, for a message the user can act on. */
export function fingerprintDifferences(
  cached: CacheFingerprint,
  current: CacheFingerprint,
): string[] {
  const labels: Record<keyof CacheFingerprint, string> = {
    head: 'the checked-out commit',
    dirty: 'tracked files modified since the last commit',
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

  const parsed = CacheFingerprintSchema.safeParse(JSON.parse(await fs.readFile(path)));
  // An unreadable fingerprint means the cache cannot be trusted, which is the
  // same position as having none.
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
