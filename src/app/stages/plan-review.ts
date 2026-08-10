import { z } from 'zod';
import {
  FindingSchema,
  ReviewResultSchema,
  roleConfigOf,
  type GlobalConfig,
  type Independence,
  type ReviewResult,
} from '../../contracts/index.js';
import type { StageDefinition } from '../stage-runner.js';

/**
 * What the reviewer is asked to return.
 *
 * Narrower than `ReviewResult`: the reviewer reports a verdict and findings, and
 * agent-flow supplies the provenance — which runner ran, and whether it was
 * genuinely independent of the author. Letting a model describe its own
 * independence would be asking it to grade its own homework.
 */
export const PlanReviewResponseSchema = z
  .object({
    verdict: z.enum(['PASS', 'FAIL']),
    summary: z.string().optional(),
    findings: z.array(FindingSchema).default([]),
  })
  .refine((review) => review.verdict === 'PASS' || review.findings.length > 0, {
    message: 'a FAIL verdict must be accompanied by at least one finding',
    path: ['findings'],
  });

export const PLAN_REVIEW_STAGE: StageDefinition = {
  name: 'plan-review',
  role: 'planReviewer',
  prompt: 'plan-review',
  outputSchema: PlanReviewResponseSchema,
};

/**
 * The runner a role is configured to use, before anything has run.
 *
 * Kept only for `--dry-run` style reporting. Independence is decided from what
 * actually executed — see `core/independence.ts`.
 */
export function configuredRunner(config: GlobalConfig, role: 'planner' | 'planReviewer'): string {
  return roleConfigOf(config.roles, role).runner;
}

/** Combines the reviewer's answer with provenance agent-flow knows. */
export function buildReviewResult(
  response: z.infer<typeof PlanReviewResponseSchema>,
  provenance: { runner: string; model?: string; reasoning: ReviewResult['reviewer']['reasoning'] },
  independence: Independence,
  /** The plan this verdict is about, so it cannot outlive it. */
  planHash?: string,
): ReviewResult {
  return ReviewResultSchema.parse({
    verdict: response.verdict,
    independence,
    reviewer: provenance,
    findings: response.findings,
    ...(planHash === undefined ? {} : { planHash }),
    ...(response.summary === undefined ? {} : { summary: response.summary }),
  });
}
