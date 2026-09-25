import { posix, win32 } from 'node:path';
import type { FileSystem } from '../ports/index.js';
import { isAtOrUnderRoot, type PathFlavour } from '../core/path-containment.js';

export interface DecideProjectTrustInput {
  readonly fs: Pick<FileSystem, 'realPath'>;
  /** The global file as parsed YAML, before any schema: this runs ahead of validation. */
  readonly globalRaw: unknown;
  readonly projectDir: string;
  readonly platform: string;
}

/**
 * Whether the operator's global `trust.projectConfig` covers `projectDir` (FR-022).
 *
 * A trusted project's config may loosen the operator's safety posture; an untrusted one
 * only tightens it (FR-023). The answer is read from the **global** source alone, so a
 * repository cannot vouch for itself (SEC-001).
 *
 * It runs on the raw global record, before the schema, because the resolver needs the
 * answer to build the record the schema then checks. So it tolerates any shape and
 * decides nothing about it: a string where a list belongs, or a number inside the list,
 * is simply not a trust entry here, and schema validation still reports it afterwards
 * against the global file.
 *
 * **No list, no filesystem.** Every command loads config, and nearly every operator has
 * no trust list; resolving `projectDir` for them would put a `realpath` on every
 * invocation to compute an answer that is already known (NFR-003).
 *
 * Both sides are resolved before comparing, which is what makes the CLI's lexical
 * `resolve(cwd)` and the server's already-resolved project directory agree, and what
 * stops a symlinked checkout from borrowing the trust of the directory it points into —
 * or escaping it. A path that cannot be resolved is not trusted: an unanswerable question
 * about loosening a safety posture answers no.
 *
 * Relative entries are skipped rather than resolved. `realPath` would resolve them against
 * the process's working directory, so an entry of `.` would trust whichever checkout the
 * CLI happened to be started in — every project, one at a time.
 */
export async function decideProjectTrust(input: DecideProjectTrustInput): Promise<boolean> {
  const flavour: PathFlavour = input.platform === 'win32' ? win32 : posix;
  const entries = trustEntries(input.globalRaw).filter((entry) => flavour.isAbsolute(entry));
  if (entries.length === 0) return false;

  const project = await resolved(input.fs, input.projectDir);
  if (project === null) return false;

  for (const entry of entries) {
    const root = await resolved(input.fs, entry);
    if (root !== null && isAtOrUnderRoot(root, project, flavour)) return true;
  }
  return false;
}

function trustEntries(globalRaw: unknown): readonly string[] {
  if (!isRecord(globalRaw)) return [];
  const trust = globalRaw['trust'];
  if (!isRecord(trust)) return [];
  const list = trust['projectConfig'];
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

async function resolved(fs: Pick<FileSystem, 'realPath'>, path: string): Promise<string | null> {
  try {
    return await fs.realPath(path);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
