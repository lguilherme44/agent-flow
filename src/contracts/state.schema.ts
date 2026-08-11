import { z } from 'zod';
import { IsoTimestampSchema, RunIdSchema } from './common.schema.js';
import { TaskStateSchema } from './task.schema.js';

/** Pipeline stages, in order. `stage` on a run points at the last one reached. */
export const RUN_STAGES = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'implementation',
  'verification',
  'final-review',
] as const;

export const RunStageSchema = z.enum(RUN_STAGES);
export type RunStage = z.infer<typeof RunStageSchema>;

/**
 * The pipeline as a person sees it (§71).
 *
 * Nine entries where `RUN_STAGES` has eight: `approval` is a step in the user's
 * mental model and in the specification's pipeline, but nothing *executes* for
 * it — so it has no events and can never appear in `state.stage`. Keeping the
 * two lists separate is what stops a display concern from becoming a stage the
 * state machine has to pretend to run.
 */
export const PIPELINE_STAGES = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'approval',
  'implementation',
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

export const TaskProgressSchema = z.object({
  id: z.string().min(1),
  state: TaskStateSchema,
  attempts: z.number().int().min(0).default(0),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

export const RunStateSchema = z.object({
  runId: RunIdSchema,
  feature: z.string().min(1),
  stage: RunStageSchema,
  status: RunStatusSchema,

  approved: z.boolean().default(false),
  approvedAt: IsoTimestampSchema.optional(),
  /**
   * Hash of the plan that was approved. The gate is about a specific plan: if
   * the plan changes afterwards, the approval no longer applies (AF-28).
   */
  approvedPlanHash: z.string().optional(),

  degradations: z.array(DegradationSchema).default([]),
  tasks: z.array(TaskProgressSchema).default([]),

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
