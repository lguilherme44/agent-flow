import { expect, openDashboard, recordConsole, recordRequests, test } from './support/harness';

/**
 * E2E-01 — a project and a run, read through the whole stack.
 *
 * Nothing is stubbed. The browser talks to a Fastify server the real `agent-flow
 * ui` started, which reads a run the real `agent-flow feature` wrote to a real
 * directory. If any layer between the two disagreed about a shape, this is where
 * it shows — and unlike a visual fixture, nobody had to keep the fixture in step
 * with the contract by hand.
 */
test.describe('a run, end to end', () => {
  test('discovers the project, opens the run, and shows its pipeline and tasks', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();
    const problems = recordConsole(page);
    const requests = recordRequests(page);

    const runId = await openDashboard(page, world);
    expect(runId).toBe(await world.runIdOf('booking-api'));

    // The project the operator pointed the server at, in the sidebar.
    await expect(
      page.getByRole('button', { name: /booking-api/ }).first(),
    ).toBeVisible();

    // The pipeline, and a run that stopped where the workflow says it should.
    await expect(page.getByRole('list', { name: 'Pipeline' })).toBeVisible();
    await expect(page.getByText('WAITING APPROVAL').first()).toBeVisible();

    // The plan the planner produced, as rows. Two tasks, and the titles are the
    // fake CLI's answer travelling all the way from a child process to the DOM.
    await expect(page.getByRole('row').filter({ hasText: 'Add recurrence types' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Generate occurrences' })).toBeVisible();

    // The inspector, opened by selecting a task.
    await page.getByRole('row').filter({ hasText: 'Add recurrence types' }).click();
    await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
    await expect(page.getByText('Domain types for a weekly series.')).toBeVisible();

    // The graph, drawn from the server's own answer about the plan's edges.
    await page.getByRole('button', { name: 'View as DAG' }).click();
    await expect(page.getByText('Task dependencies')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    expect(problems, 'the browser logged an error').toEqual([]);

    // Not one request carries a directory. The whole filesystem security model of
    // §93 is that the browser's vocabulary for a project is an id the registry
    // issued, so a path anywhere in a URL or a body is a hole in it.
    for (const request of requests.all) {
      const where = `${request.method} ${request.url}`;
      expect(request.url, where).not.toContain(world.root);
      expect(request.body, where).not.toContain(world.root);
      expect(request.body, where).not.toContain('/tmp');
    }
  });

  test('says so plainly when a project has no runs', async ({ page, makeWorld }) => {
    const world = await makeWorld({ plan: false });

    await page.goto(`${world.url}/dashboard`);

    await expect(page.getByText('No runs yet.')).toBeVisible();
    await expect(page.getByText('agent-flow feature')).toBeVisible();
  });
});
