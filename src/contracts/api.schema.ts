import { z } from 'zod';
import type { ReasoningLevel } from './common.schema.js';
import type {
  Degradation,
  PipelineStage,
  PipelineStatus,
  RunStatus,
} from './state.schema.js';
import type { TaskState } from './task.schema.js';

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

/** Every read endpoint is scoped to one project. */
export const ProjectQuerySchema = z.object({ projectId: ProjectIdSchema.optional() });

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

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  /** Absolute path. Read-only information; no endpoint accepts one back. */
  readonly path: string;
  readonly stack?: string;
  readonly currentRunId: string | null;
  readonly status: RunStatus | null;
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
}

export interface RunDetailView extends RunSummaryView {
  readonly approvedAt?: string;
  readonly approvedPlanHash?: string;
  readonly degradationDetail: Degradation[];
  /** Overall progress, 0–100, from task states. Zero before a plan exists. */
  readonly progress: number;
  readonly startedAt: string;
  readonly durationMs: number;
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
  readonly requirements: string[];
  readonly dependencies: string[];
  /** Present on corrective tasks, which answer a finding rather than a requirement. */
  readonly correctiveFor?: { readonly stage: string; readonly findingType: string };
  readonly runner?: string;
  readonly model?: string;
  readonly reasoning?: ReasoningLevel;
  readonly durationMs?: number;
  readonly validationPassed?: boolean;
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
  /** Task log lines, already stripped of terminal escapes. */
  readonly log: string[];
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
