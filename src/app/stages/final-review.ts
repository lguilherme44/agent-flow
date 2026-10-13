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

/**
 * What the e2e agent returns: a third verdict, because "could not run" is its own answer.
 *
 * It used to be folded into `PASS` with a `NOT RUN:` summary, and a pass is what the run
 * read. `NOT_RUN` must say what was missing, the same way a `FAIL` must say what failed.
 */
export const E2EResponseSchema = z
  .object({
    verdict: z.enum(['PASS', 'FAIL', 'NOT_RUN']),
    summary: z.string().optional(),
    findings: z.array(FindingSchema).default([]),
  })
  .refine((review) => review.verdict === 'PASS' || review.findings.length > 0, {
    message: 'a FAIL or NOT_RUN verdict must be accompanied by at least one finding',
    path: ['findings'],
  });

export const E2E_STAGE: StageDefinition = {
  name: 'e2e',
  role: 'e2e',
  prompt: 'e2e',
  outputSchema: E2EResponseSchema,
};

/** A summary that opens by saying the check never happened: `NOT RUN`, or `NOT_RUN`. */
const NOT_RUN_SUMMARY = /^\s*NOT[ _]RUN\b/i;

/**
 * Reads the old convention as what it always meant: a `PASS` whose summary opens with
 * `NOT RUN` is a NOT_RUN.
 *
 * The schema gained a third verdict and the prompt asks for it, but a model that answers
 * the way it was taught before still produces `{verdict: 'PASS', summary: 'NOT RUN: …'}`,
 * and that is exactly the shape that took pilot 75559 to FEATURE COMPLETE on a change
 * nobody had seen work. Anchored at the start, so a summary that merely mentions something
 * that "did not run" is left alone. Applied right after parsing, before anything reads
 * the verdict.
 */
export function normaliseE2EResponse(
  response: z.infer<typeof E2EResponseSchema>,
): z.infer<typeof E2EResponseSchema> {
  return response.verdict === 'PASS' && NOT_RUN_SUMMARY.test(response.summary ?? '')
    ? { ...response, verdict: 'NOT_RUN' }
    : response;
}

/** Why e2e did not run, in the words a person reads: the summary, else the first finding. */
export function notRunReason(response: z.infer<typeof E2EResponseSchema>): string {
  const summary = response.summary?.replace(/^\s*NOT[ _]RUN:?\s*/i, '').trim();
  if (summary !== undefined && summary.length > 0) return summary;
  return response.findings[0]?.description ?? 'no reason given';
}

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
  integrationHead?: string | undefined,
): ReviewResult {
  return ReviewResultSchema.parse({
    verdict: response.verdict,
    independence,
    reviewer: provenance,
    findings: response.findings,
    ...(response.summary === undefined ? {} : { summary: response.summary }),
    ...(integrationHead === undefined ? {} : { integrationHead }),
  });
}
