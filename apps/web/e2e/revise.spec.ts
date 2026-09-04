import { POLL_INTERVAL_MS } from '../src/hooks/use-live-events';
import { expect, openDashboard, openTasks, recordRequests, sleep, test } from './support/harness.js';

/**
 * E2E-04 — revision, as a job.
 *
 * Re-planning spawns runner processes and takes minutes against a real CLI, so the
 * endpoint answers 202 and the work proceeds. Progress arrives through the stream,
 * because `state.json` changing is what progress *is* — there is no second channel
 * reporting it and no timer asking.
 *
 * The plan that comes back is structurally different, not merely reworded: a third
 * task and a new edge. A revision that produced the same graph would let this pass
 * while the DAG view was reading a cached answer.
 */
test.describe('revision', () => {
  test('re-plans, invalidates the approval, and updates the graph', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();
    const requests = recordRequests(page);

    const runId = await openDashboard(page, world);

    // Approved first, so the invalidation has something to invalidate. The gate is
    // granted to one specific plan; a plan produced afterwards has not been through it.
    await world.cli('booking-api', ['approve']);
    await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();

    await page.getByRole('button', { name: 'Revise' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/This run is approved/)).toBeVisible();
    await dialog
      .getByRole('textbox')
      .fill('Add a task covering the last week of a month.');
    await dialog.getByRole('button', { name: 'Request revision' }).click();

    // 202: the job exists. The screen says what is happening rather than freezing.
    await expect(page.getByText('Re-planning…')).toBeVisible();

    // And then the new plan, through the stream. Read from the table, which is the
    // Tasks tab now — the stream event lands whichever surface is open, and this
    // asserts the row.
    await openTasks(page);
    await expect(page.getByRole('row').filter({ hasText: 'Cover the month boundary' })).toBeVisible(
      { timeout: 60_000 },
    );
    await expect(page.getByText('Re-planning…')).toHaveCount(0);

    const state = await world.stateOf('booking-api');
    expect(state['approved'], 'the approval survived a re-plan').toBe(false);
    expect(state['approvedPlanHash']).toBeUndefined();

    // The gate is closed again, so the run offers a decision rather than execution.
    await expect(page.getByRole('button', { name: 'Review & approve' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start run' })).toHaveCount(0);

    // The graph is the plan's, re-read because the plan changed — not re-laid-out
    // because a task ticked over.
    await page.getByRole('tab', { name: 'Graph' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);

    // The planner really ran, in the planner's own dialect.
    const calls = await world.runnerCalls();
    expect(calls.filter((call) => call.role === 'PLANNING_AGENT').length).toBeGreaterThanOrEqual(2);
    expect(calls.find((call) => call.role === 'PLANNING_AGENT')?.dialect).toBe('codex');

    // No path anywhere, including in the revision body.
    for (const request of requests.all) {
      expect(request.body, `${request.method} ${request.url}`).not.toContain(world.root);
    }

    expect(runId).toBe(await world.runIdOf('booking-api'));
  });

  test('does not poll while the stream is healthy', async ({ page, makeWorld }) => {
    // §89's rule, and the only way to check it is to wait longer than the fallback
    // interval and count. Polling is the fallback; a dashboard that also polls
    // *looks* live and is not, because a task that finishes appears when the timer
    // says so rather than when it happened.
    const world = await makeWorld();
    const requests = recordRequests(page);

    const runId = await openDashboard(page, world);
    const tasks = `/api/v1/runs/${runId}/tasks`;

    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    const settled = requests.countOf(tasks);

    await sleep(POLL_INTERVAL_MS + 2_000);

    expect(requests.countOf(tasks), 'the dashboard polled while the stream was live').toBe(settled);
    // And it never fell back either, which is the other half of the claim.
    await expect(page.getByText('Reconnecting — polling')).toHaveCount(0);
  });
});
