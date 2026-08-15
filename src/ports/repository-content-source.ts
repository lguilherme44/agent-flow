/**
 * Provider-neutral seam for reading a repository candidate as bounded text.
 *
 * The caller supplies a repository-relative candidate path. The Adapter owns
 * filesystem containment, file-size and text/binary decisions; callers never
 * receive bytes from a candidate that fails one of those checks.
 */

export const REPOSITORY_CONTENT_ERROR_CODES = [
  'invalid_path',
  'outside_project',
  'symlink',
  'path_changed',
  'not_found',
  'not_file',
  'too_large',
  'binary',
  'read_failed',
] as const;

export type RepositoryContentErrorCode =
  (typeof REPOSITORY_CONTENT_ERROR_CODES)[number];

export interface RepositoryContentSuccess {
  readonly ok: true;
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
}

export interface RepositoryContentFailure {
  readonly ok: false;
  readonly path: string;
  readonly errorCode: RepositoryContentErrorCode;
  /** Safe diagnostic only; it never contains file content or a canonical path. */
  readonly message: string;
}

export type RepositoryContentResult =
  | RepositoryContentSuccess
  | RepositoryContentFailure;

export interface RepositoryContentSource {
  /**
   * Reads one candidate. Unsafe and unreadable files are explicit failures,
   * never thrown flow errors. The configured Adapter limit is checked before
   * content bytes are read.
   */
  readCandidate(projectDir: string, candidatePath: string): Promise<RepositoryContentResult>;
}
