import { z } from 'zod';
import {
  FindingSchema,
  ReviewResultSchema,
  type Independence,
  type ReviewResult,
  type RunEvent,
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
 * The runners that actually wrote the code under review.
 *
 * Read from the run's own event log rather than from the executor roles,
 * because `review` is a separate invocation and the configuration it loads
 * describes what *would* run now, not what ran then. A fallback during the run,
 * or a configuration edited between the two commands, both break that
 * assumption — and both would have produced an artifact claiming independence
 * of work the reviewer had in fact done itself.
 */
export function authorsOf(events: readonly RunEvent[]): string[] {
  const runners = new Set<string>();

  for (const event of events) {
    if (event.type !== 'task_finished') continue;
    const runner = event.detail['runner'];
    if (typeof runner === 'string' && runner.length > 0) runners.add(runner);
  }

  return [...runners];
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
