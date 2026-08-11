import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@contracts/index.js';
import { applyServerEvent, belongsToProject, invalidationsFor } from './live-updates';
import { keys } from './queries';

const event = (type: string, projectId = 'demo'): ServerEvent => ({
  type,
  projectId,
  runId: 'AF-2026-001',
  timestamp: '2026-08-10T20:00:00.000Z',
  payload: {},
});

/**
 * Does an event's invalidation actually reach a query cached under `key`?
 *
 * Asked through the real matcher rather than by comparing arrays, because the
 * bug this guards against was precisely a shape mismatch that array comparison
 * would have called correct.
 */
function reaches(type: string, key: readonly unknown[], projectId = 'demo'): boolean {
  const client = new QueryClient();
  client.setQueryData(key, 'cached');

  return invalidationsFor(event(type, projectId)).some(
    (filter) =>
      client.getQueryCache().findAll({ queryKey: filter }).length > 0,
  );
}

describe('an event invalidates, it never patches', () => {
  it('always refreshes the run and its pipeline', () => {
    // The event says *something changed*; the answer still comes from the
    // server, out of the same files `status` reads.
    for (const type of ['task.completed', 'stage.started', 'run.updated']) {
      expect(reaches(type, keys.run('demo', 'AF-2026-001'))).toBe(true);
      expect(reaches(type, keys.stages('demo', 'AF-2026-001'))).toBe(true);
    }
  });

  it('reaches a query cached without a project, which is the default view', () => {
    // The bug this exists for: a single-project dashboard fetches without
    // naming a project, every event names one, and positional keys made the two
    // never match. Nothing looked broken — the screen simply stopped updating.
    expect(reaches('task.completed', keys.tasks(undefined, 'AF-2026-001'))).toBe(true);
    expect(reaches('run.updated', keys.run(undefined, 'AF-2026-001'))).toBe(true);
  });

  it('leaves another run alone', () => {
    expect(reaches('task.completed', keys.tasks('demo', 'AF-2026-999'))).toBe(false);
  });

  it('refreshes the task list on a task event', () => {
    expect(reaches('task.failed', keys.tasks('demo', 'AF-2026-001'))).toBe(true);
  });

  it('refreshes artifacts when a stage finishes, because stages produce them', () => {
    expect(reaches('stage.completed', keys.artifacts('demo', 'AF-2026-001'))).toBe(true);
  });

  it('refreshes the project list when the gate moves', () => {
    // The sidebar shows each project's status, and approval changes it.
    expect(reaches('approval.completed', keys.projects)).toBe(true);
  });

  it('refreshes broadly for an event type it has never seen', () => {
    // Too much beats too little: too little looks exactly like nothing
    // happening, which is the one failure a live dashboard cannot show.
    expect(reaches('something.invented.later', keys.tasks('demo', 'AF-2026-001'))).toBe(true);
    expect(reaches('something.invented.later', keys.runs('demo'))).toBe(true);
    expect(reaches('something.invented.later', keys.projects)).toBe(true);
  });

  it('always refreshes telemetry, which every event changes', () => {
    expect(reaches('task.completed', keys.telemetry('demo', 'AF-2026-001'))).toBe(true);
  });

  it('leaves the graph alone when only a task moved', () => {
    // The plan is what the graph is of, and a task finishing does not change it.
    // Re-reading structure on every tick is a five-hundred-node re-layout because
    // one duration ticked over (§96).
    expect(reaches('task.completed', keys.dag('demo', 'AF-2026-001'))).toBe(false);
    // A stage finishing can have replaced the plan — planning writes one, and a
    // corrective round appends to it.
    expect(reaches('stage.completed', keys.dag('demo', 'AF-2026-001'))).toBe(true);
    // So can a job: `revise` re-plans, and nothing else would say so.
    expect(reaches('job.finished', keys.dag('demo', 'AF-2026-001'))).toBe(true);
  });
});

/**
 * UI-29 — a workspace holds several projects, and run ids repeat across them.
 *
 * Two repositories under one root will both have an `AF-2026-001`. Every filter
 * above matches on the run alone, so without a project guard a task finishing in
 * one project refetches the other's run — quietly, and looking entirely correct.
 */
describe('an event stays inside its own project', () => {
  const stale = (
    keysToCache: readonly (readonly unknown[])[],
    eventProject: string,
  ): unknown[][] => {
    const client = new QueryClient();
    for (const key of keysToCache) client.setQueryData(key, 'cached');

    applyServerEvent(client, {
      type: 'task.completed',
      projectId: eventProject,
      runId: 'AF-2026-001',
      timestamp: '2026-08-10T20:00:00.000Z',
      payload: {},
    });

    return client
      .getQueryCache()
      .findAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => [...query.queryKey]);
  };

  it('does not touch the same run id in another project', () => {
    const invalidated = stale(
      [keys.tasks('alpha', 'AF-2026-001'), keys.tasks('beta', 'AF-2026-001')],
      'alpha',
    );

    expect(invalidated).toEqual([['tasks', { runId: 'AF-2026-001', projectId: 'alpha' }]]);
  });

  it('still reaches a query cached without a project', () => {
    // The single-project view fetches without naming one. Excluding it would
    // restore the bug the object-shaped keys were introduced to fix: the screen
    // goes quiet and looks exactly like an idle run.
    const invalidated = stale([keys.tasks(undefined, 'AF-2026-001')], 'alpha');

    expect(invalidated).toHaveLength(1);
  });

  it('still refreshes what belongs to no project at all', () => {
    // `['projects']` is the whole workspace, and one project's run moving does
    // change what the sidebar should say about it.
    expect(belongsToProject(keys.projects, 'alpha')).toBe(true);
    expect(belongsToProject(keys.prompt('planning'), 'alpha')).toBe(true);
  });
});
