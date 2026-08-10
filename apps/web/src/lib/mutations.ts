import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { ActionJobView, ActionResultView, ApprovalGateView } from '@contracts/index.js';
import { api } from './api';
import { keys } from './queries';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

/**
 * Asking the server to change something (UI-27, §88).
 *
 * The rule these all follow: a mutation's *response* is not the new state. It says
 * the request was accepted; what the run now looks like comes from re-reading the
 * server, out of the same files the CLI reads. So every one of them invalidates and
 * none of them patches a cache — because a patched cache is a second place where run
 * state is computed, and the first time it disagreed the screen would simply be
 * wrong with nothing to compare against.
 *
 * The stream keeps working alongside this. Invalidating on success is not a
 * replacement for it: SSE covers the changes nobody in this browser asked for, and
 * these cover the gap between a click and the next event.
 */

/** Everything a run's own screens read. Invalidated together after any write. */
function invalidateRun(
  client: ReturnType<typeof useQueryClient>,
  runId: string,
): void {
  for (const key of [
    ['run', { runId }],
    ['stages', { runId }],
    ['tasks', { runId }],
    ['task', { runId }],
    ['artifacts', { runId }],
    ['telemetry', { runId }],
    ['approval', { runId }],
    ['job', { runId }],
    ['runs'],
    ['projects'],
    ['analytics'],
  ]) {
    void client.invalidateQueries({ queryKey: key });
  }
}

/**
 * The approval gate, as the server computes it (§90).
 *
 * Fetched rather than assembled from the run: the verdict, the findings and — most
 * importantly — the plan hash have to be the server's own computation, or the modal
 * would be showing a second opinion about what is being approved.
 */
export function useApprovalGate(
  projectId: string | undefined,
  runId: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<ApprovalGateView> {
  return useQuery({
    queryKey: keys.approval(projectId, runId ?? ''),
    queryFn: () => api.approvalGate(runId as string, projectId),
    enabled: runId !== undefined && (options.enabled ?? true),
    // Always re-read when the modal opens. The plan may have changed since the
    // page loaded, and approving a stale hash is the one thing this must not do.
    staleTime: 0,
  });
}

/**
 * The long action in flight for this run, if any.
 *
 * Not polled. The server publishes `job.started` and `job.finished` on the same
 * stream every other change arrives on, and this query is invalidated by them — so
 * the dashboard has exactly one live channel, and polling stays what §89 makes it:
 * the fallback for when that channel is down.
 *
 * A job's lifecycle has to be published explicitly rather than inferred from the
 * run, because a job the workflow refused never touched `state.json` and the run
 * watcher would therefore never see it happen at all.
 */
export function useActiveJob(
  projectId: string | undefined,
  runId: string | undefined,
): UseQueryResult<ActionJobView | null> {
  return useQuery({
    queryKey: keys.job(projectId, runId ?? ''),
    queryFn: () => api.activeJob(runId as string, projectId),
    enabled: runId !== undefined,
  });
}

export function useApprove(
  projectId: string | undefined,
  runId: string,
): UseMutationResult<ActionResultView, Error, { force: boolean }> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ force }) => api.approve(runId, force, projectId),
    onSuccess: () => {
      invalidateRun(client, runId);
    },
  });
}

export function useReject(
  projectId: string | undefined,
  runId: string,
): UseMutationResult<ActionResultView, Error, { reason?: string }> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ reason }) => api.reject(runId, reason, projectId),
    onSuccess: () => {
      invalidateRun(client, runId);
    },
  });
}

export function useRevise(
  projectId: string | undefined,
  runId: string,
): UseMutationResult<ActionJobView, Error, { instruction: string }> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ instruction }) => api.revise(runId, instruction, projectId),
    onSuccess: () => {
      // The approval is cleared immediately and the re-plan follows, so the run
      // has already changed by the time this returns even though the job has not
      // finished.
      invalidateRun(client, runId);
    },
  });
}

export function useStart(
  projectId: string | undefined,
  runId: string,
): UseMutationResult<ActionJobView, Error, { taskId?: string }> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId }) => api.start(runId, taskId, projectId),
    onSuccess: () => {
      invalidateRun(client, runId);
    },
  });
}

export function useRetry(
  projectId: string | undefined,
  runId: string,
): UseMutationResult<ActionResultView, Error, { taskId: string; force: boolean }> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, force }) => api.retry(runId, taskId, force, projectId),
    onSuccess: () => {
      invalidateRun(client, runId);
    },
  });
}
