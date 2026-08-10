import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api';
import type {
  ArtifactContentView,
  ArtifactView,
  ProjectView,
  RunDetailView,
  RunSummaryView,
  RunnerHealthView,
  StageViewResponse,
  TaskDetailView,
  TaskSummaryView,
} from '@contracts/index.js';
import type { TelemetryResponse } from './api';

/**
 * Server state lives here and only here (§88).
 *
 * There is no store holding a copy of `RunState`. The run belongs to the
 * StateStore on disk; this is a cache of what the server said about it, and a
 * cache that can be invalidated is the only kind that cannot disagree. Local
 * React state is for what the *browser* owns — which task is selected, which tab
 * is open, what the filters are — and nothing else.
 */

/**
 * Query keys carry their scope as an *object*, not as positional segments.
 *
 * That shape is load-bearing. TanStack matches an object inside a key
 * partially, so `['tasks', { runId }]` invalidates the task list whether the
 * page fetched it for a named project or for the default one.
 *
 * With positional keys it did not. A dashboard with no project selected fetched
 * under a placeholder, while every SSE event names the real project — so the
 * invalidation missed and the screen went quiet while the run kept moving. The
 * bug is invisible in the single-project case that is also the common one:
 * everything renders, nothing updates, and it looks exactly like an idle run.
 */
export const keys = {
  projects: ['projects'] as const,
  runs: (projectId?: string) => ['runs', { projectId }] as const,
  run: (projectId: string | undefined, runId: string) =>
    ['run', { runId, projectId }] as const,
  stages: (projectId: string | undefined, runId: string) =>
    ['stages', { runId, projectId }] as const,
  tasks: (projectId: string | undefined, runId: string) =>
    ['tasks', { runId, projectId }] as const,
  task: (projectId: string | undefined, runId: string, taskId: string) =>
    ['task', { runId, taskId, projectId }] as const,
  artifacts: (projectId: string | undefined, runId: string) =>
    ['artifacts', { runId, projectId }] as const,
  artifact: (projectId: string | undefined, runId: string, name: string) =>
    ['artifact', { runId, name, projectId }] as const,
  telemetry: (projectId: string | undefined, runId: string) =>
    ['telemetry', { runId, projectId }] as const,
  runnerHealth: (projectId?: string) => ['runner-health', { projectId }] as const,
};

export function useProjects(): UseQueryResult<ProjectView[]> {
  return useQuery({ queryKey: keys.projects, queryFn: () => api.projects() });
}

export function useRuns(projectId?: string): UseQueryResult<RunSummaryView[]> {
  return useQuery({ queryKey: keys.runs(projectId), queryFn: () => api.runs(projectId) });
}

export function useRun(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<RunDetailView> {
  return useQuery({
    queryKey: keys.run(projectId, runId ?? ''),
    queryFn: () => api.run(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

export function useStages(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<StageViewResponse[]> {
  return useQuery({
    queryKey: keys.stages(projectId, runId ?? ''),
    queryFn: () => api.stages(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

export function useTasks(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<TaskSummaryView[]> {
  return useQuery({
    queryKey: keys.tasks(projectId, runId ?? ''),
    queryFn: () => api.tasks(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

export function useTask(
  projectId: string | undefined,
  runId: string | undefined,
  taskId: string | undefined,
): UseQueryResult<TaskDetailView> {
  return useQuery({
    queryKey: keys.task(projectId, runId ?? '', taskId ?? ''),
    queryFn: () => api.task(runId as string, taskId as string, projectId),
    enabled: runId !== undefined && taskId !== undefined,
  });
}

export function useArtifacts(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<ArtifactView[]> {
  return useQuery({
    queryKey: keys.artifacts(projectId, runId ?? ''),
    queryFn: () => api.artifacts(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

export function useArtifact(
  projectId: string | undefined,
  runId: string | undefined,
  name: string | undefined,
): UseQueryResult<ArtifactContentView> {
  return useQuery({
    queryKey: keys.artifact(projectId, runId ?? '', name ?? ''),
    queryFn: () => api.artifact(runId as string, name as string, projectId),
    enabled: runId !== undefined && name !== undefined,
  });
}

export function useTelemetry(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<TelemetryResponse> {
  return useQuery({
    queryKey: keys.telemetry(projectId, runId ?? ''),
    queryFn: () => api.telemetry(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

/**
 * Runner health for one project.
 *
 * `enabled` exists because this query is not free: the server spawns each
 * runner's CLI with `--version`. The sidebar wants it unconditionally — that is
 * the one place the answer is always worth having — while a page that will not
 * display it should not be paying for it.
 */
export function useRunnerHealth(
  projectId?: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<RunnerHealthView[]> {
  return useQuery({
    queryKey: keys.runnerHealth(projectId),
    queryFn: () => api.runnerHealth(projectId),
    enabled: options.enabled ?? true,
    // Worth knowing, not worth re-asking every time a component mounts.
    staleTime: 30_000,
  });
}
