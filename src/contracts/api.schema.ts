import { z } from 'zod';
import type { ForgeCheck, ForgeFailure } from './forge.schema.js';
import type { QualityGateResult, ReviewFinding } from './review.schema.js';
import { ArtifactNameSchema, type ReasoningLevel } from './common.schema.js';
import { LocaleSchema } from './locale.js';
import type { Finding, FindingAdjudication } from './review.schema.js';
import {
  WorkflowClassSchema,
  PipelineStageSchema,
  RunStageSchema,
  type Degradation,
  type PipelineStage,
  type PipelineStatus,
  type RunEvent,
  type RunStatus,
  type WorkflowClass,
} from './state.schema.js';
import type { TaskState } from './task.schema.js';
import type { TelemetryEntry } from './result.schema.js';
import type { RunProjection } from './projection.js';
import type { ContextTelemetryObservation } from './context-telemetry.schema.js';

/**
 * The contract between the local server and the browser (§86).
 *
 * Two different jobs live here, and they use different tools on purpose.
 *
 * **Requests are validated at runtime**, with Zod, because they come from
 * outside. A project id or a run id arriving over HTTP is untrusted input, and
 * the shapes below are the only ones the server will act on. Crucially, no
 * endpoint accepts a filesystem path: the browser names a *project*, and the
 * server resolves it through the registry. A path the client could choose is a
 * path the client could point anywhere.
 *
 * **Responses are types only.** The server produces them from state it already
 * validated on the way in; re-validating our own output on the way out costs a
 * parse per request and catches nothing the type system did not.
 */

/**
 * Project ids are slugs the server generates, never anything a client supplies
 * from elsewhere. The pattern is enforced so a crafted id cannot become a path
 * segment that escapes a directory, even if some later handler forgets.
 */
export const ProjectIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'expected a project id, not a path');

export const RunIdParamSchema = z
  .string()
  .regex(/^AF-\d{4}-\d{3}$/, 'expected a run id like AF-2026-001');

export const TaskIdParamSchema = z
  .string()
  .regex(/^(TASK|FIX)-\d{3}$/, 'expected a task id like TASK-001');

export const ProjectParamsSchema = z.object({ projectId: ProjectIdSchema });

export const RunParamsSchema = z.object({ runId: RunIdParamSchema });

export const TaskParamsSchema = z.object({
  runId: RunIdParamSchema,
  taskId: TaskIdParamSchema,
});

/**
 * Device ids are opaque identifiers issued by the server.
 *
 * Constrained by regex so a crafted device id cannot escape path segments
 * or smuggle control characters (SEC-007, SEC-008).
 */
export const DeviceIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'expected a device id');

/**
 * A device label is constrained at the schema to a printable, control-character-free
 * charset of at most 40 characters (SEC-008, NFR-009).
 *
 * It is rendered both to a terminal and to a page, and it is the one attacker-supplied
 * string in device pairing that reaches either.
 */
export const DeviceLabelSchema = z
  .string()
  .regex(/^[\x20-\x7E]{1,40}$/, 'expected a printable device label of at most 40 characters');

/**
 * A single-use pairing code is 12 characters, typed with or without hyphens (NFR-009, FR-003).
 *
 * Normalised by stripping hyphens and lowercasing so the server compares plaintext uniformly.
 */
export const PairingCodeFieldSchema = z
  .string()
  .regex(
    /^[0-9a-zA-Z]{4}-?[0-9a-zA-Z]{4}-?[0-9a-zA-Z]{4}$/,
    'expected a 12-character pairing code like xxxx-xxxx-xxxx',
  )
  .transform((v) => v.replace(/-/g, '').toLowerCase());

export const PairRequestSchema = z.object({
  code: PairingCodeFieldSchema,
  label: DeviceLabelSchema,
});

export const DeviceSessionParamsSchema = z.object({
  deviceId: DeviceIdSchema,
});

export type PairRequest = z.infer<typeof PairRequestSchema>;
export type DeviceSessionParams = z.infer<typeof DeviceSessionParamsSchema>;

/**
 * A stage is named from a closed set, never spelled by the caller.
 *
 * The name becomes a filename under the run's `logs/`, so this enum is the whole defence
 * against traversal — the same shape `ArtifactParamsSchema` and `PromptNameSchema` use,
 * and for the same reason: a client that can choose a path can choose any path.
 */
export const StageLogParamsSchema = z.object({
  runId: RunIdParamSchema,
  stage: PipelineStageSchema,
});

/**
 * The artifact names are `ARTIFACT_NAMES`, asked rather than re-spelled.
 *
 * This enum was a second hand-written copy of that list, and the two agreed only because
 * nobody had added an artifact since. The next one would have parsed everywhere in the
 * product and been refused by this one route, as `unknown artifact` — a 400 naming the
 * caller for the server's own omission.
 */
export const ArtifactParamsSchema = z.object({
  runId: RunIdParamSchema,
  artifact: ArtifactNameSchema,
});

/**
 * A prompt is named, never located.
 *
 * The same rule as project ids: the client supplies a name, the server looks it
 * up in the set it found in its own installation directory. There is no request
 * shape that can address a file outside `prompts/`, so path traversal has nothing
 * to traverse — and the pattern is enforced here as well, so a later handler that
 * forgets cannot be the whole defence.
 */
export const PromptNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'expected a prompt name, not a path');

export const PromptParamsSchema = z.object({ prompt: PromptNameSchema });

/** Every read endpoint is scoped to one project. */
export const ProjectQuerySchema = z.object({ projectId: ProjectIdSchema.optional() });

/**
 * The language a read is answered in (§93 is untouched: this names no path and no file).
 *
 * `passthrough` because every route already parses its own query with its own schema —
 * this one is read alongside them, not instead of them, and a strict object would refuse
 * `projectId` on the same request.
 */
export const LocaleQuerySchema = z
  .object({ lang: LocaleSchema.optional() })
  .passthrough();

/**
 * `doctor`, and the one part of it a caller has to ask for.
 *
 * The §8.4 install probe checks out a throwaway copy and runs the project's own install —
 * minutes on a large repository. It is the default in a terminal, which can block and
 * announce it, and opt-in over HTTP, which cannot: the first version of `GET /doctor` ran
 * it unconditionally and the page timed out before painting anything.
 */
export const DoctorQuerySchema = z.object({
  projectId: ProjectIdSchema.optional(),
  install: z.coerce.boolean().optional(),
});

/**
 * A configuration source is named by scope and registry id, never by path.
 *
 * **`lang` is declared here because `.strict()` is load-bearing.** Strictness is what
 * refuses an unexpected key outright rather than ignoring it — a `path=` on this route
 * gets a refusal, which is §93 enforced by the shape instead of by a reader's discipline.
 * The Deck appends `lang` to every URL (the language is part of a read's address), so the
 * one transport key has to be part of every strict query schema or the route 400s on a
 * request that is perfectly well formed. Measured: the Crew screen said "the
 * configuration could not be read" for exactly this reason, on a config that loads fine.
 */
export const ConfigEditorQuerySchema = z
  .object({
    scope: z.enum(['global', 'project']),
    projectId: ProjectIdSchema.optional(),
    lang: LocaleSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.scope === 'project' && target.projectId === undefined) {
      context.addIssue({ code: 'custom', path: ['projectId'], message: 'project scope requires projectId' });
    }
    if (target.scope === 'global' && target.projectId !== undefined) {
      context.addIssue({ code: 'custom', path: ['projectId'], message: 'global scope does not accept projectId' });
    }
  });

export const ConfigPathSchema = z
  .array(z.union([z.string().min(1).max(128), z.number().int().nonnegative()]))
  .min(1)
  .max(16);

export const ConfigEditOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set'), path: ConfigPathSchema, value: z.unknown() }).strict(),
  z.object({ kind: z.literal('unset'), path: ConfigPathSchema }).strict(),
]);

export const ConfigValidateRequestSchema = z
  .object({ operations: z.array(ConfigEditOperationSchema).min(1).max(100) })
  .strict();

export const ConfigApplyRequestSchema = ConfigValidateRequestSchema.extend({
  expectedRevision: z.string().regex(/^sha256:(?:missing|[a-f0-9]{64})$/),
}).strict();

// ---------------------------------------------------------------------------
// Write requests (§86, UI-27)
// ---------------------------------------------------------------------------

/**
 * What a client may say when asking for an action.
 *
 * Read the absences. There is no `planHash` on the approve body, and there could
 * not be: approval is granted to a specific plan, and a caller that named the plan
 * it wanted credited could open the gate for something nobody read (§90). The
 * server reads the plan on disk and hashes it.
 *
 * There is no path, no command and no runner executable anywhere in this section
 * either. The browser's whole vocabulary is an id the server issued and a sentence
 * a person typed.
 */
export const ApproveRequestSchema = z.object({
  /**
   * Overrides a refusal the server said was forcible, and only those.
   *
   * Which ones those are is the server's answer, not this schema's: the gate reports
   * `refusal.forcible`, and a client that kept its own list would eventually be wrong
   * about it. Today they are the four review refusals and a plan a person rejected.
   *
   * Recorded on the run as a degradation, which is the point: a gate opened over a
   * failed review — or over somebody's "no" — has to look different afterwards from
   * one that passed.
   */
  force: z.boolean().default(false),
});

export const RejectRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2_000).optional(),
});

export const ReviseRequestSchema = z.object({
  /** What should change. Free text a person wrote; never interpreted as a command. */
  instruction: z.string().trim().min(1).max(4_000),
});

export const StartRequestSchema = z.object({
  /** Restricts execution to one task, as `agent-flow task` does. */
  taskId: TaskIdParamSchema.optional(),
});

export const RetryRequestSchema = z.object({
  /** Retries a BLOCKED task, or one past its attempt limit. Deliberate either way. */
  force: z.boolean().default(false),
  /**
   * This task is meant to change nothing; accept an empty diff (PRI-20).
   *
   * Same use case, second adapter, as `--expect-no-change` on `agent-flow retry`. It has
   * to exist here too: the operator most likely to hit `acceptance_evidence_missing` is
   * the one watching the run in the browser, and a net reachable only from a terminal is
   * a net for half the people who need it.
   */
  expectNoChange: z.boolean().default(false),
});

/**
 * `agent-flow review`, from the browser (Deck).
 *
 * The last step of every run was a command a person had to remember to type: seven runs
 * on the machine this was written on finished every task and then sat at "run
 * `agent-flow review`" for days. Same use case, second adapter — a job, like `start`,
 * because verification and two reviewers take minutes.
 */
export const ReviewRequestSchema = z.object({
  /** Turn the findings into corrective tasks and review the corrected plan, as `--fix` does. */
  fix: z.boolean().default(false),
});

/**
 * `agent-flow feature "<description>"`, from the browser (Deck).
 *
 * A new run, planned. The description is free text a person wrote — the same trust class
 * as a revision instruction, and handled the same way: it is never interpreted as a
 * command, and it reaches the planner as the feature request the CLI would have passed.
 * Everything else here is a flag the CLI already has. There is no `from`: resuming names
 * an existing run, and that is a different request from starting one.
 *
 * The project is named in the query, as every read is; a run id does not exist yet.
 */
export const PlanRequestSchema = z.object({
  description: z.string().trim().min(1).max(8_000),
  /** Override the workflow class the classifier would pick, as `--workflow` does. */
  workflow: WorkflowClassSchema.optional(),
  /** Stop after planning, without the automated review, as `--skip-review` does. */
  skipReview: z.boolean().default(false),
  /** Ignore the cached repository map, as `--no-cache` does. */
  noCache: z.boolean().default(false),
});

export const ResumePlanningRequestSchema = z.object({
  from: RunStageSchema.optional(),
  skipReview: z.boolean().default(false),
  noCache: z.boolean().default(false),
});
export type ResumePlanningRequest = z.infer<typeof ResumePlanningRequestSchema>;

export const JobParamsSchema = z.object({
  jobId: z.string().regex(/^job-\d{4,}$/, 'expected a job id'),
});

/**
 * How much history an aggregate covers.
 *
 * Bounded, because analytics over an unbounded history reads every run's event
 * log to draw one bar. The bound is reported rather than applied quietly — a
 * chart that silently describes twenty of two hundred runs is a chart that lies
 * about its own scope.
 */
export const AnalyticsQuerySchema = z.object({
  projectId: ProjectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const EventsQuerySchema = z.object({
  projectId: ProjectIdSchema.optional(),
  runId: RunIdParamSchema.optional(),
});

/**
 * Reclaim old run state, and the Git namespace that goes with it (§20, 7.7).
 *
 * `dryRun` is the field the screen exists for: reclaiming a worktree or a ref is the
 * operation that frightens people most, and the answer to "what would this remove" has to
 * come from *the same function that removes it* — a preview computed some other way is a
 * preview of a different operation.
 *
 * Every flag here is a deliberate widening of what may be deleted, and none is a default.
 * `branches` is the only one that can delete work, and §20.4 is emphatic that it is never
 * implied: a run's integration branch is the product the tool told you to go and merge.
 */
export const CleanRequestSchema = z.object({
  /** Keep the newest N runs. */
  keep: z.coerce.number().int().min(0).max(1_000).optional(),
  /** Include the active run, which holds in-flight work. */
  force: z.boolean().optional(),
  /** Also drop the cached repository map. */
  cache: z.boolean().optional(),
  /** Also reclaim the worktrees §20.3 retains — the only copy of what an agent produced. */
  worktrees: z.boolean().optional(),
  /** Also delete an integration branch that is merged nowhere. Deletes work. */
  branches: z.boolean().optional(),
  /** Report and change nothing. The page asks for this first, always. */
  dryRun: z.boolean().optional(),
});

/** Register a candidate. No path, no command, no runner — one id the server issued. */
export const RegisterProjectRequestSchema = z.object({
  candidateId: ProjectIdSchema,
  /**
   * Replace files that already exist.
   *
   * `init` never clobbers by default (§7.7) — it is the first thing agent-flow does in a
   * repository somebody cares about, and a tool that overwrites a hand-written AGENTS.md
   * on first contact does not get a second chance. This is the deliberate override, and
   * it also carries the AR-01 gate: it proceeds past an active run whose `planningBase`
   * the resulting commit would invalidate, and that override is recorded on the run.
   */
  force: z.boolean().optional(),
});


// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface HealthResponse {
  readonly status: 'ok';
  readonly version: string;
  readonly projects: number;
  /** Where the server is bound. Shown so a non-loopback bind is never invisible. */
  readonly host: string;
  readonly port: number;
}

/** A run named from somewhere that is not looking at the run itself. */
export interface RunRefView {
  readonly runId: string;
  readonly feature: string;
  readonly status: RunStatus;
  readonly stage: string;
  readonly updatedAt: string;
}

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  /** Absolute path. Read-only information; no endpoint accepts one back. */
  readonly path: string;
  readonly stack?: string;
  readonly currentRunId: string | null;
  readonly status: RunStatus | null;
  /**
   * The most recent run that has finished, one way or another.
   *
   * Distinct from `currentRunId`, which is whatever `.agent-flow/current-run`
   * points at — a project can have an active run and a last completed run at the
   * same time, and §81 asks for both.
   */
  readonly lastRun?: RunRefView;
  readonly runCount: number;
}

export interface RunSummaryView {
  readonly projectId: string;
  readonly runId: string;
  readonly feature: string;
  readonly stage: string;
  readonly status: RunStatus;
  readonly approved: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly taskCount: number;
  readonly completedTasks: number;
  readonly degradations: number;
  /**
   * Overall progress, 0–100, from task states. Zero before a plan exists.
   *
   * Computed here rather than in the browser so the runs list and the run detail
   * cannot round it differently — the same number in two places that disagree is
   * worse than the number being absent from one of them.
   */
  readonly progress: number;
  readonly durationMs: number;
  readonly workflow?: WorkflowClass;
  readonly revisionCount?: number;
}

/**
 * How a run isolates its tasks, as a person needs to read it (§21.2).
 *
 * Three values where `state.isolationMode` has two: `legacy` is the **absent**
 * case — a run created before MVP 2, which predates the question rather than
 * having answered `none` (§25.2). It is *projected* here and is never a stored
 * value, because there is no honest field to store it in.
 */
export type IsolationView = 'none' | 'worktree' | 'legacy';

/**
 * What the run asked of parallelism and what it got (§21.2, M2-00.3).
 *
 * Two numbers rather than one, because "4" and "1" are different facts and a
 * reader who saw only the configured one would plan around it. This is the answer
 * to "why is this still running one task at a time".
 */
export interface ParallelismView {
  readonly requested: number;
  readonly effective: number;
  readonly clamped: boolean;
  readonly reason?: string;
}

/**
 * What an isolated run is doing, for somebody who has to debug it (§21.2).
 *
 * **Ref names and object ids appear here; filesystem paths never do** (§21.3,
 * §26.1 rule 4). The asymmetry is deliberate rather than an oversight: a branch
 * name is provenance a person needs — §19.3 prints it and tells them to merge it —
 * and the server never accepts one back. A worktree path is a machine fact the
 * attempt artifact deliberately does not even store (§7.2).
 */
export interface IsolationDetailView {
  readonly mode: IsolationView;
  readonly parallelism: ParallelismView;
  /** `agent-flow/<gitRunKey>/integration`, derived. Absent unless isolated. */
  readonly integrationBranch?: string;
  /** The commit verification, review and the DoD all describe (§19.2). */
  readonly integrationHead?: string;
  /** The commit the plan was written against (§6.1). */
  readonly planningBase?: string;
  /** How many tasks have their work on the integration branch (I-3). */
  readonly tasksIntegrated: number;
  /**
   * Why the run's mode and the current configuration disagree, in words (§21.4).
   *
   * Absent when they agree. Without it the tool looks broken to the one user who
   * did exactly what the documentation told them to and then wondered why it had
   * no effect.
   */
  readonly note?: string;
}

export interface RunDetailView extends RunSummaryView {
  readonly approvedAt?: string;
  readonly approvedPlanHash?: string;
  readonly degradationDetail: Degradation[];
  readonly startedAt: string;
  /** §21.2. Present for every run; `mode` carries the legacy projection. */
  readonly isolation: IsolationDetailView;
  /** §15: what an integration conflict recorded, from the event it wrote. */
  readonly integrationConflicts: IntegrationConflictView[];
  /**
   * The AR-07 runtime projection, computed once (C-19 … C-22).
   *
   * Shipped rather than left to the client. Every surface used to derive its own answer
   * from raw state, and they disagreed: `Resume` was offered on a run with nothing
   * runnable, `plan_rejected` stayed on screen while revision 2 ran, and one collapsed
   * percentage read 100% with verification pending and then fell. There is one answer here
   * because there is one function that produces it.
   */
  readonly runtime: RunProjection;
}

export interface IntegrationConflictView {
  readonly task: string;
  readonly attempt: number;
  /** Repository-relative, as `git diff --name-only` reports them. */
  readonly paths: string[];
  /** The sibling whose merge moved the head — usually the answer to "why". */
  readonly previouslyIntegrated?: string;
}

export interface StageViewResponse {
  readonly stage: PipelineStage;
  readonly status: PipelineStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly runner?: string;
  readonly model?: string;
  readonly reasoning?: ReasoningLevel;
  readonly attempts?: number;
  readonly errorCode?: string;
}

/**
 * One stage's own log, as it was written (§95).
 *
 * The full runner output, already redacted at the point it was captured — the file the
 * `stage_failed` event carries two kilobytes of. Those two kilobytes were all a browser
 * could reach: enough to see that something failed, rarely enough to see why, and the
 * remedy was a terminal and a path nobody remembers.
 *
 * `perTask` is not an error. `implementation` and `code-review` run once per task and
 * write one log each, which the task view already serves; saying so is better than an
 * empty array that reads as "nothing happened".
 */
export interface StageLogView {
  readonly stage: PipelineStage;
  /** Oldest first, terminal escapes stripped. Empty when the stage wrote none. */
  readonly lines: string[];
  readonly present: boolean;
  /** How many lines the file holds, whether or not they all fit. */
  readonly total: number;
  readonly truncated: boolean;
  /** Set for the stages whose logs belong to a task rather than to the stage. */
  readonly perTask?: true;
}

export interface TaskSummaryView {
  readonly id: string;
  readonly title: string;
  readonly complexity: string;
  readonly risk: string;
  readonly state: TaskState;
  readonly attempts: number;
  /**
   * Why a `blocked` task is blocked (§20, §23).
   *
   * `agent` means the task's own runner answered BLOCKED (a decision the SDD
   * is missing); `dependency` means an upstream failure held the task back and
   * it never ran. Only the second is ever released by recovery. Absent on a
   * blocked task, treat it as `agent` — absence is evidence of nothing.
   */
  readonly blockReason?: 'agent' | 'dependency';
  readonly requirements: string[];
  readonly dependencies: string[];
  /** Present on corrective tasks, which answer a finding rather than a requirement. */
  readonly correctiveFor?: { readonly stage: string; readonly findingType: string };
  /**
   * What ran, from `result.json` — or from the newest attempt artifact when there is no
   * `result.json` (Issue #21).
   *
   * **Two sources, because one of them is often absent by design.** `task-executor.ts`
   * writes `result.json` only in sequential mode; under worktrees the sole writer is the
   * Integrator's success path, so a `failed` or `review_required` task in an isolated run
   * has none — permanently. This triple then came back empty for a task that had run
   * twice, on a board whose first question is what is doing the work.
   *
   * Never from configuration, in either case. A completed task's model cannot move when
   * a role's YAML changes, and `run-actions.ts` refuses the one action that could rewrite
   * the artifact under new configuration: a retry of a `completed` task, which `--force`
   * deliberately does not open.
   *
   * `undefined` means **nothing recorded a model** and nothing more than that. It is not
   * evidence that the runner chose its own default: a record can be a *plan*
   * (`plannedExecution` resolves the role without the member), `runners.<id>.model` is a
   * fourth place a model can be configured that no record sees, and the
   * openai-compatible adapter sends the literal string `'default'`. See
   * `contracts/model-identity.ts`.
   */
  readonly runner?: string;
  readonly model?: string;
  readonly reasoning?: ReasoningLevel;
  /**
   * How long the task took, from `result.json` only.
   *
   * **Deliberately not backfilled from an attempt.** The newest attempt of a task that
   * ran twice took less time than the task did, and `validationPassed` below reads as the
   * task's verdict rather than one attempt's commands. Reporting either from an attempt
   * would answer a question with a different question's answer.
   */
  readonly durationMs?: number;
  readonly validationPassed?: boolean;
  /**
   * An isolated workspace is live for this task right now (§21.2).
   *
   * Derived — `running` in a worktree run — rather than stored, because a boolean
   * on disk saying "a workspace exists" is a second copy of a fact the task's own
   * state already carries, and the two could disagree after a crash.
   */
  readonly workspaceActive?: boolean;
  /**
   * The attempt is validated and its marker is not on the integration branch yet.
   *
   * The state that has no name in `TaskState` and that a person watching a parallel
   * run most needs to see: the work is done, the merge has not happened, and
   * `completed` would be a lie until it does (I-3).
   */
  readonly awaitingIntegration?: boolean;
  /** Where this task's validated tree landed (§10.3). Ref names and oids only. */
  readonly integration?: {
    readonly attempt: number;
    readonly branch: string;
    readonly marker: string;
    readonly mergeCommit: string;
    readonly validatedTree: string;
    readonly integratedAt: string;
  };
}

export interface TaskDetailView extends TaskSummaryView {
  readonly description: string;
  readonly acceptanceCriteria: string[];
  readonly validation: string[];
  readonly validationExpectation: string;
  readonly files: string[];
  readonly filesChanged: string[];
  readonly notes: string[];
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly reasoningClamped?: boolean;
  readonly fallback?: { readonly from: string; readonly errorCode: string };
  readonly errorCode?: string;
  readonly commands: {
    readonly command: string;
    readonly exitCode: number;
    readonly durationMs: number;
    readonly stdout: string;
    readonly stderr: string;
  }[];
  /**
   * The newest attempt's log lines, already stripped of terminal escapes.
   *
   * One flat field so a caller that does not care about attempts still gets an answer to
   * "what happened". {@link attemptLogs} carries the rest.
   */
  readonly log: string[];
  /**
   * Every attempt's log, oldest first (C-07).
   *
   * A retry is a fresh attempt in every respect, including its log, and a task that failed
   * twice before succeeding has three of them. Collapsing that into one field would delete
   * the record of exactly the attempt somebody is retrying because they wanted to read it.
   *
   * Empty for a sequential run, which writes one unsuffixed log and always did.
   */
  readonly attemptLogs?: { readonly attempt: number; readonly lines: string[] }[];
  /**
   * What each attempt did, oldest first (AR-08).
   *
   * The flattened fields above describe the **newest** attempt only. That was tolerable
   * while a second attempt required somebody to type `retry --force`; with AR-03's
   * automatic recovery on by default it is the normal path, and the questions it leaves
   * unanswerable are the ones a person actually has — what failed the first time, whether
   * it cost a budget, and whether the retry ran on the same model.
   *
   * Absent rather than empty for a task with no attempt artifacts. A sequential run writes
   * one unsuffixed log and no receipts, and "0 attempts" over a task that ran is wrong.
   */
  readonly attemptHistory?: AttemptHistoryView[];
}

/**
 * One attempt, as its own artifact recorded it (§11.3, AD-34).
 *
 * Read from `attempt-<n>.json` and `attempt-<n>.failed.json` rather than reconstructed from
 * the task's current state, which only remembers the last one. `consumedAttempt` in
 * particular is *recorded* rather than recomputed: it is the decision the recovery budget
 * was applied to at the time, and a reader asking "why was retry still allowed" deserves an
 * answer that does not depend on a policy table that may since have changed (I-22).
 */
export interface AttemptHistoryView {
  readonly attempt: number;
  readonly outcome: 'succeeded' | 'failed';
  /** What actually ran, not what was configured — under a fallback the two differ. */
  readonly runner: string;
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  readonly reasoningClamped: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Present on a failure. The refined class, never the raw transport code. */
  readonly failureClass?: string;
  /** Whether this failure spent one of the task's work attempts (AD-37, I-22). */
  readonly consumedAttempt?: boolean;
  /** Just the command names. The output lives in the log, which is paired below. */
  readonly failedCommands: string[];
  /** This attempt's own log, already stripped of terminal escapes. Empty when none. */
  readonly log: string[];
  /**
   * What this attempt's prompt cost, in bytes (AR-09).
   *
   * Absent when nothing measured it — a run predating the measurement, or a stage whose
   * event never landed. Reporting `0` would be a number nobody produced.
   */
  readonly contextBytes?: number;
  /**
   * What this retry's context added over the attempt it replaced (AR-09).
   *
   * Absent on the first attempt, which has nothing to be compared against. Negative when
   * the retry was cheaper, which happens and is worth saying: a packet that displaced a
   * large advisory block makes the second attempt smaller than the first.
   */
  readonly recoveryCost?: { readonly addedBytes: number; readonly addedShare: number };
}

/**
 * The plan's dependency graph, and nothing else (§92, UI-28).
 *
 * Structure only: ids, edges and a drawing rank. Every fact *about* a task — its
 * title, its status, which model ran it — comes from `/tasks`, which the same
 * screen already holds. That split is not tidiness. The graph changes when the
 * plan changes, which is rare; statuses change constantly, and a view that
 * carried both would re-run its layout every time a task moved.
 *
 * `depth` is a column index, not a schedule. It is the longest dependency chain
 * reaching a task. Two tasks at the same depth are not a parallel wave — the
 * scheduler runs one at a time, in topological order.
 */
export interface RunDagView {
  readonly runId: string;
  readonly projectId: string;
  readonly nodes: { readonly taskId: string; readonly depth: number }[];
  readonly edges: { readonly from: string; readonly to: string }[];
  /**
   * Dependencies naming a task the plan does not contain.
   *
   * Reported instead of drawn. A phantom node would put a task on screen that
   * nothing describes, and dropping the edge in silence would show a waiting task
   * as a root.
   */
  readonly unresolved: { readonly taskId: string; readonly dependsOn: string }[];
  /** Present when the plan's graph is not acyclic. Then `depth` means nothing. */
  readonly invalid?: {
    readonly kind: string;
    readonly message: string;
    readonly cycle?: string[];
  };
}

/**
 * The run's audit log, as it was written (Deck: the recorder).
 *
 * **A copy of the trail, not a projection over it.** Every other view in this file folds
 * `events.jsonl` into an answer — a stage status, a lane, a priority. This one hands the
 * lines over so a surface can draw *when* each fact became true and let a person scrub back
 * to it. Nothing the browser draws from this is authoritative: the moment it asks "what is
 * the state now" it asks `/tasks` and `/stages`, which are the server's answer.
 *
 * The same lines already cross this boundary one at a time, spread into the SSE payload
 * (`event-bridge.ts`); this is the batch form for a reader who arrived after they happened.
 *
 * Bounded, and the bound is reported. A log that outgrows it keeps its **newest** lines —
 * the present is what an operator is usually asking about — and `truncated` says the
 * origin was cut, so a timeline whose first tick is not `run_created` can say why.
 */
export interface RunEventLogView {
  readonly runId: string;
  readonly projectId: string;
  /** Oldest first, as the file is. */
  readonly events: RunEvent[];
  /** How many lines the file holds, whether or not they all fit. */
  readonly total: number;
  readonly truncated: boolean;
}

export interface ArtifactView {
  readonly name: string;
  readonly label: string;
  readonly available: boolean;
  readonly sizeBytes?: number;
  readonly updatedAt?: string;
}

export interface ArtifactContentView extends ArtifactView {
  readonly content: string;
  readonly truncated: boolean;
}

export interface RunnerView {
  readonly id: string;
  /** The adapter type. Never a credential, never a path to one. */
  readonly provider: string;
  readonly reasoningLevels: ReasoningLevel[];
  readonly structuredOutput: string;
}

/**
 * A runner type this installation supports, and what declaring one takes (§7).
 *
 * The list the editor offers when somebody adds their own agent. Sent by the server
 * because the server is where adapters are registered: a browser holding its own copy
 * would ship one machine's runners as everybody's, which is exactly what the local-only
 * template did.
 */
export interface RunnerTypeView {
  readonly type: string;
  /** Which keys this type reads, and which it cannot work without. */
  readonly fields: readonly {
    readonly name: string;
    readonly required: boolean;
    /** Holds the *name* of an environment variable, never a value (§7.1). */
    readonly secretEnv?: true;
  }[];
  /** The CLI's own surface, before a model narrows it. */
  readonly capabilities: {
    readonly supportedReasoningLevels: readonly ReasoningLevel[];
    readonly supportsReadOnly: boolean;
    readonly supportsWorkingDirectory: boolean;
    readonly structuredOutputStrategy: 'native' | 'prompted';
  };
}

/**
 * The models a runner reports it can be pointed at (AD-13).
 *
 * Asked of the provider — `agy models`, an OpenAI-compatible `GET /models` — never held
 * as a table in this repository, where it would be provider knowledge above the adapter
 * boundary and would rot besides. `models` is empty for a runner that cannot enumerate,
 * which is a fact about that CLI and not an error.
 *
 * A **suggestion**, never a constraint: a model released this morning has to stay
 * typeable this morning, so nothing downstream may treat this as the set of valid values.
 */
export interface RunnerModelsView {
  readonly id: string;
  readonly models: readonly string[];
}

export interface RunnerHealthView {
  readonly id: string;
  readonly installed: boolean;
  readonly executable: boolean;
  readonly auth: string;
  readonly version?: string;
  readonly detail?: string;
}

/** One end of a configured route: a runner, a model, an effort. */
export interface RoutedAgentView {
  readonly runner: string;
  /** Absent when the role pins no model and the runner's own default applies. */
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  /** True when the runner cannot do the configured effort and ran below it. */
  readonly reasoningClamped: boolean;
  readonly structuredOutput: string;
}

/**
 * What one logical role would run (§82).
 *
 * Three layers, deliberately not collapsed: the role the workflow asks for, the
 * route a human configured, and the route that would actually resolve. They agree
 * most of the time, and the times they do not are the only times this page matters.
 */
export interface RoleRouteView {
  readonly role: string;
  /**
   * Where this role's route lives in a configuration source.
   *
   * `executor.trivial` is written `roles.executors.trivial`, and an editor that
   * reconstructed that from the role name would be keeping a private copy of a rule
   * `roleConfigOf` already owns. Sent so the browser can address the value it edits.
   */
  readonly configKeys: readonly string[];
  /** The prompts this role runs, and therefore what its runner must support. */
  readonly prompts: string[];
  readonly requiresReadOnly: boolean;
  /** True when the role writes: it needs a runner with a working directory. */
  readonly requiresWorkingDirectory: boolean;
  readonly requiresNativeStructuredOutput: boolean;
  readonly configured: {
    readonly runner: string;
    readonly model?: string;
    readonly reasoning: ReasoningLevel;
    readonly timeoutSeconds: number;
  };
  readonly resolved?: RoutedAgentView;
  /** Present when the configured route cannot be resolved at all. */
  readonly error?: { readonly kind: string; readonly message: string };
  readonly fallback?: RoutedAgentView;
  /** Why there is no fallback. Absent by choice is not the same as unusable. */
  readonly fallbackAbsent?: 'disabled' | 'not_configured' | 'unusable';
}

/**
 * A repository the workspace could register, named by an id the server issued (7.6).
 *
 * The reason this exists rather than a path field on the request: the whole filesystem
 * security model is that a client names an id and the registry resolves it (§93). A
 * directory with no `.agent-flow/` had no id, so there was no request shape that could
 * ask for it — which is why "add a project" was a disabled button for two milestones.
 */
/**
 * What `clean` did, or what it would do (§20, 7.7).
 *
 * Assigned from `app/workspace-cleanup.ts`'s own report, the way `DoctorView` is — the
 * shapes are linked by a compile error rather than by two people remembering.
 *
 * The two refusals are separate outcomes because their repairs are: `locked` means
 * somebody is executing that run right now, and `namespace_failed` means Git would not
 * let go of something, so §20.1 keeps the state that explains what is still on disk.
 */
export interface CleanRunView {
  readonly runId: string;
  readonly outcome: 'locked' | 'namespace_failed' | 'removed';
  readonly reclaim?: {
    /** Workspace-relative, never absolute (§7.2, §21.3). */
    readonly worktrees: readonly string[];
    /** Kept because they are the only copy of what their agent produced (§20.3). */
    readonly worktreesRetained: readonly string[];
    readonly attemptRefs: readonly string[];
    readonly integrationBranch: {
      readonly kind: 'redundant' | 'forced' | 'kept' | 'absent';
      readonly ref?: string;
      readonly mergedInto?: string;
      readonly head?: string;
    };
    readonly stateRemovable: boolean;
    /** Path-free sentences, one per thing that could not be done. */
    readonly failures: readonly string[];
  };
}

export interface CleanView {
  /** True when nothing was written and every outcome is what *would* happen. */
  readonly dryRun: boolean;
  readonly keep: number;
  readonly totalRuns: number;
  readonly runs: readonly CleanRunView[];
  /** The active run, kept because `force` was not set. Named rather than skipped. */
  readonly protectedRun?: string;
  /**
   * Throwaway workspaces that belonged to no run (§20.5).
   *
   * `doctor`'s install probe and a read-only stage each cut one, both at the top of the
   * owned root, and both outside every per-run reclamation. Reported by segment, never by
   * path (§21.3).
   */
  readonly strays: readonly { readonly segment: string; readonly removed: boolean }[];
  readonly cacheRemoved: boolean;
  /** Something was refused — a non-zero exit in a terminal, a warning on a screen. */
  readonly refused: boolean;
}

export interface ProjectCandidateView {
  readonly id: string;
  readonly name: string;
}

export interface ProjectRegisteredView {
  /** The project as the registry now knows it — the id every later request uses. */
  readonly project: ProjectView;
  readonly stack: { readonly type: string; readonly name: string };
  /** Project-relative, never absolute (§21.3). */
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly skipped: readonly string[];
  /**
   * What the operator has to know before the first feature.
   *
   * `install_dirties_tree` is the expensive one: a Node project with no committed
   * lockfile is handed `npm install`, which rewrites it, which fails the post-setup
   * cleanliness assertion, which refuses every task in worktree mode. A live run
   * discovered that after paying for planning.
   */
  readonly warnings: readonly (
    | { readonly kind: 'install_dirties_tree'; readonly command: string }
    | { readonly kind: 'no_validation_commands' }
    | { readonly kind: 'active_run'; readonly runId: string; readonly status: string }
  )[];
}

/**
 * "Can this machine work?", over HTTP (§59).
 *
 * The first question of every working day, and until now only a terminal could ask it:
 * `doctor` computed each fact and immediately printed it, so the CLI was both the only
 * caller and the only possible one. On a surface that is meant to replace the terminal,
 * that made the answer unreachable exactly where it is needed first.
 *
 * **Not a hand-copied mirror.** `app/diagnostics.ts` owns the shape; `contracts` may not
 * import `app`, so the link is made by assignment instead — `server.ts` assigns a
 * `Diagnosis` straight into a `DoctorView`, and a field that moves or disappears there is
 * a compile error here. That is deliberately the lesson of the artifact-name defect: a
 * second list that agrees only until somebody edits one of them.
 *
 * Deliberately widened in two places. `PermissionFinding` and `ProbeResult` are declared
 * in `core` and `app`, and their string unions are re-declared as `string` rather than
 * imported — a narrower union is assignable to `string`, so the compile-time link holds,
 * and the browser gains nothing from being unable to type a value the server may add.
 */
export interface DoctorToolView {
  readonly name: 'node' | 'git';
  readonly present: boolean;
  readonly version?: string;
  /** Git only: the worktree-mode floor, so the answer sits beside the question. */
  readonly floor?: string;
  readonly belowFloor?: boolean;
}

export interface DoctorCapabilityView {
  readonly kind: 'resolved' | 'unresolvable';
  readonly role: string;
  readonly runner: string;
  readonly model?: string;
  readonly requestedReasoning: ReasoningLevel;
  readonly effectiveReasoning?: ReasoningLevel;
  readonly supportedReasoningLevels?: readonly ReasoningLevel[];
  readonly reasoningClamped?: boolean;
  readonly permissions?: 'read-only' | 'write';
  readonly permissionFinding?: {
    readonly failureClass: string;
    readonly runner: string;
    readonly model?: string;
    readonly toolClass: string;
    readonly action: string;
  };
  /** `unresolvable` only. */
  readonly errorKind?: string;
  readonly reason?: string;
}

export interface DoctorStageRoutingView {
  readonly stage: string;
  readonly role: string;
  readonly runner: string;
  readonly runnerType: string;
  readonly readsRepository: boolean;
  /** A stage that opens no file, served by a runner that spawns a process. */
  readonly overpowered: boolean;
}

export interface DoctorInstallProbeView {
  readonly outcome: 'skipped' | 'dirty_before' | 'install_failed' | 'clean' | 'dirties_checkout';
  readonly reason?: string;
  readonly command?: string;
  readonly entries?: readonly string[];
}

export interface DoctorRunnerView {
  readonly id: string;
  readonly installed: boolean;
  readonly executable: boolean;
  readonly auth: string;
  readonly version?: string;
  readonly detail?: string;
}

export interface DoctorProbeView {
  readonly id: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly detail?: string;
  readonly efforts?: readonly {
    readonly reasoning: ReasoningLevel;
    readonly outcome: string;
    readonly detail?: string;
  }[];
  readonly toolUse?: { readonly outcome: string; readonly detail?: string };
}

export interface DoctorView {
  readonly status: 'OK' | 'DEGRADED' | 'FAIL';
  readonly tools: readonly DoctorToolView[];
  readonly install: DoctorInstallProbeView;
  readonly capabilities: readonly DoctorCapabilityView[];
  readonly stageRouting: readonly DoctorStageRoutingView[];
  readonly unusedRunners: readonly { readonly id: string; readonly type: string }[];
  readonly runners: readonly DoctorRunnerView[];
  /** Empty unless a deep probe was asked for; the route never asks for one. */
  readonly probes: readonly DoctorProbeView[];
  readonly orphanRoles: readonly { readonly role: string; readonly primary: string }[];
  readonly degradations: readonly {
    readonly kind: string;
    readonly reason: string;
    readonly impact: string;
  }[];
  readonly notes: readonly string[];
  readonly unresolvableRoles: readonly string[];
  readonly remediations: readonly { readonly problem: string; readonly fix: string }[];
  /**
   * False from this route, always, and the browser has to say so.
   *
   * The server may not read the process environment (§93), so a runner authenticated by
   * `apiKeyEnv` answers `401` to a health check made without its key and is reported
   * `not configured`. Repeating that as a finding would send somebody to fix credentials
   * that are already there — the flag is what lets the page write "not checked from here"
   * instead.
   */
  readonly readsEnvironment: boolean;
  readonly remoteAccess: DoctorRemoteAccessView;
}

/**
 * Remote access status as reported by GET /api/v1/doctor (FR-023).
 *
 * Known by the running server process; unknown from a standalone CLI command.
 */
export type DoctorRemoteAccessView =
  | { readonly known: false }
  | {
      readonly known: true;
      readonly enabled: boolean;
      readonly admittedAddresses: readonly string[];
      readonly liveSessions: number;
    };

/**
 * A live paired device session, as listed by GET /api/v1/sessions (FR-011).
 *
 * Exposes deviceId, label, and activity timestamps. No secret and no hash of one
 * appears in this view (SEC-003). Declares no filesystem path field
 * (test/architecture.test.ts:1851-1898).
 */
export interface DeviceSessionView {
  readonly deviceId: string;
  readonly label: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
}

/**
 * Result of successfully pairing a device via POST /api/v1/pair (FR-005).
 *
 * Sets an HttpOnly session cookie on the response; the body contains device metadata
 * and never contains a secret.
 */
export interface PairResponseView {
  readonly deviceId: string;
  readonly label: string;
  readonly pairedAt: number;
}

/**
 * A prompt as an asset (§83).
 *
 * No version field, because prompts declare none — and inventing one would be
 * metadata nothing enforces and nothing reads, which this codebase already
 * decided is worse than absent. `digest` is the identity instead: it changes when
 * the prompt changes, which is the property a version number is wanted for.
 */
export interface PromptView {
  readonly name: string;
  /** Relative to the installed package. Never an absolute path. */
  readonly source: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
  /** Short digest of the file's bytes. */
  readonly digest: string;
  readonly permissions: string;
  readonly outputFormat: string;
  readonly requiredVars: string[];
  readonly nativeStructuredOutput: boolean;
  /** Logical roles that run this prompt. */
  readonly roles: string[];
  /** Pipeline stages that run it. Empty for the per-task implementation prompt. */
  readonly stages: string[];
  /** Present when the front matter would not parse. */
  readonly error?: string;
}

export interface PromptContentView extends PromptView {
  readonly content: string;
  readonly truncated: boolean;
}

/** One bucket of an aggregate, keyed by whatever it groups on. */
export interface MetricBucketView {
  readonly key: string;
  readonly count: number;
  readonly durationMs: number;
  readonly failures: number;
  readonly fallbacks: number;
  readonly retries: number;
}

/** Context estimates observed from the run audit trail; never provider billing. */
export interface ContextTelemetryView {
  readonly basis: 'estimated_operational_not_billing';
  readonly scope: {
    readonly eventsScanned: number;
    readonly eventLimit: number;
    readonly observations: number;
    readonly truncated: boolean;
  };
  readonly observations: readonly ContextTelemetryObservation[];
  /** Absent only when a capped log prevents an honest not-observed conclusion. */
  readonly aggregate?: ContextTelemetryObservation;
}

/** Bounded cross-run context estimates, kept separate from runner telemetry. */
export interface ContextTelemetryAnalyticsView {
  readonly basis: 'estimated_operational_not_billing';
  readonly scope: {
    readonly runsObserved: number;
    readonly observations: number;
    readonly observationLimit: number;
    readonly eventLogsTruncated: number;
    readonly truncated: boolean;
  };
  readonly aggregate?: ContextTelemetryObservation;
  /**
   * Per-observation outcome counts — mechanically proven, never derived from
   * overlapping aggregate counters.
   *
   * `deliveredAdvisories` counts observations where bypassReason is absent.
   * `bypassedObservations` counts observations where bypassReason is present.
   * Each is counted independently; they sum to `observations`.
   * `bypassReasons` is a closed-vocabulary histogram sorted by count descending.
   */
  readonly outcomes?: {
    readonly observations: number;
    readonly utilityCalls: number;
    readonly deliveredAdvisories: number;
    readonly bypassedObservations: number;
    readonly bypassReasons: ReadonlyArray<{
      readonly reason: string;
      readonly count: number;
    }>;
  };
}


/**
 * Operational analytics (§84), derived and never stored.
 *
 * Every number here is a projection of the same state and event files the CLI
 * reads. Nothing is recorded for analytics' sake, so there is no third writer to
 * disagree with the two that exist — and nothing here can be stale in a way
 * `status` is not.
 *
 * No monetary figure appears, at any level. Duration and counts are facts this
 * tool observed; a price is a guess about somebody else's contract.
 */
/**
 * One run's telemetry, as the route actually answers it (7.4).
 *
 * The previous dashboard declared this shape by hand and **lost `context` doing it** — the
 * AR-09 estimates are the half that answers "why did that stage cost so much", and a
 * hand-copied response type is exactly how a served field comes to have no reader. Declared
 * here, assigned from the handler, so a field that moves is a compile error.
 *
 * `summary` mirrors `core/telemetry.ts`'s own summary, widened where that module's types
 * are its own: `contracts` may not import `core`, and a narrower record is assignable to a
 * wider one, so the link holds without the dependency.
 */
export interface TelemetryBucketView {
  readonly count: number;
  readonly durationMs: number;
  readonly failures: number;
  readonly fallbacks: number;
  readonly retries: number;
}

export interface TelemetrySummaryView {
  readonly entries: number;
  readonly durationMs: number;
  readonly failures: number;
  readonly fallbacks: number;
  readonly retries: number;
  /** Entries that ran below the effort they were configured for (R-15). */
  readonly reasoningClamped: number;
  readonly byRunner: Record<string, TelemetryBucketView>;
  /** Keyed by the model the runner reported; entries without one are omitted. */
  readonly byModel: Record<string, TelemetryBucketView>;
  readonly byRole: Record<string, TelemetryBucketView>;
  readonly byStage: Record<string, TelemetryBucketView>;
}

export interface RunTelemetryView {
  readonly entries: readonly TelemetryEntry[];
  readonly summary: TelemetrySummaryView;
  /** Absent means context telemetry was not observed; it never means zero. */
  readonly context?: ContextTelemetryView;
}

export interface AnalyticsView {
  readonly scope: {
    readonly projectIds: string[];
    readonly runsAvailable: number;
    readonly runsConsidered: number;
    /** True when older runs were excluded from every number below. */
    readonly truncated: boolean;
  };
  readonly runsByProject: {
    readonly projectId: string;
    readonly total: number;
    readonly byStatus: Record<string, number>;
  }[];
  readonly tasksByState: Record<string, number>;
  readonly totals: {
    readonly entries: number;
    readonly durationMs: number;
    readonly failures: number;
    readonly fallbacks: number;
    readonly retries: number;
    readonly reasoningClamped: number;
  };
  readonly byRunner: MetricBucketView[];
  readonly byModel: MetricBucketView[];
  readonly byRole: MetricBucketView[];
  readonly byStage: MetricBucketView[];
  /** Absent means context telemetry was not observed; it never means zero. */
  readonly context?: ContextTelemetryAnalyticsView;
}

/**
 * The approval gate as the server computes it (§90).
 *
 * `planHash` is shown so a person can see what they are about to approve. It is
 * never accepted back — the approve endpoint recomputes it, so a value that
 * arrived from a browser has nowhere to go.
 *
 * No `sddVersion` or `planVersion`, because neither artifact declares one.
 * `sddDigest` is a digest and says so; inventing a version number would be
 * metadata nothing maintains, presented as if somebody did.
 */
export interface ApprovalGateView {
  readonly runId: string;
  readonly approved: boolean;
  readonly approvedAt?: string;
  readonly canApprove: boolean;
  readonly refusal?: { readonly kind: string; readonly forcible: boolean };
  /** What the person should know before deciding — degradations, mostly (R-16). */
  readonly warnings: string[];
  readonly planHash: string;
  readonly taskCount: number;
  readonly sddDigest?: string;
  readonly review?: {
    readonly verdict: string;
    readonly independence: string;
    readonly planHash?: string;
    /** Whether the verdict is about the plan currently on disk. */
    readonly coversThisPlan: boolean;
    readonly findings: Finding[];
    readonly adjudications?: FindingAdjudication[];
    readonly residualRisks?: readonly string[];
    /** The integration HEAD the reviewer read the code against (§19.2). Absent for legacy reviews. */
    readonly integrationHead?: string;
    /**
     * Whether this verdict still describes the code that is integrated (M6, I-41).
     *
     * **Answered here rather than in the browser.** The dashboard used to compute it from
     * whichever fields it happened to hold, which is precisely what M6 §59 forbids: a
     * surface deriving review freshness by its own rules is a second authority, and its
     * first disagreement with the run puts a decision nobody made on screen.
     *
     * `unverifiable` when either side has no commit — a plan-only run has no code for a
     * review to have gone stale against, and calling that stale would be a claim nobody
     * measured.
     */
    readonly freshness: 'current' | 'stale' | 'unverifiable';
  };
  readonly degradations: Degradation[];
}

/** A long action in flight (UI-27). Never a second channel for run state. */
export interface ActionJobView {
  readonly id: string;
  readonly kind: string;
  readonly projectId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly error?: ActionErrorView;
}

/**
 * A refused action, as §95 requires it: what happened, and what to do about it.
 *
 * `error` is a code a client may branch on; `message` and `action` are for the
 * person. No stack trace crosses this boundary, ever.
 */
export interface ActionErrorView {
  readonly error: string;
  readonly message: string;
  readonly action?: string;
  /** True when a deliberate override could get past this refusal. */
  readonly forcible?: boolean;
  readonly detail?: Record<string, unknown>;
}

/** A completed synchronous action. Warnings ride along even on success (R-16). */
export interface ActionResultView {
  readonly runId: string;
  readonly warnings: string[];
  readonly detail?: Record<string, unknown>;
}

/**
 * One effective setting, with the layer that produced it (§85).
 *
 * The origin is the point. A value alone invites an edit to whichever file the
 * reader happens to open; a value plus "this project overrides it" says which file
 * will actually take effect.
 */
export interface ConfigSettingView {
  /** Dotted path into the merged config. Stable, and what a person would grep. */
  readonly key: string;
  readonly label: string;
  /** Rendered for reading. Never a secret, never an environment variable. */
  readonly value: string;
  readonly origin: 'default' | 'global' | 'project';
  /** Present when the value has a consequence worth stating beside it. */
  readonly note?: string;
}

export interface ConfigSectionView {
  readonly id: string;
  readonly title: string;
  /** Present when the section exists in the spec and has nothing behind it. */
  readonly note?: string;
  readonly settings: ConfigSettingView[];
}

export interface ConfigView {
  readonly sources: {
    readonly globalPath: string;
    readonly globalPresent: boolean;
    readonly projectPath: string;
    readonly projectPresent: boolean;
  };
  readonly sections: ConfigSectionView[];
  /**
   * Present when the configuration would not load at all.
   *
   * Returned with the sources rather than as a failed request: a broken config is a
   * state the page must show, and the paths are exactly what somebody needs to fix
   * it (§95).
   */
  readonly configError?: string;
}

export type ConfigEditorScope = 'global' | 'project';
export type ConfigEditorPath = readonly (string | number)[];

export interface ConfigEditorFieldView {
  readonly path: ConfigEditorPath;
  readonly explicitValue: unknown;
  readonly effectiveValue: unknown;
  readonly origin?: 'default' | 'global' | 'project';
  readonly editable: boolean;
  readonly reason?: 'global_only';
  readonly effect: 'server_restart' | 'next_run' | 'next_execution_context';
  readonly valueType: 'string' | 'boolean' | 'integer' | 'number' | 'string_list' | 'reasoning_level' | 'enum';
  /**
   * What a closed field accepts, in the schema's order.
   *
   * Present for `enum` and `reasoning_level`, absent for every open type. Without it a
   * browser knows a field is closed and still has to render free text, which turns a
   * typo into a round-trip and a diagnostic instead of a value it could never have
   * picked (§95).
   */
  readonly options?: readonly string[];
}

export interface ConfigEditorDynamicFieldView {
  readonly path: readonly string[];
  readonly editable: boolean;
  readonly reason?: 'global_only';
  readonly effect: ConfigEditorFieldView['effect'];
  readonly valueType: ConfigEditorFieldView['valueType'];
  readonly options?: readonly string[];
}

export interface ConfigEditorView {
  readonly target: { readonly scope: ConfigEditorScope; readonly projectId?: string };
  readonly revision: string;
  readonly exists: boolean;
  readonly fields: readonly ConfigEditorFieldView[];
  readonly dynamicFields: readonly ConfigEditorDynamicFieldView[];
  /** Names are safe for diagnostics; values of unknown nodes never cross the API. */
  readonly unknownKeys: readonly string[];
}

export interface ConfigEditorDiagnosticView {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly path: ConfigEditorPath;
  readonly message: string;
  readonly action?: string;
}

export interface ConfigEditorChangeView {
  readonly path: ConfigEditorPath;
  readonly before: unknown;
  readonly after: unknown;
  readonly effect: ConfigEditorFieldView['effect'];
}

export interface ConfigValidationView {
  readonly valid: boolean;
  readonly revision: string;
  readonly diagnostics: readonly ConfigEditorDiagnosticView[];
  readonly changes: readonly ConfigEditorChangeView[];
}

/** The SSE envelope of §87. */
export interface ServerEvent {
  readonly type: string;
  readonly projectId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

export interface ApiError {
  readonly error: string;
  readonly message: string;
}

/* ─── Collaboration (M4-07) ────────────────────────────────────────────────── */

/**
 * One agent, as the dashboard and `status` both render it.
 *
 * The roster is *derived* from configuration rather than persisted, so this is a view of
 * what the run would resolve rather than of a record. It carries no credential and no
 * path: a runner *id* is a configuration key the operator chose, and the model is the
 * opaque string AD-13 keeps it as.
 */
export interface AgentView {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly runner: string;
  readonly model?: string;
  readonly skills: readonly string[];
}

export interface MessageView {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  /** The sender's display name, resolved through the run's roster once, here. */
  readonly fromName: string;
  /** An agent id, `@role`, or `everyone`. Flattened for display only. */
  readonly to: string;
  readonly type: string;
  readonly taskId?: string;
  readonly subject: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly createdAt: string;
}

export interface ThreadView {
  readonly id: string;
  readonly status: string;
  readonly subject: string;
  readonly opener: string;
  readonly taskId?: string;
  readonly participants: readonly string[];
  readonly messages: readonly MessageView[];
  readonly openedAt: string;
  readonly lastMessageAt: string;
}

export interface HandoffView {
  readonly threadId: string;
  readonly taskId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly settledAt?: string;
}

export interface BlackboardEntryView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly subject: string;
  readonly author: string;
  readonly authorName: string;
  readonly statement: string;
  readonly rationale?: string;
  readonly affects: readonly string[];
  readonly supersedes?: string;
  readonly supersededBy?: string;
  readonly createdAt: string;
}

/**
 * Everything one run's collaboration amounts to, in one response.
 *
 * One response rather than four endpoints, because the four are read together — a
 * dashboard tab shows threads *and* decisions — and because a thread's status and an
 * entry's status are folds over logs that must be read at one instant. Four calls would
 * make a repaint able to show a thread as open beside the entry that closed it.
 *
 * `enabled` is the run's *configuration*, not whether anything was said. The two are
 * different answers and the empty state depends on which: "off" invites the operator to
 * turn it on, and "on, and quiet" does not.
 */
export interface CollaborationView {
  readonly enabled: boolean;
  readonly agents: readonly AgentView[];
  readonly threads: readonly ThreadView[];
  readonly handoffs: readonly HandoffView[];
  readonly entries: readonly BlackboardEntryView[];
}

/* ─── Team (M5) ────────────────────────────────────────────────────────────── */

/**
 * One member of a configured team, as the dashboard and the CLI both see it (§37).
 *
 * **`status` is derived, never stored.** A member is `working` because a task the run
 * says is running was assigned to it, and `full` because it has as many as its capacity
 * allows. A persisted `busy` flag would be a second copy of task state, and it would be
 * the copy that survives a crash saying somebody is working on a task that is not.
 *
 * Carries no credential and no path: a runner id is a configuration key, the model is the
 * opaque string AD-13 keeps it as, and an ownership pattern is repository-relative by the
 * schema that accepted it.
 */
export interface TeamMemberView {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly runner: string;
  readonly model?: string;
  readonly skills: readonly string[];
  readonly specializations: readonly string[];
  readonly maxConcurrentTasks: number;
  readonly ownership: {
    readonly preferred: readonly string[];
    readonly exclusive: readonly string[];
    readonly shared: readonly string[];
  };
  /** Task ids the run currently has running with this member. */
  readonly assigned: readonly string[];
  /** How many tasks this member has been assigned across the whole run. */
  readonly assignedTotal: number;
  readonly status: 'idle' | 'working' | 'full';
}

/** One member's place in a ranking, with the reason it was ruled out if it was. */
export interface CandidateView {
  readonly agentId: string;
  readonly agentName: string;
  readonly score: number;
  readonly skillMatch: number;
  readonly ownership: number;
  readonly riskFit: number;
  readonly matchedSkills: readonly string[];
  readonly excludedBy?: string;
}

/**
 * Why this task went to this agent (§38).
 *
 * The ranking rides along because "the AI decided" is not an answer (I-34): an operator
 * asking why Backend did not get a task is asking about the candidate that lost, and a
 * view holding only the winner cannot say.
 */
export interface TaskAssignmentView {
  readonly taskId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly role: string;
  readonly reason: string;
  readonly detail?: string;
  readonly previousAgentId?: string;
  readonly assignedAt: string;
  readonly candidates: readonly CandidateView[];
}

/** A task a wave would not take, and what it waited for. */
export interface WaveDeferralView {
  readonly taskId: string;
  readonly reason: 'capacity' | 'ownership';
  readonly detail: string;
  readonly waitsFor?: string;
  readonly patterns: readonly string[];
  readonly agents: readonly string[];
}

/**
 * What the run's assignments amount to, counted (§41).
 *
 * Counted here rather than at each caller, so the CLI's summary line and the dashboard's
 * header cannot disagree about how many times a task changed hands.
 */
export interface TeamTotals {
  readonly assignments: number;
  readonly reassignments: number;
  readonly capacityDeferrals: number;
  readonly ownershipDeferrals: number;
  readonly candidatesConsidered: number;
  /**
   * How often each filter ruled a candidate out, across the run (§41).
   *
   * The aggregate a per-candidate `excludedBy` cannot give: "capacity fired forty times"
   * is a configuration to change, and forty rows each saying `capacity` is a list to
   * count. Keyed by the exclusion, so a reason this product has not invented yet appears
   * without a schema change.
   */
  readonly exclusions: Readonly<Record<string, number>>;
}

/**
 * A run's team, in one response (M5-ACC-15).
 *
 * **One projection, three surfaces.** The CLI, the HTTP API and the dashboard all render
 * this and none of them computes an assignment: a browser that ranked candidates would be
 * a second assignment authority, and the first time it disagreed with the run the operator
 * would be looking at a screen that describes a decision nobody made (I-33).
 *
 * `configured` is whether a `teams:` block exists, not whether anything was assigned. A
 * legacy run is `configured: false` with an empty member list, which is a different empty
 * state from a configured team that has not started — one invites configuration and the
 * other does not.
 */
export interface TeamView {
  readonly configured: boolean;
  readonly members: readonly TeamMemberView[];
  readonly assignments: readonly TaskAssignmentView[];
  readonly deferrals: readonly WaveDeferralView[];
  readonly totals: TeamTotals;
}

/* ─── Review (M6) ──────────────────────────────────────────────────────────── */

/**
 * The review view, declared where every layer can see it.
 *
 * Here rather than in `core/review/view.ts` for the reason `TeamView` is here: contracts
 * may not import from the core, and the browser needs the shape. The core produces this;
 * this describes it.
 *
 * **Deliberately the whole thing rather than a summary.** The browser renders the
 * decision the workflow acted on, which means it has to receive all of it — a view that
 * carried a verdict without its conditions would leave the dashboard to explain a refusal
 * it cannot see the reasons for, and explaining it would mean deriving them (§59).
 */
export type ReviewThreadStatus =
  | 'in_review'
  | 'changes_requested'
  | 'awaiting_recheck'
  | 'approved'
  | 'blocked';

export type FindingLifecycle = 'open' | 'acknowledged' | 'disputed' | 'fixed' | 'verified';

export interface ProjectedFindingView {
  readonly finding: ReviewFinding;
  readonly reviewId: string;
  readonly taskId: string;
  readonly round: number;
  readonly status: FindingLifecycle;
  readonly correctiveTask?: string;
  readonly verifiedBy?: string;
}

export interface QualityDecisionView {
  readonly approved: boolean;
  readonly conditions: readonly { name: string; met: boolean; detail?: string }[];
  readonly blockedBy: readonly string[];
}

export interface ReviewThreadView {
  readonly taskId: string;
  readonly status: ReviewThreadStatus;
  readonly freshness: 'current' | 'stale' | 'unverifiable';
  readonly rounds: number;
  readonly reviewer: string;
  readonly reviewerName: string;
  readonly author: string;
  readonly independence: number;
  readonly reviewedTree?: string;
  readonly integratedTree?: string;
  readonly findings: readonly ProjectedFindingView[];
  readonly openBlocking: number;
  readonly decision: QualityDecisionView;
}

export interface ReviewTotals {
  readonly reviews: number;
  readonly tasksReviewed: number;
  readonly findings: number;
  readonly openFindings: number;
  readonly verifiedFindings: number;
  readonly staleReviews: number;
  readonly disputes: number;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly byIndependence: Readonly<Record<string, number>>;
}

export interface ReviewView {
  /** Whether this run reviewed anything. A run with no reviewer is not an empty review. */
  readonly reviewed: boolean;
  readonly threads: readonly ReviewThreadView[];
  readonly gates: readonly QualityGateResult[];
  /**
   * The required gates that are not satisfied — answered, not derived.
   *
   * `required && status !== 'passed'` is the sentence that turns evidence into a refusal,
   * and one place answers it. The dashboard's own architecture rule caught the panel
   * recomputing this, which is exactly the second authority §59 forbids.
   */
  readonly unsatisfiedGates: readonly QualityGateResult[];
  readonly totals: ReviewTotals;
}

/* ─── Delivery (M7) ────────────────────────────────────────────────────────── */

/**
 * Declared here rather than in `core/forge/delivery.ts`, for the reason `TeamView` and
 * `ReviewView` are here: contracts may not import from the core, and the browser needs the
 * shape. M7 left it in the core and the dashboard reached four directories up to type its
 * own query — which worked, and was the layering rule holding only because nothing had
 * asked it a harder question yet. M8's control snapshot is that question.
 *
 * The core produces this; this describes it. `core/forge/delivery.ts` re-exports both
 * names so every existing import keeps working.
 */
export const DELIVERY_STATES = [
  /** No provider. The ordinary case, and not a problem. */
  'disabled',
  /** Configured, and nothing has been published yet. */
  'not_published',
  'published',
  'pr_open',
  'checks_pending',
  'checks_green',
  'checks_red',
  /** The remote branch moved under us. Publishing again would be guessing. */
  'remote_diverged',
  'delivery_failed',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface DeliveryView {
  readonly state: DeliveryState;
  readonly provider: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly publishedCommit?: string;
  readonly issue?: { readonly number: number; readonly url: string };
  readonly pullRequest?: { readonly number: number; readonly url: string; readonly state: string };
  readonly checks: readonly ForgeCheck[];
  readonly checkSummary: { readonly total: number; readonly green: number; readonly red: number; readonly pending: number };
  readonly syncedAt?: string;
  readonly failure?: ForgeFailure;
  /** A sentence for a person, always. A state name alone sends them to the source. */
  readonly detail: string;
}
