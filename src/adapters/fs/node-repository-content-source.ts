import { constants, promises as fs } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { validateAndNormalizeRepositoryPath } from '../../contracts/context-packet.schema.js';
import type {
  RepositoryContentErrorCode,
  RepositoryContentFailure,
  RepositoryContentResult,
  RepositoryContentSource,
} from '../../ports/repository-content-source.js';

export const DEFAULT_MAX_REPOSITORY_FILE_BYTES = 256 * 1024;
export const HARD_MAX_REPOSITORY_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_REPOSITORY_CANDIDATE_PATH_LENGTH = 1024;

export interface NodeRepositoryContentSourceConfig {
  readonly maxFileBytes?: number;
}

/**
 * Node filesystem Adapter for the repository-content seam.
 *
 * Candidate authority is exact: path aliases and every symlink are refused.
 * A pre-open lstat walk rejects unsafe file kinds without blocking. After the
 * nonblocking open, containment and dev+ino identity are proved again before
 * any bytes are read, closing intermediate-component swap windows.
 */
export class NodeRepositoryContentSource implements RepositoryContentSource {
  private readonly maxFileBytes: number;

  constructor(config: NodeRepositoryContentSourceConfig = {}) {
    this.maxFileBytes = sanitizeMaxFileBytes(config.maxFileBytes);
  }

  async readCandidate(projectDir: string, candidatePath: string): Promise<RepositoryContentResult> {
    const pathResult = exactCandidatePath(candidatePath);
    if (!pathResult.ok) return pathResult.failure;

    const path = pathResult.path;
    try {
      const root = await fs.realpath(projectDir);
      const requestedPath = join(root, path);
      if (!isContained(root, requestedPath)) return failure(path, 'outside_project');

      const initial = await capturePathSnapshot(root, path);
      if (!initial.ok) return failure(path, initial.errorCode);

      let repeated: PathSnapshotResult;
      try {
        repeated = await capturePathSnapshot(root, path);
      } catch {
        return failure(path, 'path_changed');
      }
      if (!repeated.ok) {
        return failure(path, repeated.errorCode === 'symlink' ? 'symlink' : 'path_changed');
      }
      if (!sameSnapshot(initial.snapshot, repeated.snapshot)) {
        return failure(path, 'path_changed');
      }

      return await this.openAndReadAuthorized(requestedPath, path, initial.snapshot.final);
    } catch (error) {
      return failure(path, classifyFileSystemFailure(error));
    }
  }

  private async openAndReadAuthorized(
    requestedPath: string,
    path: string,
    authorizedFinal: FileIdentity,
  ): Promise<RepositoryContentResult> {
    const handle = await fs.open(requestedPath, secureOpenFlags());

    try {
      const handleStats = await handle.stat({ bigint: true });
      if (
        !handleStats.isFile() ||
        handleStats.dev !== authorizedFinal.dev ||
        handleStats.ino !== authorizedFinal.ino
      ) {
        return failure(path, 'path_changed');
      }
      if (handleStats.size > BigInt(this.maxFileBytes)) return failure(path, 'too_large');

      const contentBytes = await readSnapshot(handle, Number(handleStats.size));
      if (looksBinary(contentBytes)) return failure(path, 'binary');

      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contentBytes);
      } catch {
        return failure(path, 'binary');
      }

      return Object.freeze({ ok: true, path, content, bytes: contentBytes.byteLength });
    } finally {
      await handle.close();
    }
  }
}

function secureOpenFlags(): number {
  // These two flags are POSIX-only in Node. Native Windows path handling and
  // post-open identity proof still apply there; unavailable flags are not
  // mistaken for a security guarantee.
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
  return constants.O_RDONLY | noFollow | nonBlock;
}

function sanitizeMaxFileBytes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return DEFAULT_MAX_REPOSITORY_FILE_BYTES;
  }
  return Math.min(value, HARD_MAX_REPOSITORY_FILE_BYTES);
}

function exactCandidatePath(
  candidatePath: string,
): { readonly ok: true; readonly path: string } | {
  readonly ok: false;
  readonly failure: RepositoryContentFailure;
} {
  if (
    typeof candidatePath !== 'string' ||
    candidatePath.length === 0 ||
    candidatePath.length > MAX_REPOSITORY_CANDIDATE_PATH_LENGTH ||
    !hasExactUtf8RoundTrip(candidatePath) ||
    hasUnsafeDiagnosticControls(candidatePath) ||
    candidatePath
      .split('/')
      .some((segment) => !hasExactUtf8RoundTrip(segment) || isUnsafePortableSegment(segment))
  ) {
    return { ok: false, failure: failure('', 'invalid_path') };
  }

  const validation = validateAndNormalizeRepositoryPath(candidatePath);
  if (
    !validation.valid ||
    !validation.normalizedPath ||
    validation.normalizedPath !== candidatePath
  ) {
    return { ok: false, failure: failure('', 'invalid_path') };
  }

  return { ok: true, path: candidatePath };
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface PathSnapshot {
  readonly chain: readonly FileIdentity[];
  readonly final: FileIdentity;
}

type PathSnapshotResult =
  | { readonly ok: true; readonly snapshot: PathSnapshot }
  | { readonly ok: false; readonly errorCode: 'symlink' | 'not_file' | 'path_changed' };

async function capturePathSnapshot(
  root: string,
  candidatePath: string,
): Promise<PathSnapshotResult> {
  const segments = candidatePath.split('/');
  const chain: FileIdentity[] = [];
  let current = root;

  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) {
      const segment = segments[index] ?? '';
      if (!(await hasSingleExactEntry(current, segment))) {
        return { ok: false, errorCode: 'path_changed' };
      }
      current = join(current, segment);
    }
    const stats = await fs.lstat(current, { bigint: true });
    if (stats.isSymbolicLink()) return { ok: false, errorCode: 'symlink' };

    const final = index === segments.length - 1;
    if (final ? !stats.isFile() : !stats.isDirectory()) {
      return { ok: false, errorCode: 'not_file' };
    }
    chain.push(Object.freeze({ dev: stats.dev, ino: stats.ino }));
  }

  return {
    ok: true,
    snapshot: Object.freeze({
      chain: Object.freeze(chain),
      final: chain[chain.length - 1] as FileIdentity,
    }),
  };
}

async function hasSingleExactEntry(parent: string, segment: string): Promise<boolean> {
  const expected = Buffer.from(segment, 'utf8');
  const entries = await fs.readdir(parent, { encoding: 'buffer' });
  let matches = 0;

  for (const entry of entries) {
    if (entry.equals(expected)) matches += 1;
  }
  return matches === 1;
}

function sameSnapshot(left: PathSnapshot, right: PathSnapshot): boolean {
  return (
    left.chain.length === right.chain.length &&
    left.chain.every(
      (identity, index) =>
        identity.dev === right.chain[index]?.dev && identity.ino === right.chain[index]?.ino,
    )
  );
}

function isUnsafePortableSegment(segment: string): boolean {
  if (/[<>:"\\|?*]/.test(segment) || segment.endsWith('.') || segment.endsWith(' ')) return true;
  const basename = segment.split('.')[0] ?? '';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(basename);
}

function hasExactUtf8RoundTrip(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function hasUnsafeDiagnosticControls(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function readSnapshot(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: number,
): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array();

  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function looksBinary(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (
      byte === 0 ||
      byte === 127 ||
      (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)
    ) {
      return true;
    }
  }
  return false;
}

function classifyFileSystemFailure(error: unknown): RepositoryContentErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
  if (code === 'ELOOP') return 'symlink';
  return 'read_failed';
}

const FAILURE_MESSAGES: Readonly<Record<RepositoryContentErrorCode, string>> = Object.freeze({
  invalid_path: 'candidate path is not a safe exact repository-relative path',
  outside_project: 'candidate resolves outside the project root',
  symlink: 'candidate path contains a symbolic link',
  path_changed: 'candidate path changed during secure open',
  not_found: 'candidate does not exist',
  not_file: 'candidate is not a regular file',
  too_large: 'candidate exceeds the configured file-size limit',
  binary: 'candidate is binary or is not valid UTF-8 text',
  read_failed: 'candidate could not be read safely',
});

function failure(path: string, errorCode: RepositoryContentErrorCode): RepositoryContentFailure {
  return Object.freeze({ ok: false, path, errorCode, message: FAILURE_MESSAGES[errorCode] });
}
