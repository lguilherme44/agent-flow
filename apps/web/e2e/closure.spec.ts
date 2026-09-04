import type { ChildProcess } from 'node:child_process';
import { expect, openDashboard, openOverview, openTasks, recordConsole, test } from './support/harness.js';
import type { World } from './support/world';

/**
 * M2-12 — the milestone as one system, rather than as the modules it is made of.
 *
 * Every other suite here proves a part: `parallel.spec.ts` proves width and a
 * conflict, `isolated.spec.ts` proves the read model, the integration tests prove
 * each of §17's crash windows against real Git. What none of them can prove is the
 * composition — that a *graph* runs across two waves, that the second wave's agents
 * are handed the first wave's integrated result, that a coordinator dying between
 * the two neither repeats nor loses what was already merged, and that the review at
 * the end reads the composed product instead of the checkout the user is sitting in.
 *
 * The graph is the one §28's M2-12 asks for and the one a person would draw:
 *
 * ```text
 * TASK-001 ─┐
 *           ├──> TASK-003
 * TASK-002 ─┘
 *
 * TASK-004
 * ```
 *
 * Three ready at once, one that must wait. Three and not two, because a width of
 * two cannot tell "as many as the plan allows" from "two".
 *
 * **Nothing here is timed.** Overlap is held still with the fake's park-and-release
 * latch and observed; the crash is a `SIGKILL` at a point the test put the run in.
 * A `sleep` anywhere below would make this a test of how fast this machine is.
 */

/** The run's integration branch, from the key the run was born with. */
async function integrationBranch(world: World): Promise<string> {
  const state = (await world.stateOf('booking-api')) as { gitRunKey?: string };
  return `agent-flow/${state.gitRunKey ?? ''}/integration`;
}

/** The merge commits on a branch, oldest first, each as `[merge, first, second]`. */
async function merges(world: World, branch: string): Promise<string[][]> {
  const listed = await world.git('booking-api', [
    'rev-list',
    '--merges',
    '--parents',
    '--reverse',
    branch,
  ]);
  return listed
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(' '));
}

interface TaskView {
  readonly id: string;
  readonly state: string;
  readonly attempts: number;
  /** Absent until a person has asked for this task to run again. */
  readonly attemptsBeforeHumanRetry?: number;
}

async function tasksOf(world: World): Promise<TaskView[]> {
  const state = (await world.stateOf('booking-api')) as { tasks: TaskView[] };
  return state.tasks;
}

test.describe('MVP 2, end to end', () => {
  test('runs a two-wave graph in parallel, integrates it serially, and reviews the result', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld({
      worktrees: true,
      maxTasks: 4,
      wavePlan: true,
      hold: true,
      branch: 'my-work',
    });
    const problems = recordConsole(page);

    const planned = (await world.stateOf('booking-api')) as {
      isolationMode?: string;
      planningBase?: string;
    };
    expect(planned.isolationMode).toBe('worktree');

    const before = await world.workingTree('booking-api');
    expect(before.branch).toBe('my-work');
    expect(before.status).toBe('');

    await openDashboard(page, world);
    await world.cli('booking-api', ['approve']);

    // Requested 4, and the graph offers 3 — so the *effective* width is what the
    // wave has, and the page says the run was not reduced. On Overview as of M8.5.
    await openOverview(page);
    await expect(page.getByText('Tasks at once')).toBeVisible();
    await expect(page.getByText(/parallelism.maxTasks is 4/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Start run' }).click();

    // ---- wave 1: three agents inside three different worktrees, at once -----
    await expect
      .poll(async () => world.parked(), { timeout: 120_000 })
      .toEqual(['TASK-001', 'TASK-002', 'TASK-004']);

    // TASK-003 is not among them, and that is the barrier rather than a coincidence
    // of scheduling: it has two dependencies and neither has been integrated.
    const mid = await tasksOf(world);
    expect(mid.find((task) => task.id === 'TASK-003')?.state).toBe('queued');
    expect(mid.filter((task) => task.state === 'running').map((task) => task.id)).toEqual([
      'TASK-001',
      'TASK-002',
      'TASK-004',
    ]);
    // `in worktree` is a cell of the task table, which is the Tasks tab now.
    await openTasks(page);
    await expect(page.getByText('in worktree')).toHaveCount(3);

    const branch = await integrationBranch(world);
    const waveBase = await world.git('booking-api', ['rev-parse', branch]);

    // Three worktrees, three branches, one shared base — read out of Git.
    const listed = await world.git('booking-api', ['worktree', 'list', '--porcelain']);
    const attemptBranches = [...listed.matchAll(/^branch refs\/heads\/(agent-flow\/\S+)$/gm)]
      .map((match) => match[1] as string)
      .filter((ref) => /\/attempt-1$/.test(ref));
    expect(attemptBranches).toHaveLength(3);
    expect(new Set(attemptBranches).size).toBe(3);
    for (const ref of attemptBranches) {
      expect(
        await world.git('booking-api', ['merge-base', ref, branch]),
        `${ref} was not cut from the wave base`,
      ).toBe(waveBase);
    }

    // The wave base is the planning base, because nothing has merged yet.
    expect(waveBase).toBe(planned.planningBase);

    await world.release();

    // ---- the whole graph finishes ------------------------------------------
    await expect(page.getByText('4/4 tasks')).toBeVisible({ timeout: 240_000 });

    const after = (await world.stateOf('booking-api')) as {
      integrationHead?: string;
      tasks: TaskView[];
      degradations: Array<{ kind: string }>;
    };
    expect(after.tasks.map((task) => task.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(after.tasks.map((task) => task.attempts)).toEqual([1, 1, 1, 1]);
    expect(after.degradations.map((entry) => entry.kind)).not.toContain('parallelism_clamped');

    // ---- integration: serial, topological, one merge per task --------------
    const merged = await merges(world, branch);
    expect(merged, 'one merge commit per task, and no more').toHaveLength(4);
    for (const merge of merged) expect(merge, '--no-ff was not used').toHaveLength(3);

    // The dependent task is integrated last. Finish order did not decide this —
    // TASK-004 has no edges and could have finished first or last — the graph did.
    const markers = merged.map((merge) => merge[2] as string);
    const subjectOf = async (oid: string): Promise<string> =>
      world.git('booking-api', ['log', '-1', '--format=%s', oid]);
    expect(await subjectOf(markers[3] as string)).toMatch(/TASK-003/);

    // Wave 2's base contained wave 1's work: the first three merges are ancestors
    // of the fourth marker's parent, which is where TASK-003's attempt was cut.
    const dependentBase = await world.git('booking-api', ['rev-parse', `${markers[3] ?? ''}^`]);
    for (const marker of markers.slice(0, 3)) {
      expect(
        await world.git('booking-api', ['merge-base', '--is-ancestor', marker, dependentBase]).then(
          () => true,
          () => false,
        ),
        'wave 2 was cut from a base that does not contain wave 1',
      ).toBe(true);
    }

    expect(await world.git('booking-api', ['rev-parse', branch])).toBe(after.integrationHead);

    // ---- the composed product ----------------------------------------------
    const tree = await world.git('booking-api', ['ls-tree', '-r', '--name-only', branch]);
    for (const path of [
      'src/task-001.txt',
      'src/task-002.txt',
      'src/task-004.txt',
      'src/composed.txt',
    ]) {
      expect(tree, `${path} is not on the integration branch`).toContain(path);
    }

    // TASK-003 read its dependencies rather than being told they existed. The file
    // it wrote is derived from theirs, so this line could not have been produced by
    // an agent handed a checkout of the planning base.
    expect(await world.git('booking-api', ['show', `${branch}:src/composed.txt`])).toBe(
      'TASK-001 wrote this line + TASK-002 wrote this line',
    );

    // ---- §19.2: the review read the integration tree ------------------------
    // A separate command, and deliberately so: verification and review judge the
    // *composed* product, which does not exist until the last task is integrated.
    const reviewed = await world.cli('booking-api', ['review']);
    expect(reviewed.code, `review failed: ${reviewed.stderr}`).toBe(0);

    const calls = await world.runnerCalls();
    const reviewers = calls.filter(
      (call) => call.role === 'FINAL_REVIEW_AGENT' || call.role === 'VERIFICATION_AGENT',
    );
    expect(reviewers.length, 'no final verification or review ran').toBeGreaterThan(0);
    for (const call of reviewers) {
      // The composed product, in front of the reviewer. The user's checkout has
      // none of these files, so this is not a listing either tree could produce.
      expect(call.sees, `${call.role} did not read the integration tree`).toEqual([
        'composed.txt',
        'task-001.txt',
        'task-002.txt',
        'task-004.txt',
      ]);
    }

    // ---- I-10: the user's checkout, byte for byte ---------------------------
    expect(await world.workingTree('booking-api')).toEqual(before);
    expect(
      await world.git('booking-api', ['ls-tree', '-r', '--name-only', 'my-work']),
    ).not.toContain('src/composed.txt');

    expect(problems).toEqual([]);
  });

  test('survives the coordinator being killed mid-graph without repeating or losing work', async ({
    makeWorld,
  }) => {
    // §17 through the production path, at the point that matters most: some tasks
    // are `completed` and on the integration branch, one attempt is in flight. A
    // recovery that treats those two the same is a recovery that either re-runs a
    // paid agent or merges a marker twice, and both are silent.
    const world = await makeWorld({
      worktrees: true,
      maxTasks: 4,
      wavePlan: true,
      hold: true,
      // Only the dependent task parks. Wave 1 runs to completion and integrates,
      // so the kill below lands *after* three merges rather than before any.
      holdTask: 'TASK-003',
      branch: 'my-work',
    });

    const before = await world.workingTree('booking-api');
    await world.cli('booking-api', ['approve']);

    const coordinator: ChildProcess = world.spawnCli('booking-api', ['run']);

    // Deterministic: the agent for TASK-003 says on disk that it is inside. It can
    // only be there once wave 1 has been integrated, because that is what released
    // it — so this single fact pins the whole state the crash happens in.
    await expect.poll(async () => world.parked(), { timeout: 240_000 }).toEqual(['TASK-003']);

    const branch = await integrationBranch(world);
    const beforeCrash = await tasksOf(world);
    expect(
      beforeCrash.filter((task) => task.state === 'completed').map((task) => task.id),
      'wave 1 had not integrated when the crash was staged',
    ).toEqual(['TASK-001', 'TASK-002', 'TASK-004']);
    expect(await merges(world, branch)).toHaveLength(3);
    const headBeforeCrash = await world.git('booking-api', ['rev-parse', branch]);

    // A real crash. No handler runs, nothing is flushed.
    await world.kill(coordinator);

    // Killing the coordinator did not move the branch: everything merged is still
    // merged, and nothing half-merged was left behind.
    expect(await world.git('booking-api', ['rev-parse', branch])).toBe(headBeforeCrash);

    const implBeforeRestart = (await world.runnerCalls()).filter(
      (call) => call.role === 'IMPLEMENTATION_AGENT',
    ).length;

    // Let the next attempt through, and restart. Recovery runs at the start of
    // `start`, under the execution lock (§17.2).
    await world.release();
    const resumed = await world.cli('booking-api', ['run']);
    expect(resumed.code, `the resumed run failed: ${resumed.stderr}`).toBe(0);

    const after = await tasksOf(world);
    expect(after.map((task) => task.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);

    // **No agent rerun for work that was already integrated.** The three completed
    // tasks kept attempt 1 and were not invoked again; only TASK-003 was.
    expect(
      after.filter((task) => task.id !== 'TASK-003').map((task) => task.attempts),
      'a completed task was executed again after recovery',
    ).toEqual([1, 1, 1]);

    const implAfter = (await world.runnerCalls()).filter(
      (call) => call.role === 'IMPLEMENTATION_AGENT',
    );
    const rerun = implAfter.slice(implBeforeRestart);
    expect(
      new Set(
        rerun
          .map((call) => /TASK-\d+/.exec(call.argv.join(' '))?.[0])
          .filter((id): id is string => id !== undefined),
      ),
      'recovery invoked an agent for a task that was already integrated',
    ).not.toContain('TASK-001');

    // **No duplicate merge.** Four tasks, four merge commits, and the three from
    // before the crash are the same commits they were.
    const finalMerges = await merges(world, branch);
    expect(finalMerges, 'recovery merged something twice').toHaveLength(4);
    expect(finalMerges.slice(0, 3).map((merge) => merge[0])).toEqual(
      (await merges(world, headBeforeCrash)).map((merge) => merge[0]),
    );

    // And the product is complete, so the run did not merely stop being broken.
    const tree = await world.git('booking-api', ['ls-tree', '-r', '--name-only', branch]);
    expect(tree).toContain('src/composed.txt');

    expect(await world.workingTree('booking-api')).toEqual(before);
  });

  test('retries on a fresh worktree and keeps what the failed attempt left', async ({
    makeWorld,
  }) => {
    // §16. A retry is a *new attempt*, not a resumed one: new branch, new worktree,
    // new evidence, cut from the integration head as it stands now. The previous
    // attempt's evidence survives, because it is the only record of what happened.
    const world = await makeWorld({
      worktrees: true,
      maxTasks: 2,
      independentTasks: true,
      branch: 'my-work',
      // Validation, gated on an environment variable the test controls. **Not
      // `AF_FAKE_IMPL: 'failed'`**, which kills the agent's process: an attempt
      // whose agent never returned produced nothing to validate and leaves no
      // artifact by design (§17.3 windows 1 and 2), so it is the wrong failure to
      // ask "was the evidence retained" about. This one fails *after* the agent
      // worked, which is the attempt that has evidence worth keeping.
      // Written without a `: ` anywhere, because this string is interpolated into
      // the project's YAML as a plain scalar and a colon-space would start a
      // nested mapping.
      testCommand: 'node -e "process.exit(process.env.AF_GATE===undefined?1:0)"',
    });

    await world.cli('booking-api', ['approve']);

    // The first `run` spends the whole unattended budget, not one attempt. `recovery`
    // ships enabled and `retry.maxAttempts` is 2, so validation refuses attempt 1, the
    // repair loop opens attempt 2 on its own, validation refuses that too, and the run
    // stops and asks. Two attempts, two worktrees, two artifacts — before a person has
    // touched anything.
    const failed = await world.cli('booking-api', ['run']);
    expect(failed.code, 'a failed validation was reported as success').not.toBe(0);

    const stalled = await tasksOf(world);
    expect(stalled.every((task) => task.state !== 'completed')).toBe(true);

    const runId = await world.runIdOf('booking-api');
    const attemptOne = `.agent-flow/runs/${runId}/tasks/TASK-001/attempt-1.json`;
    const evidenceBefore = await world.readProjectFile('booking-api', attemptOne);
    expect(evidenceBefore, 'attempt 1 left no evidence').not.toBe('');

    const refsBefore = await world.git('booking-api', [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/agent-flow',
    ]);

    // Retry, and this time validation is satisfied.
    //
    // The retry must not be refused, and that is half of what this asserts. The budget
    // the repair loop just spent bounds *unattended* work; this line is somebody asking,
    // so it is not what the budget is about. Before that distinction existed, this call
    // answered `attempts_exhausted` and offered `--force` — the run escalated naming
    // `retry` as its one human action and then refused it.
    const retried = await world.cli('booking-api', ['retry', 'TASK-001']);
    expect(retried.code, `retry refused: ${retried.stderr}`).toBe(0);
    const second = await world.cli('booking-api', ['run'], { AF_GATE: '1' });

    const afterRetry = await tasksOf(world);
    const task = afterRetry.find((entry) => entry.id === 'TASK-001');
    // Three: two the machine spent on its own, and one a person asked for. The lifetime
    // count never resets — it is the evidence — so what a retry restarts is the streak.
    expect(task?.attempts, 'the retry did not open a new attempt').toBe(3);
    expect(task?.attemptsBeforeHumanRetry, 'the streak did not restart').toBe(2);

    // A *fresh* branch, not a reused one — and attempt 1's ref is still there.
    const refsAfter = await world.git('booking-api', [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/agent-flow',
    ]);
    expect(refsAfter).toContain('/TASK-001/attempt-3');
    expect(refsBefore, 'attempt 1 had no ref to keep').toContain('/TASK-001/attempt-1');
    for (const attempt of ['attempt-1', 'attempt-2']) {
      expect(refsAfter, `the retry deleted ${attempt}'s ref`).toContain(`/TASK-001/${attempt}`);
    }

    // A *fresh* worktree: two distinct paths for the two attempts, and they differ
    // in the attempt segment rather than by having been reused.
    const listed = await world.git('booking-api', ['worktree', 'list', '--porcelain']);
    expect(listed).toMatch(/TASK-001[\\/]attempt-3/);

    // And attempt 1's evidence is byte-identical to what it was: retention, not
    // rewriting (§20.3). This is the file a person reads to find out why it failed.
    expect(await world.readProjectFile('booking-api', attemptOne)).toBe(evidenceBefore);

    // Attempt 2 wrote its own evidence beside it rather than over it.
    expect(
      await world.readProjectFile(
        'booking-api',
        `.agent-flow/runs/${runId}/tasks/TASK-001/attempt-2.json`,
      ),
    ).not.toBe('');

    expect(second.stdout + second.stderr).not.toMatch(/attempt_evidence_missing/);
  });

  test('cleans up what it owns and leaves everything else alone', async ({ makeWorld }) => {
    // §20. `clean` runs long after the run, usually with nobody watching, and R-12
    // is the case where it takes the product with it. The foreign worktree and the
    // foreign branch below are the control: they are in the same repository and
    // belong to somebody else.
    const world = await makeWorld({
      worktrees: true,
      maxTasks: 2,
      independentTasks: true,
      branch: 'my-work',
    });

    await world.cli('booking-api', ['approve']);
    const ran = await world.cli('booking-api', ['run']);
    expect(ran.code, `the run failed: ${ran.stderr}`).toBe(0);

    const branch = await integrationBranch(world);
    const head = await world.git('booking-api', ['rev-parse', branch]);

    // Somebody else's branch, in this repository, under a name of their own.
    await world.git('booking-api', ['branch', 'someone-elses-work', 'my-work']);

    const before = await world.workingTree('booking-api');

    // `--keep 0 --force` because this world has exactly one run and it is the
    // active one: the shipped defaults keep the five most recent and never touch
    // the current run, so a bare `clean` here would correctly do nothing at all.
    const cleaned = await world.cli('booking-api', ['clean', '--keep', '0', '--force']);
    expect(cleaned.code, `clean failed: ${cleaned.stderr}`).toBe(0);

    // Owned worktrees are gone: no `agent-flow/` branch is checked out anywhere.
    const listed = await world.git('booking-api', ['worktree', 'list', '--porcelain']);
    expect(listed).not.toMatch(/branch refs\/heads\/agent-flow\/\S+\/attempt-/);

    // The integration branch is the product, and it is merged nowhere, so it is
    // kept and said so (§20.4). Deleting it is what R-12 is about.
    expect(await world.git('booking-api', ['rev-parse', branch])).toBe(head);
    expect(cleaned.stdout + cleaned.stderr).toMatch(/agent-flow\/\S+\/integration/);

    // Nothing foreign was touched.
    expect(
      await world.git('booking-api', ['rev-parse', 'someone-elses-work']),
    ).toBe(await world.git('booking-api', ['rev-parse', 'my-work']));

    // Idempotent: a second clean finds nothing left to do and says so calmly.
    const again = await world.cli('booking-api', ['clean', '--keep', '0', '--force']);
    expect(again.code, `the second clean failed: ${again.stderr}`).toBe(0);
    expect(await world.git('booking-api', ['rev-parse', branch])).toBe(head);

    expect(await world.workingTree('booking-api')).toEqual(before);
  });
});
