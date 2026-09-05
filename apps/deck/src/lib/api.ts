import type {
  ActionJobView,
  ActionResultView,
  ApprovalGateView,
  ControlSnapshotView,
  ProjectView,
  RoleRouteView,
  RunDagView,
  RunDetailView,
  RunEventLogView,
  RunSummaryView,
  RunnerHealthView,
  StageViewResponse,
  TaskDetailView,
  TaskSummaryView,
  WorkspaceView,
} from '@contracts/index.js';

/**
 * The only door out of this app.
 *
 * Same origin, JSON, and a vocabulary made of ids the server issued. Nothing here can name
 * a directory, a ref or an executable, because no request shape has a field for one — the
 * browser says *which project* and *which run*, and the server resolves both through its
 * registry. Every response type is the server's own contract, imported rather than copied,
 * so a shape that moves fails the compiler instead of rendering `undefined` into a cell.
 */

export const API_BASE = '/api/v1';

/**
 * The header every write carries.
 *
 * A custom header makes a cross-origin request non-simple, which is what forces the
 * browser to ask the server first — and the server's answer is no. Spelled here rather
 * than imported from `src/server/request-guard.ts` because this bundle has its own
 * compiler; the server's test pins the value, and the E2E suite drives this file against
 * the real thing, so a drift is red somewhere.
 */
export const CLIENT_HEADER = 'x-agent-flow-client';

export class ApiError extends Error {
  readonly code: string | undefined;
  readonly action: string | undefined;
  readonly forcible: boolean;
  readonly detail: Record<string, unknown> | undefined;

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
    this.code = extras.code;
    this.action = extras.action;
    this.forcible = extras.forcible ?? false;
    this.detail = extras.detail;
  }
}

type Query = Record<string, string | undefined>;

export function url(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const search = params.toString();
  return `${API_BASE}${path}${search === '' ? '' : `?${search}`}`;
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = undefined;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    const refusal = (body ?? {}) as {
      error?: string;
      message?: string;
      action?: string;
      forcible?: boolean;
      detail?: Record<string, unknown>;
    };
    throw new ApiError(response.status, refusal.message ?? `${String(response.status)} from the server`, {
      ...(refusal.error === undefined ? {} : { code: refusal.error }),
      ...(refusal.action === undefined ? {} : { action: refusal.action }),
      ...(refusal.forcible === undefined ? {} : { forcible: refusal.forcible }),
      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
    });
  }

  return body as T;
}

export async function getJson<T>(path: string, query: Query = {}): Promise<T> {
  const response = await fetch(url(path, query), { headers: { accept: 'application/json' } });
  return parse<T>(response);
}

export async function postJson<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
  const response = await fetch(url(path, query), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      [CLIENT_HEADER]: 'deck',
    },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(response);
}

/** A run is always addressed with its project: run ids restart per project per year. */
export interface RunAddress {
  readonly projectId: string;
  readonly runId: string;
}

const scoped = (address: RunAddress): Query => ({ projectId: address.projectId });

export const api = {
  workspace: () => getJson<WorkspaceView>('/workspace'),
  projects: () => getJson<ProjectView[]>('/projects'),
  runs: (projectId?: string) =>
    getJson<RunSummaryView[]>('/runs', projectId === undefined ? {} : { projectId }),

  run: (a: RunAddress) => getJson<RunDetailView>(`/runs/${a.runId}`, scoped(a)),
  stages: (a: RunAddress) => getJson<StageViewResponse[]>(`/runs/${a.runId}/stages`, scoped(a)),
  tasks: (a: RunAddress) => getJson<TaskSummaryView[]>(`/runs/${a.runId}/tasks`, scoped(a)),
  task: (a: RunAddress, taskId: string) =>
    getJson<TaskDetailView>(`/runs/${a.runId}/tasks/${taskId}`, scoped(a)),
  dag: (a: RunAddress) => getJson<RunDagView>(`/runs/${a.runId}/dag`, scoped(a)),
  control: (a: RunAddress) => getJson<ControlSnapshotView>(`/runs/${a.runId}/control`, scoped(a)),
  eventLog: (a: RunAddress) => getJson<RunEventLogView>(`/runs/${a.runId}/events`, scoped(a)),
  approval: (a: RunAddress) => getJson<ApprovalGateView>(`/runs/${a.runId}/approval`, scoped(a)),
  job: (a: RunAddress) => getJson<ActionJobView | null>(`/runs/${a.runId}/job`, scoped(a)),

  agents: (projectId?: string) =>
    getJson<RoleRouteView[]>('/agents', projectId === undefined ? {} : { projectId }),
  runnersHealth: (projectId?: string) =>
    getJson<RunnerHealthView[]>('/runners/health', projectId === undefined ? {} : { projectId }),

  approve: (a: RunAddress, force: boolean) =>
    postJson<ActionResultView>(`/runs/${a.runId}/approve`, { force }, scoped(a)),
  reject: (a: RunAddress, reason?: string) =>
    postJson<ActionResultView>(
      `/runs/${a.runId}/reject`,
      reason === undefined || reason.trim() === '' ? {} : { reason },
      scoped(a),
    ),
  revise: (a: RunAddress, instruction: string) =>
    postJson<ActionJobView>(`/runs/${a.runId}/revise`, { instruction }, scoped(a)),
  start: (a: RunAddress, taskId?: string) =>
    postJson<ActionJobView>(
      `/runs/${a.runId}/start`,
      taskId === undefined ? {} : { taskId },
      scoped(a),
    ),
  retry: (a: RunAddress, taskId: string, force: boolean) =>
    postJson<ActionResultView>(`/runs/${a.runId}/tasks/${taskId}/retry`, { force }, scoped(a)),
  review: (a: RunAddress, fix = false) =>
    postJson<ActionJobView>(`/runs/${a.runId}/review`, { fix }, scoped(a)),
  /**
   * A new feature: the run is created at once and planning proceeds as a job. The job
   * carries the new run's id, which is where the page goes next.
   */
  plan: (projectId: string, body: { description: string; workflow?: string; skipReview?: boolean; noCache?: boolean }) =>
    postJson<ActionJobView>('/runs', body, { projectId }),
};

/** Cache keys are the URLs, so invalidation can reason about paths. */
export const keys = {
  workspace: () => url('/workspace'),
  projects: () => url('/projects'),
  runs: (projectId?: string) => url('/runs', projectId === undefined ? {} : { projectId }),
  run: (a: RunAddress) => url(`/runs/${a.runId}`, scoped(a)),
  stages: (a: RunAddress) => url(`/runs/${a.runId}/stages`, scoped(a)),
  tasks: (a: RunAddress) => url(`/runs/${a.runId}/tasks`, scoped(a)),
  task: (a: RunAddress, taskId: string) => url(`/runs/${a.runId}/tasks/${taskId}`, scoped(a)),
  dag: (a: RunAddress) => url(`/runs/${a.runId}/dag`, scoped(a)),
  control: (a: RunAddress) => url(`/runs/${a.runId}/control`, scoped(a)),
  eventLog: (a: RunAddress) => url(`/runs/${a.runId}/events`, scoped(a)),
  approval: (a: RunAddress) => url(`/runs/${a.runId}/approval`, scoped(a)),
  job: (a: RunAddress) => url(`/runs/${a.runId}/job`, scoped(a)),
  agents: (projectId?: string) => url('/agents', projectId === undefined ? {} : { projectId }),
  runnersHealth: (projectId?: string) =>
    url('/runners/health', projectId === undefined ? {} : { projectId }),
};
