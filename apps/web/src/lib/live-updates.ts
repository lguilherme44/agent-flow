import type { QueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@contracts/index.js';

/**
 * Which cached questions an event makes stale (§89).
 *
 * The event carries no state, and that is deliberate. It says *something about
 * this run changed*; the answer still comes from the server, out of the same
 * files `status` reads. Patching the cache from a payload would make the browser
 * a second place where run state is computed, and the first disagreement would
 * be invisible — the screen would simply be wrong, with nothing to compare
 * against.
 *
 * Scope is matched by run, never by project. A dashboard showing the default
 * project fetches without naming one, while every event names it; keying the
 * invalidation on the project would miss exactly the case that matters most —
 * the single-project view, where the screen would quietly stop updating and look
 * like an idle run.
 */
export function invalidationsFor(event: ServerEvent): readonly (readonly unknown[])[] {
  const { runId } = event;

  const runScoped = [
    ['run', { runId }],
    ['stages', { runId }],
    ['telemetry', { runId }],
    // M8. The control snapshot is stale for every reason the run is: a task moving, a
    // stage finishing, a gate opening, a job ending. It is in the run-scoped set rather
    // than in each branch below because it is *composed* of all of them — a snapshot that
    // refreshed on task events but not on stage ones would show a board that moves and an
    // attention queue that does not.
    ['control', { runId }],
  ];

  // A task moving changes its state, never the plan it came from. The graph is
  // deliberately not in this list: re-fetching structure on every tick would
  // re-lay-out a five-hundred-node view because one duration changed (§96).
  if (event.type.startsWith('task.')) {
    return [...runScoped, ['tasks', { runId }], ['task', { runId }]];
  }

  // A stage finishing can have replaced the plan — planning writes one, and a
  // corrective round appends to it — so this is where the graph is re-read.
  if (event.type.startsWith('stage.')) {
    return [...runScoped, ['artifacts', { runId }], ['dag', { runId }]];
  }

  // A job's own lifecycle. Published by the server rather than derived from the
  // run, because a refused action never touches `state.json` — and invalidating the
  // run alongside it, since a job that finished may well have changed one.
  if (event.type.startsWith('job.')) {
    return [
      ...runScoped,
      ['job', { runId }],
      ['tasks', { runId }],
      ['artifacts', { runId }],
      // `revise` is a job, and it re-plans. Nothing else would tell the graph.
      ['dag', { runId }],
    ];
  }

  if (event.type.startsWith('approval.')) {
    return [...runScoped, ['tasks', { runId }], ['projects']];
  }

  if (event.type === 'run.created' || event.type === 'run.completed') {
    return [...runScoped, ['runs'], ['projects'], ['workspace']];
  }

  // `run.updated` and anything this table has never seen. Broad on purpose: a
  // new event type must refresh too much rather than too little, because too
  // little looks exactly like nothing happening.
  return [
    ...runScoped,
    ['tasks', { runId }],
    ['artifacts', { runId }],
    ['dag', { runId }],
    ['runs'],
    ['projects'],
    ['workspace'],
  ];
}

/**
 * Whether a cached question is one this project's events can answer (UI-29).
 *
 * Run ids are only unique inside a project: two repositories in one workspace
 * will both have an `AF-2026-001`, and `['run', { runId }]` matches every one of
 * them. Without this, a task finishing in one project refetched another project's
 * run — quietly, correctly-looking, and wrong.
 *
 * A key that names no project still matches, and deliberately. That is the
 * single-project view, which fetches without naming one while every event names
 * it; excluding it would restore the exact bug the object-shaped keys were
 * introduced to fix, where the screen goes quiet and looks like an idle run.
 * Over-invalidating costs a refetch. Under-invalidating costs the truth.
 */
export function belongsToProject(queryKey: readonly unknown[], projectId: string): boolean {
  const scope = queryKey[1];
  if (typeof scope !== 'object' || scope === null) return true;

  const cached = (scope as { projectId?: unknown }).projectId;
  return cached === undefined || cached === projectId;
}

export function applyServerEvent(client: QueryClient, event: ServerEvent): void {
  for (const queryKey of invalidationsFor(event)) {
    void client.invalidateQueries({
      queryKey,
      predicate: (query) => belongsToProject(query.queryKey, event.projectId),
    });
  }
}
