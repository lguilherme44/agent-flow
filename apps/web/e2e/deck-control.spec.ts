import { join } from 'node:path';

import { expect, recordConsole, test } from './support/harness.js';
import { REPO_ROOT } from './support/world.js';

const project = 'booking-api';

/**
 * Stopping a run, and reading what a stage said.
 *
 * Both were capabilities with no button. `pause`, `resume` and `cancel` have been in the
 * core and on the server since PRI-14 and PRI-15 — the CLI could stop a run and the
 * browser watching it could not — and a stage's log has been written to disk all along
 * while the only thing a browser could reach was a two-kilobyte excerpt on failure.
 */
test.describe('Deck run control', () => {
  test('pauses a run, says so, and resumes it', async ({ page, makeWorld }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck' });
    const problems = recordConsole(page);
    await world.cli(project, ['approve']);
    const runId = await world.runIdOf(project);

    await page.goto(`${world.url}/p/${project}/runs/${runId}`);
    await expect(page.getByRole('heading', { name: runId })).toBeVisible();

    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    // The pause is a fact about the run, not about this tab: it survives a reload because
    // it was written to `state.json`, which is what the CLI reads too.
    await expect(page.getByText(/A task already in flight finishes/)).toBeVisible();
    await page.reload();
    await expect(page.getByText('paused', { exact: true })).toBeVisible();

    const png = await page.screenshot({ path: join(REPO_ROOT, 'apps/web/e2e/.results', 'deck-control-paused.png') });
    await testInfo.attach('paused', { body: png, contentType: 'image/png' });

    // The state the CLI would refuse to `run` from.
    expect(await world.stateOf(project)).toHaveProperty('pauseRequestedAt');

    await page.getByRole('button', { name: 'Resume the run' }).click();
    await expect(page.getByText('paused', { exact: true })).toHaveCount(0);
    expect(await world.stateOf(project)).not.toHaveProperty('pauseRequestedAt');
    expect(problems, 'the browser logged an error').toEqual([]);
  });

  test('asks before cancelling, and says what survives', async ({ page, makeWorld }) => {
    const world = await makeWorld({ dashboard: 'deck' });
    const runId = await world.runIdOf(project);
    await page.goto(`${world.url}/p/${project}/runs/${runId}`);
    await expect(page.getByRole('heading', { name: runId })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel run' }).click();
    // Terminal, in a row where every other button is reversible. What it says is what
    // survives, which is the question somebody hesitating over it is actually asking.
    await expect(page.getByText(/evidence, its integration branch and its worktrees/)).toBeVisible();

    await page.getByRole('button', { name: 'Keep running' }).click();
    expect(await world.stateOf(project)).toMatchObject({ status: 'waiting_for_approval' });

    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.getByRole('button', { name: 'Cancel the run' }).click();
    await expect(page.locator('.chip').filter({ hasText: 'cancelled' })).toBeVisible();
    expect(await world.stateOf(project)).toMatchObject({ status: 'cancelled' });

    // Terminal means terminal: nothing offers to restart it.
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
  });

  test("shows a stage's own output, not the excerpt an event carries", async ({ page, makeWorld }, testInfo) => {
    const world = await makeWorld({ dashboard: 'deck' });
    const runId = await world.runIdOf(project);
    await page.goto(`${world.url}/p/${project}/runs/${runId}`);
    await expect(page.getByRole('heading', { name: runId })).toBeVisible();

    await page.getByRole('tab', { name: 'Stage output' }).click();
    await page.getByLabel('Stage log').selectOption('planning');

    // The file the stage runner wrote, header and all — not the excerpt an event carries.
    const body = page.locator('.stage-log__body');
    await expect(body).toContainText('stage=planning role=planner');
    const png = await page.screenshot({ path: join(REPO_ROOT, 'apps/web/e2e/.results', 'deck-stage-log.png') });
    await testInfo.attach('stage-log', { body: png, contentType: 'image/png' });

    // A stage whose log belongs to its tasks says so rather than reading as empty.
    await page.getByLabel('Stage log').selectOption('final-review');
    await expect(page.locator('.stage-log')).toContainText(/No log for final-review/);
  });
});
