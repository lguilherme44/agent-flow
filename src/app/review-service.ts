import { z } from 'zod';
import {
  FindingSchema,
  ReviewVerdictSchema,
  type AgentId,
  type AgentIdentity,
  type CommandResult,
  type EffectiveConfig,
  type ReviewRecord,
  type Task,
} from '../contracts/index.js';
import type { AgentRoster } from '../core/collaboration/roster.js';
import { selectReviewer, hasReviewer } from '../core/review/reviewer.js';
import { normaliseReview } from '../core/review/normalise.js';
import { projectQualityGates } from '../core/review/gates.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import type { Clock } from '../ports/index.js';
import type { ReviewStore } from './review-store.js';
import type { StageRunner } from './stage-runner.js';
import type { StateStore } from './state-store.js';
import { StageFailure, type StageDefinition } from './stage-runner.js';

/**
 * One change, reviewed by somebody who did not write it (M6-03).
 *
 * **Everything a model could forge is supplied here rather than asked for.** The reviewer
 * is chosen by the assignment policy, the author comes from the run, the tree comes from
 * the integrator, and the finding ids come from a counter over the log. What the model
 * returns is a verdict, some findings and a sentence — content, and nothing else.
 *
 * The service decides nothing about whether the run continues. It records what a reviewer
 * said; `decideQuality` weighs that against the gates and the tree (I-44). A verdict of
 * `approve` here is a proposal, and the distinction is the milestone.
 *
 * Wired unconditionally and answering with silence when no member reviews, exactly as the
 * collaboration service answers with silence when the channel is off — so the mode is
 * decided by configuration rather than by the wiring.
 */

/**
 * What a reviewing agent returns.
 *
 * No id, no reviewer, no tree, no round. The reviewer reports what it found; Agent Flow
 * supplies the provenance — the same split `ReviewResponseSchema` already uses for the
 * run-level review, and for the same reason: asking a model to describe its own
 * independence is asking it to grade its own homework.
 */
export const CodeReviewResponseSchema = z
  .object({
    verdict: ReviewVerdictSchema,
    summary: z.string().max(4000).optional(),
    findings: z.array(FindingSchema).default([]),
  })
  .refine((review) => review.verdict === 'approve' || review.findings.length > 0, {
    message: 'a verdict other than approve must be accompanied by at least one finding',
    path: ['findings'],
  });

export interface ReviewServiceOptions {
  readonly clock: Clock;
  readonly store: StateStore;
  readonly reviews: ReviewStore;
  readonly stageRunner: StageRunner;
  readonly roster: AgentRoster;
  readonly config: EffectiveConfig;
  readonly canImplement: (agent: AgentIdentity) => boolean;
}

export interface ReviewRequest {
  readonly runId: string;
  readonly task: Task;
  /** Who wrote the code. From the assignment, never from the review (I-42). */
  readonly author: AgentId;
  /** The commit this change integrated as. Absent in sequential mode. */
  readonly integratedTree?: string;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  /** What the project's commands already said, so the reviewer does not repeat them. */
  readonly commandResults: readonly CommandResult[];
  readonly agentsMd: string;
  readonly inFlight: ReadonlyMap<AgentId, number>;
  readonly signal?: AbortSignal;
}

export interface ReviewOutcomeRecord {
  readonly record?: ReviewRecord;
  /** Why no review happened, when none did. Never an error — most runs have no reviewer. */
  readonly skipped?: string;
}

export class ReviewService {
  constructor(private readonly options: ReviewServiceOptions) {}

  /** Whether this configuration reviews at all. Cheap, and asked before anything else. */
  get enabled(): boolean {
    return hasReviewer(this.options.config.global);
  }

  /**
   * Reviews one change, or says why it did not.
   *
   * Never throws. A review that cannot run is a review that did not happen, and a run
   * must not fail because a reviewer was unavailable — the quality decision will refuse
   * to approve without one, which is the fail-closed direction and a better answer than
   * a halted run.
   */
  async review(request: ReviewRequest): Promise<ReviewOutcomeRecord> {
    if (!this.enabled) return { skipped: 'no team member declares review skills' };

    const { clock, store, reviews, roster, config } = this.options;

    const selection = selectReviewer({
      task: request.task,
      author: request.author,
      config: config.global,
      roster,
      inFlight: request.inFlight,
      canImplement: this.options.canImplement,
      now: clock.now(),
    });

    if (selection?.reviewer === undefined) {
      await store.appendEvent(request.runId, 'review_requested', {
        task: request.task.id,
        reason: selection?.degraded ?? 'no reviewer could be assigned',
      });
      return { skipped: selection?.degraded ?? 'no reviewer could be assigned' };
    }

    const round = (await this.roundsFor(request.runId, request.task.id)) + 1;
    const reviewId = await reviews.nextReviewId(request.runId);

    await store.appendEvent(request.runId, 'reviewer_assigned', {
      task: request.task.id,
      review: reviewId,
      reviewer: selection.reviewer,
      author: request.author,
      independence: selection.independence,
      ...(selection.degraded === undefined ? {} : { degraded: selection.degraded }),
    });

    const proposal = await this.ask(request, reviewId, round);
    if (proposal === undefined) {
      // **A malformed review is not an approval** (§22, I-47). The absence is recorded and
      // the quality decision refuses, which is louder than a `changes_requested` and much
      // quieter than a run that stopped.
      await store.appendEvent(request.runId, 'review_completed', {
        task: request.task.id,
        review: reviewId,
        verdict: 'blocked',
        findings: 0,
        blocking: 0,
        detail: 'the reviewer produced no output that satisfied the contract',
      });
      return { skipped: 'the reviewer produced no valid output' };
    }

    const { record, droppedPaths, truncated } = normaliseReview({
      proposal,
      reviewId,
      runId: request.runId,
      taskId: request.task.id,
      round,
      reviewer: selection.reviewer,
      author: request.author,
      independence: selection.independence,
      ...(request.integratedTree === undefined ? {} : { reviewedTree: request.integratedTree }),
      firstFindingNumber: await reviews.nextFindingNumber(request.runId),
      maxFindings: config.global.review.maxFindingsPerReview,
      now: clock.now(),
    });

    await reviews.appendReview(request.runId, record);

    for (const finding of record.findings) {
      await store.appendEvent(request.runId, 'finding_raised', {
        task: request.task.id,
        review: reviewId,
        finding: finding.id,
        severity: finding.severity,
        category: finding.type,
        ...(finding.file === undefined ? {} : { file: finding.file }),
      });
    }

    await store.appendEvent(request.runId, 'review_completed', {
      task: request.task.id,
      review: reviewId,
      verdict: record.verdict,
      findings: record.findings.length,
      ...(request.integratedTree === undefined ? {} : { tree: request.integratedTree }),
      ...(droppedPaths === 0 ? {} : { droppedPaths }),
      ...(truncated === 0 ? {} : { truncated }),
    });

    await this.recordGates(request);

    return { record };
  }

  /**
   * Runs the reviewer and returns what it proposed, or nothing.
   *
   * Nothing covers every way a review can fail to produce a contract-satisfying answer:
   * an unavailable runner, a timeout, a response that will not parse. All of them mean
   * the same thing downstream — there is no review — and none of them may become one.
   */
  private async ask(
    request: ReviewRequest,
    reviewId: string,
    round: number,
  ): Promise<z.infer<typeof CodeReviewResponseSchema> | undefined> {
    await this.options.store.appendEvent(request.runId, 'review_started', {
      task: request.task.id,
      review: reviewId,
      round,
      ...(request.integratedTree === undefined ? {} : { tree: request.integratedTree }),
    });

    try {
      const result = await this.options.stageRunner.run(
        codeReviewStage(request.task.id, round),
        request.runId,
        {
          taskId: request.task.id,
          taskTitle: request.task.title,
          taskDescription: request.task.description,
          acceptanceCriteria: request.task.acceptanceCriteria.map((line) => `- ${line}`).join('\n'),
          diff: request.diff,
          changedFiles: request.changedFiles.map((file) => `- ${file}`).join('\n'),
          qualityEvidence: evidenceOf(request.commandResults),
          agentsMd: request.agentsMd,
        },
        {
          task: request.task.id,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );

      const parsed = CodeReviewResponseSchema.safeParse(result.data);
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      if (error instanceof StageFailure) return undefined;
      throw error;
    }
  }

  /** How many reviews this task has already had. Counted from the log, never stored. */
  private async roundsFor(runId: string, taskId: string): Promise<number> {
    const existing = await this.options.reviews.readReviews(runId);
    return existing.filter((record) => record.taskId === taskId).length;
  }

  /**
   * Records what each gate said, once, beside the review that will be weighed against it.
   *
   * The gates are projected rather than run: these commands already executed as part of
   * the attempt, and running them again would be a second answer to what they said.
   */
  private async recordGates(request: ReviewRequest): Promise<void> {
    const results = projectQualityGates({
      quality: this.options.config.global.quality,
      registry: buildValidationRegistry(this.options.config.project),
      ran: request.commandResults,
      changedFiles: request.changedFiles,
    });

    for (const gate of results) {
      await this.options.store.appendEvent(request.runId, 'quality_gate_evaluated', {
        task: request.task.id,
        gate: gate.gateId,
        category: gate.category,
        required: gate.required,
        status: gate.status,
        ...(gate.exitCode === undefined ? {} : { exitCode: gate.exitCode }),
        ...(gate.durationMs === undefined ? {} : { durationMs: gate.durationMs }),
      });
    }
  }
}

/** What the commands said, compressed to the line a reviewer needs. */
function evidenceOf(results: readonly CommandResult[]): string {
  if (results.length === 0) return 'No validation commands ran for this change.';

  return results
    .map((result) => `- ${result.command}: exit ${String(result.exitCode)}`)
    .join('\n');
}

/**
 * Declared here rather than in `stages/` because the service is its only caller.
 *
 * `logName` is set per call rather than here, for the reason `implementation` sets one:
 * this stage runs once per task per round, and a fixed name would keep the log of
 * whichever finished last and lose every other.
 */
export function codeReviewStage(taskId: string, round: number): StageDefinition {
  return {
    name: 'code-review',
    role: 'finalReviewer',
    prompt: 'code-review',
    outputSchema: CodeReviewResponseSchema,
    logName: `code-review-${taskId}-${String(round)}`,
  };
}
