import { expect, openDashboard, recordConsole, recordRequests, test } from './support/harness';

/**
 * M2-10 — what a run in worktree mode looks like from a browser.
 *
 * The chain under test is the whole one: a real Git repository, a real
 * `createRun` that captures `isolationMode` because the repository satisfied
 * §6.3, a real scheduler that prepares worktrees and mints markers, a real
 * Integrator that merges them, a real `StateStore` those all write to, the real
 * read model projecting it, real Fastify serving it, and React rendering the
 * answer. Nothing here is seeded into `state.json` and nothing is mounted with
 * hand-written props — the point of the milestone is that the *product's* facts
 * reach the screen, and a fixture would agree with a broken read model.
 *
 * Two things this file deliberately does not attempt.
 *
 * An **integration conflict** is unreachable here, and that is a property of the
 * milestone rather than of the test: a conflict is two markers from *one wave*
 * (§15), and until M2-11 a wave holds one task, so every merge is against a head
 * this attempt was cut from. It is covered where it is reachable — in the
 * concurrency suite against real Git, and in the Web unit tests for the
 * rendering.
 *
 * A durable **awaiting-integration** likewise needs the coordinator to die
 * between the marker and the merge (§17.3 window 5), which is M2-07's fault
 * injection and lives in-process. What *is* observable from a browser is its live
 * twin — a task holding an isolated workspace right now — and the second test
 * below parks a real agent inside one to see it.
 */

test.describe('an isolated run, from the browser', () => {
  test('reports the branch, the head and how much of the plan is merged', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld({ worktrees: true });
    const problems = recordConsole(page);
    const requests = recordRequests(page);

    // The premise, checked rather than assumed. A run that fell back to
    // sequential would still render a dashboard, and every assertion below would
    // pass for the wrong reason.
    const planned = (await world.stateOf('booking-api')) as {
      isolationMode?: string;
      gitRunKey?: string;
      planningBase?: string;
    };
    expect(planned.isolationMode, 'the run was not born isolated').toBe('worktree');
    expect(planned.gitRunKey).toMatch(/^AF-\d{4}-\d{3}-[0-9a-f]+$/);

    // I-10, fingerprinted before anything executes. `git status` by eye is not
    // enough: HEAD, the branch, the untracked files and the index are four
    // separate promises.
    const before = await world.workingTree('booking-api');

    await openDashboard(page, world);
    await world.cli('booking-api', ['approve']);

    const start = page.getByRole('button', { name: 'Start run' });
    await expect(start).toBeVisible();
    await start.click();

    // In worktree mode `completed` means integrated (I-3), so this number moving
    // to 2/2 is already the statement that both merges happened.
    await expect(page.getByText('2 / 2').first()).toBeVisible({ timeout: 180_000 });

    const state = (await world.stateOf('booking-api')) as {
      integrationHead?: string;
      tasks: Array<{ id: string; state: string; attempts: number }>;
    };
    expect(state.tasks.map((task) => task.state)).toEqual(['completed', 'completed']);
    expect(state.integrationHead, 'nothing recorded an integration head').toMatch(/^[0-9a-f]{40}$/);

    // §21.2 on screen. The branch is derived from `gitRunKey` by the server, and
    // the browser is shown the name rather than asked for it.
    const branch = `agent-flow/${planned.gitRunKey ?? ''}/integration`;
    await expect(page.getByText('Isolation')).toBeVisible();
    await expect(page.getByText('worktree', { exact: true })).toBeVisible();
    await expect(page.getByText(branch)).toBeVisible();
    await expect(page.getByTitle(state.integrationHead as string)).toBeVisible();

    // The branch the server named is the branch Git actually has, and its tip is
    // the head the run recorded. Asserted against the repository rather than
    // against the response, because a read model agreeing with itself proves
    // nothing.
    expect(await world.git('booking-api', ['rev-parse', branch])).toBe(state.integrationHead);

    // Both tasks' work composed onto one branch — the product of the milestone,
    // read out of Git.
    const tree = await world.git('booking-api', ['ls-tree', '-r', '--name-only', branch]);
    expect(tree).toContain('src/task-001.txt');
    expect(tree).toContain('src/task-002.txt');

    // Per-task provenance, in the inspector: which attempt, which marker, which
    // merge, and the tree that was validated. Object ids and a ref name — the
    // things §26.1 rule 4 permits in a response.
    await page.getByRole('row').filter({ hasText: 'Add recurrence types' }).click();
    await expect(page.getByText('Integration')).toBeVisible();
    await expect(page.getByText('Attempt', { exact: true })).toBeVisible();
    await expect(page.getByText('Marker')).toBeVisible();
    await expect(page.getByText('Validated tree')).toBeVisible();

    // I-10, fingerprinted after. Four values, all identical: the user's checkout
    // never moved, was never dirtied and was never staged into.
    expect(await world.workingTree('booking-api')).toEqual(before);

    // §21.3 and I-8, on the wire and on the page. Not one request names a
    // directory, and nothing rendered is a filesystem path — including the
    // worktree root, which the artifact deliberately never stored (§7.2).
    for (const request of requests.all) {
      const where = `${request.method} ${request.url}`;
      expect(decodeURIComponent(request.url), where).not.toContain(world.root);
      expect(request.body, where).not.toContain(world.root);
    }
    const rendered = await page.locator('body').innerText();
    expect(rendered).not.toContain(world.root);
    expect(rendered).not.toContain('.agent-flow/worktrees');

    expect(problems).toEqual([]);
  });

  test('marks the task that is holding a live workspace right now', async ({ page, makeWorld }) => {
    // §21.2's `workspaceActive`, derived from the task being `running` in an
    // isolated run. Observed by parking a real agent inside the workspace: the
    // fake writes a marker file when it arrives and blocks until this test writes
    // the release, so the assertion is driven by evidence on disk and never by a
    // sleep.
    const world = await makeWorld({ worktrees: true, hold: true });

    await world.cli('booking-api', ['approve']);
    await openDashboard(page, world);
    await page.getByRole('button', { name: 'Start run' }).click();

    // The agent for the first task has arrived and is not coming back until
    // released, which is precisely the state a live workspace describes.
    await expect
      .poll(async () => world.parked(), { timeout: 120_000 })
      .toEqual(['TASK-001']);

    const row = page.getByRole('row').filter({ hasText: 'Add recurrence types' });
    await expect(row.getByText('RUNNING')).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText('in worktree')).toBeVisible();

    // And the sibling that has not started says nothing about workspaces: the
    // fact is per task and derived, not a property of the run.
    const waiting = page.getByRole('row').filter({ hasText: 'Generate occurrences' });
    await expect(waiting.getByText('in worktree')).toHaveCount(0);

    // Released, and the run is allowed to finish — a parked agent left behind
    // would hold a worktree lock into teardown.
    await world.release();
    await expect(page.getByText('2 / 2').first()).toBeVisible({ timeout: 180_000 });
    await expect(row.getByText('in worktree')).toHaveCount(0);
  });
});
