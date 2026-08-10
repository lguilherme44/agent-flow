import { z } from 'zod';
import {
  AnyTaskIdSchema,
  IsoTimestampSchema,
  ReasoningLevelSchema,
  RunIdSchema,
  RunnerErrorCodeSchema,
  WorkflowRoleSchema,
} from './common.schema.js';
import { RunStageSchema } from './state.schema.js';
import { TaskStateSchema } from './task.schema.js';

/** Outcome of one validation command, run by the orchestrator (AD-10). */
export const CommandResultSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  durationMs: z.number().int().min(0),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  truncated: z.boolean().default(false),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

/** §21, plus the provenance fields the spec leaves implicit. */
export const TaskResultSchema = z.object({
  task: AnyTaskIdSchema,
  status: TaskStateSchema,

  /** What actually ran — not what was configured. They differ under fallback. */
  runner: z.string().min(1),
  model: z.string().optional(),
  reasoning: ReasoningLevelSchema,
  /** True when the target runner could not honour the requested level (R-15). */
  reasoningClamped: z.boolean().default(false),
  /** Present only when a fallback fired; records what it replaced (§55). */
  fallback: z
    .object({ from: z.string().min(1), errorCode: RunnerErrorCodeSchema })
    .optional(),

  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,

  filesChanged: z.array(z.string()).default([]),
  validation: z.object({
    /** Whether the commands exited zero — not whether the task succeeded. */
    passed: z.boolean(),
    /**
     * What was expected of them. Recorded because `passed: false` on its own
     * is ambiguous once test-first tasks exist: it may be the intended result.
     */
    expectation: z.enum(['pass', 'fail', 'none']).default('pass'),
    commands: z.array(CommandResultSchema).default([]),
  }),

  notes: z.array(z.string()).default([]),
  errorCode: RunnerErrorCodeSchema.optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

/**
 * One unit of work that ran, with what it actually cost in time and effort.
 *
 * Local operational telemetry (§57), and emphatically **not** billing: there are
 * no monetary values here and none may be added. Nothing in the workflow reads
 * it, and nothing may — `state.json` remains the source of truth and
 * `events.jsonl` the audit trail. A telemetry entry is a *projection* of those
 * two, reconstructible from them at any time, which is why it can never drift
 * from them or be repaired independently of them.
 *
 * The provenance fields record what executed, not what was configured. Under a
 * fallback the two differ, and that difference is most of what the numbers are
 * for.
 */
export const TelemetryEntrySchema = z.object({
  runId: RunIdSchema,
  /** Stage-level work, or one task inside the implementation stage. */
  kind: z.enum(['stage', 'task']),
  stage: RunStageSchema,
  taskId: AnyTaskIdSchema.optional(),
  role: WorkflowRoleSchema,

  runner: z.string().min(1),
  model: z.string().optional(),
  reasoning: ReasoningLevelSchema,
  reasoningClamped: z.boolean().default(false),
  fallback: z.object({ from: z.string().min(1), errorCode: RunnerErrorCodeSchema }).optional(),

  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,
  durationMs: z.number().int().min(0),

  /** Shares the task vocabulary; a stage only ever completes or fails. */
  status: TaskStateSchema,
  /** Total invocations including the first. One means nothing was retried. */
  attempts: z.number().int().min(1).default(1),
  errorCode: RunnerErrorCodeSchema.optional(),
});
export type TelemetryEntry = z.infer<typeof TelemetryEntrySchema>;
