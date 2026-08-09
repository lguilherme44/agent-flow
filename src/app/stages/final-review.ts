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
 * What a reviewing agent returns.
 *
 * The reviewer reports a verdict and findings; agent-flow supplies the
 * provenance. Asking a model to describe its own independence would be asking
 * it to grade its own homework.
 */
export const ReviewResponseSchema = z
  .object({
    verdict: z.enum(['PASS', 'FAIL']),
    summary: z.string().optional(),
    findings: z.array(FindingSchema).default([]),
  })
  .refine((review) => review.verdict === 'PASS' || review.findings.length > 0, {
    message: 'a FAIL verdict must be accompanied by at least one finding',
    path: ['findings'],
  });

export const VERIFICATION_STAGE: StageDefinition = {
  name: 'verification',
  role: 'verification',
  prompt: 'verification',
  outputSchema: ReviewResponseSchema,
};

export const FINAL_REVIEW_STAGE: StageDefinition = {
  name: 'final-review',
  role: 'finalReviewer',
  prompt: 'final-review',
  outputSchema: ReviewResponseSchema,
};

/**
 * Whether the final reviewer is a different provider from the implementers.
 *
 * Compares against every executor role, not just one: if any of them shares the
 * reviewer's runner, the same model both wrote code and judged it, and §3.2's
 * protection against a repeated wrong assumption does not apply.
 */
export function finalReviewIndependence(config: GlobalConfig): Independence {
  const reviewer = roleConfigOf(config.roles, 'finalReviewer').runner;
  const implementers = [
    roleConfigOf(config.roles, 'executor.trivial').runner,
    roleConfigOf(config.roles, 'executor.normal').runner,
    roleConfigOf(config.roles, 'executor.complex').runner,
  ];

  return implementers.includes(reviewer) ? 'same-provider-fresh-context' : 'cross-provider';
}

export function buildReview(
  response: z.infer<typeof ReviewResponseSchema>,
  provenance: { runner: string; model?: string; reasoning: ReviewResult['reviewer']['reasoning'] },
  independence: Independence,
): ReviewResult {
  return ReviewResultSchema.parse({
    verdict: response.verdict,
    independence,
    reviewer: provenance,
    findings: response.findings,
    ...(response.summary === undefined ? {} : { summary: response.summary }),
  });
}

/**
 * Turns review findings into corrective tasks (§29).
 *
 * They re-enter the same pipeline — routed, executed and verified like any
 * other task — rather than being handed straight to a model to patch. A fix
 * that skips the gate is exactly the kind of unreviewed change the workflow
 * exists to prevent.
 */
export function findingsToTasks(
  review: ReviewResult,
  options: { minSeverity?: 'low' | 'medium' | 'high' | 'critical'; startIndex?: number } = {},
): Array<Record<string, unknown>> {
  const order = ['low', 'medium', 'high', 'critical'];
  const threshold = order.indexOf(options.minSeverity ?? 'medium');

  return review.findings
    .filter((finding) => order.indexOf(finding.severity) >= threshold)
    .map((finding, index) => ({
      id: `FIX-${String((options.startIndex ?? 0) + index + 1).padStart(3, '0')}`,
      title: finding.description.slice(0, 80),
      description: `${finding.description}\n\nSuggested action: ${finding.suggestedAction}`,
      complexity: finding.severity === 'critical' || finding.severity === 'high' ? 'complex' : 'normal',
      risk: finding.severity === 'critical' ? 'high' : finding.severity === 'high' ? 'medium' : 'low',
      dependencies: [],
      requirements: finding.requirement === undefined ? ['FR-001'] : [finding.requirement],
      files: { likely: finding.file === undefined ? [] : [finding.file] },
      acceptanceCriteria: [finding.suggestedAction],
      validation: [],
    }));
}
