import { z } from 'zod';
import {
  CommitOidSchema,
  FailureClassSchema,
  GitRunKeySchema,
  IsolationModeSchema,
  IsoTimestampSchema,
  RunIdSchema,
} from './common.schema.js';
import { TaskStateSchema } from './task.schema.js';

/** Pipeline stages, in order. `stage` on a run points at the last one reached. */
export const RUN_STAGES = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'implementation',
  /**
   * One change, reviewed by somebody who did not write it (M6).
   *
   * Distinct from `verification` and `final-review`, which are run-level and ask about
   * the whole feature. This runs per task, against the tree that task integrated as, and
   * it is the only review whose freshness can be checked — because it is the only one
   * that names a single tree.
   */
  'code-review',
  'verification',
  'final-review',
] as const;

export const RunStageSchema = z.enum(RUN_STAGES);
export type RunStage = z.infer<typeof RunStageSchema>;

/**
 * The pipeline as a person sees it (§71).
 *
 * Ten entries where `RUN_STAGES` has nine: `approval` is a step in the user's
 * mental model and in the specification's pipeline, but nothing *executes* for
 * it — so it has no events and can never appear in `state.stage`. Keeping the
 * two lists separate is what stops a display concern from becoming a stage the
 * state machine has to pretend to run.
 *
 * `code-review` joined both in M6. It executes — once per task, like
 * `implementation` — and it is a phase a person watching a run expects to see,
 * so leaving it out of the picture would have hidden the thing the milestone adds.
 */
export const PIPELINE_STAGES = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'approval',
  'implementation',
  'code-review',
  'verification',
  'final-review',
] as const;

export const PipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const PIPELINE_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'blocked',
  'waiting_approval',
] as const;

export const PipelineStatusSchema = z.enum(PIPELINE_STATUSES);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const RUN_STATUSES = [
  'running',
  'waiting_for_approval',
  'plan_rejected',
  'approved',
  'completed',
  'failed',
  /**
   * An operator stopped this run (PRI-14).
   *
   * The one terminal outcome that is neither `completed` nor `failed`, and it earns a
   * member of this enum for exactly that reason: reporting a cancelled run as failed would
   * make the dashboard, the Definition of Done and `status --json` all describe a person's
   * decision as a defect.
   *
   * **Only cancel writes it, and nothing writes over it.** A run reaching here has had its
   * process groups terminated and its evidence retained; the tasks that were running are
   * `interrupted`, the queued ones are still queued, and the integration branch and the
   * failed worktrees are still on disk. What is gone is the intent to continue.
   */
  'cancelled',
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * A capability the environment lost while still being able to work (R-16).
 *
 * The danger of the ternary health model (C-2) is that DEGRADED quietly becomes
 * the normal state. Persisting the reason on the run — rather than printing a
 * warning that scrolls away — is what keeps the loss visible at approval time.
 */
export const DEGRADATION_KINDS = [
  'runner_unavailable_with_fallback',
  'single_provider',
  'auth_unverified',
  'reasoning_clamped',
  // A human overruled a gate. Not a malfunction — a guarantee the workflow
  // normally provides, deliberately given up, which is exactly what this
  // channel exists to carry.
  'forced_approval',
  // The run asked for more parallelism than the product can isolate, and got
  // less. Here rather than in a log line for the reason the channel exists: the
  // question "why did this run one task at a time when I configured four" is
  // asked long after the terminal has scrolled, and the honest answer belongs on
  // the run. Recorded only when the two numbers actually differ.
  'parallelism_clamped',
] as const;

export const DegradationSchema = z.object({
  kind: z.enum(DEGRADATION_KINDS),
  reason: z.string().min(1),
  /** What the user actually loses. Never a generic warning. */
  impact: z.string().min(1),
  detectedAt: IsoTimestampSchema,
});
export type Degradation = z.infer<typeof DegradationSchema>;

/**
 * Why a task sits in `blocked` (§20, §23).
 *
 * Two very different reasons share the state, and conflating them is what made
 * dependency-derived blocks unrecoverable: a task whose *own* agent answered
 * BLOCKED is exactly what §23 says must not be retried automatically, while a
 * task held back because an upstream task failed **never ran** and has no
 * answer of its own to protect. `blockReason` records which one this is on the
 * persisted task, so `blocked` stops meaning two things at once.
 *
 * Absent (legacy state written before this field existed) the conservative
 * default is `agent`: "no reason recorded" is evidence of nothing, so the task
 * stays force-gated rather than being guessed at.
 */
export const BLOCK_REASONS = ['agent', 'dependency'] as const;
export const BlockReasonSchema = z.enum(BLOCK_REASONS);
export type TaskBlockReason = z.infer<typeof BlockReasonSchema>;

export const TaskProgressSchema = z.object({
  id: z.string().min(1),
  state: TaskStateSchema,
  /**
   * **Work** attempts, and only those (AR §4.4, AD-37).
   *
   * The field is unchanged and so is its default; what narrows is its *meaning*.
   * An attempt is one invocation of an AgentRunner for one task, in one prepared
   * workspace, whose work was observed and judged — so everything the run knew, or
   * could have known, before invoking the agent belongs in
   * {@link TaskProgressSchema.shape.infrastructureFailures} instead.
   *
   * This is the counter `retry` gates on, which is why the split matters: one task
   * in the evidence run spent its second attempt on a denied `grep` — an
   * environment fact with nothing to say about the quality of the work — and the
   * single counter then forced `retry --force`, a mechanism for deliberately
   * overruling a gate, spent to work around miscounting.
   */
  attempts: z.number().int().min(0).default(0),
  /**
   * Preflight and environment failures, gated by their own budget (AD-37, I-22).
   *
   * Bounded rather than uncounted: a permanently misconfigured environment would
   * otherwise retry forever. Counted rather than decremented from `attempts`,
   * because arithmetic that hides history is not an audit trail.
   *
   * Defaults to `0`, so every state file written before this field existed parses
   * unchanged and reads as "no infrastructure failure recorded" — which is exactly
   * what those runs could observe.
   */
  infrastructureFailures: z.number().int().min(0).default(0),
  /**
   * The value of {@link TaskProgressSchema.shape.attempts} when a person last asked for
   * this task to run again.
   *
   * **A counter, not a reset**, for the same reason `infrastructureFailures` is one:
   * arithmetic that hides history is not an audit trail. `attempts` keeps counting every
   * work attempt this task ever made; the difference between the two is the streak that
   * happened *with nobody watching*, and that streak is what `retry.maxAttempts` bounds.
   *
   * The distinction was free until AR-03 turned autonomous recovery on by default. After
   * it, the repair loop spent the same budget `retry` gates on — so with the shipped
   * defaults every ordinary failure reached the operator with nothing left, and the
   * dashboard's Retry button refused every time it was pressed. `agent-flow retry`
   * answered `attempts_exhausted` and offered `--force`: a limit you must override to do
   * the normal thing.
   *
   * The principle is the one `app/autonomy-budget.ts` already states about the run-level
   * counters — "a call a person asked for is not autonomous and must not count against a
   * budget that exists to bound unattended work". This applies it to the counter that was
   * missed.
   *
   * **Optional rather than defaulted to `0`**, unlike `infrastructureFailures` beside it,
   * and the difference is that `0` is a fact there and an absence here. A task nobody has
   * intervened in has no such moment to record, and a field that appears only when the
   * event it describes has happened keeps `state.json` readable by a person. Every state
   * file written before this field existed therefore parses unchanged and reads as "no
   * person has intervened", which is exactly what those runs could observe.
   */
  attemptsBeforeHumanRetry: z.number().int().min(0).optional(),
  /** The class of the most recent failure (AD-36). Absent until one is classified. */
  failureClass: FailureClassSchema.optional(),
  lastFailureAt: IsoTimestampSchema.optional(),
  blockReason: BlockReasonSchema.optional(),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

export const WORKFLOW_CLASSES = ['trivial', 'simple', 'standard', 'high-risk'] as const;
export const WorkflowClassSchema = z.enum(WORKFLOW_CLASSES);
export type WorkflowClass = z.infer<typeof WorkflowClassSchema>;

export const RunStateSchema = z.object({
  runId: RunIdSchema,
  feature: z.string().min(1),
  stage: RunStageSchema,
  status: RunStatusSchema,
  workflow: WorkflowClassSchema.optional(),
  revisionCount: z.number().int().min(0).default(0),

  approved: z.boolean().default(false),
  approvedAt: IsoTimestampSchema.optional(),
  /**
   * Hash of the plan that was approved. The gate is about a specific plan: if
   * the plan changes afterwards, the approval no longer applies (AF-28).
   */
  approvedPlanHash: z.string().optional(),

  /**
   * When an operator asked this run to stop at its next safe boundary (PRI-15).
   *
   * **A request, not a status.** A run's `status` says where it is in the workflow;
   * "paused" says what a person asked for. Those are different axes, and folding pause
   * into `RUN_STATUSES` would make `waiting_for_approval` and `paused` mutually exclusive
   * when they are plainly not.
   *
   * Honoured at the top of the dispatch loop, between tasks — never mid-task. The task in
   * flight runs to its natural end, because killing it throws away work already paid for
   * and there is no partial result to keep. So the observable behaviour is "pausing…" and
   * then "paused", and anything claiming to be immediate would be lying.
   *
   * Read by the `start` use case as well as by the scheduler, so a `agent-flow run` typed
   * after a pause refuses rather than quietly overriding it — the same rule the execution
   * lock follows, for the same reason.
   */
  pauseRequestedAt: IsoTimestampSchema.optional(),
  /**
   * When an operator cancelled this run, and who asked.
   *
   * Kept beside the terminal `cancelled` status rather than folded into it, because the
   * status answers "what happened" and this answers "when, and on whose say-so" — and an
   * audit trail that cannot distinguish a cancellation from a crash is not one.
   */
  cancelledAt: IsoTimestampSchema.optional(),

  degradations: z.array(DegradationSchema).default([]),
  tasks: z.array(TaskProgressSchema).default([]),

  /**
   * The commit the repository was on when the run was created (MVP 2 §6.1).
   *
   * Not "the current HEAD" — the HEAD the plan was written against. In worktree
   * mode it is the commit the integration branch is cut from; in sequential mode
   * it is what the gates compare the working tree against.
   */
  planningBase: CommitOidSchema.optional(),
  /** This run's Git namespace, captured at creation with the two above. §5.2. */
  gitRunKey: GitRunKeySchema.optional(),
  /**
   * How this run isolates its tasks, decided once at creation (I-13).
   *
   * Nothing else writes it: not an execution, not a retry, not a resume and above
   * all not a configuration change. Every reader downstream takes this value
   * rather than asking the configuration again.
   */
  isolationMode: IsolationModeSchema.optional(),
  /**
   * The integration branch's head as this run last recorded it (§5.3, §14.3).
   *
   * The only mutable Git fact a run persists, and deliberately so: it is the
   * discriminator that tells "my own namespace, resumed" apart from "somebody
   * else's wreckage", which is a question `events.jsonl` must not be asked to
   * answer (I-1).
   */
  integrationHead: CommitOidSchema.optional(),

  /**
   * What this run's approval has already authorised, and what it has spent (AD-46).
   *
   * Absent on every run created before this field existed, and absent is not
   * `{ correctiveRoundsUsed: 0 }`: a run that predates bounded corrective autonomy
   * never had the grant, and nothing may read one into it. The counters exist so a
   * budget can be enforced without recomputing it from the event log, and
   * `grantedAt` records when the envelope was first evaluated for this run.
   */
  autonomy: z
    .object({
      correctiveRoundsUsed: z.number().int().min(0).default(0),
      /** AgentRunner calls made with no intervening human action (AR §6.2). */
      autonomousModelCalls: z.number().int().min(0).default(0),
      grantedAt: IsoTimestampSchema.optional(),
    })
    .optional(),

  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type RunState = z.infer<typeof RunStateSchema>;

/** Append-only audit trail entry (AD-06). Never the source of truth. */
export const RunEventSchema = z.object({
  at: IsoTimestampSchema,
  type: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * The event names recovery is allowed to emit (AR §8.8).
 *
 * `RunEventSchema.type` is an open string and stays open — enriching or adding an
 * event has never been a breaking change, and that is load-bearing for the
 * milestones above this one. So this list is not a validator; it is the *spelling*,
 * declared once, in the layer that owns vocabulary.
 *
 * It exists because the alternative is each milestone inventing its own name at the
 * call site, and two spellings of one event is a read model that silently reports
 * half of what happened. Declared here in full, ahead of the code that emits them,
 * for the same reason the failure taxonomy is: so the next milestone reaches for a
 * name rather than coining one.
 */
export const RECOVERY_EVENT_TYPES = [
  'workspace_prepared',
  'workspace_preparation_failed',
  'task_failure_classified',
  'recovery_started',
  'recovery_step_completed',
  'recovery_exhausted',
  'environment_repaired',
  'failure_context_built',
  'wave_serialised_for_overlap',
  'corrective_plan_repaired',
  'corrective_envelope_evaluated',
  'init_during_active_run',
  /**
   * What one stage's prompt was made of, in bytes, by source (AR-09).
   *
   * Autonomy must not be bought with context explosion, and a total nobody can attribute
   * is a number nobody can act on.
   */
  'stage_context_measured',
] as const;

export type RecoveryEventType = (typeof RECOVERY_EVENT_TYPES)[number];

/**
 * The event names collaboration is allowed to emit (M4).
 *
 * Declared here, in full, ahead of the code that emits them, for the same reason
 * {@link RECOVERY_EVENT_TYPES} is: `RunEventSchema.type` is an open string and stays open,
 * so this is not a validator — it is the *spelling*, declared once in the layer that owns
 * vocabulary. The alternative is each module coining a name at the call site, and two
 * spellings of one event is a read model that silently reports half of what happened.
 *
 * Every one of them is a record of something Agent Flow *decided*, never of something an
 * agent claimed. A message being posted is the orchestrator's act of accepting it.
 */
export const COLLABORATION_EVENT_TYPES = [
  'collaboration_message_posted',
  'collaboration_message_rejected',
  /** The whole outbox was refused — unparseable, oversized, or pointing somewhere it should not. */
  'collaboration_outbox_refused',
  /**
   * An outbox tried to name its own sender.
   *
   * The parse already discarded it, so nothing changed; this exists so that an agent
   * attempting impersonation on every attempt of every run leaves a trace (I-28).
   */
  'collaboration_sender_claimed',
  /**
   * The outbox could not be removed from the workspace.
   *
   * Loud, because it means `git add -A` will stage agent-authored content into the
   * validated tree, which is exactly what I-32 exists to prevent.
   */
  'collaboration_outbox_not_removed',
  'collaboration_budget_exhausted',
  'blackboard_entry_recorded',
  /** An entry was superseded by an author other than its own. Both stay live (I-30). */
  'blackboard_entry_contested',
] as const;

export type CollaborationEventType = (typeof COLLABORATION_EVENT_TYPES)[number];

/**
 * What an operator did to a run's lifecycle (PRI-14, PRI-15).
 *
 * Declared here for the reason the list above is: so the next reader of the event log
 * finds one spelling rather than three. These are the only events that record a *person's*
 * decision about whether a run continues, which is exactly the thing an audit of an
 * autonomous system is for — a run that stopped is otherwise indistinguishable from one
 * that crashed.
 */
export const LIFECYCLE_EVENT_TYPES = [
  /** `detail: { at }`. Written once; pausing twice does not move the timestamp. */
  'run_paused',
  /** `detail: { at }`. The pause request was cleared and execution asked to continue. */
  'run_resumed',
  /**
   * `detail: { at, interrupted, pid?, hostname? }`.
   *
   * `interrupted` names the tasks that were running when it happened, because "which work
   * was severed mid-flight" is the first question anybody reading a cancelled run asks.
   * The holder is recorded when one was executing, and absent when nothing was.
   */
  'run_cancelled',
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

/**
 * The event names team orchestration is allowed to emit (M5).
 *
 * Declared here for the reason the three lists above are: so the next reader of the event
 * log finds one spelling rather than three. Every one records something *Agent Flow*
 * decided — an assignment is a decision the policy took, never a request an agent made
 * (I-33).
 */
export const TEAM_EVENT_TYPES = [
  /**
   * `detail: { task, agent, role, reason, detail?, candidates }`.
   *
   * Emitted only when the answer is not the router's, because a `reason: 'routed'` on
   * every task would be a row nobody reads. The candidate ranking rides on it so that
   * "why did Backend not get this" is answerable from the audit trail alone (I-34).
   */
  'task_assigned',
  /** `detail: { task, from, to, reason }`. A task that changed hands, and why. */
  'task_reassigned',
  /**
   * `detail: { task, agents, detail }`. A ready task held one wave because every member
   * that could take it is at `maxConcurrentTasks` in the wave being formed.
   */
  'wave_deferred_for_capacity',
  /**
   * `detail: { task, waitsFor, patterns, detail }`. Held one wave because it and an
   * already-admitted task both write into an area somebody declared exclusive.
   */
  'wave_deferred_for_ownership',
] as const;

export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];

/**
 * What a review did, as the audit trail records it (M6).
 *
 * **The timeline is folded from these; there is no timeline store** (§63). Every state a
 * review or a finding can be in is derivable from this vocabulary plus the collaboration
 * log plus run state — which is what lets I-43 hold: a finding's status is a question
 * about facts, not a field somebody writes.
 */
export const REVIEW_EVENT_TYPES = [
  /** `detail: { task, round, reason }`. A review was asked for — explicitly (§17). */
  'review_requested',
  /** `detail: { task, review, reviewer, author, independence, degraded? }`. */
  'reviewer_assigned',
  /** `detail: { task, review, reviewer, tree? }`. */
  'review_started',
  /**
   * `detail: { task, review, verdict, findings, blocking, tree? }`.
   *
   * `verdict` is what the reviewer proposed. Whether the workflow advanced is a separate
   * decision, recorded separately, because a model's opinion is not a gate (I-44).
   */
  'review_completed',
  /** `detail: { task, review, finding, severity, category, file? }`. */
  'finding_raised',
  /** `detail: { task, finding, by, message }`. The implementer answered. */
  'finding_acknowledged',
  /** `detail: { task, finding, by, message, reason }`. */
  'finding_disputed',
  /** `detail: { task, finding, correctiveTask, tree }`. Corrective work integrated. */
  'finding_fixed',
  /** `detail: { task, finding, by, evidence }`. A re-review or a gate, never a claim. */
  'finding_verified',
  /** `detail: { task, finding, correctiveTask }`. */
  'corrective_task_created',
  /** `detail: { gate, category, required, status, exitCode?, durationMs? }`. */
  'quality_gate_evaluated',
  /** `detail: { task, budget, limit, open, attempted, action }`. Escalation (§30). */
  'review_budget_exhausted',
] as const;

export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];
