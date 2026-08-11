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
    return [...runScoped, ['runs'], ['projects']];
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
  ];
}

export function applyServerEvent(client: QueryClient, event: ServerEvent): void {
  for (const key of invalidationsFor(event)) {
    void client.invalidateQueries({ queryKey: key });
  }
}
