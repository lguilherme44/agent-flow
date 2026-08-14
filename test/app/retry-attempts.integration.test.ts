import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { TaskWorkspaces, type TaskWorkspace } from '../../src/app/task-workspaces.js';
import { WorktreeRecovery } from '../../src/app/worktree-recovery.js';
import { recordAttempt } from '../../src/app/attempt-receipt.js';
import { attemptLogName, runPaths } from '../../src/app/paths.js';
import {
  PlanSchema,
  TaskResultSchema,
  type EffectiveConfig,
  type Plan,
  type Task,
  type TaskResult,
} from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';
import { makeWorktreeRun, type WorktreeRun } from '../fixtures/worktree-run.js';
import { forceState } from '../fixtures/crash.js';

/**
 * A retry is a new attempt, and it destroys nothing (§16, I-12, M2-08).
 *
 * Most of I-12 holds *by construction* rather than by a check, and this suite
 * exists to prove that rather than to assume it: the branch, the workspace, the
 * artifact and the log are all named with the attempt number, so attempt *n+1*
 * cannot reach attempt *n*'s anything. What a test can still get wrong is the
 * boundary — that a retry consumes exactly one attempt, that recovery consumes
 * none, and that a retried task is cut from the integration head as it stands
 * *now* rather than from the base its predecessor failed against.
 *
 * Against real Git, because "the conflict is gone by construction" (§15) is a
 * claim about what merging into a moved branch does.
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

const taskOf = (id: string, dependencies: string[] = []): Record<string, unknown> => ({
  id,
  title: `Task ${id}`,
  description: 'Work.',
  complexity: 'normal',
  risk: 'low',
  dependencies,
  requirements: ['FR-001'],
  acceptanceCriteria: ['Done.'],
  validation: [],
});

function planOf(...ids: string[]): Plan {
  return PlanSchema.parse({ feature: 'f', tasks: ids.map((id) => taskOf(id)) });
}

/**
 * An executor whose output depends on which attempt it is.
 *
 * `contents(task, attempt)` decides what the "agent" writes, so a first attempt
 * can conflict and a second can be told apart from it by the bytes on the branch.
 */
function attemptAwareExecutor(
  current: WorktreeRun,
  contents: (task: string, attempt: number) => string,
  observed: { readonly bases: string[]; readonly saw: string[] },
  judgementFor: (attempt: number) => 'satisfied' | 'unsatisfied' = () => 'satisfied',
): TaskExecutor {
  return {
    execute: async (
      task: Task,
      runId: string,
      _sdd: string,
      workspace?: TaskWorkspace,
    ): Promise<TaskResult> => {
      if (workspace?.isolation === undefined) throw new Error('expected an isolated workspace');
      observed.bases.push(`${task.id}@${workspace.attempt}=${workspace.isolation.base}`);
      // What the workspace held before this agent wrote a line, which is how "cut
      // from the moved integration head" is observable at all.
      observed.saw.push(
        `${task.id}@${workspace.attempt}:${
          existsSync(join(workspace.path, 'sibling.txt')) ? 'has-sibling' : 'no-sibling'
        }`,
      );

      writeFileSync(join(workspace.path, 'shared.txt'), contents(task.id, workspace.attempt));

      const judgement = judgementFor(workspace.attempt);
      const result = TaskResultSchema.parse({
        task: task.id,
        // `review_required` is what `judgeValidation` returns for an expectation
        // that was not met, so this is the shape a real failed validation has.
        status: judgement === 'satisfied' ? 'completed' : 'review_required',
        runner: 'fake',
        reasoning: 'medium',
        startedAt: '2026-08-09T19:59:00.000Z',
        finishedAt: '2026-08-09T20:00:00.000Z',
        filesChanged: ['shared.txt'],
        validation: { passed: judgement === 'satisfied', expectation: 'pass', commands: [] },
      });

      const recorded = await recordAttempt(
        {
          workspaces: current.repo.workspaces,
          fs: current.fs,
          clock: current.clock,
          host: current.host,
          projectDir: current.repo.dir,
        },
        {
          draft: {
            run: runId,
            task: task.id,
            attempt: workspace.attempt,
            base: workspace.isolation.base,
            branch: workspace.isolation.branch,
            workspace: workspace.isolation.relativePath,
            runner: 'fake',
            reasoning: 'medium',
            reasoningClamped: false,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            filesChanged: ['shared.txt'],
            agentReport: { status: 'COMPLETED', notes: [], deviations: [] },
            validation: {
              expectation: 'pass',
              passed: judgement === 'satisfied',
              ids: [],
              commands: [],
            },
            validationJudgement: judgement,
          },
          workspacePath: workspace.path,
          gitRunKey: current.gitRunKey,
        },
      );
      if (!recorded.ok) throw new Error(recorded.failure.detail);

      return result;
    },
  } as unknown as TaskExecutor;
}

function schedulerFor(current: WorktreeRun, executor: TaskExecutor, maxAttempts = 3): Scheduler {
  const deps = {
    workspaces: current.repo.workspaces,
    fs: current.fs,
    host: current.host,
    projectDir: current.repo.dir,
  };

  return new Scheduler({
    store: current.store,
    executor,
    workspaces: new TaskWorkspaces({
      ...deps,
      processRunner: new NodeProcessRunner(),
      config: { global: {}, project: {} } as unknown as EffectiveConfig,
      clock: current.clock,
    }),
    integrator: current.integrator,
    recovery: new WorktreeRecovery({
      ...deps,
      store: current.store,
      clock: current.clock,
      integrator: current.integrator,
    }),
    maxAttempts,
  });
}

/** Resumes from the persisted states, as `run-actions.execute` does. */
async function resume(scheduler: Scheduler, plan: Plan, current: WorktreeRun) {
  const state = await current.store.loadRun(current.runId);
  const previous = Object.fromEntries(state.tasks.map((task) => [task.id, task.state]));
  return scheduler.run(plan, current.runId, 'SDD', previous);
}

/** What `retryTask` does to the run, without the lock and the config around it. */
async function requeue(current: WorktreeRun, taskId: string): Promise<void> {
  await current.store.updateRun(current.runId, (state) => ({
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === taskId ? { ...task, state: 'queued' as const } : task,
    ),
  }));
}

function merges(current: WorktreeRun): string {
  return current.repo
    .userGit(['rev-list', '--count', '--merges', `refs/heads/${current.integrationBranch}`])
    .trim();
}

function refOf(current: WorktreeRun, task: string, attempt: number): string {
  return `refs/heads/agent-flow/${current.gitRunKey}/${task}/attempt-${String(attempt)}`;
}

/**
 * Moves the integration branch the way the product moves it: by integrating a
 * sibling.
 *
 * **Never by checking the branch out.** It is checked out in the integration
 * worktree for the life of the run, so Git refuses a second checkout — and doing
 * it in the user's tree is precisely what I-10 forbids. So the head is moved
 * through the Integrator, which is also the only shape that leaves the branch
 * looking like something this product produced.
 *
 * Returns the moved head, and leaves `shared.txt` and `sibling.txt` on the branch
 * so a later attempt's workspace can be seen to contain them.
 */
async function integrateASibling(current: WorktreeRun): Promise<string> {
  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') throw new Error('expected a prepared integration workspace');

  const sibling = await current.plant('TASK-002', 1, {
    write: { 'shared.txt': 'from a sibling\n', 'sibling.txt': 'a sibling was here\n' },
  });
  const outcome = await current.integrator.integrate({
    runId: current.runId,
    workspace: prepared.workspace,
    dag: current.dag([{ id: 'TASK-002' }]),
    attempts: [{ task: 'TASK-002', attempt: 1, result: current.resultFor('TASK-002') }],
  });
  if (outcome.outcomes[0]?.kind !== 'integrated') {
    throw new Error('the sibling did not integrate, so the head did not move');
  }
  void sibling;

  return current.repo.userGit(['rev-parse', `refs/heads/${current.integrationBranch}`]).trim();
}

/**
 * Plants a conflicting attempt 1 and lets integration refuse it (§15).
 *
 * Planted at `planningBase` rather than at the moved head, because that is what a
 * conflict *is*: an attempt validated against a base its sibling has since moved
 * away from. At concurrency 1 the scheduler cannot produce one — every wave is cut
 * from the current head — so the base is set deliberately here.
 */
async function conflictOnFirstAttempt(current: WorktreeRun): Promise<{ marker: string }> {
  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') throw new Error('expected a prepared integration workspace');

  const planted = await current.plant('TASK-001', 1, {
    base: current.planningBase,
    write: { 'shared.txt': 'from the task\n' },
  });
  const outcome = await current.integrator.integrate({
    runId: current.runId,
    workspace: prepared.workspace,
    dag: current.dag([{ id: 'TASK-001' }]),
    attempts: [{ task: 'TASK-001', attempt: 1, result: current.resultFor('TASK-001') }],
  });

  const refused = outcome.outcomes[0];
  if (refused?.kind !== 'refused' || refused.refusal.code !== 'integration_conflict') {
    throw new Error(`expected an integration conflict, got ${String(refused?.kind)}`);
  }

  // The Integrator *returns* the state a refusal leaves a task in; the **scheduler**
  // is what writes it (§14.4 — the literal lives in the module that owns the
  // write, and the scheduler copies it). Calling `integrate` directly skips that
  // half, so it is done here rather than left as a state the run never reached.
  await current.store.updateRun(current.runId, (state) => ({
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === 'TASK-001' ? { ...task, state: refused.state } : task,
    ),
  }));

  return { marker: planted.marker };
}

describe('a retry is a fresh attempt in every respect (§16, I-12)', () => {
  it('gets a new branch, a new workspace, a new artifact and a new log', async () => {
    run = await makeWorktreeRun();
    const observed = { bases: [] as string[], saw: [] as string[] };
    const plan = planOf('TASK-001', 'TASK-002');

    await run.seed(['TASK-001', 'TASK-002']);
    await integrateASibling(run);
    await conflictOnFirstAttempt(run);

    // §15's path, and the reason a person reaches for a retry: the task is in
    // `review_required` with one attempt spent and its evidence on disk.
    let state = await run.store.loadRun(run.runId);
    expect(state.tasks.find((task) => task.id === 'TASK-001')?.state).toBe('review_required');
    expect(state.tasks.find((task) => task.id === 'TASK-001')?.attempts).toBe(1);

    const attemptOne = {
      artifact: readFileSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1), 'utf8'),
      marker: run.repo.userGit(['rev-parse', refOf(run, 'TASK-001', 1)]).trim(),
    };

    await requeue(run, 'TASK-001');
    const second = await resume(
      schedulerFor(run, attemptAwareExecutor(run, () => 'from a resolved task\n', observed)),
      plan,
      run,
    );

    expect(second.planComplete).toBe(true);
    state = await run.store.loadRun(run.runId);
    const retried = state.tasks.find((task) => task.id === 'TASK-001');
    expect(retried?.state).toBe('completed');
    // **Exactly one new attempt.** The requeue spends nothing; the dispatch does.
    expect(retried?.attempts).toBe(2);

    // A new branch, and the old one still where it was.
    expect(run.repo.userGit(['rev-parse', refOf(run, 'TASK-001', 1)]).trim()).toBe(
      attemptOne.marker,
    );
    const secondMarker = run.repo.userGit(['rev-parse', refOf(run, 'TASK-001', 2)]).trim();
    expect(secondMarker).not.toBe(attemptOne.marker);

    // A new artifact, and the old one byte-identical: evidence is never rewritten.
    expect(
      readFileSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1), 'utf8'),
    ).toBe(attemptOne.artifact);
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 2))).toBe(true);

    // A new workspace. Both are still on disk, because a worktree in any state
    // other than integrated is the only copy of what its agent produced (§7.4) —
    // reclaiming them is M2-09's.
    const registered = run.repo.userGit(['worktree', 'list', '--porcelain']);
    expect(registered).toContain('TASK-001/attempt-1');
    expect(registered).toContain('TASK-001/attempt-2');

    // A new log, so the record of the attempt somebody is retrying survives the
    // retry (§16).
    const logs = runPaths(run.repo.dir, run.runId);
    expect(existsSync(logs.log(attemptLogName('TASK-001', 1)))).toBe(false);
    expect(existsSync(logs.log(attemptLogName('TASK-001', 2)))).toBe(false);
    // The stand-in executor writes no log; what is asserted is that the two names
    // differ at all, which is what makes overwriting impossible.
    expect(attemptLogName('TASK-001', 1)).not.toBe(attemptLogName('TASK-001', 2));
  });

  it('cuts the new attempt from the integration head as it stands now', async () => {
    // §16: `base := current integration HEAD`, **not** the old base. This is what
    // makes §15's promise true — "a retry creates a new attempt against the current
    // integration head, where the sibling's work is already present, so the
    // conflict is gone by construction".
    run = await makeWorktreeRun();
    const observed = { bases: [] as string[], saw: [] as string[] };
    const plan = planOf('TASK-001', 'TASK-002');

    await run.seed(['TASK-001', 'TASK-002']);
    const moved = await integrateASibling(run);
    await conflictOnFirstAttempt(run);

    await requeue(run, 'TASK-001');
    const outcome = await resume(
      schedulerFor(run, attemptAwareExecutor(run, () => 'resolved\n', observed)),
      plan,
      run,
    );

    expect(outcome.planComplete).toBe(true);
    // Attempt 1 was validated against `planningBase` — that is what made it
    // conflict. Attempt 2 is cut from the head the sibling's merge moved to, which
    // is §16's `base := current integration HEAD` and the whole of why §15 can
    // promise the conflict is gone by construction.
    expect(moved).not.toBe(run.planningBase);
    expect(observed.bases).toEqual([`TASK-001@2=${moved}`]);
    // And the agent could see the sibling's file before it wrote a line, which is
    // the property a base value alone does not prove.
    expect(observed.saw).toEqual(['TASK-001@2:has-sibling']);
    // The conflict really is gone: the retry merged cleanly.
    expect(merges(run)).toBe('2');
  });

  it('keeps every attempt’s evidence across several retries', async () => {
    // Three attempts, driven by a validation that keeps failing — the ordinary
    // reason somebody retries three times. Attempts 1 and 2 are `unsatisfied`, so
    // they leave an artifact and no marker; attempt 3 passes.
    run = await makeWorktreeRun();
    const observed = { bases: [] as string[], saw: [] as string[] };
    const plan = planOf('TASK-001');

    const artifacts: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await requeue(run, 'TASK-001');
      await resume(
        schedulerFor(
          run,
          attemptAwareExecutor(
            run,
            (_task, n) => `attempt ${String(n)}\n`,
            observed,
            (n) => (n < 3 ? 'unsatisfied' : 'satisfied'),
          ),
          5,
        ),
        plan,
        run,
      );
      artifacts.push(
        readFileSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', attempt), 'utf8'),
      );
    }

    // Three attempts, three artifacts, three branches — and the first two are
    // byte-identical to what they were when they were written.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const path = runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', attempt);
      expect(existsSync(path), `attempt ${String(attempt)}`).toBe(true);
      expect(readFileSync(path, 'utf8'), `attempt ${String(attempt)}`).toBe(artifacts[attempt - 1]);
      expect(
        run.repo.userGit(['rev-parse', refOf(run, 'TASK-001', attempt)]).trim(),
      ).toMatch(/^[0-9a-f]{40}$/);
    }

    // Each artifact records its own attempt number, so nothing was reused.
    expect(
      artifacts.map((raw) => (JSON.parse(raw) as { attempt: number }).attempt),
    ).toEqual([1, 2, 3]);
    expect((await run.store.loadRun(run.runId)).tasks[0]?.attempts).toBe(3);
  });
});

describe('what consumes an attempt, and what does not', () => {
  it('recovery finishes a durable attempt without spending another', async () => {
    // The boundary M2-07 and M2-08 share: recovery **finishes** attempt *n*, retry
    // **starts** attempt *n+1*. A recovery that spent an attempt would burn the
    // retry budget of a task that had already done its work.
    run = await makeWorktreeRun();
    const workspace = await run.integrator.prepare(run.runId);
    if (workspace.kind !== 'ready') throw new Error('expected a prepared workspace');
    await run.seed(['TASK-001']);

    await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    expect((await run.store.loadRun(run.runId)).tasks[0]?.attempts).toBe(1);

    const outcome = await resume(
      schedulerFor(run, attemptAwareExecutor(run, () => 'unused\n', { bases: [], saw: [] })),
      planOf('TASK-001'),
      run,
    );

    expect(outcome.planComplete).toBe(true);
    const state = await run.store.loadRun(run.runId);
    expect(state.tasks[0]?.state).toBe('completed');
    // Still one. The agent was never invoked again, and no second artifact exists.
    expect(state.tasks[0]?.attempts).toBe(1);
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 2))).toBe(false);
    expect(merges(run)).toBe('1');
  });

  it('does not turn a valid durable attempt pending integration into a retry', async () => {
    // The same property from the other side: a task whose marker is published and
    // unmerged must be *integrated*, never re-run. Re-running it would discard a
    // validated tree and pay for the agent twice.
    run = await makeWorktreeRun();
    const prepared = await run.integrator.prepare(run.runId);
    if (prepared.kind !== 'ready') throw new Error('expected a prepared workspace');
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const observed = { bases: [] as string[], saw: [] as string[] };

    await resume(
      schedulerFor(run, attemptAwareExecutor(run, () => 'must not run\n', observed)),
      planOf('TASK-001'),
      run,
    );

    // The executor was never called, so no base was observed.
    expect(observed.bases).toEqual([]);
    const result = await run.store.readTaskResult(run.runId, 'TASK-001');
    expect(result?.integration?.marker).toBe(planted.marker);
  });

  it('bounds requeued attempts with retry.maxAttempts', async () => {
    // The bound M2-00.2 made correct, still bounding. `recoverInterrupted` leaves a
    // task past the limit `interrupted` for a person rather than trying it again —
    // which is what keeps recovery from becoming the automatic retry loop §23
    // forbids.
    run = await makeWorktreeRun();
    await run.seed(['TASK-001']);
    forceState(run, [{ id: 'TASK-001', state: 'running', attempts: 2 }]);

    const outcome = await resume(
      schedulerFor(run, attemptAwareExecutor(run, () => 'x\n', { bases: [], saw: [] }), 2),
      planOf('TASK-001'),
      run,
    );

    expect(outcome.recovered).toEqual([]);
    expect(outcome.states['TASK-001']).toBe('interrupted');
    const state = await run.store.loadRun(run.runId);
    expect(state.tasks[0]?.attempts).toBe(2);

    const event = (await run.store.readEvents(run.runId)).find(
      (entry) => entry.type === 'task_interrupted',
    );
    expect(event?.detail['requeued']).toBe(false);
    expect(String(event?.detail['reason'])).toContain('attempt limit');
  });

  it('does not retry an unrecognised integration history automatically', async () => {
    // A branch that contains the marker with no merge introducing it is a refusal,
    // and a refusal is not a retry trigger: the fix is a person's, and re-running
    // the agent would build a second attempt over a history nobody can explain.
    run = await makeWorktreeRun();
    const prepared = await run.integrator.prepare(run.runId);
    if (prepared.kind !== 'ready') throw new Error('expected a prepared workspace');
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const linear = run.repo
      .userGit(['commit-tree', planted.validatedTree, '-p', planted.marker, '-m', 'rebuilt'])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${run.integrationBranch}`, linear]);

    const observed = { bases: [] as string[], saw: [] as string[] };
    const outcome = await resume(
      schedulerFor(run, attemptAwareExecutor(run, () => 'must not run\n', observed)),
      planOf('TASK-001'),
      run,
    );

    expect(outcome.haltedBy).toContain('integration_history_unrecognised');
    expect(observed.bases, 'the agent was invoked over an unexplained history').toEqual([]);
    const state = await run.store.loadRun(run.runId);
    expect(state.tasks[0]?.state).toBe('review_required');
    expect(state.tasks[0]?.attempts).toBe(1);
  });
});
