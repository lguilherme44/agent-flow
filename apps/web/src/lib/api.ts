import type {
  AnalyticsView,
  ArtifactContentView,
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }

  const suffix = query.toString();
  const response = await fetch(`${API_BASE}${path}${suffix === '' ? '' : `?${suffix}`}`);

  if (!response.ok) {
    // The server's own message, when it sent one. A generic "request failed"
    // hides the difference between "no such run" and "the server is down",
    // which is exactly what the person looking at the screen needs (§95).
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : response.statusText;
    throw new ApiError(response.status, message);
  }

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
  task: (runId: string, taskId: string, projectId?: string) =>
    get<TaskDetailView>(`/runs/${runId}/tasks/${taskId}`, { projectId }),
  artifacts: (runId: string, projectId?: string) =>
    get<ArtifactView[]>(`/runs/${runId}/artifacts`, { projectId }),
  artifact: (runId: string, name: string, projectId?: string) =>
    get<ArtifactContentView>(`/runs/${runId}/artifacts/${name}`, { projectId }),
  telemetry: (runId: string, projectId?: string) =>
    get<TelemetryResponse>(`/runs/${runId}/telemetry`, { projectId }),

  runners: (projectId?: string) => get<RunnerView[]>('/runners', { projectId }),
  runnerHealth: (projectId?: string) =>
    get<RunnerHealthView[]>('/runners/health', { projectId }),

  agents: (projectId?: string) => get<RoleRouteView[]>('/agents', { projectId }),

  prompts: () => get<PromptView[]>('/prompts'),
  prompt: (name: string) => get<PromptContentView>(`/prompts/${name}`),

  analytics: (projectId?: string) => get<AnalyticsView>('/analytics', { projectId }),
};
