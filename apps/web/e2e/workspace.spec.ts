import { expect, recordConsole, recordRequests, sleep, test } from './support/harness';

/**
 * E2E-07 — two projects that both hold AF-2026-001.
 *
 * That collision is the whole scenario, and it is not contrived: run ids restart
 * at 001 per project per year, so any two repositories initialised in the same
 * year have one. Every way the dashboard could confuse them is a way an operator
 * approves, revises or starts the wrong repository's plan.
 */
const PROJECTS = ['booking-api', 'payments-api'] as const;

test.describe('workspace isolation', () => {
  test('keeps two projects apart, in the URL and on the wire', async ({ page, makeWorld }) => {
    const world = await makeWorld({ projects: PROJECTS, workspace: true });
    const problems = recordConsole(page);
    const requests = recordRequests(page);

    // The premise, checked rather than assumed.
    expect(await world.runIdOf('booking-api')).toBe(await world.runIdOf('payments-api'));

    await page.goto(`${world.url}/projects`);
    await expect(page.getByRole('row').filter({ hasText: 'booking-api' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'payments-api' })).toBeVisible();

    // Reached the way an operator reaches it: through the history, which is where
    // the two ids look identical.
    await page.goto(`${world.url}/runs`);
    const row = page.getByRole('row').filter({ hasText: 'payments-api' });
    await expect(row).toBeVisible();
    await row.getByRole('link').click();

    // The project travelled with the link. Without it the run resolves against the
    // primary project and the page shows booking-api's run of the same name.
    await expect(page).toHaveURL(/project=payments-api/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^AF-\d{4}-\d{3}$/);
    await expect(page.getByText('Add weekly recurrence to payments-api')).toBeVisible();

    // Switching projects changes the data and leaves the run behind — a run id
    // belongs to one project, and carrying it across is a 404 dressed as a bug.
    await page.getByRole('button', { name: /booking-api/ }).first().click();
    await expect(page).toHaveURL(/\/dashboard\?project=booking-api/);
    await expect(page.getByText('Add weekly recurrence to booking-api')).toBeVisible();
    await expect(page.getByText('Add weekly recurrence to payments-api')).toHaveCount(0);

    expect(problems).toEqual([]);

    // Not one request names a directory, in a workspace least of all: the server
    // was pointed at the parent, and the browser still only ever says an id.
    for (const request of requests.all) {
      const where = `${request.method} ${request.url}`;
      expect(decodeURIComponent(request.url), where).not.toContain(world.root);
      expect(request.body, where).not.toContain(world.root);
    }
  });

  test('a change in one project does not disturb the other', async ({ page, makeWorld }) => {
    // The stream is filtered by project on the server, and this is what that is
    // for: a workspace of six repositories where one is executing would otherwise
    // re-read all six every time a task ticked over.
    const world = await makeWorld({ projects: PROJECTS, workspace: true });
    const requests = recordRequests(page);

    await page.goto(`${world.url}/dashboard?project=payments-api`);
    await expect(page.getByText('Add weekly recurrence to payments-api')).toBeVisible();
    await expect(page.getByText('Live', { exact: true })).toBeVisible();

    const reads = (): number =>
      requests.all.filter(
        (entry) => entry.method === 'GET' && entry.url.includes('project=payments-api'),
      ).length;

    const settled = reads();

    // A real change in the other project, made by the other adapter.
    const approved = await world.cli('booking-api', ['approve']);
    expect(approved.code).toBe(0);

    // Long enough for the watcher to notice and publish, and short enough to stay
    // well inside the polling fallback interval.
    await sleep(3_000);

    expect(reads(), "booking-api's event invalidated payments-api").toBe(settled);
    // The screen is still the project it was on, unchanged.
    await expect(page.getByText('Add weekly recurrence to payments-api')).toBeVisible();
    expect((await world.stateOf('payments-api'))['approved']).toBe(false);

    // And the same event does reach the project it belongs to, so this is isolation
    // rather than a stream that simply does not work.
    await page.goto(`${world.url}/dashboard?project=booking-api`);
    await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
  });
});
