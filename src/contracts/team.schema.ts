import { z } from 'zod';
import { AgentIdSchema } from './collaboration.schema.js';
import {
  AnyTaskIdSchema,
  IsoTimestampSchema,
  WorkflowRoleSchema,
  type WorkflowRole,
} from './common.schema.js';

/**
 * Who forms a team, what each member can do, and who is expected to touch what (M5).
 *
 * M4 answered *who the agents are*. This answers the four questions that turn a roster
 * into an assignment: which agents form a team, what each can do, who should receive a
 * given task, and which work may happen at once.
 *
 * **Nothing here is a second identity.** `AgentIdentity` is M4's and stays M4's; a
 * `TeamMember` is the configuration a member's identity is *derived from*, and the
 * derivation produces the same `AgentIdentity` every existing consumer already reads.
 * Two identities for one agent is the drift this file is written to avoid.
 */

/* ─── Skills ───────────────────────────────────────────────────────────────── */

/**
 * A normalised skill identifier.
 *
 * **Validated but open**, which is the balance the milestone asks for. A closed enum
 * would make every new stack a product release; a free string would make `Vue`, `vue`
 * and ` vue ` three skills that score zero against each other, and a matcher that
 * silently scores zero is worse than one that refuses.
 *
 * The character class is `ValidationIdSchema`'s, for the same reason: a skill id reaches
 * a log line, a projection key and a scoring table.
 */
export const SkillIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'expected a normalised skill id: lowercase letters, digits and dashes',
  );
export type SkillId = z.infer<typeof SkillIdSchema>;

/**
 * Turns what a person typed into a `SkillId`, or `undefined` when nothing survives.
 *
 * **The only place a string becomes a skill.** Two normalisers is two answers to whether
 * `Node.js` and `nodejs` are the same skill, and the one that is wrong is the one nobody
 * runs. Case is folded, whitespace and dots and underscores become dashes, runs of
 * dashes collapse, and the ends are trimmed — so `  Node.JS  `, `node_js` and `Node-JS`
 * all arrive as `node-js`.
 */
export function normaliseSkill(raw: string): SkillId | undefined {
  const normalised = raw
    .trim()
    .toLowerCase()
    .replace(/[\s._/]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return SkillIdSchema.safeParse(normalised).success ? normalised : undefined;
}

/** Every distinct skill in a list, normalised, in first-seen order. */
export function normaliseSkills(raw: readonly string[]): SkillId[] {
  const seen = new Set<SkillId>();
  for (const candidate of raw) {
    const skill = normaliseSkill(candidate);
    if (skill !== undefined) seen.add(skill);
  }
  return [...seen];
}

/* ─── Capacity ─────────────────────────────────────────────────────────────── */

/**
 * How much work one member may hold at once.
 *
 * One field, deliberately. Modelling an imaginary human CPU is not the job, and one
 * number is what the scheduler can actually act on — everything else would be a setting
 * nothing reads.
 *
 * **Busy is never stored** (I-39). Whether a member is at its limit is derived from the
 * run's own task states; a persisted `busy: true` outlives the crash that ended the work.
 */
export const AgentCapacitySchema = z.object({
  maxConcurrentTasks: z.number().int().min(1).default(1),
});
export type AgentCapacity = z.infer<typeof AgentCapacitySchema>;

/* ─── Ownership ────────────────────────────────────────────────────────────── */

/**
 * What a member is expected to work on.
 *
 * **Coordination, never containment** (I-37). The execution boundary is the worktree and
 * the process; ownership decides who *should* take a task and which two tasks must not
 * share a wave. An ownership rule that was load-bearing for safety would be a sandbox
 * implemented in a policy file, and it would be the weakest one in the product.
 *
 * Three modes and no more without a case for a fourth:
 *
 *   - `preferred` — a ranking signal. The owner is scored up; others are not refused.
 *   - `exclusive` — two tasks writing here may not share a wave, whoever holds them.
 *   - `shared` — explicitly anyone's. Overlap detection still applies.
 */
export const OWNERSHIP_MODES = ['preferred', 'exclusive', 'shared'] as const;

export const OwnershipModeSchema = z.enum(OWNERSHIP_MODES);
export type OwnershipMode = z.infer<typeof OwnershipModeSchema>;

/**
 * A path pattern an ownership rule covers.
 *
 * Repository-relative and bounded to the same shapes a plan's `files.likely` may hold.
 * The traversal defences are `validateAndNormalizeRepositoryPath`'s and are applied by
 * the matcher rather than restated here — a second path rule is a second chance to miss
 * one of `..`, a drive letter or a percent-encoded separator.
 *
 * `**` and `*` are the only wildcards, because the plan writes literal paths and the
 * ownership map only has to cover directories.
 */
export const ResourcePatternSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9_.*/-]+$/,
    'expected a repository-relative path pattern, such as src/server/**',
  );
export type ResourcePattern = z.infer<typeof ResourcePatternSchema>;

export const OwnershipRuleSchema = z.object({
  preferred: z.array(ResourcePatternSchema).max(64).default([]),
  exclusive: z.array(ResourcePatternSchema).max(64).default([]),
  shared: z.array(ResourcePatternSchema).max(64).default([]),
});
export type OwnershipRule = z.infer<typeof OwnershipRuleSchema>;

/* ─── Members and teams ────────────────────────────────────────────────────── */

export const TeamMemberConfigSchema = z.object({
  /**
   * The logical role this member serves.
   *
   * Kept from M4's vocabulary rather than replaced: a role is what a *stage* asks for,
   * and a member is who answers. Two members may serve one role, which is the whole
   * reason a team is not a roster.
   */
  role: WorkflowRoleSchema,
  runner: z.string().min(1),
  model: z.string().min(1).optional(),
  displayName: z.string().min(1).max(120).optional(),
  /**
   * Raw as the operator wrote them; normalised at derivation.
   *
   * Accepted unnormalised on purpose — a configuration file is written by a person, and
   * refusing `TypeScript` because it is not `typescript` would be a schema being clever
   * at the operator's expense.
   */
  skills: z.array(z.string().min(1).max(60)).max(32).default([]),
  specializations: z.array(z.string().min(1).max(60)).max(16).default([]),
  capacity: AgentCapacitySchema.prefault({}),
  ownership: OwnershipRuleSchema.prefault({}),
});
export type TeamMemberConfig = z.infer<typeof TeamMemberConfigSchema>;

export const TeamPoliciesSchema = z.object({
  /**
   * **How many times a task may change hands is `collaboration.maxHandoffsPerTask`,
   * not a second budget here.**
   *
   * A `maxReassignmentsPerTask` lived on this object for one commit and the architecture
   * rule against dead core exports caught what it had done: it left `admitHandoff`
   * — the function that already reads the collaboration budget — with no caller, which
   * is what one concept with two names looks like from the outside. A handoff accepted
   * is a reassignment; there was never a second thing to bound.
   *
   * What remains here is the permission, which is genuinely a team's to grant.
   */

  /**
   * Whether an accepted handoff may be *considered* by the assignment policy.
   *
   * Distinct from M4's `collaboration.handoffsReassignExecution`, which this supersedes
   * in meaning: that flag used to make an accepted handoff assign the target directly,
   * and now it makes one eligible for a decision the policy still owns.
   */
  admitHandoffs: z.boolean().default(false),
});
export type TeamPolicies = z.infer<typeof TeamPoliciesSchema>;

export const TeamConfigSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  members: z.record(AgentIdSchema, TeamMemberConfigSchema),
  policies: TeamPoliciesSchema.prefault({}),
});
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

/**
 * The `teams:` block, keyed by team id.
 *
 * A record rather than an array so a team has a stable id that is not its position and
 * not its display name — the same reason `runners:` and `roles:` are records.
 *
 * Absent in every configuration written before M5, and absent means *legacy*: the roster
 * is derived from `roles:` and assignment is the router's, byte-for-byte.
 */
export const TeamsConfigSchema = z.record(z.string().min(1).max(64), TeamConfigSchema);
export type TeamsConfig = z.infer<typeof TeamsConfigSchema>;

/* ─── Assignment ───────────────────────────────────────────────────────────── */

/**
 * Why a candidate was ruled out, before any score was compared.
 *
 * **Eligibility precedes ranking**, and this enum is how that stays true: a candidate
 * with an exclusion never reaches the comparison, however well it would have scored.
 */
export const CANDIDATE_EXCLUSIONS = [
  'role_mismatch',
  'runner_capability',
  'ownership',
  'capacity',
] as const;

export const CandidateExclusionSchema = z.enum(CANDIDATE_EXCLUSIONS);
export type CandidateExclusion = z.infer<typeof CandidateExclusionSchema>;

export const CandidateScoreSchema = z.object({
  agentId: AgentIdSchema,
  /** 0…1. Meaningless when `excludedBy` is set, and reported anyway — see below. */
  score: z.number(),
  skillMatch: z.number(),
  ownership: z.number(),
  riskFit: z.number(),
  /** The skills the task asked for that this member declares. */
  matchedSkills: z.array(SkillIdSchema).default([]),
  /**
   * Present when this member was ruled out.
   *
   * Kept in the list rather than filtered out of it, because "why did Backend not get
   * this" is the question an operator asks and a filtered list cannot answer.
   */
  excludedBy: CandidateExclusionSchema.optional(),
});
export type CandidateScore = z.infer<typeof CandidateScoreSchema>;

/**
 * Why this task is on this agent.
 *
 * `routed` is the legacy path and the fallback for every refusal, so a run with no team
 * configured records exactly what M4 recorded.
 */
export const ASSIGNMENT_REASONS = [
  'routed',
  'team_match',
  'handoff_admitted',
  'handoff_not_admitted',
  'handoff_refused_capability',
  'handoff_budget_exhausted',
  'no_eligible_member',
  'reassigned',
] as const;

export const AssignmentReasonSchema = z.enum(ASSIGNMENT_REASONS);
export type AssignmentReason = z.infer<typeof AssignmentReasonSchema>;

export const TaskAssignmentSchema = z.object({
  taskId: AnyTaskIdSchema,
  agentId: AgentIdSchema,
  /** The role the router chose. Kept beside the agent because the plan is written in roles. */
  role: WorkflowRoleSchema,
  reason: AssignmentReasonSchema,
  /**
   * Every member considered, ranked, with what each scored and what ruled it out.
   *
   * I-34: "the AI decided" is not an answer. This is the answer.
   */
  candidates: z.array(CandidateScoreSchema).max(64).default([]),
  /** A sentence for a person, when the reason alone does not say enough. */
  detail: z.string().max(500).optional(),
  /** Set on a reassignment, naming who held it before. */
  previousAgentId: AgentIdSchema.optional(),
  assignedAt: IsoTimestampSchema,
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;

/**
 * What a task needs, derived from the plan before any member is considered.
 *
 * **Derived from data the plan already carries**, and from a model only where it does
 * not: `complexity`, `risk` and `files.likely` are on the task, and the capability
 * requirements come from the implementation prompt's front matter exactly as
 * `resolveRole` already reads them. A model call to classify something the planner has
 * already written down would be a second, worse answer.
 */
export interface TaskRequirements {
  readonly taskId: string;
  readonly role: WorkflowRole;
  readonly complexity: 'trivial' | 'normal' | 'complex';
  readonly risk: 'low' | 'medium' | 'high';
  readonly files: readonly string[];
  readonly skills: readonly SkillId[];
  /** Where each skill came from, so an operator can tell inference from configuration. */
  readonly skillSources: Readonly<Record<string, 'scope' | 'ownership' | 'advisory'>>;
}
