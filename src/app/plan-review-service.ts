import type { Plan, ReviewResult, RunEvent } from '../contracts/index.js';
import { assessIndependence, explainIndependence, type ProviderOf } from '../core/independence.js';
import { planHash } from './approval.js';
import type { StageRunner } from './stage-runner.js';
import type { StateStore } from './state-store.js';
import {
  PLAN_REVIEW_STAGE,
  PLAN_REVIEW_SIMPLE_STAGE,
  PlanReviewResponseSchema,
  buildReviewResult,
} from './stages/plan-review.js';

export interface PlanReviewServiceOptions {
  readonly store: StateStore;
  readonly stageRunner: StageRunner;
  /** Maps a runner id to its provider, for judging review independence. */
  readonly providerOf: ProviderOf;
}

export interface PlanReviewRequest {
  readonly runId: string;
  /** The plan this verdict will be bound to. */
  readonly plan: Plan;
  readonly sdd: string;
  readonly architectureImpact: string;
  /**
   * The runners that produced what is being reviewed.
   *
   * For a freshly planned document that is the planner. For a corrective plan it
   * is the planner *and* the reviewer whose findings became the FIX tasks — a
   * plan review by that same provider would be judging work derived from its own
   * conclusions, which is exactly what independence is supposed to rule out.
   */
  readonly authors: readonly string[];
}

/**
 * Runs the plan review, wherever a plan comes from.
 *
 * Extracted because there are now two producers of plans — the planning pipeline
 * and the corrective loop — and only one of them had a review. The corrective
 * loop consequently left a plan whose only review described the *previous*
 * document, so `approve` refused it and the live workflow required
 * `approve --force` on every corrective round. `--force` is an override for a
 * guarantee deliberately given up; a mandatory `--force` is a broken gate.
 *
 * Everything the verdict depends on lives here exactly once: stage execution,
 * independence judged from what actually ran, the degradation a same-provider
 * review implies, the plan hash the verdict is bound to, and the artifact.
 */
export class PlanReviewService {
  constructor(private readonly options: PlanReviewServiceOptions) {}

  async review(request: PlanReviewRequest): Promise<ReviewResult> {
    const { store, providerOf } = this.options;

    const result = await this.options.stageRunner.run(PLAN_REVIEW_STAGE, request.runId, {
      sdd: request.sdd,
      architectureImpact: request.architectureImpact,
      plan: JSON.stringify(request.plan, null, 2),
    });

    const response = PlanReviewResponseSchema.parse(result.data);

    // Judged after the fact, from what ran on both sides. Deriving it from
    // configuration beforehand meant a reviewer that fell back onto the
    // planner's runner still produced an artifact claiming independence.
    const independence = assessIndependence(request.authors, result.execution.runner, providerOf);

    if (independence === 'same-provider-fresh-context') {
      // §56 allows this, but the protection cross-provider review exists to
      // provide is simply absent — so it is recorded on the run rather than
      // left for a reader to infer (R-16).
      await store.recordDegradation(request.runId, {
        kind: 'single_provider',
        reason: explainIndependence(request.authors, result.execution.runner, providerOf),
        impact:
          'the plan review is same-provider: a wrong assumption made while planning may be ' +
          'repeated rather than caught',
      });
    }

    const review = buildReviewResult(
      response,
      {
        runner: result.execution.runner,
        ...(result.execution.model === undefined ? {} : { model: result.execution.model }),
        reasoning: result.execution.reasoning,
      },
      independence,
      planHash(request.plan),
    );

    await store.writeArtifact(request.runId, 'planReview', `${JSON.stringify(review, null, 2)}\n`);
    return review;
  }

  async reviewSimple(request: {
    runId: string;
    plan: Plan;
    featureRequest: string;
    authors: readonly string[];
  }): Promise<ReviewResult> {
    const { store, providerOf } = this.options;

    const result = await this.options.stageRunner.run(PLAN_REVIEW_SIMPLE_STAGE, request.runId, {
      featureRequest: request.featureRequest,
      plan: JSON.stringify(request.plan, null, 2),
    });

    const response = PlanReviewResponseSchema.parse(result.data);

    const independence = assessIndependence(request.authors, result.execution.runner, providerOf);

    if (independence === 'same-provider-fresh-context') {
      await store.recordDegradation(request.runId, {
        kind: 'single_provider',
        reason: explainIndependence(request.authors, result.execution.runner, providerOf),
        impact:
          'the plan review is same-provider: a wrong assumption made while planning may be ' +
          'repeated rather than caught',
      });
    }

    const review = buildReviewResult(
      response,
      {
        runner: result.execution.runner,
        ...(result.execution.model === undefined ? {} : { model: result.execution.model }),
        reasoning: result.execution.reasoning,
      },
      independence,
      planHash(request.plan),
    );

    await store.writeArtifact(request.runId, 'planReview', `${JSON.stringify(review, null, 2)}\n`);
    return review;
  }
}

/**
 * The runners that actually executed a stage, newest last.
 *
 * Read from the run's own event log rather than from configuration, for the same
 * reason `authorsOf` is: a later command loads the configuration as it stands
 * *now*, which describes what would run today, not what ran then. A fallback
 * during planning, or an edited config, both break that assumption.
 */
export function stageRunnersOf(events: readonly RunEvent[], stage: string): string[] {
  const runners = new Set<string>();

  for (const event of events) {
    if (event.type !== 'stage_completed') continue;
    if (event.detail['stage'] !== stage) continue;

    const runner = event.detail['runner'];
    if (typeof runner === 'string' && runner.length > 0) runners.add(runner);
  }

  return [...runners];
}
