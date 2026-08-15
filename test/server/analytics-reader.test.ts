import { describe, it, expect } from 'vitest';
import { AnalyticsReader } from '../../src/server/analytics-reader.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';

describe('AnalyticsReader (M2.1-A)', () => {
  it('does not count failed/refused runs as running', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const projectDir = '/workspace/test-project';
    const store = new StateStore({ fs, clock, projectDir });

    // Create a run that failed during planning
    const run1 = await store.createRun('feature 1');
    await store.updateRun(run1.runId, (s) => ({ ...s, status: 'failed' }));
    await store.appendEvent(run1.runId, 'planning_refused', {
      code: 'working_tree_dirty',
      detail: 'uncommitted changes',
      action: 'Commit or stash',
    });

    // Create a normal running run
    await store.createRun('feature 2');

    // Create a completed run
    const run3 = await store.createRun('feature 3');
    await store.updateRun(run3.runId, (s) => ({ ...s, status: 'completed' }));

    const reader = new AnalyticsReader({ fs, clock });
    const view = await reader.aggregate([{ id: 'test-project', name: 'Test Project', path: projectDir }]);

    expect(view.scope.runsAvailable).toBe(3);
    expect(view.scope.runsConsidered).toBe(3);

    const projectRuns = view.runsByProject[0];
    expect(projectRuns?.total).toBe(3);
    expect(projectRuns?.byStatus['failed']).toBe(1);
    expect(projectRuns?.byStatus['running']).toBe(1);
    expect(projectRuns?.byStatus['completed']).toBe(1);
  });

  it('reads historical runs without new events (backward compatibility)', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const projectDir = '/workspace/legacy-project';
    const store = new StateStore({ fs, clock, projectDir });

    // Legacy run with only run_created
    const legacy = await store.createRun('legacy feature');
    await store.updateRun(legacy.runId, (s) => ({ ...s, status: 'completed' }));

    const reader = new AnalyticsReader({ fs, clock });
    const view = await reader.aggregate([{ id: 'legacy-project', name: 'Legacy Project', path: projectDir }]);

    expect(view.scope.runsAvailable).toBe(1);
    expect(view.runsByProject[0]?.byStatus['completed']).toBe(1);
  });
});
