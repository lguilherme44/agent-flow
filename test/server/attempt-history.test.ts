import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { RunReader } from '../../src/server/run-reader.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import type { RegisteredProject } from '../../src/server/project-registry.js';

/**
 * AR-08 — attempt history is visible per task, with each attempt's log.
 *
 * The logs were already reachable. The **outcomes** were not: `TaskDetailView` flattens the
 * newest attempt — its runner, its model, whether validation passed — and says nothing
 * about the ones before it. A task that failed on attempt 1 and passed on attempt 2 reports
 * attempt 2's provenance and attempt 1's log, and no field connects them.
 *
 * That was tolerable while a second attempt required somebody to type `retry --force`. With
 * AR-03's automatic recovery on by default it is the normal path, and the questions it
 * leaves unanswerable are the ones a person actually has: what failed the first time,
 * whether it cost a budget, and whether the retry ran on the same model.
 *
 * Every one of those facts is already on disk — `attempt-<n>.json` and
 * `attempt-<n>.failed.json` are written for exactly this reason (§11.3, AD-34) — and the
 * reader opened those files only to ask whether a merge had happened.
 */

const PROJECT: RegisteredProject = { id: 'demo', name: 'demo', path: '/repo' } as RegisteredProject;

const PLAN = {
  feature: 'f',
  tasks: [
    {
      id: 'TASK-001',
      title: 'One',
      description: 'Work.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Done.'],
      validation: ['test'],
    },
  ],
};

const OID = 'a'.repeat(40);

async function world() {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', 'project:\n  name: demo\n  type: node\n');
  fs.seed('/home/.agent-flow/config.yaml', '');

  const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/repo' });
  const reader = new RunReader({
    fs,
    clock: new FixedClock(),
    globalConfigPath: '/home/.agent-flow/config.yaml',
  });

  const run = await store.createRun('f');
  const paths = runPaths('/repo', run.runId);
  fs.seed(paths.plan, JSON.stringify(PLAN));
  await store.updateRun(run.runId, (state) => ({
    ...state,
    stage: 'implementation',
    tasks: [
      { id: 'TASK-001', state: 'completed' as const, attempts: 2, infrastructureFailures: 0 },
    ],
  }));

  return { fs, store, reader, run, paths };
}

/** A failed attempt, as `task-executor.ts` writes it. */
const failed = (runId: string, attempt: number, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    run: runId,
    task: 'TASK-001',
    attempt,
    base: OID,
    branch: `agent-flow/x/TASK-001/attempt-${String(attempt)}`,
    workspace: `worktrees/TASK-001-${String(attempt)}`,
    runner: 'claude',
    model: 'a-model',
    reasoning: 'medium',
    reasoningClamped: false,
    startedAt: '2026-08-17T10:00:00.000Z',
    finishedAt: '2026-08-17T10:01:00.000Z',
    failureClass: 'validation_unsatisfied',
    consumedAttempt: true,
    validation: {
      expectation: 'pass',
      passed: false,
      ids: ['test'],
      commands: [
        {
          command: 'npm test',
          exitCode: 1,
          durationMs: 900,
          stdout: '',
          stderr: 'AssertionError: expected 2, got 3',
          truncated: false,
        },
      ],
    },
    ...overrides,
  });

/** A successful attempt, as `attempt-receipt.ts` writes it. */
const succeeded = (runId: string, attempt: number, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    run: runId,
    task: 'TASK-001',
    attempt,
    base: OID,
    branch: `agent-flow/x/TASK-001/attempt-${String(attempt)}`,
    workspace: `worktrees/TASK-001-${String(attempt)}`,
    runner: 'claude',
    model: 'a-model',
    reasoning: 'medium',
    reasoningClamped: false,
    startedAt: '2026-08-17T10:02:00.000Z',
    finishedAt: '2026-08-17T10:03:00.000Z',
    validatedTree: 'b'.repeat(40),
    marker: 'c'.repeat(40),
    receipt: { nonce: '0'.repeat(32), validatedTree: 'b'.repeat(40), issuedAt: '2026-08-17T10:03:00.000Z' },
    validation: { expectation: 'pass', passed: true, ids: ['test'], commands: [] },
    validationJudgement: 'satisfied',
    agentReport: { status: 'COMPLETED', filesChanged: ['src/a.ts'], notes: [] },
    ...overrides,
  });

describe('attempt history (AR-08)', () => {
  it('reports one entry per attempt, oldest first', async () => {
    const { fs, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));

    const detail = await reader.taskDetail(PROJECT, run.runId, 'TASK-001');

    expect(detail?.attemptHistory?.map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it('says how each attempt ended, which is the whole question', async () => {
    const { fs, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]).toMatchObject({
      attempt: 1,
      outcome: 'failed',
      failureClass: 'validation_unsatisfied',
    });
    expect(history?.[1]).toMatchObject({ attempt: 2, outcome: 'succeeded' });
  });

  it('carries whether a failure spent one of the task budget attempts (I-22)', async () => {
    // Recorded at the time rather than recomputed, so "why was retry still allowed" has an
    // answer that does not depend on a policy table that may since have changed.
    const { fs, reader, run, paths } = await world();
    fs.seed(
      paths.failedAttempt('TASK-001', 1),
      failed(run.runId, 1, { failureClass: 'runner_permission_required', consumedAttempt: false }),
    );

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]?.consumedAttempt).toBe(false);
  });

  it('carries what actually ran on each attempt, not what was configured', async () => {
    // Under a fallback the two differ, and that difference is most of what provenance is
    // for. A retry that silently landed on another runner is invisible without this.
    const { fs, reader, run, paths } = await world();
    fs.seed(
      paths.failedAttempt('TASK-001', 1),
      failed(run.runId, 1, { runner: 'codex', model: 'other-model', reasoning: 'high' }),
    );
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]).toMatchObject({ runner: 'codex', model: 'other-model', reasoning: 'high' });
    expect(history?.[1]?.runner).toBe('claude');
  });

  it('keeps a finished attempt on its own model after the configuration moves (Issue #21)', async () => {
    // **The test above proves the artifact is read. It does not prove the artifact wins.**
    // `world()` seeds an empty global config and a project block with no `roles:`, so no
    // model is configured anywhere — and a reader that started preferring configuration
    // over the artifact would keep it green, because there would be nothing to prefer.
    //
    // This is the missing half: a configuration that names a *different* model for the
    // role, in force at read time, over an attempt that recorded its own. Issue #21's
    // acceptance turns on exactly this — "changing config after a completed attempt does
    // not make historical UI claim the new model executed the old attempt".
    const { fs, reader, run, paths } = await world();

    fs.seed(
      '/home/.agent-flow/config.yaml',
      [
        // The control lives in this block. `parallelism.maxTasks` is the one field the
        // reader does consult, so an unusual value arriving in the view is proof that this
        // configuration was loaded, parsed and in force at read time — which is what makes
        // the model assertions below a preference rather than an absence.
        'parallelism:',
        '  maxTasks: 7',
        'roles:',
        '  executor.normal:',
        '    runner: claude',
        '    model: a-model-configured-later',
        '  executor.trivial:',
        '    runner: claude',
        '    model: a-model-configured-later',
        '',
      ].join('\n'),
    );

    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1, { model: 'the-model-that-ran' }));
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2, { model: 'the-model-that-ran' }));

    const detail = await reader.taskDetail(PROJECT, run.runId, 'TASK-001');
    const runView = await reader.runDetail(PROJECT, run.runId);

    // Positive control: this configuration is readable, and the reader read it.
    expect(
      runView?.isolation.parallelism.requested,
      'the configuration was not loaded, so nothing below is a preference',
    ).toBe(7);

    expect(detail?.attemptHistory?.length).toBe(2);
    for (const entry of detail?.attemptHistory ?? []) {
      expect(entry.model, `attempt ${String(entry.attempt)}`).toBe('the-model-that-ran');
    }
  });

  it('names the failing command, so the entry is actionable on its own', async () => {
    const { fs, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]?.failedCommands).toEqual(['npm test']);
  });

  it('pairs each attempt with its own log', async () => {
    // The pairing is the point. `attemptLogs` and the outcomes were two lists a caller had
    // to join by index, and an attempt with no log — a failure before the runner started —
    // shifted the join by one.
    const { fs, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));
    fs.seed(paths.log('implementation-TASK-001-attempt-2'), 'second try\n');

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]?.log).toEqual([]);
    expect(history?.[1]?.log).toEqual(['second try']);
  });

  it('reports no history for a task that has none, rather than an empty list', async () => {
    // Absent and empty are different: a sequential run writes one unsuffixed log and no
    // attempt artifacts, and rendering "0 attempts" over a task that ran would be wrong.
    const { reader, run } = await world();

    expect((await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory).toBeUndefined();
  });

  it('survives an attempt artifact it cannot parse', async () => {
    // A read model. One corrupt file costs that entry, never the task view.
    const { fs, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), '{ not json');
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.map((entry) => entry.attempt)).toEqual([2]);
  });

  it('reports what each attempt cost, and what the retry added (AR-09)', async () => {
    // AR-09's acceptance, in the one place it can be checked: "a recovered task's total
    // token cost is reported against a first-attempt baseline".
    //
    // `recoveryCostAgainstBaseline` existed, was tested, and had **no caller** — the same
    // disease as the runtime projection. A measurement nothing reports is not a measurement;
    // it is a function with a test.
    const { fs, store, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    fs.seed(paths.taskAttempt('TASK-001', 2), succeeded(run.runId, 2));

    await store.appendEvent(run.runId, 'stage_context_measured', {
      stage: 'implementation',
      role: 'executor.trivial',
      task: 'TASK-001',
      attempt: 1,
      totalBytes: 10_000,
      parts: [{ source: 'stagePrompt', bytes: 10_000, share: 100 }],
      overCeiling: false,
    });
    await store.appendEvent(run.runId, 'stage_context_measured', {
      stage: 'implementation',
      role: 'executor.trivial',
      task: 'TASK-001',
      attempt: 2,
      totalBytes: 12_500,
      parts: [{ source: 'stagePrompt', bytes: 12_500, share: 100 }],
      overCeiling: false,
    });

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]?.contextBytes).toBe(10_000);
    expect(history?.[1]?.contextBytes).toBe(12_500);
    // The packet's price, against the attempt it replaced.
    expect(history?.[1]?.recoveryCost).toEqual({ addedBytes: 2_500, addedShare: 25 });
    // The first attempt has nothing to be compared against, and inventing 0% would be an
    // assertion nobody measured.
    expect(history?.[0]?.recoveryCost).toBeUndefined();
  });

  it('reports no cost rather than a fabricated one when nothing measured it', async () => {
    // A run predating AR-09, or a stage whose measurement never landed.
    const { fs, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]?.contextBytes).toBeUndefined();
    expect(history?.[0]?.recoveryCost).toBeUndefined();
  });

  it('ignores a measurement belonging to another task', async () => {
    const { fs, store, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));

    await store.appendEvent(run.runId, 'stage_context_measured', {
      stage: 'implementation',
      role: 'executor.trivial',
      task: 'TASK-002',
      attempt: 1,
      totalBytes: 99_000,
      parts: [],
      overCeiling: false,
    });

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.[0]?.contextBytes).toBeUndefined();
  });

  it('never scans past the task\'s own attempt counter', async () => {
    // **The regression this exists for.** `MAX_SUPPORTED_ATTEMPT` is `Number.MAX_SAFE_INTEGER`
    // — it bounds path *validity*, not iteration. The sibling that reads logs gets away with
    // using it because it stops at the first gap; this scan cannot, because an attempt that
    // failed before the runner started writes no artifact and stopping there would hide
    // every attempt after it.
    //
    // Written the first time with that constant as the loop bound, it did not fail. It hung,
    // and a hang is a worse failure than a wrong answer: the suite times out somewhere else
    // and the cause is nowhere near the report.
    const { fs, reader, run, paths } = await world();
    fs.seed(paths.failedAttempt('TASK-001', 1), failed(run.runId, 1));
    // Far beyond the counter. Reachable only by an unbounded scan.
    fs.seed(paths.taskAttempt('TASK-001', 9), succeeded(run.runId, 9));

    const history = (await reader.taskDetail(PROJECT, run.runId, 'TASK-001'))?.attemptHistory;

    expect(history?.map((entry) => entry.attempt)).toEqual([1]);
  });
});
