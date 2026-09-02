import {
  ReviewRecordSchema,
  validateAndNormalizeRepositoryPath,
  type AgentId,
  type Finding,
  type IndependenceLevel,
  type ReviewFinding,
  type ReviewRecord,
  type ReviewVerdict,
} from '../../contracts/index.js';

/**
 * What a reviewer proposed, turned into what the run records (M6-03, §16).
 *
 * **This is the trust boundary for review output**, and it is the same boundary the
 * outbox harvest is for a message. A model returns content; Agent Flow supplies identity,
 * provenance and the tree the review is about. Everything the model could forge is
 * therefore not a field it can fill: the reviewer's id comes from the assignment, the
 * author's from the run, the tree from Git, and the finding ids from a counter over the
 * log.
 *
 * Two rules do the work, and both are refusals rather than corrections:
 *
 *   **A path outside the repository is dropped, and the finding is kept.** A reviewer
 *   that pointed at the wrong place still found something, and losing the finding to
 *   punish the citation would cost more than it protects (M6-ACC-05). What is dropped is
 *   counted, so a review that cites nothing real reads as one.
 *
 *   **A malformed review is not an approval.** The caller gets a refusal it can record,
 *   never a record with a default verdict — §22 in one sentence, and the reason a parse
 *   failure has to be louder than a `changes_requested`.
 *
 * Pure. No filesystem, no Git, no clock.
 */

export interface ReviewProposal {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly Finding[];
  readonly summary?: string;
  readonly scope?: readonly string[];
}

export interface NormaliseInput {
  readonly proposal: ReviewProposal;
  readonly reviewId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly round: number;
  readonly reviewer: AgentId;
  readonly author: AgentId;
  readonly independence: IndependenceLevel;
  readonly reviewedTree?: string;
  /** The first finding number free in this run. Derived from the log, never counted. */
  readonly firstFindingNumber: number;
  /** Bounds one review's output. Exhaustion truncates visibly, never silently. */
  readonly maxFindings: number;
  readonly now: string;
}

export interface NormalisedReview {
  readonly record: ReviewRecord;
  /** Citations and `file` values that named nothing inside the repository. */
  readonly droppedPaths: number;
  /** Findings beyond the budget. Reported so a truncated review reads as truncated. */
  readonly truncated: number;
}

export function normaliseReview(input: NormaliseInput): NormalisedReview {
  let dropped = 0;
  let number = input.firstFindingNumber;

  const kept = input.proposal.findings.slice(0, input.maxFindings);
  const truncated = input.proposal.findings.length - kept.length;

  const findings: ReviewFinding[] = kept.map((finding) => {
    const file = safePath(finding.file);
    if (finding.file !== undefined && file === undefined) dropped += 1;

    const evidence = finding.evidence.filter((reference) => {
      if (reference.kind !== 'file') return true;
      if (safePath(reference.id) !== undefined) return true;
      dropped += 1;
      return false;
    });

    const id = `FIND-${String(number).padStart(4, '0')}`;
    number += 1;

    // `file` is pulled out of the spread rather than overwritten by it. A conditional
    // spread only *adds* a key, so `{ ...finding, ...(ok ? { file } : {}) }` leaves the
    // rejected path exactly where it was — which is how a traversal survived the check
    // that exists to remove it.
    const { file: _proposed, ...rest } = finding;
    void _proposed;

    return {
      ...rest,
      id,
      ...(file === undefined ? {} : { file }),
      evidence,
    };
  });

  const record = ReviewRecordSchema.parse({
    id: input.reviewId,
    runId: input.runId,
    taskId: input.taskId,
    round: input.round,
    reviewer: input.reviewer,
    author: input.author,
    independence: input.independence,
    ...(input.reviewedTree === undefined ? {} : { reviewedTree: input.reviewedTree }),
    verdict: input.proposal.verdict,
    scope: (input.proposal.scope ?? []).map(safePath).filter((path): path is string => path !== undefined),
    findings,
    ...(input.proposal.summary === undefined ? {} : { summary: input.proposal.summary }),
    createdAt: input.now,
  });

  return { record, droppedPaths: dropped, truncated };
}

/**
 * A path, if it is one this repository can name.
 *
 * Delegated to the validator the ContextPacket and the collaboration reference both use.
 * A second list of what a path may not be is a second chance to miss one of `..`, a drive
 * letter, a percent-encoded separator or `.git`.
 */
function safePath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const validated = validateAndNormalizeRepositoryPath(raw);
  return validated.valid ? (validated.normalizedPath ?? raw) : undefined;
}
