import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { StateStore } from '../../src/app/state-store.js';
import { TaskWorkspaces, type TaskWorkspace } from '../../src/app/task-workspaces.js';
import { Integrator } from '../../src/app/integrator.js';
import { WorktreeRecovery } from '../../src/app/worktree-recovery.js';
import { recordAttempt } from '../../src/app/attempt-receipt.js';
import { runPaths } from '../../src/app/paths.js';
import {
  PlanSchema,
  TaskResultSchema,
  type EffectiveConfig,
  type Plan,
  type Task,
  type TaskResult,
} from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';
import type { FileSystem } from '../../src/ports/index.js';
import type { GitWorkspaces } from '../../src/adapters/git/git-workspaces.js';
import { makeWorktreeRun, type WorktreeRun } from '../fixtures/worktree-run.js';
import { CrashInjected, delegating } from '../fixtures/crash.js';

/**
 * A run killed at a precise point, resumed, against real Git (§26.5).
 *
 * **The fault is injected into a port, not into production code**, and the whole
 * of the mechanism is that every collaborator already arrives injected: wrapping
 * one in a `Proxy` puts a deterministic failure at an exact call with nothing
 * added to `src/`. §28 asks for exactly this — "the fault hook must be
 * deterministic, not timing-based" — and a `sleep` would prove nothing about
 * where the process died.
 *
 * **Every case asserts what was durable at the moment of the kill**, before the
 * resume runs. Without that, a test claiming window 7 passes just as happily when
 * the fault actually landed in window 5, which §28 names as the specific way a
 * recovery test goes green while proving nothing.
 *
 * The whole path is real: the `Scheduler`, the `TaskWorkspaces` service, the
 * `Integrator` and the `WorktreeRecovery`. Only the coding agent is not, and the
 * stand-in does precisely what `TaskExecutor` does with an agent's output.
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
 * An executor that writes one file and records the attempt, exactly as
 * `TaskExecutor` does — no agent, no runner, no validation command.
 */
function plantingExecutor(current: WorktreeRun, workspaces: GitWorkspaces): TaskExecutor {
  return {
    execute: async (
      task: Task,
      runId: string,
      _sdd: string,
      workspace?: TaskWorkspace,
    ): Promise<TaskResult> => {
      if (workspace?.isolation === undefined) throw new Error('expected an isolated workspace');
      writeFileSync(join(workspace.path, `${task.id}.txt`), `${task.id}\n`);

      const result = TaskResultSchema.parse({
        task: task.id,
        status: 'completed',
        runner: 'fake',
        reasoning: 'medium',
        startedAt: '2026-08-09T19:59:00.000Z',
        finishedAt: '2026-08-09T20:00:00.000Z',
        filesChanged: [`${task.id}.txt`],
        validation: { passed: true, expectation: 'pass', commands: [] },
      });

      const recorded = await recordAttempt(
        {
          // The **injected** adapter, not the run's own: a kill placed on
          // `writeTree` or `updateRef` has to reach the §11.2 sequence, and the
          // executor is where that sequence runs.
          workspaces,
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
            filesChanged: [`${task.id}.txt`],
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
}

/** The whole production graph, with the two ports a test may replace. */
function schedulerFor(
  current: WorktreeRun,
  parts: { readonly fs?: FileSystem; readonly workspaces?: GitWorkspaces } = {},
): Scheduler {
  const fs = parts.fs ?? current.fs;
  const workspaces = parts.workspaces ?? current.repo.workspaces;
  const store = new StateStore({ fs, clock: current.clock, projectDir: current.repo.dir });
  const deps = { workspaces, fs, host: current.host, projectDir: current.repo.dir };
  const integrator = new Integrator({ ...deps, store, clock: current.clock });

  return new Scheduler({
    store,
    executor: plantingExecutor(current, workspaces),
    workspaces: new TaskWorkspaces({
      ...deps,
      processRunner: new NodeProcessRunner(),
      config: { global: {}, project: {} } as unknown as EffectiveConfig,
      clock: current.clock,
    }),
    integrator,
    recovery: new WorktreeRecovery({ ...deps, store, clock: current.clock, integrator }),
  });
}

/** Everything durable, as a process starting up would find it. */
async function durable(current: WorktreeRun, task: string) {
  const paths = runPaths(current.repo.dir, current.runId);
  const state = await current.store.loadRun(current.runId);
  const branch = `refs/heads/${current.integrationBranch}`;

  return {
    artifact: existsSync(paths.taskAttempt(task, 1)),
    result: existsSync(paths.taskResult(task)),
    taskState: state.tasks.find((entry) => entry.id === task)?.state,
    attempts: state.tasks.find((entry) => entry.id === task)?.attempts,
    integrationHead: state.integrationHead,
    branchHead: current.repo.userGit(['rev-parse', branch]).trim(),
    merges: current.repo.userGit(['rev-list', '--count', '--merges', branch]).trim(),
    // The **value** rather than a boolean, and the distinction is the one this
    // suite exists to catch: §7.3 creates the attempt branch with the worktree, at
    // the wave base, so "the ref resolves" is true from the moment the workspace
    // exists and says nothing about whether a marker was published.
    markerRef: (
      await current.repo.workspaces.revParse({
        cwd: current.repo.dir,
        rev: `refs/heads/agent-flow/${current.gitRunKey}/${task}/attempt-1`,
      })
    ),
  };
}

/** What the attempt branch points at, or null when it does not resolve. */
function refAt(at: Awaited<ReturnType<typeof durable>>): string | null {
  return at.markerRef.ok ? at.markerRef.value : null;
}

/** Runs the scheduler and swallows the injected crash, as a dead process does. */
async function crashing(scheduler: Scheduler, plan: Plan, current: WorktreeRun): Promise<void> {
  await expect(scheduler.run(plan, current.runId, 'SDD')).rejects.toThrow(CrashInjected);
}

/**
 * Resumes the way the production path resumes: **from the persisted states.**
 *
 * `run-actions.execute` reads them off the run and hands them in, so work already
 * completed is not paid for twice. Starting a resume with an empty map would tell
 * the scheduler every task is `queued` — which is not what a killed run left, and
 * a test built on it would be testing a fresh run wearing a resume's clothes.
 */
async function resume(scheduler: Scheduler, plan: Plan, current: WorktreeRun) {
  const state = await current.store.loadRun(current.runId);
  const previous = Object.fromEntries(state.tasks.map((task) => [task.id, task.state]));
  return scheduler.run(plan, current.runId, 'SDD', previous);
}

describe('killed between the marker and the merge (§17.3 window 5)', () => {
  it('resumes by merging the marker the dead process published', async () => {
    run = await makeWorktreeRun();
    const plan = planOf('TASK-001');

    // The kill lands *after* `update-ref`, so the marker is durable and nothing
    // downstream of it ran.
    const killed = schedulerFor(run, {
      workspaces: delegating(run.repo.workspaces, killAfterUpdateRef(run)),
    });
    await crashing(killed, plan, run);

    const at = await durable(run, 'TASK-001');
    expect(at.artifact, 'the artifact must be durable at the kill').toBe(true);
    // The ref moved off the wave base, which is what publishing a marker does.
    expect(refAt(at), 'the marker ref must be durable at the kill').not.toBeNull();
    expect(refAt(at), 'the ref must have moved off the wave base').not.toBe(run.planningBase);
    expect(at.merges, 'nothing may have been merged yet').toBe('0');
    expect(at.result).toBe(false);
    expect(at.taskState).toBe('running');

    const outcome = await resume(schedulerFor(run), plan, run);

    expect(outcome.planComplete).toBe(true);
    const after = await durable(run, 'TASK-001');
    expect(after.merges).toBe('1');
    expect(after.taskState).toBe('completed');
    expect(after.integrationHead).toBe(after.branchHead);
    expect(after.result).toBe(true);
    // The recovered attempt was finished, not redone: the counter did not move.
    expect(after.attempts).toBe(1);
  });
});

describe('killed before the ref update (§17.3 windows 3, 4)', () => {
  it('resumes by rebuilding the marker at the same commit id', async () => {
    run = await makeWorktreeRun();
    const plan = planOf('TASK-001');

    const killed = schedulerFor(run, {
      workspaces: delegating(run.repo.workspaces, {
        updateRef: async () => {
          throw new CrashInjected('the marker was committed and the ref was not updated');
        },
      }),
    });
    await crashing(killed, plan, run);

    const at = await durable(run, 'TASK-001');
    expect(at.artifact, 'the artifact must be durable at the kill').toBe(true);
    // **The ref exists and is still at the wave base**, because §7.3 created it
    // with the worktree. This is the durable shape of windows 3 and 4, and reading
    // it as "the marker is here" is the misclassification this assertion pins.
    expect(refAt(at), 'the ref must still be at the wave base at the kill').toBe(run.planningBase);
    expect(at.merges).toBe('0');
    expect(at.taskState).toBe('running');

    const outcome = await resume(schedulerFor(run), plan, run);

    expect(outcome.planComplete).toBe(true);
    const after = await durable(run, 'TASK-001');
    expect(refAt(after)).not.toBe(run.planningBase);
    expect(after.merges).toBe('1');
    expect(after.attempts).toBe(1);

    // The marker the resume published is the one the artifact describes, which is
    // what makes windows 3 and 4 one window (§12.2).
    const result = await run.store.readTaskResult(run.runId, 'TASK-001');
    expect(result?.integration?.marker).toBe(
      run.repo
        .userGit(['rev-parse', `refs/heads/agent-flow/${run.gitRunKey}/TASK-001/attempt-1`])
        .trim(),
    );
  });
});

describe('killed after the merge, before result.json (§17.3 window 7, case 1)', () => {
  it('resumes by recording the merge Git already made', async () => {
    run = await makeWorktreeRun();
    const plan = planOf('TASK-001');

    const killed = schedulerFor(run, {
      workspaces: delegating(run.repo.workspaces, killAfterMerge(run)),
    });
    await crashing(killed, plan, run);

    const at = await durable(run, 'TASK-001');
    expect(at.merges, 'the merge must be durable at the kill').toBe('1');
    expect(at.result, 'result.json must NOT exist at the kill').toBe(false);
    expect(at.taskState).toBe('running');
    expect(at.integrationHead, 'the state must still name the old head').not.toBe(at.branchHead);
    const landed = at.branchHead;

    const outcome = await resume(schedulerFor(run), plan, run);

    expect(outcome.planComplete).toBe(true);
    const after = await durable(run, 'TASK-001');
    // **No second merge**, and the branch did not move.
    expect(after.merges).toBe('1');
    expect(after.branchHead).toBe(landed);
    expect(after.integrationHead).toBe(landed);
    expect(after.taskState).toBe('completed');
    expect(after.result).toBe(true);
    expect(after.attempts).toBe(1);
  });
});

describe('killed after result.json, before the state write (§17.3 window 7, case 2)', () => {
  it('resumes by completing the task the merge already finished', async () => {
    run = await makeWorktreeRun();
    const plan = planOf('TASK-001');
    const resultPath = runPaths(run.repo.dir, run.runId).taskResult('TASK-001');
    const current = run;

    // The kill is keyed on the *path* being written, which is what makes it land
    // between the two durable writes of §14.3 step 7 rather than near them.
    const killed = schedulerFor(run, {
      fs: delegating(run.fs, {
        writeFileAtomic: async (target: string, contents: string) => {
          await current.fs.writeFileAtomic(target, contents);
          if (target === resultPath) throw new CrashInjected('result.json was written');
        },
      }),
    });
    await crashing(killed, plan, run);

    const at = await durable(run, 'TASK-001');
    expect(at.merges, 'the merge must be durable at the kill').toBe('1');
    expect(at.result, 'result.json must be durable at the kill').toBe(true);
    expect(at.taskState, 'the task must not be completed at the kill').toBe('running');
    expect(at.integrationHead).not.toBe(at.branchHead);
    const landed = at.branchHead;

    const outcome = await resume(schedulerFor(run), plan, run);

    expect(outcome.planComplete).toBe(true);
    const after = await durable(run, 'TASK-001');
    expect(after.merges).toBe('1');
    expect(after.branchHead).toBe(landed);
    expect(after.integrationHead).toBe(landed);
    expect(after.taskState).toBe('completed');
    expect(after.attempts).toBe(1);
  });
});

describe('killed during the agent (§17.3 windows 1, 2)', () => {
  it('resumes by spending a new attempt, because nothing was observed', async () => {
    run = await makeWorktreeRun();
    const plan = planOf('TASK-001');
    const current = run;

    // Killed before any evidence: `write-tree` is the first durable step of §11.2,
    // so failing it leaves the worktree edited and nothing recorded.
    const killed = schedulerFor(run, {
      workspaces: delegating(run.repo.workspaces, {
        writeTree: async () => {
          throw new CrashInjected('the agent finished and nothing was recorded');
        },
      }),
    });
    await crashing(killed, plan, current);

    const at = await durable(run, 'TASK-001');
    expect(at.artifact, 'no artifact may exist at the kill').toBe(false);
    // The branch exists at the wave base and nothing marked it — the same shape
    // windows 3 and 4 have, and told apart from them by the artifact's absence.
    expect(refAt(at)).toBe(run.planningBase);
    expect(at.taskState).toBe('running');
    expect(at.attempts).toBe(1);

    const outcome = await resume(schedulerFor(run), plan, run);

    expect(outcome.planComplete).toBe(true);
    expect(outcome.recovered).toEqual(['TASK-001']);
    const after = await durable(run, 'TASK-001');
    // A fresh attempt, on a fresh branch, and the first attempt's branch survives
    // as the only durable record of what it produced (I-12, §16).
    expect(after.attempts).toBe(2);
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 2))).toBe(true);
    expect(after.merges).toBe('1');
    expect(after.taskState).toBe('completed');
  });
});

describe('a resume is idempotent all the way through the scheduler', () => {
  it('changes nothing when the run is started a third time', async () => {
    run = await makeWorktreeRun();
    const plan = planOf('TASK-001', 'TASK-002');

    const killed = schedulerFor(run, {
      workspaces: delegating(run.repo.workspaces, killAfterMerge(run)),
    });
    await crashing(killed, plan, run);

    await resume(schedulerFor(run), plan, run);
    const after = {
      one: await durable(run, 'TASK-001'),
      two: await durable(run, 'TASK-002'),
      events: (await run.store.readEvents(run.runId)).length,
    };

    const again = await resume(schedulerFor(run), plan, run);

    expect(again.planComplete).toBe(true);
    expect(await durable(run, 'TASK-001')).toEqual(after.one);
    expect(await durable(run, 'TASK-002')).toEqual(after.two);
    // Nothing was re-recorded either: a completed run observed again is silent.
    expect((await run.store.readEvents(run.runId)).length).toBe(after.events);
  });
});

describe('sequential and unwired runs are untouched by any of this', () => {
  it('never reaches recovery with no service wired', async () => {
    run = await makeWorktreeRun();
    const plan = planOf('TASK-001');

    // No `recovery` and no `integrator`: the M2-06-and-earlier shape. The
    // scheduler must behave exactly as it did, which for an isolated executor
    // means the run completes without an integration branch being consulted.
    const scheduler = new Scheduler({
      store: run.store,
      executor: {
        execute: async (task: Task): Promise<TaskResult> =>
          TaskResultSchema.parse({
            task: task.id,
            status: 'completed',
            runner: 'fake',
            reasoning: 'medium',
            startedAt: '2026-08-09T19:59:00.000Z',
            finishedAt: '2026-08-09T20:00:00.000Z',
            validation: { passed: true, commands: [] },
          }),
      } as unknown as TaskExecutor,
    });

    const outcome = await scheduler.run(plan, run.runId, 'SDD');

    expect(outcome.planComplete).toBe(true);
    // No integration branch was created, and no recovery event was written.
    expect(
      (await run.store.readEvents(run.runId)).map((entry) => entry.type),
    ).not.toContain('integration_recovered');
  });
});

/** Kills after `update-ref`, so the marker is published and nothing else ran. */
function killAfterUpdateRef(current: WorktreeRun): Partial<Record<keyof GitWorkspaces, unknown>> {
  return {
    updateRef: async (options: Parameters<GitWorkspaces['updateRef']>[0]) => {
      // Awaited first: the durable effect has to land, or this is a failure rather
      // than a crash.
      await current.repo.workspaces.updateRef(options);
      throw new CrashInjected('the marker ref was published');
    },
  };
}

/** Kills after `merge`, so the merge commit exists and nothing recorded it. */
function killAfterMerge(current: WorktreeRun): Partial<Record<keyof GitWorkspaces, unknown>> {
  return {
    merge: async (options: Parameters<GitWorkspaces['merge']>[0]) => {
      const outcome = await current.repo.workspaces.merge(options);
      if (!outcome.ok || outcome.value.kind !== 'merged') return outcome;
      throw new CrashInjected('the merge landed on the integration branch');
    },
  };
}
