import { expect, openDashboard, openTasks, recordConsole, test } from './support/harness.js';

/**
 * E2E-05 and E2E-06 — execution and retry.
 *
 * Start is the one action where the browser and the terminal genuinely differ, and
 * the difference is entirely in the adapters: the CLI awaits the scheduler, the
 * server runs it as a job and answers immediately. The use case underneath is the
 * same function, which is why a run started from a browser produces the same task
 * results, the same events and the same `state.json` as one started from a shell.
 */
test.describe('execution', () => {
  test('runs the approved plan and reports every task through the stream', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();
    const problems = recordConsole(page);

    await openDashboard(page, world);
    await world.cli('booking-api', ['approve']);

    const start = page.getByRole('button', { name: 'Start run' });
    await expect(start).toBeVisible();
    await start.click();

    // The job, then the work. `Running…` is the job's own state: a gate the
    // workflow refused never touches `state.json`, so nothing else would report it.
    await expect(page.getByText('Running…')).toBeVisible();
    await expect(page.getByText('2/2 tasks')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Running…')).toHaveCount(0);

    const state = (await world.stateOf('booking-api')) as { tasks: Array<{ state: string }> };
    expect(state.tasks.map((task) => task.state)).toEqual(['completed', 'completed']);

    // The result the agent reported, read back off disk: the file it says it
    // changed, and the validation command Agent Flow ran itself.
    await openTasks(page);
    await page.getByRole('row').filter({ hasText: 'Generate occurrences' }).click();
    await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
    await page.getByRole('tab', { name: 'Files (1)' }).click();
    await expect(page.getByText('src/recurrence.js')).toBeVisible();
    await page.getByRole('tab', { name: 'Tests (1)' }).click();
    await expect(page.getByText('node --version')).toBeVisible();

    const calls = await world.runnerCalls();
    const implementations = calls.filter((call) => call.role === 'IMPLEMENTATION_AGENT');
    expect(implementations).toHaveLength(2);
    // Write permissions for the implementation stage, read-only for planning — the
    // adapter's own flag, produced by the adapter, observed on the real argv.
    expect(implementations[0]?.argv.join(' ')).toContain('workspace-write');

    expect(problems).toEqual([]);
  });
});

test.describe('retry', () => {
  test('puts a failed task back in the queue from the inspector', async ({ page, makeWorld }) => {
    const world = await makeWorld();

    // The failure is produced by the product: approve, run, and have the
    // implementation agent report FAILED. Nothing is written into `state.json` by
    // hand, so the state the browser retries from is one the scheduler produced.
    await world.cli('booking-api', ['approve']);
    const failed = await world.cli('booking-api', ['run'], { AF_FAKE_IMPL: 'failed' });
    expect(failed.code, 'the run was supposed to stop').not.toBe(0);

    const before = (await world.stateOf('booking-api')) as {
      tasks: Array<{ id: string; state: string; attempts: number }>;
    };
    const stopped = before.tasks.find((task) => task.state === 'failed');
    expect(stopped, 'no task failed, so there is nothing to retry').toBeDefined();

    await openDashboard(page, world);
    await openTasks(page);

    await page.getByRole('row').filter({ hasText: 'Add recurrence types' }).click();
    await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();

    await page.getByRole('button', { name: 'Retry' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/becomes attempt/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Retry task' }).click();
    await expect(dialog).toHaveCount(0);

    // Queued on disk. Retry requeues; it does not execute — running the plan again
    // is a separate, deliberate act.
    await expect
      .poll(
        async () => {
          const after = (await world.stateOf('booking-api')) as {
            tasks: Array<{ id: string; state: string }>;
          };
          return after.tasks.find((task) => task.id === stopped?.id)?.state;
        },
        { timeout: 15_000 },
      )
      .toBe('queued');

    // And no runner was spawned by the retry itself.
    const calls = await world.runnerCalls();
    const implementations = calls.filter((call) => call.role === 'IMPLEMENTATION_AGENT').length;
    await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
    expect((await world.runnerCalls()).filter((c) => c.role === 'IMPLEMENTATION_AGENT')).toHaveLength(
      implementations,
    );
  });
});
