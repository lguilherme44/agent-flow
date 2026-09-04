import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { RunReader } from '../../src/server/run-reader.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import type { RegisteredProject } from '../../src/server/project-registry.js';

/**
 * Issue #21 — what ran, on a task whose `result.json` does not exist.
 *
 * **The defect this file was written to prove, before it was believed.** `task-executor.ts`
 * writes `result.json` only in sequential mode; under worktrees the sole writer is the
 * Integrator's success path, and its own docstring says an isolated run "does not write
 * `result.json` at all". So a `failed` or `review_required` task in an isolated run leaves
 * `TaskSummaryView.runner` and `.model` absent — permanently, not until something catches
 * up — while `attempt-<n>.json` beside it names exactly what ran.
 *
 * That is not an edge case in this repository. All four runs under `.agent-flow/runs/` are
 * `isolationMode: worktree`, and two of their eight tasks are in precisely this state:
 * `review_required`, `attempts: 2`, no `result.json`, two attempt artifacts each naming a
 * runner. `validationJudgement` is `unsatisfied` on both, so `awaitingIntegration` is false
 * too and the row carried nothing at all about the work.
 *
 * A board that leads with the model would have answered "not reported" on the most common
 * real configuration — which is more confidently wrong than the silence it replaced. So
 * `tasks()` now backfills the identity triple from the newest attempt artifact, which the
 * same reader already opens to build `AttemptHistoryView`.
 */

const PROJECT: RegisteredProject = { id: 'demo', name: 'demo', path: '/repo' } as RegisteredProject;

const OID = 'a'.repeat(40);

const PLAN = {
  feature: 'f',
  tasks: [
    {
      id: 'TASK-001',
      title: 'One',
      description: 'Work.',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Done.'],
      validation: ['test'],
    },
  ],
};

/**
 * A run in the mode the defect lives in.
 *
 * `isolationMode: 'worktree'` is the whole point: in sequential mode `finish()` writes a
 * `result.json` and none of this arises.
 */
async function world(options: {
  state: 'running' | 'failed' | 'review_required' | 'completed';
  attempts: number;
}) {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', 'project:\n  name: demo\n  type: node\n');
  fs.seed('/home/.agent-flow/config.yaml', '');

  const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/repo' });
  const reader = new RunReader({
    fs,
    clock: new FixedClock(),
    globalConfigPath: '/home/.agent-flow/config.yaml',
  });

  // Captured at creation and immutable after it, which the store enforces: isolation is
  // decided once per run (M2-03). A test that set it later would be testing a state the
  // product refuses to reach.
  const run = await store.createRun('f', (runId) => ({
    isolationMode: 'worktree' as const,
    planningBase: 'b'.repeat(40),
    gitRunKey: `${runId}-0f3a91c4bd27e615`,
  }));
  const paths = runPaths('/repo', run.runId);
  fs.seed(paths.plan, JSON.stringify(PLAN));

  await store.updateRun(run.runId, (state) => ({
    ...state,
    stage: 'implementation',
    tasks: [
      {
        id: 'TASK-001',
        state: options.state,
        attempts: options.attempts,
        infrastructureFailures: 0,
      },
    ],
  }));

  const summary = async () => {
    const tasks = await reader.tasks(PROJECT, run.runId);
    return tasks?.find((entry) => entry.id === 'TASK-001');
  };

  return { fs, store, reader, run, paths, summary };
}

const failed = (runId: string, attempt: number, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    run: runId,
    task: 'TASK-001',
    attempt,
    base: OID,
    branch: `agent-flow/f/TASK-001/attempt-${String(attempt)}`,
    workspace: `worktrees/TASK-001-${String(attempt)}`,
    runner: 'agy',
    model: 'gemini-3.1-pro-high',
    reasoning: 'high',
    reasoningClamped: false,
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:01:00.000Z',
    failureClass: 'validation_unsatisfied',
    consumedAttempt: true,
    validation: { expectation: 'pass', passed: false, ids: ['test'], commands: [] },
    ...overrides,
  });

const succeeded = (runId: string, attempt: number, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    run: runId,
    task: 'TASK-001',
    attempt,
    base: OID,
    branch: `agent-flow/f/TASK-001/attempt-${String(attempt)}`,
    workspace: `worktrees/TASK-001-${String(attempt)}`,
    runner: 'agy',
    model: 'gemini-3.1-pro-high',
    reasoning: 'high',
    reasoningClamped: false,
    startedAt: '2026-09-01T10:02:00.000Z',
    finishedAt: '2026-09-01T10:05:00.000Z',
    validatedTree: 'b'.repeat(40),
    marker: 'c'.repeat(40),
    validation: { expectation: 'pass', passed: true, ids: ['test'], commands: [] },
    validationJudgement: 'unsatisfied',
    agentReport: { status: 'COMPLETED', filesChanged: ['src/a.ts'], notes: [] },
    ...overrides,
  });

describe('a task whose result.json a worktree run never wrote', () => {
  it('is the state this repository is actually in, so the fixture is not invented', async () => {
    // The positive control for the whole file: prove the reader really does report nothing
    // when the artifacts are absent, so a passing test below is the backfill working rather
    // than the fixture leaking a value in from somewhere else.
    const { summary } = await world({ state: 'review_required', attempts: 2 });

    const task = await summary();
    expect(task?.state).toBe('review_required');
    expect(task?.attempts).toBe(2);
    expect(task?.runner, 'nothing on disk, so nothing to report').toBeUndefined();
    expect(task?.model).toBeUndefined();
  });

  it('names what ran, from the newest attempt artifact', async () => {
    const { fs, run, paths, summary } = await world({ state: 'review_required', attempts: 2 });
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));

    const task = await summary();

    expect(task?.runner).toBe('agy');
    expect(task?.model).toBe('gemini-3.1-pro-high');
    expect(task?.reasoning).toBe('high');
  });

  it('takes the newest attempt, not the first, because a retry can land elsewhere', async () => {
    // Under a fallback the substitute's runner and model are what executed. Reading the
    // oldest artifact would report the runner that was *down* — the same defect
    // `stage-runner.ts` documents for its own event log.
    const { fs, run, paths, summary } = await world({ state: 'failed', attempts: 2 });
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(
      paths.failedAttempt('TASK-001', 2),
      failed(run.runId, 2, { runner: 'claude', model: 'claude-opus-5' }),
    );

    const task = await summary();

    expect(task?.runner).toBe('claude');
    expect(task?.model).toBe('claude-opus-5');
  });

  it('finds the attempt in flight, whose artifact lands before the counter does', async () => {
    const { fs, run, paths, summary } = await world({ state: 'running', attempts: 1 });
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(
      paths.taskAttempt('TASK-001', 2),
      succeeded(run.runId, 2, { runner: 'codex', model: 'gpt-5.6-sol' }),
    );

    const task = await summary();

    expect(task?.runner).toBe('codex');
    expect(task?.model).toBe('gpt-5.6-sol');
  });

  it('reports a legacy attempt that recorded no model as reporting no model', async () => {
    // The artifact predates the field, or the role pinned nothing. Either way the honest
    // answer is that nothing recorded a model — never the runner id in its place.
    const { fs, run, paths, summary } = await world({ state: 'failed', attempts: 1 });
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1, { model: undefined }));

    const task = await summary();

    expect(task?.runner).toBe('agy');
    expect(task?.model).toBeUndefined();
  });

  it('answers the task duration with silence rather than an attempt duration', async () => {
    // Asserted as an absence on purpose. The newest attempt of a task that ran twice took
    // less time than the task did, and `validationPassed` on the summary reads as the
    // task's verdict rather than one attempt's commands. Backfilling either would answer a
    // question with a different question's answer — which is the failure mode this
    // milestone exists to remove, so a later "completion" of this block should go red here.
    const { fs, run, paths, summary } = await world({ state: 'review_required', attempts: 2 });
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));

    const task = await summary();

    expect(task?.runner, 'the identity triple is backfilled').toBe('agy');
    expect(task?.durationMs, 'the task duration is not an attempt duration').toBeUndefined();
    expect(task?.validationPassed, "an attempt's commands are not the task's verdict").toBeUndefined();
  });

  it('never lets an attempt overrule a result that exists', async () => {
    // The record is the record. A completed task in worktree mode does have a
    // `result.json`, written by the Integrator, and it carries the model of the attempt it
    // integrated — so a newer artifact must not be able to move it.
    const { fs, run, paths, summary } = await world({ state: 'completed', attempts: 2 });

    fs.seed(
      paths.taskResult('TASK-001'),
      JSON.stringify({
        task: 'TASK-001',
        status: 'completed',
        runner: 'claude',
        model: 'claude-opus-5',
        reasoning: 'medium',
        reasoningClamped: false,
        startedAt: '2026-09-01T10:02:00.000Z',
        finishedAt: '2026-09-01T10:05:00.000Z',
        filesChanged: [],
        validation: { passed: true, expectation: 'pass', commands: [] },
        notes: [],
      }),
    );

    fs.seed(
      paths.taskAttempt('TASK-001', 2),
      succeeded(run.runId, 2, { runner: 'agy', model: 'a-model-from-a-later-artifact' }),
    );

    const task = await summary();

    expect(task?.runner).toBe('claude');
    expect(task?.model).toBe('claude-opus-5');
  });

  it('looks for no artifact at all when the counter says nothing was dispatched', async () => {
    // Nine queued tasks on a board paint would otherwise be eighteen filesystem probes to
    // learn nothing, so the reader is guarded on the counter. **Asserted behaviourally
    // rather than by counting reads**: an artifact is planted where one cannot legitimately
    // exist, and the guard is what keeps it out of the view. A read-counting version would
    // need the fake to record reads, which it does not — and a test that silently skips
    // when a field is missing is a test that asserts nothing.
    const { fs, run, paths, summary } = await world({ state: 'running', attempts: 0 });
    fs.seed(paths.taskAttempt('TASK-001', 1), succeeded(run.runId, 1));

    const task = await summary();

    expect(task?.runner).toBeUndefined();
    expect(task?.model).toBeUndefined();
  });
});
