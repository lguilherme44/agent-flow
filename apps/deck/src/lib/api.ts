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
  ConfigView,
  PipelineStage,
  RunnerHealthView,
  RunnerModelsView,
  RunnerTypeView,
  StageLogView,
  StageViewResponse,
  TaskDetailView,
  TaskSummaryView,
  WorkspaceView,
  ConfigEditorView,
  ConfigValidationView,
  ConfigEditorScope,
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

async function parse<T>(response: Response, acceptedErrorStatuses: readonly number[] = []): Promise<T> {
  const text = await response.text();
  let body: unknown = undefined;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    const refusal = (body ?? {}) as {
      error?: string;
      message?: string;
      action?: string;
      forcible?: boolean;
      detail?: Record<string, unknown>;
    };
    const detail = refusal.detail ?? (typeof body === 'object' && body !== null ? body as Record<string, unknown> : undefined);
    throw new ApiError(response.status, refusal.message ?? `${String(response.status)} from the server`, {
      ...(refusal.error === undefined ? {} : { code: refusal.error }),
      ...(refusal.action === undefined ? {} : { action: refusal.action }),
      ...(refusal.forcible === undefined ? {} : { forcible: refusal.forcible }),
      ...(detail === undefined ? {} : { detail }),
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

export async function patchJson<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
  const response = await fetch(url(path, query), {
    method: 'PATCH',
    headers: { accept: 'application/json', 'content-type': 'application/json', [CLIENT_HEADER]: 'deck' },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(response);
}

export type ConfigEditorOperation =
  | { readonly kind: 'set'; readonly path: readonly (string | number)[]; readonly value: unknown }
  | { readonly kind: 'unset'; readonly path: readonly (string | number)[] };

export interface ConfigAppliedView {
  readonly status: 'applied';
  readonly view: ConfigEditorView;
  readonly changes: ConfigValidationView['changes'];
}

const configQuery = (scope: ConfigEditorScope, projectId?: string): Query => ({
  scope,
  ...(scope === 'project' ? { projectId } : {}),
});

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
  /** One stage's own log — the runner's whole output, not the excerpt an event carries. */
  stageLog: (a: RunAddress, stage: PipelineStage) =>
    getJson<StageLogView>(`/runs/${a.runId}/stages/${stage}/log`, scoped(a)),
  approval: (a: RunAddress) => getJson<ApprovalGateView>(`/runs/${a.runId}/approval`, scoped(a)),
  job: (a: RunAddress) => getJson<ActionJobView | null>(`/runs/${a.runId}/job`, scoped(a)),

  agents: (projectId?: string) =>
    getJson<RoleRouteView[]>('/agents', projectId === undefined ? {} : { projectId }),
  runnersHealth: (projectId?: string) =>
    getJson<RunnerHealthView[]>('/runners/health', projectId === undefined ? {} : { projectId }),
  /** What each runner reports it can be pointed at. Costs a spawn, so it is its own call. */
  runnerModels: (projectId?: string) =>
    getJson<RunnerModelsView[]>('/runners/models', projectId === undefined ? {} : { projectId }),
  /** Which adapters this installation supports. A property of the machine, not a project. */
  runnerTypes: () => getJson<RunnerTypeView[]>('/runner-types', {}),
  /** Read-only, and read here for one thing: which files the two scopes actually are. */
  config: (projectId?: string) => getJson<ConfigView>('/config', projectId === undefined ? {} : { projectId }),
  configEditor: (scope: ConfigEditorScope, projectId?: string) =>
    getJson<ConfigEditorView>('/config/editor', configQuery(scope, projectId)),
  validateConfig: async (scope: ConfigEditorScope, projectId: string | undefined, operations: readonly ConfigEditorOperation[]) => {
    const response = await fetch(url('/config/editor/validate', configQuery(scope, projectId)), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', [CLIENT_HEADER]: 'deck' },
      body: JSON.stringify({ operations }),
    });
    return parse<ConfigValidationView>(response, [422]);
  },
  applyConfig: (scope: ConfigEditorScope, projectId: string | undefined, expectedRevision: string, operations: readonly ConfigEditorOperation[]) =>
    patchJson<ConfigAppliedView>('/config/editor', { expectedRevision, operations }, configQuery(scope, projectId)),

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
  /**
   * Stop starting new work, keep what is in flight (PRI-15).
   *
   * The three below have existed in the core and on the server since pause landed and had
   * no button anywhere: the CLI could stop a run and the browser watching it could not.
   */
  pause: (a: RunAddress) => postJson<ActionResultView>(`/runs/${a.runId}/pause`, {}, scoped(a)),
  resume: (a: RunAddress) => postJson<ActionResultView>(`/runs/${a.runId}/resume`, {}, scoped(a)),
  /** Terminal, by an operator's decision. Evidence and branches stay on disk (PRI-14). */
  cancel: (a: RunAddress) => postJson<ActionResultView>(`/runs/${a.runId}/cancel`, {}, scoped(a)),
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
  stageLog: (a: RunAddress, stage: string) => url(`/runs/${a.runId}/stages/${stage}/log`, scoped(a)),
  approval: (a: RunAddress) => url(`/runs/${a.runId}/approval`, scoped(a)),
  job: (a: RunAddress) => url(`/runs/${a.runId}/job`, scoped(a)),
  agents: (projectId?: string) => url('/agents', projectId === undefined ? {} : { projectId }),
  runnersHealth: (projectId?: string) =>
    url('/runners/health', projectId === undefined ? {} : { projectId }),
  runnerTypes: () => url('/runner-types', {}),
  runnerModels: (projectId?: string) => url('/runners/models', projectId === undefined ? {} : { projectId }),
  config: (projectId?: string) => url('/config', projectId === undefined ? {} : { projectId }),
  configEditor: (scope: ConfigEditorScope, projectId?: string) => url('/config/editor', configQuery(scope, projectId)),
};
