import { createHash } from 'node:crypto';

/**
 * The mark Agent Flow leaves on the remote objects it creates (M7 §18).
 *
 * **The whole answer to "what if the remote succeeded and this process died?"** Local
 * evidence is written after the remote call returns, so there is always a window where the
 * object exists and nothing here knows it. Recovery closes that window by asking the
 * remote whether an object carrying *this run's* mark already exists.
 *
 * **In `app` rather than `core`, following `approval.ts`.** Hashing is not I/O, and the
 * layering rule that keeps `node:` imports out of `core` is right to be blunt about it
 * rather than to grow an exception list — `planHash` made the same move for the same
 * reason.
 *
 * Deterministic, so a retry computes the same mark. Non-secret, because it ends up in a
 * public Issue body and a mark that had to stay private would be a credential published on
 * purpose. It identifies; it does not authenticate.
 */

export type ForgeObjectKind = 'issue' | 'pull_request' | 'comment';

/** The marker, in an HTML comment so GitHub renders nothing and a reader sees nothing. */
export function fingerprintMarker(input: {
  readonly runId: string;
  readonly kind: ForgeObjectKind;
  readonly digest: string;
}): string {
  return `<!-- agent-flow:run=${input.runId};kind=${input.kind};fingerprint=${input.digest} -->`;
}

/**
 * The digest for one logical remote object.
 *
 * Includes the commit for a pull request and a comment, and *excludes* it for an Issue: an
 * Issue is about the feature and outlives every correction, while a PR body and a summary
 * comment describe one exact tree. Getting that backwards would mean a corrective round
 * opening a second Issue, or a PR body from three commits ago being adopted as current.
 */
export function fingerprint(input: {
  readonly runId: string;
  readonly kind: ForgeObjectKind;
  readonly repository: { readonly host: string; readonly owner: string; readonly repo: string };
  readonly commit?: string;
  /** For a comment: which logical update this is, so two different updates are two comments. */
  readonly topic?: string;
}): string {
  const parts = [
    input.repository.host.toLowerCase(),
    input.repository.owner.toLowerCase(),
    input.repository.repo.toLowerCase(),
    input.runId,
    input.kind,
    input.kind === 'issue' ? '' : (input.commit ?? ''),
    input.topic ?? '',
  ];

  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32);
}

/**
 * Whether a body carries this exact mark.
 *
 * A substring test on a delimited marker rather than a parse: the surrounding text is
 * written by whoever edited the Issue afterwards, and a body that has been reformatted,
 * translated or appended to still carries the comment.
 */
export function carriesFingerprint(body: string | undefined, marker: string): boolean {
  return body !== undefined && body.includes(marker);
}
