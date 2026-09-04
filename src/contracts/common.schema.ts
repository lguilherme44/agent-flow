import { z } from 'zod';

/**
 * Logical reasoning effort (§3.1).
 *
 * These are the only values the core ever sees. Each adapter translates them to
 * whatever its CLI accepts — Claude Code takes `xhigh`, Codex takes something
 * else. Letting a physical value reach the core would defeat the abstraction, so
 * the schema rejects them outright.
 */
export const REASONING_ORDER = ['low', 'medium', 'high', 'very_high'] as const;

export const ReasoningLevelSchema = z.enum(REASONING_ORDER);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/**
 * Logical roles the workflow addresses (§3). Stages resolve roles; they never
 * name a runner or a model.
 */
export const WORKFLOW_ROLES = [
  'architect',
  'sdd',
  'planner',
  'planReviewer',
  'executor.trivial',
  'executor.normal',
  'executor.complex',
  'verification',
  'finalReviewer',
] as const;

export const WorkflowRoleSchema = z.enum(WORKFLOW_ROLES);
export type WorkflowRole = z.infer<typeof WorkflowRoleSchema>;

/**
 * Normalised runner failures (§22.1). Adapters translate their CLI's error
 * vocabulary into these; the core decides on the code and never on the text.
 */
export const RUNNER_ERROR_CODES = [
  'quota_exceeded',
  'auth_required',
  'runner_unavailable',
  'timeout',
  'execution_failed',
  'invalid_output',
  'blocked',
] as const;

export const RunnerErrorCodeSchema = z.enum(RUNNER_ERROR_CODES);
export type RunnerErrorCode = z.infer<typeof RunnerErrorCodeSchema>;

/**
 * The only failures a fallback may react to (§55).
 *
 * Fallback is infrastructure, not a correction strategy. Retrying a poor
 * implementation on a different model buries a quality problem instead of
 * surfacing it, so the remaining codes are deliberately excluded here — at the
 * schema level, where config cannot opt back in.
 */
export const FALLBACK_TRIGGERS = ['quota_exceeded', 'auth_required', 'runner_unavailable'] as const;

export const FallbackTriggerSchema = z.enum(FALLBACK_TRIGGERS);
export type FallbackTrigger = z.infer<typeof FallbackTriggerSchema>;

/**
 * What kind of failure this was, one level above the runner transport (AR §3, AD-36).
 *
 * **A refinement of {@link RUNNER_ERROR_CODES}, never a replacement for it.**
 * That list is the *adapter translation* contract — deliberately small, and
 * `FALLBACK_TRIGGERS` is defined as a subset of it at the schema level, so growing
 * it would change fallback reasoning as a side effect. What was missing is the
 * level above: `execution_failed` covered an unsupported effort, a denied command
 * and a genuine implementation failure, which are three failures with three
 * different correct responses.
 *
 * So this enum sits on top, and every class declares which runner code it refines
 * — see `core/failure-classification.ts`, which owns that table. Nothing branches
 * on both: a module reads the class or it reads the code, and the class is the one
 * that carries a recovery disposition.
 *
 * Grouped by the four detection points of AR §3.1–§3.5, in that order, because the
 * group decides whether an attempt was ever spent (I-22).
 */
export const FAILURE_CLASSES = [
  // §3.1 PRE_EXECUTION — knowable before the agent is invoked.
  'project_not_initialized',
  'runner_unavailable',
  'runner_not_authenticated',
  'model_capability_mismatch',
  'permission_not_ready',
  'workspace_not_ready',
  'dependency_environment_not_ready',
  'validation_registry_incomplete',
  // §3.2 RUNNER — the agent was invoked and the process failed.
  'runner_execution_failed',
  'runner_timeout',
  'runner_quota_exhausted',
  'runner_permission_required',
  'malformed_runner_output',
  /**
   * The output parsed, satisfied the schema, and failed a rule about the plan.
   *
   * Distinct from `malformed_runner_output`, which it used to share, and the
   * distinction is what a reader acts on: malformed sends someone looking at the
   * contract or the runner, and this one is the only case where `revise` is the
   * right tool. Measured on a real run — six coherent tasks, valid JSON, rejected
   * because two of them were independent in the DAG and declared the same file.
   */
  'plan_rejected_by_checks',
  // §3.3 TASK — the agent produced work and it was judged.
  'implementation_completed',
  'validation_unsatisfied',
  'acceptance_evidence_missing',
  'acceptance_evidence_unsatisfied',
  'scope_violation',
  'agent_blocked',
  // §3.4 INTEGRATION.
  'merge_conflict',
  'integration_validation_failed',
  'integration_history_invalid',
  // §3.5 REVIEW.
  'semantic_review_failed',
  'final_review_failed',
  'corrective_plan_invalid',
  'corrective_plan_rejected',
] as const;

export const FailureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof FailureClassSchema>;

/**
 * Where a failure sits relative to the moment an agent was invoked (AR §3).
 *
 * Load-bearing rather than descriptive: `PRE_EXECUTION` is exactly the set whose
 * `consumesAttempt` is `no`, which is I-22 — and I-22 is what makes
 * `retry --force` unnecessary for an environment fault.
 */
export const FAILURE_GROUPS = [
  'PRE_EXECUTION',
  'RUNNER',
  'TASK',
  'INTEGRATION',
  'REVIEW',
] as const;

export const FailureGroupSchema = z.enum(FAILURE_GROUPS);
export type FailureGroup = z.infer<typeof FailureGroupSchema>;

/**
 * The disposition of a failure — what may happen next (AR §3.6).
 *
 * Not a failure kind of its own. Every {@link FAILURE_CLASSES} entry maps to
 * exactly one of these, by table rather than by judgement, and
 * `recovery_exhausted` is the one that must always arrive with the AR §3.6
 * escalation contract attached.
 */
export const RECOVERY_DISPOSITIONS = ['recoverable', 'requires_human', 'recovery_exhausted'] as const;

export const RecoveryDispositionSchema = z.enum(RECOVERY_DISPOSITIONS);
export type RecoveryDisposition = z.infer<typeof RecoveryDispositionSchema>;

/**
 * Who is entitled to decide a given failure's response (AR §5).
 *
 * `mechanical` is 20 of AR §5's 22 rows, and the two exceptions are review
 * verdicts — advisory, whose findings re-enter as ordinary tasks through ordinary
 * gates. A row that is `mechanical` spends zero model calls, by contract.
 */
export const FAILURE_AUTHORITIES = ['mechanical', 'llm_advisory', 'human'] as const;

export const FailureAuthoritySchema = z.enum(FAILURE_AUTHORITIES);
export type FailureAuthority = z.infer<typeof FailureAuthoritySchema>;

/**
 * The artifacts a stage can produce — a closed vocabulary, not a path.
 *
 * Declared here rather than in `app/paths.ts`, which is where it used to live and where
 * it still resolves to a filename. The list itself is *vocabulary*: it is what a plan, a
 * message or a review may name when it points at something the run produced, and every
 * other closed vocabulary in this product is declared in the contracts layer for the same
 * reason — a caller that needs to validate a name must not have to import the layer that
 * knows where the file is.
 *
 * `app/paths.ts` re-exports the type and owns the name → path mapping, so no existing
 * import changed and there is still exactly one place that composes a path.
 */
export const ARTIFACT_NAMES = [
  'request',
  'architectureImpact',
  'sdd',
  'plan',
  'planReview',
  'verification',
  'finalReview',
] as const;

export const ArtifactNameSchema = z.enum(ARTIFACT_NAMES);
export type ArtifactName = z.infer<typeof ArtifactNameSchema>;

/** Requirement ids carried by the SDD (§40) and referenced by tasks (§41). */
export const RequirementIdSchema = z
  .string()
  .regex(/^(FR|NFR|SEC)-\d{3}$/, 'expected FR-000, NFR-000 or SEC-000');

export const TaskIdSchema = z.string().regex(/^TASK-\d{3}$/, 'expected TASK-000');

export const FixTaskIdSchema = z.string().regex(/^FIX-\d{3}$/, 'expected FIX-000');

export const AnyTaskIdSchema = z.union([TaskIdSchema, FixTaskIdSchema]);

export const RunIdSchema = z.string().regex(/^AF-\d{4}-\d{3}$/, 'expected AF-YYYY-NNN');

/**
 * A Git object id, lowercase hex, never abbreviated (MVP 2 §5, §10.2).
 *
 * Forty characters because an abbreviation is only unique in the repository that
 * produced it, and only until that repository grows a second object sharing the
 * prefix. Every id recorded through this schema is a claim about one specific
 * commit or tree that a later step re-checks against the repository — and a claim
 * whose meaning can widen is not a claim.
 */
export const CommitOidSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'expected a 40-character lowercase Git object id');

/**
 * A run's Git namespace: its `runId` plus 64 bits of randomness (MVP 2 §5.2).
 *
 * The suffix exists so a new run cannot adopt the refs of an earlier run with the
 * same id whose state was deleted while its branches were not. The randomness is
 * generated by the application layer at run creation; this schema is the shape
 * everything downstream re-validates against, including immediately before the key
 * is composed into a ref name. That re-validation is the ref-injection defence
 * (§22, S-2), and it must not depend on a caller having done its job.
 */
export const GitRunKeySchema = z
  .string()
  .regex(/^AF-\d{4}-\d{3}-[0-9a-f]{16}$/, 'expected AF-YYYY-NNN-<16 lowercase hex>');

/**
 * Where a run's tasks do their work (MVP 2 §4.4, I-13).
 *
 * Captured once, when the run is created, and immutable afterwards — which is why
 * it is a property of the *run* rather than a question asked of the configuration
 * at each execution. A configuration flag consulted per execution describes the
 * machine at that moment; this describes the run, and a run is the thing the
 * workflow makes promises about.
 *
 * Absent is a third state and not a synonym for `none`: a run created before this
 * field existed predates the question entirely (§25.2), and nothing may promote it.
 */
export const ISOLATION_MODES = ['none', 'worktree'] as const;

export const IsolationModeSchema = z.enum(ISOLATION_MODES);
export type IsolationMode = z.infer<typeof IsolationModeSchema>;

/**
 * Identifier of a validation command declared in the project configuration.
 *
 * The shape is the first of two defences. A plan is written by a model, and the
 * repository's own contents feed the prompt that produces it — so plan content
 * is untrusted input. Before this existed, `Task.validation` was a free string
 * that the orchestrator handed to `/bin/sh -c`, which put model-authored text on
 * a shell *outside* the runner's sandbox, the only containment agent-flow has.
 *
 * Restricting the character set means no string accepted here can express a
 * command, a pipe, a redirect or a substitution. The second defence is
 * `checkPlan`, which requires the id to exist in the project configuration.
 */
/**
 * A review, and a finding inside one (M6).
 *
 * Here rather than in `review.schema.ts` because a *message* may reference a finding —
 * that reference is how a developer's response binds to what it answers without a second
 * messaging store — and the collaboration schema cannot import the review schema, which
 * imports it. Shared ids live where both sides can see them.
 */
export const ReviewIdSchema = z.string().regex(/^REV-\d{4}$/, 'expected REV-0000');
export type ReviewId = z.infer<typeof ReviewIdSchema>;

export const FindingIdSchema = z.string().regex(/^FIND-\d{4}$/, 'expected FIND-0000');
export type FindingId = z.infer<typeof FindingIdSchema>;

export const ValidationIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'expected the id of a validation command declared in the project config ' +
      '(lowercase letters, digits and dashes), not a shell command',
  );

export const IsoTimestampSchema = z.iso.datetime();
