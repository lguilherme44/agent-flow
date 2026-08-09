import { z } from 'zod';
import {
  AnyTaskIdSchema,
  IsoTimestampSchema,
  ReasoningLevelSchema,
  RunnerErrorCodeSchema,
} from './common.schema.js';
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
    passed: z.boolean(),
    commands: z.array(CommandResultSchema).default([]),
  }),

  notes: z.array(z.string()).default([]),
  errorCode: RunnerErrorCodeSchema.optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

/** Local operational telemetry (§57). Never presented as billing. */
export const TelemetryEntrySchema = z.object({
  runner: z.string().min(1),
  model: z.string().optional(),
  role: z.string().min(1),
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,
  status: z.string().min(1),
});
export type TelemetryEntry = z.infer<typeof TelemetryEntrySchema>;
