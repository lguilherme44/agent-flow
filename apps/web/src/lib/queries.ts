import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api';
import type {
  AnalyticsView,
  ArtifactContentView,
  CollaborationView,
  TeamView,
  ReviewView,
  ConfigView,
  ArtifactView,
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
  dag: (projectId: string | undefined, runId: string) =>
    ['dag', { runId, projectId }] as const,
  task: (projectId: string | undefined, runId: string, taskId: string) =>
    ['task', { runId, taskId, projectId }] as const,
  artifacts: (projectId: string | undefined, runId: string) =>
    ['artifacts', { runId, projectId }] as const,
  artifact: (projectId: string | undefined, runId: string, name: string) =>
    ['artifact', { runId, name, projectId }] as const,
  telemetry: (projectId: string | undefined, runId: string) =>
    ['telemetry', { runId, projectId }] as const,
  collaboration: (projectId: string | undefined, runId: string) =>
    ['collaboration', { runId, projectId }] as const,
  team: (projectId: string | undefined, runId: string) =>
    ['team', { runId, projectId }] as const,
  review: (projectId: string | undefined, runId: string) =>
    ['review', { runId, projectId }] as const,
  runnerHealth: (projectId?: string) => ['runner-health', { projectId }] as const,
  runners: (projectId?: string) => ['runners', { projectId }] as const,
  agents: (projectId?: string) => ['agents', { projectId }] as const,
  prompts: ['prompts'] as const,
  prompt: (name: string) => ['prompt', { name }] as const,
  analytics: (projectId?: string) => ['analytics', { projectId }] as const,
  config: (projectId?: string) => ['config', { projectId }] as const,
  approval: (projectId: string | undefined, runId: string) =>
    ['approval', { runId, projectId }] as const,
  job: (projectId: string | undefined, runId: string) => ['job', { runId, projectId }] as const,
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

/**
 * The plan's dependency graph (§92).
 *
 * A separate query from `useTasks` because it changes on a different clock. The
 * graph moves when the plan does — a re-plan, a corrective round — and the task
 * list moves every few seconds. Held together they would re-lay-out the graph on
 * every status tick; held apart, the layout survives until the structure itself
 * changes.
 *
 * `staleTime` is long for the same reason, and the stream still invalidates this
 * when a stage completes, which is when a plan can have been replaced.
 */
export function useRunDag(
  projectId: string | undefined,
  runId: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<RunDagView> {
  return useQuery({
    queryKey: keys.dag(projectId, runId ?? ''),
    queryFn: () => api.dag(runId as string, projectId),
    enabled: runId !== undefined && (options.enabled ?? true),
    staleTime: 60_000,
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
  options?: { enabled?: boolean },
): UseQueryResult<ArtifactContentView> {
  return useQuery({
    queryKey: keys.artifact(projectId, runId ?? '', name ?? ''),
    queryFn: () => api.artifact(runId as string, name as string, projectId),
    enabled: (options?.enabled ?? true) && runId !== undefined && name !== undefined,
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

/**
 * The routing table (§82).
 *
 * Resolution only — no runner is contacted, so this is as cheap as reading the
 * config, and the page can hold it as long as the config has not changed.
 */
export function useAgents(projectId?: string): UseQueryResult<RoleRouteView[]> {
  return useQuery({ queryKey: keys.agents(projectId), queryFn: () => api.agents(projectId) });
}

/** Runner identity — the adapter type behind an id. Never a credential. */
export function useRunners(projectId?: string): UseQueryResult<RunnerView[]> {
  return useQuery({
    queryKey: keys.runners(projectId),
    queryFn: () => api.runners(projectId),
    staleTime: 60_000,
  });
}

/**
 * The prompts this installation ships.
 *
 * Not scoped to a project: prompts belong to the agent-flow installation, not to
 * a repository, and pretending otherwise would suggest a project can change them.
 */
export function usePrompts(): UseQueryResult<PromptView[]> {
  return useQuery({ queryKey: keys.prompts, queryFn: () => api.prompts(), staleTime: 60_000 });
}

export function usePrompt(name: string | undefined): UseQueryResult<PromptContentView> {
  return useQuery({
    queryKey: keys.prompt(name ?? ''),
    queryFn: () => api.prompt(name as string),
    enabled: name !== undefined,
    staleTime: 60_000,
  });
}

/**
 * Aggregates across a project's history (§84).
 *
 * Reads every considered run's event log, so it is the most expensive read in the
 * API. Held longer than the default because history does not change while you look
 * at it — and the stream invalidates it when a run does move.
 */
export function useAnalytics(projectId?: string): UseQueryResult<AnalyticsView> {
  return useQuery({
    queryKey: keys.analytics(projectId),
    queryFn: () => api.analytics(projectId),
    staleTime: 15_000,
  });
}

/** The effective configuration, sectioned, with the origin of each value (§85). */
export function useConfig(projectId?: string): UseQueryResult<ConfigView> {
  return useQuery({
    queryKey: keys.config(projectId),
    queryFn: () => api.config(projectId),
    staleTime: 30_000,
  });
}

/**
 * What the agents on this run said to each other (M4-07).
 *
 * One query for all four parts, matching the one endpoint that serves them: a thread's
 * status and an entry's status are folds over logs that have to be read at one instant,
 * and four caches expiring independently would let a repaint show a thread as open beside
 * the entry that closed it.
 */
export function useCollaboration(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<CollaborationView> {
  return useQuery({
    queryKey: keys.collaboration(projectId, runId ?? ''),
    queryFn: () => api.collaboration(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

/**
 * The run's team (M5-08, M5-ACC-15).
 *
 * **The component renders this and computes none of it.** Members, assignments, the
 * ranking behind each one and the totals all arrive from `core/team/view.ts`, which is
 * the same fold `af status` prints. A browser that ranked its own candidates would be a
 * second assignment authority, and its first disagreement with the run would put a
 * decision nobody made on screen (I-33).
 *
 * One query for all of it, matching the one endpoint: a member's derived status and the
 * assignment that produced it are folds over one log at one instant, and two caches
 * expiring apart would show somebody idle beside the task they are running.
 */
export function useTeam(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<TeamView> {
  return useQuery({
    queryKey: keys.team(projectId, runId ?? ''),
    queryFn: () => api.team(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

/**
 * The run's reviews (M6-09, M6-ACC-21).
 *
 * **The component renders this and derives none of it.** Review status, a finding's
 * blocking status, a gate's verdict and a review's freshness all arrive answered — §59
 * names all four, and a browser that computed any would be a second authority.
 */
export function useReview(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<ReviewView> {
  return useQuery({
    queryKey: keys.review(projectId, runId ?? ''),
    queryFn: () => api.review(runId as string, projectId),
    enabled: runId !== undefined,
  });
}
