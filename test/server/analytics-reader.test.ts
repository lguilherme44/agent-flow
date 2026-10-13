import { describe, it, expect } from 'vitest';
import { AnalyticsReader } from '../../src/server/analytics-reader.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';

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

/**
 * Dogfood 08/10 (Luis): "medir a qualidade da entrega por modelo". The Metrics screen read only
 * counts and durations; now it reads what each role × model spent and what the code each
 * model wrote looked like to its first review.
 */
describe('quality by model, read from the runs (dogfood 08/10)', () => {
  it('reports spend by role × model and the first review of each model’s code', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const projectDir = '/workspace/p';
    const store = new StateStore({ fs, clock, projectDir });
    const run = await store.createRun('popup');
    await store.updateRun(run.runId, (s) => ({
      ...s,
      status: 'completed',
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
    }));
    await store.appendEvent(run.runId, 'task_started', { task: 'TASK-001', role: 'executor.normal' });
    fs.seed(
      runPaths(projectDir, run.runId).taskResult('TASK-001'),
      JSON.stringify({
        task: 'TASK-001',
        status: 'completed',
        runner: 'claude',
        model: 'claude-sonnet-5-5',
        reasoning: 'medium',
        startedAt: '2026-10-09T10:00:00.000Z',
        finishedAt: '2026-10-09T10:05:00.000Z',
        validation: { passed: true, expectation: 'pass', commands: [] },
        usage: { model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 400, costUsd: 0.25 },
      }),
    );
    fs.seed(
      runPaths(projectDir, run.runId).reviews,
      `${JSON.stringify({
        id: 'REV-0001',
        runId: run.runId,
        taskId: 'TASK-001',
        round: 1,
        reviewer: 'codeReviewer',
        author: 'executor.normal',
        independence: 2,
        verdict: 'changes_requested',
        findings: [
          { id: 'FIND-0001', severity: 'medium', type: 'bug', description: 'Off by one.', suggestedAction: 'Fix it.' },
        ],
        createdAt: '2026-10-09T10:06:00.000Z',
      })}\n`,
    );

    const view = await new AnalyticsReader({ fs, clock }).aggregate([{ id: 'p', name: 'p', path: projectDir }]);

    const executor = view.byRoleModel?.find((bucket) => bucket.key === 'executor.normal · claude-sonnet-5-5');
    expect(executor).toMatchObject({ count: 1, inputTokens: 1000, outputTokens: 400, usageReporting: 1 });
    expect(executor).not.toHaveProperty('costUsd');
    expect(view.byEffort?.map((bucket) => bucket.key)).toContain('medium');
    expect(view.quality).toEqual([
      { model: 'claude-sonnet-5-5', tasks: 1, firstAttempt: 1, reviewed: 1, findings: { medium: 1 } },
    ]);
  });
});
