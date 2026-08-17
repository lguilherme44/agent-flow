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

/** The review stages whose findings can become work (§29). */
export const CORRECTIVE_ORIGINS = ['plan-review', 'verification', 'final-review'] as const;
export const CorrectiveOriginStageSchema = z.enum(CORRECTIVE_ORIGINS);
export type CorrectiveOriginStage = z.infer<typeof CorrectiveOriginStageSchema>;

/**
 * Where a corrective task came from.
 *
 * The generator this replaces had one channel for traceability — `requirements`
 * — and a finding with no requirement was given `FR-001` so the field could be
 * filled. That is a fabricated relationship: `out_of_scope`, `missing_test`,
 * `security` and `architectural_deviation` findings routinely correspond to no
 * requirement at all, and coverage checking then treats the invented citation as
 * real work against FR-001.
 *
 * So the origin gets its own field. A finding that *does* name a requirement
 * still carries it, unchanged, in both places; a finding that does not carries
 * nothing it did not say.
 */
export const CorrectiveOriginSchema = z.object({
  stage: CorrectiveOriginStageSchema,
  /** The finding's own `type`, verbatim — never normalised into a requirement. */
  findingType: z.string().min(1),
  severity: FindingSeveritySchema,
  /** Present only when the finding named one. */
  requirement: RequirementIdSchema.optional(),
  description: z.string().min(1),
  file: z.string().optional(),
});
export type CorrectiveOrigin = z.infer<typeof CorrectiveOriginSchema>;

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

export const FindingClosureStatusSchema = z.enum([
  'RESOLVED',
  'SUPERSEDED',
  'PROPOSE_ACCEPT_WITH_RATIONALE',
]);
export type FindingClosureStatus = z.infer<typeof FindingClosureStatusSchema>;

export const FindingAdjudicationDecisionSchema = z.enum([
  'ACCEPTED',
  'REJECTED',
  'ACCEPT_AS_RESIDUAL_RISK',
]);
export type FindingAdjudicationDecision = z.infer<typeof FindingAdjudicationDecisionSchema>;

export const FindingAdjudicationSchema = z.object({
  findingIndex: z.number().int().min(0),
  decision: FindingAdjudicationDecisionSchema,
  reason: z.string().optional(),
});
export type FindingAdjudication = z.infer<typeof FindingAdjudicationSchema>;

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
    adjudications: z.array(FindingAdjudicationSchema).default([]),
    residualRisks: z.array(z.string()).default([]),
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
    /**
     * The integration HEAD the reviewer read the code against (§19.2).
     *
     * Absent for reviews written before this field was added, or for plan-only
     * reviews where no integration tree exists yet. When present, enables
     * mechanical freshness assessment: a review is CURRENT only if this matches
     * the run's current `integrationHead`.
     */
    integrationHead: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  })
  .refine((review) => review.verdict === 'PASS' || review.findings.length > 0, {
    message: 'a FAIL verdict must be accompanied by structured findings',
    path: ['findings'],
  });


export type ReviewResult = z.infer<typeof ReviewResultSchema>;
