import type {
  AgentMessage,
  FindingStatus,
  ReviewFinding,
  ReviewRecord,
  RunEvent,
} from '../../contracts/index.js';

/**
 * Where each finding is in its life — **derived, never stored** (I-43, §14).
 *
 * Every transition is already a fact this run recorded somewhere:
 *
 * ```text
 * open           a review raised it and nothing has answered
 * acknowledged   the implementer said so, in a message
 * disputed       the implementer disagreed, in a message, with a reason
 * fixed          a corrective task for it integrated                     ← evidence, not a claim
 * verified       a later review read the corrected tree and did not raise it again
 * ```
 *
 * A stored status would be a second copy of all of that, and it would be the copy a crash
 * between two writes leaves wrong. It would also be a field an agent could eventually
 * write, which is the whole of §26 and §27: "I fixed FIND-004" is a sentence, and the
 * official status only moves when there is a corrective attempt behind it.
 *
 * **Neither an acknowledgement nor a dispute closes anything** (§25). Both are answers,
 * and an answer is not a fix.
 *
 * Pure: three logs in, a status per finding out.
 */

export interface FindingProjectionInput {
  readonly reviews: readonly ReviewRecord[];
  /** The conversation. A response is collaboration's, not a second messaging store (§23). */
  readonly messages: readonly AgentMessage[];
  /** The audit trail, for the corrective work that makes `fixed` a fact rather than a claim. */
  readonly events: readonly RunEvent[];
}

export interface ProjectedFinding {
  readonly finding: ReviewFinding;
  readonly reviewId: string;
  readonly taskId: string;
  readonly round: number;
  readonly status: FindingStatus;
  /** The corrective task that carried the fix, when one did. */
  readonly correctiveTask?: string;
  /** Which review saw the corrected tree and let it go, when one did. */
  readonly verifiedBy?: string;
}

/**
 * Every finding in the run, with the status the record implies.
 *
 * Ordered as the reviews were written, so two reads of one log agree — and so a reader
 * sees the first review's findings before the re-review's.
 */
export function projectFindings(input: FindingProjectionInput): ProjectedFinding[] {
  const answered = answersByFinding(input.messages);
  const fixed = correctiveByFinding(input.events);
  const projected: ProjectedFinding[] = [];

  for (const review of input.reviews) {
    for (const finding of review.findings) {
      const correctiveTask = fixed.get(finding.id);
      const verifier = verifierOf(input.reviews, review, finding, correctiveTask !== undefined);

      projected.push({
        finding,
        reviewId: review.id,
        taskId: review.taskId,
        round: review.round,
        status: statusOf({
          answer: answered.get(finding.id),
          hasCorrective: correctiveTask !== undefined,
          verifier,
        }),
        ...(correctiveTask === undefined ? {} : { correctiveTask }),
        ...(verifier === undefined ? {} : { verifiedBy: verifier }),
      });
    }
  }

  return projected;
}

/**
 * The status those three facts imply.
 *
 * Ordered from the strongest evidence down, which is what makes it a projection rather
 * than a state machine: there is no transition to get wrong, only a question about what
 * is true. A finding that was disputed and then fixed and then verified is `verified` —
 * the dispute is history, and the history is still in the log.
 */
function statusOf(input: {
  answer?: 'acknowledged' | 'disputed';
  hasCorrective: boolean;
  verifier?: string;
}): FindingStatus {
  if (input.verifier !== undefined) return 'verified';
  if (input.hasCorrective) return 'fixed';
  if (input.answer !== undefined) return input.answer;
  return 'open';
}

/**
 * Which review verified a finding, if one did.
 *
 * **Two conditions, and both are refusals of the easy answer.** A later review only
 * verifies a finding if it read a *different* tree — a re-review of the same commit has
 * seen nothing new and cannot have confirmed a fix. And there must be corrective work
 * behind it (§27): a reviewer that simply stopped mentioning something did not verify it,
 * it forgot it.
 */
function verifierOf(
  reviews: readonly ReviewRecord[],
  raised: ReviewRecord,
  finding: ReviewFinding,
  hasCorrective: boolean,
): string | undefined {
  if (!hasCorrective) return undefined;

  const later = reviews.filter(
    (review) =>
      review.taskId === raised.taskId &&
      review.round > raised.round &&
      review.reviewedTree !== undefined &&
      review.reviewedTree !== raised.reviewedTree,
  );

  // The first later review that read a corrected tree and did not raise this again. A
  // review that raised the same finding once more has verified nothing.
  const clean = later.find(
    (review) => !review.findings.some((raisedAgain) => sameFinding(raisedAgain, finding)),
  );

  return clean?.id;
}

/**
 * Whether two findings are the same complaint.
 *
 * By content rather than by id, because a re-review allocates new ids: it is a fresh
 * review, and it has no way to know which id the first one used. Category plus file plus
 * description is what "the same complaint" means when nobody is carrying a reference.
 */
function sameFinding(a: ReviewFinding, b: ReviewFinding): boolean {
  return a.type === b.type && a.file === b.file && a.description === b.description;
}

/**
 * What the implementer said about each finding, from the conversation.
 *
 * **Collaboration's log, not a second one** (§23, M6-ACC-08). A response is a message; the
 * review domain stores the *structure* of a finding and collaboration stores the dialogue
 * about it. A finding referenced by a message is how the two meet.
 *
 * The last answer wins: an implementer that disputed and then acknowledged has
 * acknowledged.
 */
function answersByFinding(
  messages: readonly AgentMessage[],
): Map<string, 'acknowledged' | 'disputed'> {
  const answers = new Map<string, 'acknowledged' | 'disputed'>();

  for (const message of messages) {
    const answer = answerOf(message);
    if (answer === undefined) continue;

    for (const reference of message.references) {
      if (reference.kind === 'finding') answers.set(reference.id, answer);
    }
  }

  return answers;
}

/**
 * What kind of answer a message is, if it is one.
 *
 * `acknowledge` is the type that exists for exactly this. A dispute is a
 * `review_feedback` that says it disagrees — read from the body because there is no
 * `disputed` message type and adding one would grow M4's vocabulary for a distinction
 * M4's vocabulary can already express.
 *
 * Anything else referencing a finding is a comment, and a comment answers nothing.
 */
function answerOf(message: AgentMessage): 'acknowledged' | 'disputed' | undefined {
  if (message.type === 'acknowledge') return 'acknowledged';
  if (message.type !== 'review_feedback') return undefined;
  return /\b(?:dispute[ds]?|disagree[ds]?)\b/i.test(message.body) ? 'disputed' : undefined;
}

/**
 * Which corrective task carried the fix for each finding.
 *
 * From `corrective_task_created` paired with the task actually completing — a corrective
 * task that was created and never ran has fixed nothing, and `fixed` is supposed to mean
 * evidence rather than intent.
 */
function correctiveByFinding(events: readonly RunEvent[]): Map<string, string> {
  const created = new Map<string, string>();
  const completed = new Set<string>();

  for (const event of events) {
    if (event.type === 'corrective_task_created') {
      const finding = event.detail['finding'];
      const task = event.detail['correctiveTask'];
      if (typeof finding === 'string' && typeof task === 'string') created.set(finding, task);
      continue;
    }

    if (event.type === 'task_finished') {
      const task = event.detail['task'];
      const status = event.detail['status'];
      if (typeof task === 'string' && status === 'completed') completed.add(task);
    }
  }

  const fixed = new Map<string, string>();
  for (const [finding, task] of created) {
    if (completed.has(task)) fixed.set(finding, task);
  }

  return fixed;
}
