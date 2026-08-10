import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@contracts/index.js';
import { invalidationsFor } from './live-updates';
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
});
