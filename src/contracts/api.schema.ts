import { z } from 'zod';
import type { QualityGateResult, ReviewFinding } from './review.schema.js';
import type { ReasoningLevel } from './common.schema.js';
import type { Finding, FindingAdjudication } from './review.schema.js';
import type {
  Degradation,
  PipelineStage,
  PipelineStatus,
  RunStatus,
  WorkflowClass,
} from './state.schema.js';
import type { TaskState } from './task.schema.js';
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

export const ArtifactParamsSchema = z.object({
  runId: RunIdParamSchema,
  artifact: z.enum([
    'request',
    'architectureImpact',
    'sdd',
    'plan',
    'planReview',
    'verification',
    'finalReview',
  ]),
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
});

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
  readonly runner?: string;
  readonly model?: string;
  readonly reasoning?: ReasoningLevel;
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
  /** The prompts this role runs, and therefore what its runner must support. */
  readonly prompts: string[];
  readonly requiresReadOnly: boolean;
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
