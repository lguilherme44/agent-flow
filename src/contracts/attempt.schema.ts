import { z } from 'zod';
import {
  AnyTaskIdSchema,
  CommitOidSchema,
  IsoTimestampSchema,
  ReasoningLevelSchema,
  RunIdSchema,
  RunnerErrorCodeSchema,
} from './common.schema.js';
import { CommandResultSchema } from './result.schema.js';

/**
 * One local execution of a task, and the evidence it produced (MVP 2 §10).
 *
 * Deliberately *not* `TaskResultSchema`. That one carries `status: TaskState`, and
 * a file on disk saying `"status": "completed"` for work that has not reached the
 * integration branch is a lie recovery would believe (I-3). Two artifacts, two
 * meanings: `attempt-<n>.json` records what happened inside one worktree,
 * `result.json` records the task's outcome — and in worktree mode the second is
 * written only after integration.
 */

/** What the task's validation expectation was found to be, inside its own worktree. */
export const ValidationJudgementSchema = z.enum([
  /** The expectation was met, in this worktree, against this base. */
  'satisfied',
  /** Validation ran and the expectation was not met. */
  'unsatisfied',
  /** Setup failed, the agent failed, or the agent reported BLOCKED. */
  'not_reached',
]);
export type ValidationJudgement = z.infer<typeof ValidationJudgementSchema>;

/**
 * Proof that a specific tree is the one validation passed over (§11).
 *
 * The agent runs with write permission inside its worktree, so "validation passed"
 * asserted by anything the agent could have written is worth nothing. The nonce is
 * generated *after* the agent process has exited, and the tree binds the claim to
 * bytes rather than to a message.
 */
export const AttemptReceiptSchema = z.object({
  /** 128 random bits, hex. Generated only once the agent process is gone. */
  nonce: z.string().regex(/^[0-9a-f]{32}$/, 'expected 32 lowercase hex characters'),
  /** The tree validation actually ran over. */
  validatedTree: CommitOidSchema,
  /** Also the marker commit's author and committer date — see §12.2. */
  issuedAt: IsoTimestampSchema,
});
export type AttemptReceipt = z.infer<typeof AttemptReceiptSchema>;

export const TaskAttemptResultSchema = z
  .object({
    run: RunIdSchema,
    task: AnyTaskIdSchema,
    attempt: z.number().int().min(1),

    base: CommitOidSchema,
    branch: z.string().min(1),
    /**
     * Workspace-relative, never absolute (§7.2).
     *
     * The absolute root is a machine fact the adapter resolves; keeping it out of
     * the artifact makes the path leak of §21.3 structurally impossible rather
     * than a rule somebody has to remember.
     */
    workspace: z.string().min(1),

    // Provenance: what actually ran, not what was configured. Under a fallback
    // the two differ, and that difference is most of what these fields are for.
    runner: z.string().min(1),
    model: z.string().optional(),
    reasoning: ReasoningLevelSchema,
    reasoningClamped: z.boolean().default(false),
    fallback: z
      .object({ from: z.string().min(1), errorCode: RunnerErrorCodeSchema })
      .optional(),

    startedAt: IsoTimestampSchema,
    finishedAt: IsoTimestampSchema,

    filesChanged: z.array(z.string()).default([]),
    agentReport: z.object({
      status: z.enum(['COMPLETED', 'BLOCKED']),
      notes: z.array(z.string()).default([]),
      deviations: z.array(z.string()).default([]),
    }),

    validation: z.object({
      expectation: z.enum(['pass', 'fail', 'none']),
      /** Whether the commands exited zero — not whether the expectation was met. */
      passed: z.boolean(),
      ids: z.array(z.string()).default([]),
      commands: z.array(CommandResultSchema).default([]),
    }),
    validationJudgement: ValidationJudgementSchema,

    /** Present if and only if `validationJudgement === 'satisfied'`. */
    receipt: AttemptReceiptSchema.optional(),

    errorCode: z.string().optional(),
  })
  .refine((attempt) => (attempt.validationJudgement === 'satisfied') === (attempt.receipt !== undefined), {
    message: 'a receipt exists exactly when the validation judgement is satisfied',
  });
export type TaskAttemptResult = z.infer<typeof TaskAttemptResultSchema>;
