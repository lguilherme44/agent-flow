import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { TaskWorkspaces, type TaskWorkspace } from '../../src/app/task-workspaces.js';
import { recordAttempt } from '../../src/app/attempt-receipt.js';
import { runPaths } from '../../src/app/paths.js';
import {
  PlanSchema,
  TaskResultSchema,
  type EffectiveConfig,
  type Task,
  type TaskResult,
} from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';
import { makeWorktreeRun, type WorktreeRun } from '../fixtures/worktree-run.js';

/**
 * One wave, end to end, against real Git (§9.1, §14).
 *
 * The scheduler, the workspace service and the Integrator are all real; only the
 * coding agent is not. The stand-in executor does exactly what `TaskExecutor`
 * does with an agent's output — write into the prepared worktree, then put it
 * through the §11.2 sequence — so what is being tested is the chain everything
 * else in this milestone rests on:
 *
 * ```text
 * wave base ← the integration branch
 *     ↓
 * a worktree cut from it
 *     ↓
 * a validated tree, a receipt, a marker
 *     ↓
 * a merge, a completed task, an advanced head
 *     ↓
 * the next wave, cut from a branch that now contains the first
 * ```
 *
 * The last line is the one that cannot be tested any other way: a dependent's
 * worktree either holds its dependency's file or it does not.
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

const taskOf = (id: string, dependencies: string[] = []) => ({
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

/**
 * An executor that writes one file and records the attempt, exactly as
 * `TaskExecutor` does — no agent, no runner, no validation command.
 */
function plantingExecutor(current: WorktreeRun) {
  const sawInWorkspace: Record<string, string[]> = {};

  const executor = {
    execute: async (
      task: Task,
      runId: string,
      _sdd: string,
      workspace?: TaskWorkspace,
    ): Promise<TaskResult> => {
      if (workspace?.isolation === undefined) throw new Error('expected an isolated workspace');

      // What the agent could see: the tree it was given, before it wrote anything.
      sawInWorkspace[task.id] = ['one.txt', 'two.txt'].filter((name) =>
        existsSync(join(workspace.path, name)),
      );

      writeFileSync(join(workspace.path, `${task.id === 'TASK-001' ? 'one' : 'two'}.txt`), `${task.id}\n`);

      const result = TaskResultSchema.parse({
        task: task.id,
        status: 'completed',
        runner: 'fake',
        reasoning: 'medium',
        startedAt: '2026-08-09T19:59:00.000Z',
        finishedAt: '2026-08-09T20:00:00.000Z',
        validation: { passed: true, expectation: 'pass', commands: [] },
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
            filesChanged: [],
            agentReport: { status: 'COMPLETED', notes: [], deviations: [] },
            validation: { expectation: 'pass', passed: true, ids: [], commands: [] },
            validationJudgement: 'satisfied',
          },
          workspacePath: workspace.path,
          gitRunKey: current.gitRunKey,
        },
      );
      if (!recorded.ok) throw new Error(recorded.failure.detail);

      return result;
    },
  } as unknown as TaskExecutor;

  return { executor, sawInWorkspace };
}

function schedulerFor(current: WorktreeRun, executor: TaskExecutor): Scheduler {
  return new Scheduler({
    store: current.store,
    executor,
    workspaces: new TaskWorkspaces({
      workspaces: current.repo.workspaces,
      fs: current.fs,
      host: current.host,
      projectDir: current.repo.dir,
      processRunner: new NodeProcessRunner(),
      config: { global: {}, project: {} } as unknown as EffectiveConfig,
      clock: current.clock,
    }),
    integrator: current.integrator,
  });
}

describe('a wave, from the integration branch and back to it (§9.1, §14)', () => {
  it('cuts the second wave from a branch that already holds the first', async () => {
    run = await makeWorktreeRun();
    const { executor, sawInWorkspace } = plantingExecutor(run);

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002', ['TASK-001'])],
    });

    const outcome = await schedulerFor(run, executor).run(plan, run.runId, 'SDD');

    expect(outcome.planComplete).toBe(true);

    // The property nothing else can prove: the dependent's worktree was cut from
    // the integration branch *after* its dependency was merged, so it held its
    // dependency's file before its own agent wrote a line.
    expect(sawInWorkspace['TASK-001']).toEqual([]);
    expect(sawInWorkspace['TASK-002']).toEqual(['one.txt']);
  });

  it('advances integrationHead once per task, and records each merge', async () => {
    run = await makeWorktreeRun();
    const { executor } = plantingExecutor(run);

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002', ['TASK-001'])],
    });

    await schedulerFor(run, executor).run(plan, run.runId, 'SDD');

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    const state = await run.store.loadRun(run.runId);

    expect(state.integrationHead).toBe(head);
    expect(state.tasks.map((task) => task.state)).toEqual(['completed', 'completed']);
    expect(
      run.repo
        .userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`])
        .trim(),
    ).toBe('2');

    // The branch holds both tasks' work, and the user's tree holds neither.
    expect(
      run.repo.userGit(['show', `refs/heads/${run.integrationBranch}:one.txt`]).trim(),
    ).toBe('TASK-001');
    expect(
      run.repo.userGit(['show', `refs/heads/${run.integrationBranch}:two.txt`]).trim(),
    ).toBe('TASK-002');
    expect(existsSync(join(run.repo.dir, 'one.txt'))).toBe(false);
    expect(run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all']).trim()).toBe('');
  });

  it('writes every result.json with its integration block, and none before', async () => {
    run = await makeWorktreeRun();

    const seenBeforeIntegration: string[] = [];
    const { executor } = plantingExecutor(run);
    const watching = {
      execute: async (...args: Parameters<TaskExecutor['execute']>) => {
        const result = await executor.execute(...args);
        // The moment the attempt is validated and marked: still no result.json,
        // because the task is not complete until its marker is merged (§10.1).
        if (existsSync(runPaths(run?.repo.dir ?? '', run?.runId ?? '').taskResult(args[0].id))) {
          seenBeforeIntegration.push(args[0].id);
        }
        return result;
      },
    } as unknown as TaskExecutor;

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002', ['TASK-001'])],
    });

    await schedulerFor(run, watching).run(plan, run.runId, 'SDD');

    expect(seenBeforeIntegration).toEqual([]);

    for (const id of ['TASK-001', 'TASK-002']) {
      const result = await run.store.readTaskResult(run.runId, id);
      expect(result?.status, id).toBe('completed');
      expect(result?.integration?.branch, id).toBe(run.integrationBranch);
      expect(result?.integration?.attempt, id).toBe(1);
      expect(result?.integration?.mergeCommit, id).toMatch(/^[0-9a-f]{40}$/);

      // The merge really names the marker the attempt artifact does.
      const attempt = JSON.parse(
        readFileSync(runPaths(run.repo.dir, run.runId).taskAttempt(id, 1), 'utf8'),
      ) as { receipt: { validatedTree: string } };
      expect(result?.integration?.validatedTree, id).toBe(attempt.receipt.validatedTree);
    }
  });
});
