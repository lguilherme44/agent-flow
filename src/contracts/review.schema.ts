import { z } from 'zod';
import { AgentIdSchema, CollaborationReferenceSchema } from './collaboration.schema.js';
import {
  AnyTaskIdSchema,
  FindingIdSchema,
  IsoTimestampSchema,
  ReasoningLevelSchema,
  RequirementIdSchema,
  ReviewIdSchema,
  RunIdSchema,
} from './common.schema.js';

/**
 * How much a finding matters, least first.
 *
 * **The order is the contract**, not the listing: `corrective-plan.ts` compares by index
 * to decide what is actionable, and M6's blocking policy compares by index to decide what
 * stops a workflow. `info` joins at the bottom rather than anywhere else for that reason —
 * every existing comparison keeps its meaning and every artifact written before M6 still
 * parses.
 *
 * `info` exists because a reviewer needs somewhere to put an observation that is true,
 * worth reading and not a defect. Without it those arrive as `low`, and `low` is then a
 * bucket holding two different things — which is how a severity policy stops meaning
 * anything.
 */
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Least severe first, so `indexOf` is a comparison. One array, exported, no second copy. */
export function severityAtLeast(severity: FindingSeverity, threshold: FindingSeverity): boolean {
  return FINDING_SEVERITIES.indexOf(severity) >= FINDING_SEVERITIES.indexOf(threshold);
}

/* ─── Where a finding is ───────────────────────────────────────────────────── */

/**
 * A place in a file, when the reviewer could name one.
 *
 * Line numbers only. A column is precision a reviewer reading a diff does not have, and
 * a range that claims it would be a number nobody can act on.
 */
export const SourceLocationSchema = z.object({
  line: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

/**
 * What kind of problem a finding is (M6, §15).
 *
 * Deliberately small, and deliberately open. A closed enum refuses the word a reviewer
 * needed and loses the finding with it; an academic taxonomy is a vocabulary nobody
 * learns. These nine are the ones the existing corrective generator already sees in
 * practice, normalised the way a skill id is.
 */
export const FINDING_CATEGORIES = [
  'correctness',
  'security',
  'requirement',
  'architecture',
  'maintainability',
  'test-gap',
  'performance',
  'accessibility',
  'ux',
] as const;
export type KnownFindingCategory = (typeof FINDING_CATEGORIES)[number];

/**
 * §28. Structured so review output can become FIX tasks without parsing prose.
 *
 * **This is the *proposed* shape — what a model may return.** It carries no id, for the
 * same reason `ProposedMessageSchema` carries no `from`: identity is Agent Flow's to
 * assign, and a field a model can fill is a field a model can forge (§16). The persisted
 * shape is {@link ReviewFindingSchema}, and the normaliser is the only thing that turns
 * one into the other.
 *
 * `type` is the category. It stays a free string rather than becoming an enum, because a
 * closed vocabulary refuses the word a reviewer needed and loses the finding with it —
 * {@link FINDING_CATEGORIES} is the set worth knowing, not the set allowed.
 */
export const FindingSchema = z.object({
  severity: FindingSeveritySchema,
  type: z.string().min(1),
  requirement: RequirementIdSchema.optional(),
  description: z.string().min(1),
  suggestedAction: z.string().min(1),
  /**
   * Deliberately unvalidated *here*, and sanitised at the boundary.
   *
   * A path outside the repository is refused by the normaliser, which drops the field and
   * counts it rather than rejecting the whole finding (M6-ACC-05): a reviewer that
   * pointed at the wrong place still found something. Validating here would mean a single
   * bad path costs the finding, and would also stop this schema from reading an artifact
   * written before the rule existed.
   */
  file: z.string().optional(),
  location: SourceLocationSchema.optional(),
  /** What the reviewer cited. Validated by the reference union, which owns path safety. */
  evidence: z.array(CollaborationReferenceSchema).max(16).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * A finding as it is stored: the proposal, plus the identity Agent Flow gave it.
 *
 * The id is what everything downstream refers to — an acknowledgement, a dispute, a
 * corrective task, a verification — so it has to be allocated by the one thing that can
 * guarantee it is unique within the run.
 */
export const ReviewFindingSchema = FindingSchema.extend({
  id: FindingIdSchema,
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/* ─── The review record ────────────────────────────────────────────────────── */

/**
 * What a reviewer proposes about the change it read.
 *
 * `approve` is a *proposal*. Whether the workflow advances is decided by the quality
 * decision, which weighs this against the gates, the open findings and the tree the
 * review actually read (I-44).
 */
export const REVIEW_VERDICTS = ['approve', 'changes_requested', 'blocked'] as const;
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/**
 * How far the reviewer stood from the author (§19).
 *
 * ```text
 * 3  different provider, different context
 * 2  same provider, different model or context
 * 1  same provider and model, fresh invocation and fresh context
 * 0  same execution context — forbidden, and unreachable by configuration
 * ```
 *
 * Persisted as the level that was actually achieved, so a degradation is a fact on the
 * record rather than a footnote (M6-ACC-03). Level 0 is in the vocabulary only so that a
 * projection can name what it is refusing.
 */
export const INDEPENDENCE_LEVELS = [0, 1, 2, 3] as const;
export const IndependenceLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type IndependenceLevel = z.infer<typeof IndependenceLevelSchema>;

/**
 * One review of one change, as it is written to `reviews.jsonl`.
 *
 * **`reviewedTree` is the field the milestone turns on** (I-41). A review is a statement
 * about one tree; a review whose tree is not the tree now integrated is stale, and a
 * stale review satisfies no gate. Identity, never a timestamp — a review written after a
 * change can still have read what came before it.
 */
export const ReviewRecordSchema = z.object({
  id: ReviewIdSchema,
  runId: RunIdSchema,
  taskId: AnyTaskIdSchema,
  /** 1 for the first review of this task, 2 for the re-review that followed, and so on. */
  round: z.number().int().min(1),
  reviewer: AgentIdSchema,
  /** Who wrote the code. Taken from the assignment, never from the review output (I-42). */
  author: AgentIdSchema,
  independence: IndependenceLevelSchema,
  /** The commit the reviewer read. 40 hex, or absent in sequential mode where none exists. */
  reviewedTree: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  verdict: ReviewVerdictSchema,
  /** The files this review claims to have covered. */
  scope: z.array(z.string().min(1).max(400)).max(200).default([]),
  findings: z.array(ReviewFindingSchema).max(64).default([]),
  summary: z.string().max(4000).optional(),
  createdAt: IsoTimestampSchema,
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

/**
 * Where a finding is in its life (§14) — **projected, never stored** (I-43).
 *
 * Every transition is already a fact the run records: the review that raised it, the
 * message that answered it, the corrective task that integrated, the re-review that saw
 * the corrected tree. A stored copy is the copy a crash between two writes leaves wrong,
 * and it is the copy an agent would eventually be able to write.
 */
export const FINDING_STATUSES = [
  'open',
  'acknowledged',
  'disputed',
  'fixed',
  'verified',
] as const;
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

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

/* ─── Quality gates (M6, §36–§41) ──────────────────────────────────────────── */

/**
 * What kind of evidence a gate produces.
 *
 * **Metadata beside the validation registry, never a second registry** (§36). The command
 * behind an id still comes from `commands` or `validationCommands`, written by a person;
 * this says what running it *means*. Two registries would be two answers to "what does
 * `test` run", and the second one is the one an LLM could eventually reach.
 */
export const QUALITY_CATEGORIES = [
  'typecheck',
  'lint',
  'unit',
  'integration',
  'e2e',
  'visual',
  'security',
  'performance',
  'accessibility',
  'custom',
] as const;
export const QualityCategorySchema = z.enum(QUALITY_CATEGORIES);
export type QualityCategory = z.infer<typeof QualityCategorySchema>;

/**
 * What one gate is, in configuration.
 *
 * `required` is the whole point and it is a human's to set (§39). No model output can
 * change it, and no model may decide that a required gate does not apply — a UtilityModel
 * may suggest applicability and may never switch one off (§40).
 */
export const QualityGateConfigSchema = z.object({
  category: QualityCategorySchema.default('custom'),
  required: z.boolean().default(false),
  /**
   * Globs that make this gate applicable, matched mechanically against the change.
   *
   * Absent means always applicable. Present means the gate applies when the change
   * touches something matching — the same segment-aware matcher the ownership map uses,
   * because two path matchers is two answers about the same path.
   */
  appliesTo: z.array(z.string().min(1).max(200)).max(32).optional(),
});
export type QualityGateConfig = z.infer<typeof QualityGateConfigSchema>;

export const QualityConfigSchema = z.object({
  gates: z.record(z.string().min(1).max(64), QualityGateConfigSchema).prefault({}),
  /**
   * Whether a `medium` finding blocks (§44).
   *
   * `critical` and `high` always block and `low` and `info` never do; `medium` is the one
   * an operator has an opinion about. Configured rather than decided per run by a model,
   * which is the property that matters — the threshold itself is a default, not a law.
   */
  blockOnMedium: z.boolean().default(true),
});
export type QualityConfig = z.infer<typeof QualityConfigSchema>;

/**
 * The four things a gate can be — and the third is the one that matters (§41, I-45).
 *
 * `not_run` is not `failed` and is never `passed`. An environment that could not answer
 * is not a codebase that answered no, and a required gate that did not run blocks exactly
 * as a failed one does. This product already learned that once, at run granularity; this
 * is the same rule per gate.
 */
export const GATE_STATUSES = ['passed', 'failed', 'not_run', 'not_applicable'] as const;
export const GateStatusSchema = z.enum(GATE_STATUSES);
export type GateStatus = z.infer<typeof GateStatusSchema>;

/** One gate's outcome, projected from validation the executor already ran. */
export const QualityGateResultSchema = z.object({
  gateId: z.string().min(1).max(64),
  category: QualityCategorySchema,
  required: z.boolean(),
  status: GateStatusSchema,
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0).optional(),
  /** Why it did not run, or did not apply. Absent when it ran. */
  detail: z.string().max(500).optional(),
});
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;
