import { z } from 'zod';
import {
  AnyTaskIdSchema,
  CommitOidSchema,
  FailureClassSchema,
  IsoTimestampSchema,
  ReasoningLevelSchema,
  RunIdSchema,
  RunUsageSchema,
  RunnerErrorCodeSchema,
} from './common.schema.js';
import { CommandResultSchema, CommandSummarySchema } from './result.schema.js';

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
    /** What this attempt spent, when the runner reported it (PRI-19). */
    usage: RunUsageSchema.optional(),

    startedAt: IsoTimestampSchema,
    finishedAt: IsoTimestampSchema,

    /**
     * What changed, according to Git (AD-39).
     *
     * The field keeps its name and its type; from AR-05a its *source* becomes
     * `git diff --name-only <base> <validatedTree>`. Until then it is still the
     * agent's list, which is the defect AD-39 names: a run cannot claim "mechanical
     * evidence over model claims" while its record of what changed is a model claim.
     * The agent's own list has somewhere else to live now —
     * `agentReport.claimedFilesChanged` — so the two can be compared rather than
     * conflated.
     */
    filesChanged: z.array(z.string()).default([]),
    /**
     * The agent's own account of what it did.
     *
     * **An object, always.** Never the raw text of a parse result, and never a JSON
     * string holding this shape: a reader that has to sniff which of the two it got
     * is a reader that will eventually guess wrong. Zod enforces it on the way in,
     * and `app/attempt-receipt.ts` parses through this schema before writing, so the
     * only way to persist a string here is to bypass the writer.
     */
    agentReport: z.object({
      status: z.enum(['COMPLETED', 'BLOCKED']),
      notes: z.array(z.string()).default([]),
      deviations: z.array(z.string()).default([]),
      /**
       * The files the agent *said* it changed (AD-39).
       *
       * Retained as a claim, next to the mechanical answer, so a divergence between
       * them is observable rather than invisible. They agreed throughout the
       * evidence run, which is a fact about one agent on one afternoon and not a
       * guarantee — and a divergence is recorded in the attempt's notes as
       * informative, never as a blocker.
       */
      claimedFilesChanged: z.array(z.string()).default([]),
    }),

    /**
     * Each acceptance criterion, and the evidence that it holds (C-15).
     *
     * The point of the discriminated union is the third member: an AC with no
     * mechanical evidence has to *say so*, explicitly, rather than being absent from
     * the map. Absence is indistinguishable from "nobody looked", and the evidence
     * run is a record of what that ambiguity costs.
     *
     * An agent's claim is never one of the members. That is deliberate and it is the
     * whole reason this map is mechanical.
     */
    acceptance: z
      .array(
        z.object({
          criterion: z.string().min(1),
          evidence: z.discriminatedUnion('kind', [
            z.object({
              kind: z.literal('validation'),
              /** A validation id from the project configuration, never a command. */
              id: z.string().min(1),
              exitCode: z.number().int(),
            }),
            z.object({
              kind: z.literal('diff'),
              /** A path inside the mechanical diff. */
              path: z.string().min(1),
            }),
            z.object({
              kind: z.literal('none'),
              /** Why nothing mechanical can speak to this criterion. */
              reason: z.string().min(1),
            }),
          ]),
        }),
      )
      .default([]),

    /**
     * The base tree and the validated tree, side by side (AD-38, I-23).
     *
     * `baseTree` is a member rather than something derived from `base`, and that is
     * not redundancy: `base` is a **commit** id and `validatedTree` is a **tree** id,
     * so they are never equal and comparing them directly always reports "changed".
     * Resolving `base^{tree}` is one Git read, and recording its answer is what makes
     * the assertion re-checkable later from the artifact alone.
     *
     * Optional because a sequential run has no validated tree to compare.
     */
    treeComparison: z
      .object({
        baseTree: CommitOidSchema,
        validatedTree: CommitOidSchema,
        identical: z.boolean(),
      })
      .optional(),

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
  })
  .refine(
    (attempt) =>
      attempt.treeComparison === undefined ||
      attempt.treeComparison.identical ===
        (attempt.treeComparison.baseTree === attempt.treeComparison.validatedTree),
    {
      // `identical` is a conclusion about the two hashes beside it, so a record where
      // they disagree is not a judgement call to be weighed later — it is a corrupt
      // artifact, and I-23 would be resting on it.
      message: 'identical must equal baseTree === validatedTree',
      path: ['treeComparison', 'identical'],
    },
  );
export type TaskAttemptResult = z.infer<typeof TaskAttemptResultSchema>;

/**
 * What a *failed* attempt leaves behind — `tasks/<TASK>/attempt-<n>.failed.json` (AD-34).
 *
 * A distinct artifact from {@link TaskAttemptResultSchema}, under a distinct name, and
 * the separation is the point. `task-executor.ts` deliberately writes no artifact when
 * the stage throws, and the justification is sound: the agent produced no report, and
 * inventing one would be evidence of a report nobody made. But the conclusion overshot
 * — the evidence of the *failure* exists (error code, provenance, raw output, duration)
 * and discarding it means the only attempts without a persisted artifact are precisely
 * the ones somebody needs to diagnose. In the evidence run the two absent files are the
 * two attempts that failed.
 *
 * **There is no `agentReport` member, and there must never be one.** MVP 2 §17.3 reads
 * "no `attempt-<n>.json`" as *the attempt's work was never observed*, and a separate
 * file name is what keeps that statement literally true while still recording why.
 */
export const FailedAttemptSchema = z.object({
  run: RunIdSchema,
  task: AnyTaskIdSchema,
  attempt: z.number().int().min(1),

  base: CommitOidSchema,
  branch: z.string().min(1),
  /** Workspace-relative, never absolute (§7.2, §21.3). */
  workspace: z.string().min(1),

  runner: z.string().min(1),
  model: z.string().optional(),
  reasoning: ReasoningLevelSchema,
  reasoningClamped: z.boolean().default(false),
  fallback: z.object({ from: z.string().min(1), errorCode: RunnerErrorCodeSchema }).optional(),
  /**
   * What this attempt spent, when the runner reported it (PRI-19).
   *
   * On the failure record too, and deliberately: a call that failed after the model
   * answered was paid for, and accounting that counts only successes under-reports
   * exactly the runs somebody is trying to understand.
   */
  usage: RunUsageSchema.optional(),

  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,

  failureClass: FailureClassSchema,
  /** Absent when the failure never reached a runner. */
  runnerErrorCode: RunnerErrorCodeSchema.optional(),
  /**
   * The head of the runner's own output, redacted (AD-33, AD-35, I-21).
   *
   * Evidence, never control flow: the true cause of one evidence-run failure —
   * `soft-denying tool confirmation "Bash"` — existed in memory and was thrown away,
   * so a person read the vendor's log directory instead. Bounded by
   * `maxRawExcerptBytes`, and there is no unredacted mirror anywhere.
   */
  rawExcerpt: z.string().optional(),

  /** The validation that did run, when any did. */
  validation: z
    .object({
      expectation: z.enum(['pass', 'fail', 'none']),
      passed: z.boolean(),
      ids: z.array(z.string()).default([]),
      commands: z.array(CommandResultSchema).default([]),
    })
    .optional(),

  /**
   * How many times the stage re-prompted for a well-formed answer.
   *
   * `StageRunner`'s internal counter, under its real name. It used to be called
   * `attempt` too, which is how the evidence run ended up with `attempt=1 failed`
   * inside a file named `…-attempt-2.log`. One word, one meaning (AR §4.4).
   */
  repairAttempts: z.number().int().min(1).default(1),
  /**
   * Whether this failure spent one of the task's work attempts (AD-37, I-22).
   *
   * Recorded rather than recomputed, because it is the decision the recovery budget
   * was applied to at the time. A reader asking "why was `retry` still allowed" gets
   * an answer from the artifact instead of re-deriving one from a table that may
   * since have changed.
   */
  consumedAttempt: z.boolean(),
});
export type FailedAttempt = z.infer<typeof FailedAttemptSchema>;

/**
 * What a retry is told about the attempt before it — `tasks/<TASK>/attempt-<n>.context.json` (AD-40).
 *
 * Assembled by pure code from persisted artifacts, appended to the implementation
 * prompt exactly as MVP 3's advisory block is, and **carrying no patch**. Handing over
 * the previous diff would make a rejected attempt a starting point and erode the
 * isolation that makes a validated tree mean anything; `--stat` conveys shape without
 * conveying content. The next attempt still branches from the integration head (AD-41):
 * knowledge travels, code does not.
 *
 * Persisted next to the attempt it informs so a run can always show what the retry was
 * told — which is the question the evidence run could not answer.
 */
export const FailureContextPacketSchema = z.object({
  previousAttempt: z.number().int().min(1),
  failureClass: FailureClassSchema,
  runnerErrorCode: RunnerErrorCodeSchema.optional(),
  /** Redacted and bounded by `maxRawExcerptBytes` (AR §6.5). */
  rawExcerpt: z.string().optional(),
  failedChecks: z.array(CommandSummarySchema).default([]),
  /** Ids only. What passed is context; what failed is the work. */
  successfulChecks: z.array(z.string()).default([]),
  /** `git diff --stat`, bounded by `maxDiffStatLines`. Never a full patch. */
  previousDiffStat: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  /**
   * The one field a model may phrase.
   *
   * Everything else here is mechanical, and a model's phrasing may not alter any of
   * it — which is what keeps a paraphrase out of the place evidence belongs.
   */
  correctiveObjective: z.string().min(1),
  /** Environment repairs already applied before this attempt. */
  environmentRepairs: z.array(z.string()).default([]),
  /**
   * What was dropped to fit the budget, in AR §6.5's fixed reverse-priority order.
   *
   * Present exactly when something was cut. A packet that exceeded its budget is
   * truncated with an explicit marker, never silently: `failureClass`, `failedChecks`
   * and `acceptanceCriteria` are never truncated, so a reader seeing this list knows
   * both that content is missing and that the load-bearing parts are not.
   */
  truncated: z.array(z.enum(['previousDiffStat', 'successfulChecks', 'rawExcerpt'])).default([]),
});
export type FailureContextPacket = z.infer<typeof FailureContextPacketSchema>;
