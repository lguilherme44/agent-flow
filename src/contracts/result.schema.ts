import { z } from 'zod';
import {
  AnyTaskIdSchema,
  CommitOidSchema,
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

  /**
   * Where this task's validated tree landed on the integration branch (MVP 2 §10.3).
   *
   * **Absent in sequential mode; present on every `completed` task in worktree
   * mode — and its presence is the on-disk statement of I-3.** A task is not done
   * because an agent said so and not because its validation passed: it is done
   * when its marker was merged, and this block is the evidence of that merge.
   *
   * Written by `app/integrator.ts` and by nothing else. In worktree mode
   * `result.json` does not exist at all until the merge has happened, because a
   * file on disk saying `"status": "completed"` for work that is not on the
   * integration branch is a lie recovery would believe (§10.1).
   */
  integration: z
    .object({
      /** Which attempt produced the marker. Attempts are immutable (§11.3). */
      attempt: z.number().int().min(1),
      /** The integration branch, `agent-flow/<gitRunKey>/integration`. */
      branch: z.string().min(1),
      /** The attempt's marker — one parent, the attempt's base (§12.1). */
      marker: CommitOidSchema,
      /** The merge that put it on the branch. Two parents, always (§14.5). */
      mergeCommit: CommitOidSchema,
      /** The wave base the attempt was cut from. */
      base: CommitOidSchema,
      /** `receipt.validatedTree` — the tree the validation commands ran against. */
      validatedTree: CommitOidSchema,
      integratedAt: IsoTimestampSchema,
    })
    .optional(),
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
