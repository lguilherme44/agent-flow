import { expect, openDashboard, openOverview, openTasks, recordConsole, test } from './support/harness.js';

/**
 * M2-11 — two tasks actually running at once, through the production path.
 *
 * `test/app/parallel-wave.integration.test.ts` proves the scheduler's contract by
 * constructing one. This proves the *wiring*, which is the thing M2-11 changed:
 * a real `agent-flow ui`, the real `start` use case behind a real HTTP request,
 * the real `buildExecutionContext` resolving concurrency from the run it loaded,
 * real worktrees, real merges — and a browser showing the number.
 *
 * The overlap is observed, not timed. Both agents are parked on a file the fake
 * writes when it arrives and blocks until this test writes a release, so
 * "two tasks were inside at once" is something the test held still and looked at.
 *
 * A test that only asserted `2 / 2` at the end would pass on a sequential run.
 */

test.describe('a parallel run, through the server', () => {
  test('runs two independent tasks at once and merges them in order', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld({
      worktrees: true,
      maxTasks: 2,
      independentTasks: true,
      hold: true,
      // Not the default branch, so "HEAD did not move" is a statement about this
      // checkout rather than an artefact of there being nowhere else to be.
      branch: 'my-work',
    });
    const problems = recordConsole(page);

    const planned = (await world.stateOf('booking-api')) as {
      isolationMode?: string;
      gitRunKey?: string;
    };
    expect(planned.isolationMode).toBe('worktree');

    // §31 / I-10: the four fingerprints of the user's checkout, taken before
    // anything executes. Clean, and necessarily so — §6.3 check 9 refuses an
    // isolated run over a dirty tree, which the second test below is about.
    const before = await world.workingTree('booking-api');
    expect(before.branch).toBe('my-work');
    expect(before.status).toBe('');

    await openDashboard(page, world);
    await world.cli('booking-api', ['approve']);

    // The run's own mode decides the width, and the page says so before anything
    // has finished — this is the read model and the scheduler agreeing. On Overview
    // as of M8.5: the isolation strip is facts about *how* the run executes, which is
    // the layer behind the header's summary rather than part of it.
    await openOverview(page);
    await expect(page.getByText('Tasks at once')).toBeVisible();
    await expect(page.getByText('2', { exact: true }).first()).toBeVisible();
    // Nothing was reduced, so nothing is explained away.
    await expect(page.getByText(/parallelism.maxTasks is 2/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Start run' }).click();

    // **The overlap proof, through the production scheduler.** Both agents parked,
    // simultaneously, in two different worktrees.
    await expect
      .poll(async () => world.parked(), { timeout: 120_000 })
      .toEqual(['TASK-001', 'TASK-002']);

    // Both tasks report a live workspace, and neither is completed: the merges
    // happen after the barrier, and `completed` means integrated (I-3).
    const mid = (await world.stateOf('booking-api')) as {
      tasks: Array<{ id: string; state: string; attempts: number }>;
    };
    expect(mid.tasks.map((task) => task.state)).toEqual(['running', 'running']);
    expect(mid.tasks.map((task) => task.attempts)).toEqual([1, 1]);

    // `in worktree` is a cell of the task table, which is the Tasks tab now.
    await openTasks(page);
    await expect(page.getByText('in worktree')).toHaveCount(2);

    // Two worktrees, two attempt branches, one shared wave base — read out of Git
    // rather than out of a response.
    const worktrees = await world.git('booking-api', ['worktree', 'list', '--porcelain']);
    const attempts = [...worktrees.matchAll(/^branch refs\/heads\/(agent-flow\/\S+)$/gm)].map(
      (match) => match[1] as string,
    );
    const perTask = attempts.filter((branch) => /\/TASK-00[12]\/attempt-1$/.test(branch));
    expect(perTask, 'expected one attempt branch per task').toHaveLength(2);
    expect(new Set(perTask).size).toBe(2);

    const base = `agent-flow/${planned.gitRunKey ?? ''}/integration`;
    for (const branch of perTask) {
      // Every attempt was cut from the wave base and nothing else: the merge-base
      // of the attempt and the integration branch is the integration branch's tip
      // as it stood when the wave opened, which is still its tip because nothing
      // has been merged.
      expect(
        await world.git('booking-api', ['merge-base', branch, base]),
        `${branch} was not cut from the wave base`,
      ).toBe(await world.git('booking-api', ['rev-parse', base]));
    }

    await world.release();

    await expect(page.getByText('2/2 tasks')).toBeVisible({ timeout: 180_000 });

    const after = (await world.stateOf('booking-api')) as {
      integrationHead?: string;
      tasks: Array<{ id: string; state: string }>;
      degradations: Array<{ kind: string }>;
    };
    expect(after.tasks.map((task) => task.state)).toEqual(['completed', 'completed']);
    // Nothing was clamped, so nothing was recorded as lost.
    expect(after.degradations.map((entry) => entry.kind)).not.toContain('parallelism_clamped');

    // Serial, deterministic integration: two merge commits, in the plan's order,
    // each with the integration head and one marker as its parents.
    const merges = (
      await world.git('booking-api', ['rev-list', '--merges', '--parents', '--reverse', base])
    )
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split(' '));
    expect(merges).toHaveLength(2);
    for (const merge of merges) expect(merge).toHaveLength(3);

    expect(await world.git('booking-api', ['rev-parse', base])).toBe(after.integrationHead);

    // Both tasks' work composed onto one branch.
    const tree = await world.git('booking-api', ['ls-tree', '-r', '--name-only', base]);
    expect(tree).toContain('src/task-001.txt');
    expect(tree).toContain('src/task-002.txt');

    // §31 / I-10: four fingerprints, all identical. Not a visual `git status` — the
    // commit, the branch, the untracked files and the index each carry a promise the
    // others do not, and only the four together say "nothing was written here".
    expect(await world.workingTree('booking-api')).toEqual(before);
    // The work exists, and it exists somewhere else. `my-work` never saw either file.
    expect(
      await world.git('booking-api', ['ls-tree', '-r', '--name-only', 'my-work']),
    ).not.toContain('src/task-001.txt');

    expect(problems).toEqual([]);
  });

  test('refuses an isolated run over a dirty tree rather than sharing it', async ({
    makeWorld,
  }) => {
    // §6.3 checks 9 and 10, and the reason M2-11 cannot make the tree unsafe: an
    // unmet precondition is a **refusal**, not a downgrade. There is no path from
    // "the worktrees are not usable" to "let us run two agents in the user's
    // checkout" — which is the one substitution that would undo the milestone.
    //
    // This is also §31's literal case: a tracked modification, a staged
    // modification and an untracked file, with the four fingerprints identical
    // afterwards. Nothing executed, so nothing could have touched them.
    const world = await makeWorld({
      worktrees: true,
      maxTasks: 2,
      independentTasks: true,
      branch: 'my-work',
    });

    await world.cli('booking-api', ['approve']);

    await world.writeFile('booking-api', 'package.json', '{ "name": "edited" }\n');
    await world.writeFile('booking-api', 'staged.txt', 'staged\n');
    await world.git('booking-api', ['add', 'staged.txt']);
    await world.writeFile('booking-api', 'untracked.txt', 'untracked\n');

    const before = await world.workingTree('booking-api');
    expect(before.status).not.toBe('');

    const refused = await world.cli('booking-api', ['run']);

    expect(refused.code, 'a dirty tree was allowed to execute').not.toBe(0);

    // Asserted on the sentence rather than on the refusal code, because the
    // sentence is what the user gets: it names the run, names the files, and says
    // what to do. A code on its own would be a message that requires the reader to
    // go and look the code up.
    const said = `${refused.stdout}${refused.stderr}`;
    expect(said).toMatch(/isolated run and this repository is not ready/);
    expect(said).toMatch(/package\.json/);
    expect(said).toMatch(/staged\.txt/);
    expect(said).toMatch(/untracked\.txt/);
    expect(said).toMatch(/Commit or stash/);
    // And it never offers the unsafe alternative.
    expect(said).not.toMatch(/sequential|one at a time|fall(ing)? back/i);

    // No agent was invoked, so no quota and no worktree was spent on a run that
    // could not have been trusted.
    const calls = await world.runnerCalls();
    expect(calls.filter((call) => call.role === 'IMPLEMENTATION_AGENT')).toHaveLength(0);

    // And every task is still where it was: a refusal consumes nothing (§6.4).
    const state = (await world.stateOf('booking-api')) as {
      isolationMode?: string;
      tasks: Array<{ state: string; attempts: number }>;
    };
    expect(state.isolationMode, 'the refusal changed the mode').toBe('worktree');
    // Not `[0, 0]`: the scheduler is what puts tasks on the run, and it never ran.
    // So the honest assertion is that no attempt was spent by anything.
    expect(state.tasks.filter((task) => task.attempts > 0)).toEqual([]);

    expect(await world.workingTree('booking-api')).toEqual(before);
  });

  test('shows the conflict, its paths and the sibling that caused it', async ({
    page,
    makeWorld,
  }) => {
    // The half of §28's M2-10 E2E that M2-10 could not reach: a conflict is two
    // markers from one wave, so it needs a width above one to exist at all. The
    // read model and the rendering shipped in M2-10; this is the first commit in
    // which the product can actually produce one, so this is where it is asserted
    // end to end.
    const world = await makeWorld({
      worktrees: true,
      maxTasks: 2,
      independentTasks: true,
      collidingTasks: true,
    });

    await world.cli('booking-api', ['approve']);
    const halted = await world.cli('booking-api', ['run']);
    expect(halted.code, 'an overlapping plan was allowed to finish').not.toBe(0);

    await openDashboard(page, world);

    // M8: the fact at the top of the queue, with the one action beside it — and this is
    // the *always-visible* copy, on the strip that replaced the queue panel on a run
    // screen. A P0 is the lead item, so it is on screen without opening anything.
    const queue = page.getByRole('region', { name: /needs? attention/i });
    await expect(queue.getByText('TASK-002 could not be merged')).toBeVisible();
    await expect(queue.getByText('P0')).toBeVisible();

    // §15: one task integrated, the other is for a person to look at. Not `failed`
    // — the attempt was valid and the plan was not.
    await openTasks(page);
    await expect(page.getByText('REVIEW REQUIRED')).toBeVisible();

    // The conflict's own detail, on Overview with the rest of the isolation facts.
    await openOverview(page);
    await expect(
      page.getByText('TASK-002 attempt 1 conflicted with the integration branch'),
    ).toBeVisible();
    // Repository-relative, which is exactly why it may be shown (§21.3).
    //
    // **Exact, because M8 made it true twice.** The isolation strip has said this since
    // M2-10; the attention queue now says it as well, at P0, because a conflict is the
    // class of thing where acting on the wrong guess loses somebody's work. Two elements
    // is the feature rather than a duplicate, so the assertion names which one it is —
    // and the queue's own copy is asserted below rather than left to a loose match.
    await expect(page.getByText('src/shared.txt', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/TASK-001 integrated first and moved the head/).first(),
    ).toBeVisible();

    // One merge on the branch, and the user's tree still holds nothing.
    const state = (await world.stateOf('booking-api')) as { gitRunKey?: string };
    const base = `agent-flow/${state.gitRunKey ?? ''}/integration`;
    expect(
      (await world.git('booking-api', ['rev-list', '--count', '--merges', base])).trim(),
    ).toBe('1');

    // And nothing rendered is a filesystem path, conflict paths included.
    const rendered = await page.locator('body').innerText();
    expect(rendered).not.toContain(world.root);
  });

  test('a sequential run still executes one at a time, whatever maxTasks says', async ({
    page,
    makeWorld,
  }) => {
    // I-13 through the production path. `maxTasks: 2`, two genuinely independent
    // tasks, no worktrees — so the run was created sequential and shares the user's
    // working tree. Two agents in there at once is the original defect, and this is
    // the scenario that would catch it arriving by the new route.
    const world = await makeWorld({ maxTasks: 2, independentTasks: true, hold: true });

    expect((await world.stateOf('booking-api'))['isolationMode']).toBe('none');

    await openDashboard(page, world);
    await world.cli('booking-api', ['approve']);
    await page.getByRole('button', { name: 'Start run' }).click();

    // One agent parked. The second cannot arrive until this one is released,
    // because the wave is one task wide.
    await expect.poll(async () => world.parked(), { timeout: 120_000 }).toEqual(['TASK-001']);

    // The page says one of two, and says why — this is the row that answers "why is
    // this still running one task at a time". On Overview with the rest of §21.2.
    await openOverview(page);
    await expect(page.getByText('1 of 2')).toBeVisible();
    // **Two copies, and both are meant.** The attention strip carries the sentence as the
    // headline it is always showing; the degradation list on Overview carries it as the
    // detail behind that headline, beside the impact and the pipeline. M8 had the same pair
    // and had to suppress one, because the queue and a header banner stacked 185px above a
    // board that had 75px left; that geometry is gone — the strip is one line and the
    // detail is on a surface you have to ask for. So this names which one it means rather
    // than matching loosely, and the strip's own copy is asserted in the conflict test.
    // The detail is a list item carrying the reason *and* its impact; the strip's copy is
    // a line inside a link. `li` names the one this test is about without depending on
    // which of the two the DOM happens to emit first.
    await expect(
      page.locator('li').filter({ hasText: /task workspace isolation does not/ }),
    ).toBeVisible();

    // Held long enough for a broken limit to dispatch the sibling. Not a proof on
    // its own — the assertion that matters is the state read below — but a second
    // agent arriving here would change `parked()` and fail the poll.
    await expect.poll(async () => world.parked(), { timeout: 5_000 }).toEqual(['TASK-001']);

    const mid = (await world.stateOf('booking-api')) as {
      tasks: Array<{ id: string; state: string }>;
    };
    expect(mid.tasks.filter((task) => task.state === 'running')).toHaveLength(1);

    await world.release();
    await expect(page.getByText('2/2 tasks')).toBeVisible({ timeout: 180_000 });

    // And the reduction is on the run's record, where it outlives the terminal.
    const after = (await world.stateOf('booking-api')) as {
      degradations: Array<{ kind: string; impact: string }>;
    };
    const clamp = after.degradations.find((entry) => entry.kind === 'parallelism_clamped');
    expect(clamp).toBeDefined();
    expect(clamp?.impact).toMatch(/1 task at a time/);
  });
});
