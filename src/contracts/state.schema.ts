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
