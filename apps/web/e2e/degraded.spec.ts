import { expect, openDashboard, openTasks, test } from './support/harness.js';

/**
 * E2E-08 — the states nobody designs for and everybody meets.
 *
 * Each of these is a *different* situation with a different next step, which is the
 * point: one "something went wrong" for all of them is what makes a dashboard
 * useless exactly when it is needed. And none of them may put a stack trace on the
 * screen — a trace tells the reader nothing they can act on and everything about
 * the machine it came from.
 */

/** What a browser must never be shown. */
const TRACE = /\bat [A-Za-z$_<][\w$.<>]* \(|node:internal|\.ts:\d+:\d+|\.js:\d+:\d+\)/;

async function assertNoTrace(text: string): Promise<void> {
  expect(text, 'a stack trace reached the browser').not.toMatch(TRACE);
}

test.describe('failure states', () => {
  test('an id this workspace never issued', async ({ page, makeWorld }) => {
    const world = await makeWorld();

    await page.goto(`${world.url}/dashboard?project=no-such-project`);

    // Said once, where the selection lives — not once per query as a server error.
    await expect(page.getByText('This server has no project called no-such-project.')).toBeVisible();
    await expect(page.getByText(/Nothing is wrong with the workflow/)).toBeVisible();

    await page.getByRole('button', { name: 'Show the whole workspace' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^AF-\d{4}-\d{3}$/);

    await assertNoTrace((await page.locator('body').textContent()) ?? '');
  });

  test('a run that is not in this project', async ({ page, makeWorld }) => {
    const world = await makeWorld();

    await page.goto(`${world.url}/runs/AF-2999-404?project=booking-api`);

    await expect(page.getByRole('alert')).toContainText('AF-2999-404 is not in this project.');
    // Whether anything stopped, which the title alone does not answer.
    await expect(page.getByRole('alert')).toContainText('Nothing has stopped');
    await expect(page.getByRole('alert')).toContainText('Pick the project it belongs to');

    await assertNoTrace((await page.getByRole('alert').textContent()) ?? '');
  });

  test('a runner that is not installed, and the task that fails because of it', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld({ missingRunner: 'executors' });

    // Health first: the executable is genuinely missing, so the shallow check says so.
    await page.goto(`${world.url}/projects`);
    await page.getByRole('row').filter({ hasText: 'booking-api' }).getByRole('button', { name: 'Select' }).click();
    const health = page.getByRole('list', { name: 'Runner health' });
    await expect(health).toBeVisible();
    await expect(health).toContainText('broken');

    // Then the consequence. Planning never touches an executor, so the run reached
    // the gate normally; execution is where the missing binary is felt.
    await world.cli('booking-api', ['approve']);
    const executed = await world.cli('booking-api', ['run']);
    expect(executed.code).not.toBe(0);

    await openDashboard(page, world);

    const failed = (await world.stateOf('booking-api')) as { tasks: Array<{ state: string }> };
    expect(failed.tasks.some((task) => task.state === 'failed')).toBe(true);

    // The inspector names the normalised code, not the adapter's prose.
    await openTasks(page);
    await page.getByRole('row').filter({ hasText: 'Add recurrence types' }).click();
    await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
    await expect(page.getByText('runner_unavailable').first()).toBeVisible();

    await assertNoTrace((await page.locator('body').textContent()) ?? '');
  });

  test('a degraded run says what it lost, before the gate is signed', async ({
    page,
    makeWorld,
  }) => {
    // One provider means the review is not independent of the planner. Permitted,
    // weaker, and recorded on the run — the reader has to be told while they still
    // have the choice, not in a post-mortem.
    const world = await makeWorld({ singleProvider: true });

    const state = (await world.stateOf('booking-api')) as {
      degradations: Array<{ kind: string }>;
    };
    expect(state.degradations.map((entry) => entry.kind)).toContain('single_provider');

    await openDashboard(page, world);
    // The degradation detail is on Overview as of M8.5, beside the escalation and the
    // pipeline. The attention strip carries the headline; this is what it points at.
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByText(/same.provider/i).first()).toBeVisible();

    await page.getByRole('button', { name: 'Review & approve' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('same provider')).toBeVisible();
    // Approvable, and honest about it.
    await expect(dialog.getByRole('button', { name: 'Approve Plan' })).toBeEnabled();

    await assertNoTrace((await dialog.textContent()) ?? '');
  });

  test('a refusal from the write API is reported where the button is', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();

    // Rejected from the terminal while the browser is open, so the browser's next
    // click meets a refusal the workflow made rather than a stale screen.
    await openDashboard(page, world);
    await world.cli('booking-api', ['reject', 'not this way']);

    await expect(page.getByText('PLAN REJECTED').first()).toBeVisible({ timeout: 15_000 });

    // The API says no, in words, with a next step and without a trace.
    const runId = await world.runIdOf('booking-api');
    // `page.request` is not the page: it sends no `Origin`, so it reaches the API the
    // way `curl` does and carries the header the request guard admits a non-browser
    // client on. Without it the answer would be 403 before any gate was consulted —
    // which would make this test pass for a reason that has nothing to do with §95.
    const response = await page.request.post(
      `${world.url}/api/v1/runs/${runId}/approve?project=booking-api`,
      { data: {}, headers: { 'x-agent-flow-client': 'e2e' } },
    );
    expect(response.status()).toBe(409);
    const body = (await response.json()) as {
      error: string;
      message: string;
      action?: string;
      forcible?: boolean;
    };
    expect(body.error).toBe('already_rejected');
    // A refusal a person can act on: what happened, and what to do instead.
    expect(body.action).toMatch(/Revise/);
    expect(body.forcible).toBe(true);
    await assertNoTrace(JSON.stringify(body));

    // Still nothing approved, which is the part that matters.
    expect((await world.stateOf('booking-api'))['approved']).toBe(false);
  });
});
