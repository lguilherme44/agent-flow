import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { Scheduler } from '../../src/app/scheduler.js';
import { TaskWorkspaces } from '../../src/app/task-workspaces.js';
import { Integrator } from '../../src/app/integrator.js';
import { WorktreeRecovery } from '../../src/app/worktree-recovery.js';
import { runPaths } from '../../src/app/paths.js';
import { revalidateTask, type RevalidationDeps } from '../../src/app/task-revalidation.js';
import {
  GlobalConfigSchema,
  PlanSchema,
  ProjectConfigSchema,
  type EffectiveConfig,
  type Plan,
} from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';
import { makeWorktreeRun, type WorktreeRun } from '../fixtures/worktree-run.js';

/**
 * The half of D19 the unit tests cannot see: what `agent-flow run` does next.
 *
 * Both READMEs claim a revalidated task is integrated normally, and the use-case tests stop
 * at `state === 'running'` with a marker on disk — which is the *premise* of that claim, not
 * the claim. Between the two sits a real hazard the reviewer read out of the code:
 * `WorktreeRecovery.recoverRun` only considers tasks marked `running`, and the scheduler
 * runs it *before* `recoverInterrupted`. If `recoverDurable` ever declined — no recovery
 * wired, evidence that would not parse, a pruned tree — the very next line demotes the task
 * to `interrupted`, and with the attempt budget spent it stays there.
 *
 * So this drives the whole production graph over a revalidated task: the `Scheduler`, the
 * `TaskWorkspaces` service, the `Integrator` and the `WorktreeRecovery`, against real Git.
 *
 * **The executor throws.** That is the strongest available statement of what the command is
 * for: a revalidated task reaches `completed` without one model call, and if the hand-off
 * ever falls through to a dispatch this test fails loudly instead of quietly paying for it.
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

const TASK = 'TASK-004';

function planOf(): Plan {
  return PlanSchema.parse({
    feature: 'f',
    tasks: [
      {
        id: TASK,
        title: 'Close the gap',
        description: 'Work.',
        complexity: 'normal',
        risk: 'low',
        dependencies: [],
        requirements: ['FR-001'],
        acceptanceCriteria: ['Done.'],
        validation: ['test'],
      },
    ],
  });
}

/** An executor that must never be reached. A revalidated task costs no model call. */
function refusingExecutor(): TaskExecutor {
  return {
    execute: () => {
      throw new Error('the scheduler dispatched an agent for a task a person had revalidated');
    },
  } as unknown as TaskExecutor;
}

/** The production graph, wired exactly as `execution-context.ts` wires it. */
function schedulerFor(current: WorktreeRun): Scheduler {
  const deps = {
    workspaces: current.repo.workspaces,
    fs: current.fs,
    host: current.host,
    projectDir: current.repo.dir,
  };
  const integrator = new Integrator({ ...deps, store: current.store, clock: current.clock });

  return new Scheduler({
    store: current.store,
    executor: refusingExecutor(),
    workspaces: new TaskWorkspaces({
      ...deps,
      processRunner: new NodeProcessRunner(),
      config: { global: {}, project: {} } as unknown as EffectiveConfig,
      clock: current.clock,
    }),
    integrator,
    recovery: new WorktreeRecovery({ ...deps, store: current.store, clock: current.clock, integrator }),
  });
}

function revalidationDeps(current: WorktreeRun, testCommand: string): RevalidationDeps {
  return {
    fs: current.fs,
    clock: current.clock,
    host: current.host,
    store: current.store,
    workspaces: current.repo.workspaces,
    processRunner: new NodeProcessRunner(),
    config: {
      project: ProjectConfigSchema.parse({
        project: { name: 'temp-repo', type: 'node' },
        commands: { test: testCommand },
      }),
      global: { execution: GlobalConfigSchema.shape.execution.parse({}) },
    },
    projectDir: current.repo.dir,
  };
}

/**
 * The namespace as the *first* `run` leaves it, before any attempt exists.
 *
 * Not decoration. §5.3's discriminator is `integrationHead`: a run whose state records none
 * while its namespace already holds refs is "somebody else's wreckage", and the Integrator
 * refuses it with `git_run_key_collision`. In production the integration branch is created
 * before the first worktree is cut, so the order here is the real one — and getting it
 * wrong is how a fixture makes the product look broken.
 */
async function openTheNamespace(current: WorktreeRun): Promise<void> {
  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') {
    throw new Error(`the integration namespace could not be prepared: ${JSON.stringify(prepared)}`);
  }
}

/** Resumes from the persisted states, the way `run-actions.execute` does. */
async function resume(scheduler: Scheduler, plan: Plan, current: WorktreeRun) {
  const state = await current.store.loadRun(current.runId);
  const previous = Object.fromEntries(state.tasks.map((task) => [task.id, task.state]));
  return scheduler.run(plan, current.runId, 'SDD', previous);
}

describe('a revalidated task is integrated by the next run (D19)', () => {
  it('reaches completed through the Integrator, with no agent dispatched', async () => {
    run = await makeWorktreeRun();
    await openTheNamespace(run);
    await run.seed([TASK], 'failed');

    // What the agent left: real work, and a validation that refused it.
    const planted = await run.plant(TASK, 1, {
      write: { 'feature.txt': 'the work the agent did\n' },
      judgement: 'unsatisfied',
      ids: ['test'],
    });

    // The person's fix, made where a person makes one.
    writeFileSync(join(planted.workspacePath, 'fixed.txt'), 'the nine imports, deleted\n');

    const revalidated = await revalidateTask(
      revalidationDeps(run, 'exit 0'),
      run.runId,
      TASK,
      { kind: 'keyboard' },
    );
    expect(revalidated.ok && revalidated.value.passed, 'the revalidation must pass first').toBe(true);

    // The premise, asserted before the hand-off so a green result below cannot come from a
    // task that was never revalidated at all.
    const handedOver = await run.store.loadRun(run.runId);
    expect(handedOver.tasks[0]?.state).toBe('running');
    expect(run.repo.userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`]).trim()).toBe('0');

    const outcome = await resume(schedulerFor(run), planOf(), run);

    expect(outcome.states[TASK]).toBe('completed');
    expect(outcome.planComplete).toBe(true);
    expect(outcome.haltedBy).toBeUndefined();

    const after = await run.store.loadRun(run.runId);
    expect(after.tasks[0]?.state).toBe('completed');
    // Integrated, not merely marked: one merge commit on the integration branch, the run's
    // recorded head moved, and the `result.json` only the Integrator writes.
    expect(run.repo.userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`]).trim()).toBe('1');
    expect(after.integrationHead).toBeTypeOf('string');
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskResult(TASK))).toBe(true);

    // And the human's fix is on the branch, which is the only thing any of this was for.
    expect(
      run.repo.userGit(['cat-file', '-e', `refs/heads/${run.integrationBranch}:fixed.txt`]),
    ).toBe('');
  });

  it('never demotes it to interrupted on the way', async () => {
    // The hazard, named. `recoverDurable` runs before `recoverInterrupted`, and if the
    // first ever declined the second would demote a task whose evidence is perfect —
    // `interrupted → queued` throws the human's tree away and pays for the agent again.
    run = await makeWorktreeRun();
    await openTheNamespace(run);
    await run.seed([TASK], 'failed');
    const planted = await run.plant(TASK, 1, {
      write: { 'feature.txt': 'work\n' },
      judgement: 'unsatisfied',
      ids: ['test'],
    });
    writeFileSync(join(planted.workspacePath, 'fixed.txt'), 'by hand\n');

    await revalidateTask(revalidationDeps(run, 'exit 0'), run.runId, TASK, { kind: 'keyboard' });
    await resume(schedulerFor(run), planOf(), run);

    const events = await run.store.readEvents(run.runId);
    expect(events.some((event) => event.type === 'task_interrupted')).toBe(false);
    // The event recovery writes when it merges durable evidence, which is the path that
    // must have been taken rather than any other that also ends in `completed`.
    expect(events.some((event) => event.type === 'integration_recovered')).toBe(true);
  });
});
