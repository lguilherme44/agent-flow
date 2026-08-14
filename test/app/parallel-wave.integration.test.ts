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
  type RunState,
  type Task,
  type TaskResult,
} from '../../src/contracts/index.js';
import type { TaskExecutor } from '../../src/app/task-executor.js';
import { MAX_ISOLATED_TASK_CONCURRENCY, resolveTaskConcurrency } from '../../src/core/concurrency.js';
import { makeWorktreeRun, type WorktreeRun } from '../fixtures/worktree-run.js';
import { Latch } from '../fixtures/latch.js';

/**
 * M2-11 — two tasks actually executing at once, and every guarantee still holding.
 *
 * The whole milestone is one argument passed to a resolver, and the reason it took
 * eleven items to earn is that nothing about "four agents at once" is safe unless
 * each one owns a worktree, its validated tree is bound to a marker, and the
 * merges happen serially in the plan's order. So this file does not test the
 * argument. It tests what the argument switched on:
 *
 * ```text
 * overlap        two agents inside the executor at the same moment, observed
 * isolation      two worktrees, two branches, one shared wave base
 * order          integration follows the plan, never who finished first
 * authority      completed appears only after the merge (I-3)
 * barrier        a dependent starts only once both dependencies are integrated
 * halting        a wave completes before the run halts (§9.2)
 * ```
 *
 * Real Git throughout, and nothing is timed. Overlap is proven with a latch: a
 * worker announces arrival and blocks, the test waits for the *arrival* and then
 * looks at a counter, and the release order is the test's to choose. A stopwatch
 * would be green on a fast machine with a broken limit.
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

/** `TASK-001` → `task-001.txt`. One file per task, so composition is visible. */
const fileOf = (taskId: string): string => `${taskId.toLowerCase()}.txt`;

interface Observed {
  /** What each task's workspace held when its agent arrived, before it wrote. */
  readonly saw: Record<string, string[]>;
  /** Where each task's agent worked, and on what branch and base. */
  readonly workspace: Record<string, { path: string; branch: string; base: string; attempt: number }>;
  /** What every task's state was at the moment each agent was inside. */
  readonly statesWhileRunning: Record<string, Record<string, string>>;
}

/**
 * An executor that blocks on a latch, then does exactly what `TaskExecutor` does.
 *
 * The agent is the only thing missing: the file is written into the prepared
 * worktree and the §11.2 sequence produces the receipt and the marker for real, so
 * everything downstream — the merge, `completed`, the composed tree — is the
 * production path acting on production evidence.
 *
 * `failing` names the tasks whose agent reports a failure. A failed task still
 * spends its attempt and still leaves its worktree behind (§8.3, §7.4); what it
 * does not leave is a marker, which is what makes §9.2 observable.
 */
function latchedExecutor(
  current: WorktreeRun,
  latch: Latch,
  failing: ReadonlySet<string> = new Set(),
  /**
   * Have every task write the *same* file, with its own contents.
   *
   * §26.4's third case, and it is not a contrived one: two tasks touching the same
   * lines is a plan whose independence analysis was wrong, and the run has to say
   * so rather than guess. Same path, different content, both created from a base
   * that has neither — which is an add/add conflict, the shape a real overlap takes.
   */
  collide = false,
): { executor: TaskExecutor; observed: Observed } {
  const observed: Observed = { saw: {}, workspace: {}, statesWhileRunning: {} };

  const executor = {
    execute: async (
      task: Task,
      runId: string,
      _sdd: string,
      workspace?: TaskWorkspace,
    ): Promise<TaskResult> => {
      if (workspace?.isolation === undefined) throw new Error('expected an isolated workspace');

      observed.workspace[task.id] = {
        path: workspace.path,
        branch: workspace.isolation.branch,
        base: workspace.isolation.base,
        attempt: workspace.attempt,
      };

      // What this agent can see of its siblings' work. Read before the latch, so
      // it describes the tree the workspace was prepared with rather than
      // whatever the test does next.
      observed.saw[task.id] = ['task-001.txt', 'task-002.txt', 'task-003.txt'].filter((name) =>
        existsSync(join(workspace.path, name)),
      );

      // **Held here, inside the executor.** Every task that reaches this line is
      // demonstrably mid-execution until the test releases it, which is what makes
      // the counter a measurement rather than an inference.
      await latch.wait(task.id);

      // Read after the release: what the run believed while this agent was inside.
      // I-3 says nothing may be `completed` before its merge, and a wave's tasks
      // are all still in flight at this point.
      const state = await current.store.loadRun(runId);
      observed.statesWhileRunning[task.id] = Object.fromEntries(
        state.tasks.map((entry) => [entry.id, entry.state]),
      );

      const startedAt = '2026-08-09T19:59:00.000Z';
      const finishedAt = '2026-08-09T20:00:00.000Z';

      if (failing.has(task.id)) {
        // No file, no receipt, no marker: a task whose agent failed produced no
        // validated tree, and inventing one would be the forgery §11 refuses.
        return TaskResultSchema.parse({
          task: task.id,
          status: 'failed',
          runner: 'fake',
          reasoning: 'medium',
          startedAt,
          finishedAt,
          errorCode: 'execution_failed',
          validation: { passed: false, expectation: 'pass', commands: [] },
        });
      }

      const written = collide ? 'shared.txt' : fileOf(task.id);
      writeFileSync(join(workspace.path, written), `${task.id} wrote this line\n`);

      const result = TaskResultSchema.parse({
        task: task.id,
        status: 'completed',
        runner: 'fake',
        reasoning: 'medium',
        startedAt,
        finishedAt,
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
            startedAt,
            finishedAt,
            filesChanged: [written],
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

  return { executor, observed };
}

/**
 * The production scheduler, given the production resolver.
 *
 * `concurrencyFor` is the same shape `buildExecutionContext` wires: the run is
 * handed to `resolveTaskConcurrency` with its own `isolationMode`. A test that
 * passed `maxConcurrency: 2` would agree with a broken wiring, because the defect
 * M2-11 closes is precisely that the number never reached here from the run.
 */
function schedulerFor(current: WorktreeRun, executor: TaskExecutor, maxTasks: number): Scheduler {
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
    concurrencyFor: (state: RunState) =>
      resolveTaskConcurrency(maxTasks, state.isolationMode ?? 'none').effective,
  });
}

/** The merge commits on the integration branch, oldest first. */
function mergesOf(current: WorktreeRun): { oid: string; parents: string[] }[] {
  const ref = `refs/heads/${current.integrationBranch}`;
  const lines = current.repo
    .userGit(['rev-list', '--merges', '--parents', '--reverse', ref])
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);

  return lines.map((line) => {
    const [oid, ...parents] = line.split(' ');
    return { oid: oid as string, parents };
  });
}

// ---------------------------------------------------------------------------

describe('two independent tasks execute at the same time (§4.3, I-11)', () => {
  it('holds both agents inside the executor at once, and integrates in plan order', async () => {
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor } = latchedExecutor(run, latch);

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002')],
    });

    const scheduling = schedulerFor(run, executor, 2).run(plan, run.runId, 'SDD');

    // **The overlap proof.** Awaited on arrival, never on a duration. Nothing has
    // been released, so every worker that arrived is still inside by construction:
    // `current` is a count of workers past the gate and not yet let out.
    //
    // Deliberately not asserted between the two arrivals. Which task reaches the
    // executor first is a race between two `git worktree add` invocations, and it
    // is not a property this milestone claims — the claim is that both are inside
    // at once, which is what these two lines say.
    await latch.until('TASK-001');
    await latch.until('TASK-002');

    expect(latch.current, 'a task left the executor before its sibling arrived').toBe(2);
    expect(latch.peak, 'the two tasks never overlapped').toBeGreaterThanOrEqual(2);

    // **Finish order is deliberately the reverse of plan order.** The whole claim
    // of §14.2 is that integration does not follow completion, and a test where
    // the two orders agree cannot tell the difference.
    latch.release('TASK-002');
    latch.release('TASK-001');

    const outcome = await scheduling;
    expect(outcome.planComplete).toBe(true);

    expect([...latch.arrivals].sort()).toEqual(['TASK-001', 'TASK-002']);
    expect(latch.completions, 'the executor did not finish in the released order').toEqual([
      'TASK-002',
      'TASK-001',
    ]);

    // Integration order, read out of Git rather than out of an array. The first
    // merge on the branch is TASK-001's, whose agent finished second.
    const merges = mergesOf(run);
    expect(merges).toHaveLength(2);

    const markerOf = async (task: string): Promise<string> => {
      const result = await run!.store.readTaskResult(run!.runId, task);
      return result?.integration?.marker ?? '';
    };

    // Exactly two parents each — the integration head before the merge, and the
    // task's own marker. A single-parent commit here would be a fast-forward,
    // which §14.5 forbids because it would leave no record of the merge.
    expect(merges[0]?.parents).toHaveLength(2);
    expect(merges[1]?.parents).toHaveLength(2);
    expect(merges[0]?.parents[1]).toBe(await markerOf('TASK-001'));
    expect(merges[1]?.parents[1]).toBe(await markerOf('TASK-002'));

    // And both files are on the branch, which is the product of the wave.
    const tree = run.repo.userGit(['ls-tree', '-r', '--name-only', run.integrationBranch]);
    expect(tree).toContain('task-001.txt');
    expect(tree).toContain('task-002.txt');
  });

  it('gives each task its own worktree and branch, cut from one shared base', async () => {
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor, observed } = latchedExecutor(run, latch);

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002')],
    });

    const scheduling = schedulerFor(run, executor, 2).run(plan, run.runId, 'SDD');

    await latch.until('TASK-001');
    await latch.until('TASK-002');

    const a = observed.workspace['TASK-001'];
    const b = observed.workspace['TASK-002'];
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    expect(a?.path).not.toBe(b?.path);
    expect(a?.branch).not.toBe(b?.branch);
    // §9.1 step 1: one wave base, read once and given to every task in the wave.
    // Reading it per task would let a sibling's merge move it mid-wave.
    expect(a?.base).toBe(b?.base);
    expect(a?.base).toBe(run.planningBase);
    expect(a?.attempt).toBe(1);
    expect(b?.attempt).toBe(1);

    // Neither agent could see the other's tree when it was prepared.
    expect(observed.saw['TASK-001']).toEqual([]);
    expect(observed.saw['TASK-002']).toEqual([]);

    // And neither can see it *now*, with both of them mid-flight and one of them
    // having written its file. Cross-task visibility is what a shared working tree
    // would give, and it is the thing worktrees exist to deny.
    latch.release('TASK-001');
    await new Promise<void>((settle) => {
      setImmediate(settle);
    });
    const bStillClean = !existsSync(join(b?.path ?? '', 'task-001.txt'));
    expect(bStillClean, "TASK-002's worktree saw TASK-001's edit").toBe(true);

    latch.release('TASK-002');
    await scheduling;

    // Composed only on the integration branch, and only after both merges: A's own
    // worktree still holds A's file and has never seen B's.
    expect(readFileSync(join(a?.path ?? '', 'task-001.txt'), 'utf8')).toContain('TASK-001');
    expect(existsSync(join(a?.path ?? '', 'task-002.txt'))).toBe(false);
  });

  it('never calls a task completed before its work is on the branch (I-3)', async () => {
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor, observed } = latchedExecutor(run, latch);

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002')],
    });

    const scheduling = schedulerFor(run, executor, 2).run(plan, run.runId, 'SDD');

    await latch.until('TASK-001');
    await latch.until('TASK-002');

    // Both agents inside: nothing has been merged and nothing may claim to be
    // completed. This is the read that would catch a scheduler writing the state
    // itself instead of taking it back from the Integrator.
    const midWave = await run.store.loadRun(run.runId);
    expect(midWave.tasks.map((task) => task.state)).toEqual(['running', 'running']);
    // The branch exists — §5.3 initialises it before the first wave — and has not
    // moved. That is a stronger statement than "no head recorded": it says the
    // integration branch was cut and nothing has been merged onto it yet.
    expect(midWave.integrationHead).toBe(run.planningBase);

    latch.release('TASK-002');
    latch.release('TASK-001');
    await scheduling;

    // What each agent saw of the run while it was inside: never a completed
    // sibling, because a sibling's merge happens after the barrier.
    for (const seen of Object.values(observed.statesWhileRunning)) {
      expect(Object.values(seen)).not.toContain('completed');
    }

    const after = await run.store.loadRun(run.runId);
    expect(after.tasks.map((task) => task.state)).toEqual(['completed', 'completed']);
    expect(after.integrationHead).toBe(
      run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim(),
    );
  });

  it('runs four at once and merges four, in the plan\'s order', async () => {
    // §26.4's second case. Four is worth its own scenario rather than trusting
    // that two generalises: it is the first width where the batch is bigger than
    // the number of CPUs a CI runner will admit to, and where a lost `StateStore`
    // update would be likeliest to show.
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor } = latchedExecutor(run, latch);

    const ids = ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'];
    const plan = PlanSchema.parse({ feature: 'f', tasks: ids.map((id) => taskOf(id)) });

    const scheduling = schedulerFor(run, executor, 4).run(plan, run.runId, 'SDD');

    for (const id of ids) await latch.until(id);
    expect(latch.current).toBe(4);
    expect(latch.peak).toBe(4);

    // Released back to front, so completion order is the exact reverse of the plan.
    for (const id of [...ids].reverse()) latch.release(id);

    const outcome = await scheduling;
    expect(outcome.planComplete).toBe(true);
    expect(latch.completions).toEqual([...ids].reverse());

    // Four merges, in the plan's order, whatever the completion order was.
    const merges = mergesOf(run);
    expect(merges).toHaveLength(4);

    const markers = await Promise.all(
      ids.map(async (id) => (await run!.store.readTaskResult(run!.runId, id))?.integration?.marker),
    );
    expect(merges.map((merge) => merge.parents[1])).toEqual(markers);

    // Every attempt's counter survived four concurrent dispatches. A lost update
    // here would make `retry.maxAttempts` count wrong, silently.
    const state = await run.store.loadRun(run.runId);
    expect(state.tasks.map((task) => task.attempts)).toEqual([1, 1, 1, 1]);
    expect(state.tasks.map((task) => task.state)).toEqual(ids.map(() => 'completed'));
  });
});

describe('a dependent waits for every dependency to be integrated (§4.3, I-3)', () => {
  it('runs A and B together, and cuts C from a base that holds both', async () => {
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor, observed } = latchedExecutor(run, latch);

    // A ─┐
    //    ├→ C
    // B ─┘
    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        taskOf('TASK-001'),
        taskOf('TASK-002'),
        taskOf('TASK-003', ['TASK-001', 'TASK-002']),
      ],
    });

    const scheduling = schedulerFor(run, executor, 4).run(plan, run.runId, 'SDD');

    await latch.until('TASK-001');
    await latch.until('TASK-002');

    // Both roots are inside, and the dependent has not been dispatched — even
    // though the resolver would allow a third worker. The barrier is the DAG's,
    // not the limit's.
    expect(latch.current).toBe(2);
    expect([...latch.arrivals].sort()).toEqual(['TASK-001', 'TASK-002']);

    latch.release('TASK-002');
    latch.release('TASK-001');

    // Still not dispatched by the time both agents have returned: the merges have
    // to happen first, and `completed` is what releases a dependent.
    await latch.until('TASK-003');
    const atThirdStart = await run.store.loadRun(run.runId);
    expect(
      atThirdStart.tasks.filter((task) => task.state === 'completed').map((task) => task.id),
    ).toEqual(['TASK-001', 'TASK-002']);

    // And its workspace was cut from a base that already holds both, which is the
    // property no amount of state-checking can substitute for.
    expect(observed.saw['TASK-003']).toEqual(['task-001.txt', 'task-002.txt']);

    latch.release('TASK-003');
    const outcome = await scheduling;

    expect(outcome.planComplete).toBe(true);
    expect(mergesOf(run)).toHaveLength(3);
  });
});

describe('a wave completes before the run halts (§9.2)', () => {
  it('integrates the sibling that succeeded, then stops and blocks the dependent', async () => {
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor } = latchedExecutor(run, latch, new Set(['TASK-002']));

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [
        taskOf('TASK-001'),
        taskOf('TASK-002'),
        taskOf('TASK-003', ['TASK-001', 'TASK-002']),
      ],
    });

    const scheduling = schedulerFor(run, executor, 4).run(plan, run.runId, 'SDD');

    await latch.until('TASK-001');
    await latch.until('TASK-002');
    // The failure is released *first*, so a fail-fast scheduler would have a
    // chance to discard the sibling that was still working.
    latch.release('TASK-002');
    latch.release('TASK-001');

    const outcome = await scheduling;

    // A succeeded and was integrated. Discarding its work because a sibling failed
    // would throw away an agent invocation already paid for, and would make the
    // outcome depend on which task finished first.
    const state = await run.store.loadRun(run.runId);
    const stateOf = (id: string): string =>
      state.tasks.find((task) => task.id === id)?.state ?? 'absent';

    expect(stateOf('TASK-001')).toBe('completed');
    expect(stateOf('TASK-002')).toBe('failed');
    // Blocked, not queued and not attempted: its dependency will never complete.
    expect(stateOf('TASK-003')).toBe('blocked');

    expect(outcome.planComplete).toBe(false);
    expect(outcome.haltedBy).toMatch(/TASK-002/);
    expect(outcome.blocked).toEqual(['TASK-003']);

    // One merge, and it is A's. The failed task produced no marker, so there was
    // nothing of it to merge — which is what makes "no marker, no merge" a shape
    // rather than a rule somebody has to remember.
    const merges = mergesOf(run);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.parents[1]).toBe(
      (await run.store.readTaskResult(run.runId, 'TASK-001'))?.integration?.marker,
    );

    // And the dependent never ran, so no third worker ever reached the latch.
    expect([...latch.arrivals].sort()).toEqual(['TASK-001', 'TASK-002']);
  });
});

describe('two tasks that touched the same lines (§15, §26.4)', () => {
  it('integrates the first, refuses the second, and records the conflicting paths', async () => {
    // Unreachable before M2-11, and that is why it lands here: a conflict is two
    // markers from *one wave*, so at a width of one every merge is against a head
    // the attempt was cut from. Raising the width is what makes an overlapping plan
    // a thing that can actually happen — and the run has to name it rather than
    // resolve it, generate a corrective task, or try another model (§15).
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor } = latchedExecutor(run, latch, new Set(), true);

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002'), taskOf('TASK-003', ['TASK-002'])],
    });

    const scheduling = schedulerFor(run, executor, 2).run(plan, run.runId, 'SDD');

    await latch.until('TASK-001');
    await latch.until('TASK-002');
    expect(latch.current).toBe(2);
    latch.release('TASK-002');
    latch.release('TASK-001');

    const outcome = await scheduling;

    const state = await run.store.loadRun(run.runId);
    const stateOf = (id: string): string =>
      state.tasks.find((task) => task.id === id)?.state ?? 'absent';

    // First in topological order wins the merge. Which agent finished first has
    // nothing to do with it (I-9).
    expect(stateOf('TASK-001')).toBe('completed');
    // Not `failed`: the attempt was valid and the plan was not. A person resolves
    // the overlap and retries against a head that now holds the sibling's work.
    expect(stateOf('TASK-002')).toBe('review_required');
    expect(outcome.haltedBy).toBeDefined();

    // Exactly one merge on the branch, and the aborted one left nothing behind —
    // `merge --abort` returns the integration worktree to its pre-merge state.
    const merges = mergesOf(run);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.parents[1]).toBe(
      (await run.store.readTaskResult(run.runId, 'TASK-001'))?.integration?.marker,
    );
    expect(state.integrationHead).toBe(merges[0]?.oid);

    // §15's record: the paths, the task, the attempt, and the sibling whose merge
    // moved the head — which is usually the actual answer to "why did this
    // conflict". Repository-relative, which is why they may be shown at all.
    const events = await run.store.readEvents(run.runId);
    const conflicts = events.filter((event) => event.type === 'integration_conflict');
    expect(conflicts).toHaveLength(1);

    const detail = conflicts[0]?.detail ?? {};
    expect(detail['task']).toBe('TASK-002');
    expect(detail['attempt']).toBe(1);
    expect(detail['paths']).toEqual(['shared.txt']);
    expect(detail['previouslyIntegrated']).toBe('TASK-001');

    // And the dependent stayed put. `queued`, not `blocked`: `blocked` is what a
    // *failed* dependency produces, and a conflict is not a failure — the attempt
    // was valid and the plan was not. TASK-003 is waiting for a person to resolve
    // the overlap and retry, which is exactly §15's "recovery is human", and it is
    // still runnable once TASK-002 integrates.
    expect(stateOf('TASK-003')).toBe('queued');
    expect(outcome.blocked).toEqual([]);
    expect([...latch.arrivals].sort()).toEqual(['TASK-001', 'TASK-002']);
  });
});

describe('a parallel wave leaves recoverable evidence (M2-07 under M2-11)', () => {
  it('keeps one artifact per attempt, and re-entering merges nothing twice', async () => {
    // M2-07's guarantees have to survive concurrency, and the way they could stop
    // holding is shared evidence: two attempts writing one artifact, or a second
    // entry re-merging what the first already merged. Both would be silent.
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor } = latchedExecutor(run, latch);

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002')],
    });

    const scheduling = schedulerFor(run, executor, 2).run(plan, run.runId, 'SDD');
    await latch.until('TASK-001');
    await latch.until('TASK-002');
    latch.release('TASK-002');
    latch.release('TASK-001');
    await scheduling;

    // One artifact per task per attempt, each naming its own branch and workspace.
    // A shared file would make recovery read one attempt's tree as another's.
    const paths = runPaths(run.repo.dir, run.runId);
    const attempts = await Promise.all(
      ['TASK-001', 'TASK-002'].map(async (id) => {
        const raw = await run!.fs.readFile(paths.taskAttempt(id, 1));
        return JSON.parse(raw) as { task: string; branch: string; workspace: string };
      }),
    );
    expect(attempts.map((attempt) => attempt.task)).toEqual(['TASK-001', 'TASK-002']);
    expect(new Set(attempts.map((attempt) => attempt.branch)).size).toBe(2);
    expect(new Set(attempts.map((attempt) => attempt.workspace)).size).toBe(2);
    // §7.2: the artifact records a workspace-*relative* path and never an absolute
    // one, which is what leaves the read model with nothing to leak.
    for (const attempt of attempts) expect(attempt.workspace.startsWith('/')).toBe(false);

    const headAfterFirst = await run.store.loadRun(run.runId);
    const mergesAfterFirst = mergesOf(run);
    expect(mergesAfterFirst).toHaveLength(2);

    // Re-entered, exactly as a resumed process would: same plan, same run, the
    // states as persisted. Everything is already integrated, so there is nothing to
    // dispatch and nothing to merge.
    const second = await schedulerFor(run, executor, 2).run(
      plan,
      run.runId,
      'SDD',
      Object.fromEntries(headAfterFirst.tasks.map((task) => [task.id, task.state])),
    );

    expect(second.planComplete).toBe(true);
    expect(second.results).toEqual([]);
    // No second latch arrival: no agent was invoked for work that was done.
    expect(latch.arrivals).toHaveLength(2);
    // No duplicate merge, and the head did not move.
    expect(mergesOf(run)).toHaveLength(2);
    expect((await run.store.loadRun(run.runId)).integrationHead).toBe(
      headAfterFirst.integrationHead,
    );
  });
});

describe('the mode comes from the run, and the width comes from the mode (I-13)', () => {
  it('executes one at a time when the run was created sequential', async () => {
    // The safety property, at the level that matters: not "the resolver returns 1"
    // — `test/core/concurrency.test.ts` covers that — but "the scheduler dispatches
    // one" for a run whose recorded mode is `none`, with `maxTasks: 4` asked for.
    run = await makeWorktreeRun();
    const latch = new Latch();
    const { executor } = latchedExecutor(run, latch);

    // The run in this fixture is isolated; overriding the resolver's view of the
    // mode is the honest way to ask "what would a sequential run do here", because
    // nothing may write `isolationMode` after creation (I-13).
    const sequential = new Scheduler({
      store: run.store,
      executor,
      workspaces: new TaskWorkspaces({
        workspaces: run.repo.workspaces,
        fs: run.fs,
        host: run.host,
        projectDir: run.repo.dir,
        processRunner: new NodeProcessRunner(),
        config: { global: {}, project: {} } as unknown as EffectiveConfig,
        clock: run.clock,
      }),
      integrator: run.integrator,
      concurrencyFor: () => resolveTaskConcurrency(4, 'none').effective,
    });

    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [taskOf('TASK-001'), taskOf('TASK-002')],
    });

    const scheduling = sequential.run(plan, run.runId, 'SDD');

    await latch.until('TASK-001');
    expect(latch.current).toBe(1);
    // Nothing else may arrive while the first is held: the wave is one task wide.
    latch.release('TASK-001');

    await latch.until('TASK-002');
    expect(latch.peak, 'a sequential run overlapped two tasks').toBe(1);
    latch.release('TASK-002');

    const outcome = await scheduling;
    expect(outcome.planComplete).toBe(true);
    // Two waves, two merges, in plan order — the sequential behaviour, unchanged.
    expect(mergesOf(run)).toHaveLength(2);
  });

  it('caps an isolated run at the ceiling, and says so', () => {
    // The resolver's own contract, restated here because M2-11 is the milestone
    // that makes it load-bearing: a configuration asking for a thousand does not
    // get a thousand worktrees, and the run records why.
    const decision = resolveTaskConcurrency(999, 'worktree');

    expect(decision.effective).toBe(MAX_ISOLATED_TASK_CONCURRENCY);
    expect(decision.clamped).toBe(true);
    expect(decision.reason).toMatch(/checkout/);
  });
});
