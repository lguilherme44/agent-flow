import { z } from 'zod';
import { ReasoningLevelSchema, RequirementIdSchema } from './common.schema.js';

export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** §28. Structured so review output can become FIX tasks without parsing prose. */
export const FindingSchema = z.object({
  severity: FindingSeveritySchema,
  type: z.string().min(1),
  requirement: RequirementIdSchema.optional(),
  description: z.string().min(1),
  suggestedAction: z.string().min(1),
  file: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * Whether the reviewer was genuinely independent of the author (§56, R-16).
 *
 * The stated purpose of cross-provider review (§3.2) is to avoid one model
 * confirming its own mistaken hypothesis. With a single healthy provider that
 * protection is gone — so the artifact records it as a first-class field rather
 * than a footnote, and readers can weigh the verdict accordingly.
 */
export const IndependenceSchema = z.enum(['cross-provider', 'same-provider-fresh-context']);
export type Independence = z.infer<typeof IndependenceSchema>;

export const ReviewResultSchema = z
  .object({
    verdict: z.enum(['PASS', 'FAIL']),
    independence: IndependenceSchema,
    reviewer: z.object({
      runner: z.string().min(1),
      model: z.string().optional(),
      reasoning: ReasoningLevelSchema,
    }),
    findings: z.array(FindingSchema).default([]),
  /**
   * The plan this verdict is about.
   *
   * A review is a statement concerning one specific document. Without this,
   * a plan that changed after being reviewed still carried its old verdict —
   * and the approval gate quoted findings about tasks that no longer existed.
   * Optional so reviews written before the field remain readable.
   */
  planHash: z.string().min(1).optional(),
    summary: z.string().optional(),
  })
  .refine((review) => review.verdict === 'PASS' || review.findings.length > 0, {
    message: 'a FAIL verdict must be accompanied by structured findings',
    path: ['findings'],
  });

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
