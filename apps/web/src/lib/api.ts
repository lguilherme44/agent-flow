import type {
  ActionJobView,
  ActionResultView,
  AnalyticsView,
  ApprovalGateView,
  ArtifactContentView,
  CollaborationView,
  TeamView,
  ReviewView,
  ConfigView,
  ArtifactView,
  HealthResponse,
  ProjectView,
  RunDetailView,
  RunSummaryView,
  RunnerHealthView,
  RunnerView,
  PromptContentView,
  PromptView,
  RoleRouteView,
  RunDagView,
  StageViewResponse,
  TaskDetailView,
  TaskSummaryView,
  TelemetryEntry,
} from '@contracts/index.js';
import type { TelemetrySummary } from '../../../../src/core/telemetry.js';

/**
 * The only way this app talks to anything.
 *
 * Every call is same-origin and read-only. The browser never reaches a runner,
 * never sees a credential, and never sends a filesystem path — it names a
 * project by the id the server issued.
 *
 * Types come from the server's own contracts rather than from a copy kept here.
 * A response shape that changed would fail to compile instead of rendering
 * `undefined` in a table cell.
 */

export const API_BASE = '/api/v1';

/**
 * The header every write carries (PRI-05).
 *
 * Duplicated from `src/server/request-guard.ts` rather than imported: this bundle is
 * built by a separate compiler with its own module resolution, and reaching across the
 * workspace boundary for a five-character constant is a worse trade than a name that
 * appears twice. `test/server/request-guard.test.ts` pins the value on the server side;
 * the e2e suite drives this file against the real server, so a drift fails there.
 */
export const CLIENT_HEADER = 'x-agent-flow-client';

/**
 * A refused request, with everything the server said about it.
 *
 * The write API answers a refusal with a code, a message and the suggested next
 * step (§95), and all three matter to different readers: the code is what a
 * component branches on, the message is what a person reads, and `action` is what
 * turns "no" into something they can do. Flattening them into one string would
 * throw away the two that are hardest to reconstruct.
 */
export class ApiError extends Error {
  readonly code?: string;
  readonly action?: string;
  /** True when a deliberate override could get past this refusal. */
  readonly forcible?: boolean;
  readonly detail?: Record<string, unknown>;

  constructor(
    readonly status: number,
    message: string,
    extras: {
      code?: string;
      action?: string;
      forcible?: boolean;
      detail?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    if (extras.code !== undefined) this.code = extras.code;
    if (extras.action !== undefined) this.action = extras.action;
    if (extras.forcible !== undefined) this.forcible = extras.forcible;
    if (extras.detail !== undefined) this.detail = extras.detail;
  }
}

/** Reads whatever a failed response managed to say, without trusting its shape. */
async function errorFrom(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  const message =
    typeof record['message'] === 'string' ? record['message'] : response.statusText;

  return new ApiError(response.status, message, {
    ...(typeof record['error'] === 'string' ? { code: record['error'] } : {}),
    ...(typeof record['action'] === 'string' ? { action: record['action'] } : {}),
    ...(typeof record['forcible'] === 'boolean' ? { forcible: record['forcible'] } : {}),
    ...(typeof record['detail'] === 'object' && record['detail'] !== null
      ? { detail: record['detail'] as Record<string, unknown> }
      : {}),
  });
}

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }

  const suffix = query.toString();
  const response = await fetch(`${API_BASE}${path}${suffix === '' ? '' : `?${suffix}`}`);

  // The server's own message, when it sent one. A generic "request failed" hides
  // the difference between "no such run" and "the server is down", which is
  // exactly what the person looking at the screen needs (§95).
  if (!response.ok) throw await errorFrom(response);

  return response.json() as Promise<T>;
}

/**
 * A write.
 *
 * Look at what it cannot carry. The body is whatever the caller passes, and every
 * caller below passes a boolean, a sentence, or an id the server issued — there is
 * no path, no command and no plan hash anywhere in this file, because the server
 * would not act on one and offering the field would suggest otherwise.
 */
async function post<T>(
  path: string,
  body: Record<string, unknown>,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }

  const suffix = query.toString();
  const response = await fetch(`${API_BASE}${path}${suffix === '' ? '' : `?${suffix}`}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Says "a client that could read this server's own code sent me" — which a page on
      // another origin cannot say. Setting a custom header makes a request non-simple, so
      // a cross-origin attempt earns a preflight, and the server answers none. Same-origin
      // requests like this one never see a preflight at all, so it costs nothing here.
      [CLIENT_HEADER]: 'dashboard',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw await errorFrom(response);
  return response.json() as Promise<T>;
}

export interface TelemetryResponse {
  readonly entries: TelemetryEntry[];
  readonly summary: TelemetrySummary;
}

export const api = {
  health: () => get<HealthResponse>('/health'),
  projects: () => get<ProjectView[]>('/projects'),

  runs: (projectId?: string) => get<RunSummaryView[]>('/runs', { projectId }),
  run: (runId: string, projectId?: string) =>
    get<RunDetailView>(`/runs/${runId}`, { projectId }),
  stages: (runId: string, projectId?: string) =>
    get<StageViewResponse[]>(`/runs/${runId}/stages`, { projectId }),
  tasks: (runId: string, projectId?: string) =>
    get<TaskSummaryView[]>(`/runs/${runId}/tasks`, { projectId }),
  // Structure only. The nodes' titles, statuses and models come from `tasks`
  // above — the same list the table renders, so the two views cannot disagree.
  dag: (runId: string, projectId?: string) =>
    get<RunDagView>(`/runs/${runId}/dag`, { projectId }),
  task: (runId: string, taskId: string, projectId?: string) =>
    get<TaskDetailView>(`/runs/${runId}/tasks/${taskId}`, { projectId }),
  artifacts: (runId: string, projectId?: string) =>
    get<ArtifactView[]>(`/runs/${runId}/artifacts`, { projectId }),
  artifact: (runId: string, name: string, projectId?: string) =>
    get<ArtifactContentView>(`/runs/${runId}/artifacts/${name}`, { projectId }),
  telemetry: (runId: string, projectId?: string) =>
    get<TelemetryResponse>(`/runs/${runId}/telemetry`, { projectId }),
  // One call for threads, handoffs, entries and the roster, because a thread's status
  // and an entry's status are folds over logs that must be read at one instant. Four
  // calls would let a repaint show a thread as open beside the entry that closed it.
  collaboration: (runId: string, projectId?: string) =>
    get<CollaborationView>(`/runs/${runId}/collaboration`, { projectId }),
  // Members, assignments, deferrals and the totals in one call, for the same reason: a
  // member's derived status and the assignment that produced it are folds over one log
  // at one instant, and two caches expiring apart would show somebody idle beside the
  // task they are running.
  team: (runId: string, projectId?: string) =>
    get<TeamView>(`/runs/${runId}/team`, { projectId }),
  // Threads, findings, gates and the decision in one call, because a finding's status and
  // the gate it is weighed against are folds over one log at one instant.
  review: (runId: string, projectId?: string) =>
    get<ReviewView>(`/runs/${runId}/review`, { projectId }),

  runners: (projectId?: string) => get<RunnerView[]>('/runners', { projectId }),
  runnerHealth: (projectId?: string) =>
    get<RunnerHealthView[]>('/runners/health', { projectId }),

  agents: (projectId?: string) => get<RoleRouteView[]>('/agents', { projectId }),

  prompts: () => get<PromptView[]>('/prompts'),
  prompt: (name: string) => get<PromptContentView>(`/prompts/${name}`),

  analytics: (projectId?: string) => get<AnalyticsView>('/analytics', { projectId }),
  config: (projectId?: string) => get<ConfigView>('/config', { projectId }),

  approvalGate: (runId: string, projectId?: string) =>
    get<ApprovalGateView>(`/runs/${runId}/approval`, { projectId }),
  activeJob: (runId: string, projectId?: string) =>
    get<ActionJobView | null>(`/runs/${runId}/job`, { projectId }),
  job: (jobId: string) => get<ActionJobView>(`/jobs/${jobId}`),

  // The writes (§86, UI-27). Each one names a run and says what to do; none of
  // them describes *how*, because the how is the server's.
  approve: (runId: string, force: boolean, projectId?: string) =>
    post<ActionResultView>(`/runs/${runId}/approve`, { force }, { projectId }),
  reject: (runId: string, reason: string | undefined, projectId?: string) =>
    post<ActionResultView>(
      `/runs/${runId}/reject`,
      reason === undefined ? {} : { reason },
      { projectId },
    ),
  revise: (runId: string, instruction: string, projectId?: string) =>
    post<ActionJobView>(`/runs/${runId}/revise`, { instruction }, { projectId }),
  start: (runId: string, taskId: string | undefined, projectId?: string) =>
    post<ActionJobView>(
      `/runs/${runId}/start`,
      taskId === undefined ? {} : { taskId },
      { projectId },
    ),
  retry: (runId: string, taskId: string, force: boolean, projectId?: string) =>
    post<ActionResultView>(
      `/runs/${runId}/tasks/${taskId}/retry`,
      { force },
      { projectId },
    ),
};
