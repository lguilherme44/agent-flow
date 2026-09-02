import { test, expect } from '@playwright/test';
import { FIXTURE_RUN_ID, TEAM } from './fixtures';
import { stubApi, settle } from './harness';

/**
 * The team surfaces, as a person sees them (§37, §38, §39).
 *
 * A picture rather than DOM assertions, for the reason the rest of this suite exists: the
 * component tests all passed while this panel could still clip a member row, wrap a
 * status badge onto its own line, or draw a full member in a colour that reads as an
 * error. "The element exists" is not "the layout is right".
 *
 * **The team is an override rather than the shared fixture.** Putting one in `ROUTES`
 * would add a second card to the bottom row of every screenshot in this suite and move
 * every baseline at once — the change §49 exists to prevent. Most runs have no team, so
 * the shared fixture is the honest default and this file photographs the other case.
 */

const WITH_TEAM = { [`/api/v1/runs/${FIXTURE_RUN_ID}/team`]: TEAM };

test.describe('team', () => {
  test('the panel, with a full member and a task nobody could take', async ({ page }) => {
    await stubApi(page, WITH_TEAM);
    await page.goto('/dashboard');
    await settle(page);

    const panel = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Team' }),
    });
    await panel.scrollIntoViewIfNeeded();

    // The line whose absence would be a silent product failure: the team was consulted,
    // could not answer, and the task ran on a role instead.
    await expect(panel.getByText('1 task(s) no member could take')).toBeVisible();
    // Status in words, not colour alone (§97).
    await expect(panel.getByText('full')).toBeVisible();
    await expect(panel.getByText('working')).toBeVisible();

    await expect(panel).toHaveScreenshot('team-panel.png');
  });

  test('the bottom row, with the team beside the conversation', async ({ page }, info) => {
    // **The composition that changed.** A card that photographs well alone can still be
    // wrong beside its neighbour — two cards of different natural heights in one grid
    // row is precisely where a layout goes ragged.
    //
    // Only from 1280, which is where `xl:grid-cols-2` puts them side by side. Below it
    // the two stack, the row grows past the viewport, and a locator screenshot of
    // something taller than the window captures the sticky topbar painted across it —
    // a baseline coupled to a header this test is not about. The stacked case is covered
    // by the panel's own shot, which every width takes.
    test.skip(
      (info.project.use.viewport?.width ?? 0) < 1280,
      'the two-column row only exists from 1280',
    );

    await stubApi(page, WITH_TEAM);
    await page.goto('/dashboard');
    await settle(page);

    const row = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Team' }) })
      .locator('..');
    await row.scrollIntoViewIfNeeded();

    await expect(row).toHaveScreenshot('team-and-collaboration-row.png');
  });

  test('the inspector answers why this agent, without being asked twice', async ({ page }) => {
    await stubApi(page, WITH_TEAM);
    await page.goto('/dashboard');
    await settle(page);

    // TASK-003's row, opened the way a person opens it. At 1280 it sits below the fold
    // of the table's own scroll container, so it is scrolled to first.
    const row = page.getByText('Recurrence Repository');
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();

    const note = page.locator('details').filter({ hasText: 'Assigned to' });
    await note.scrollIntoViewIfNeeded();

    // Closed: one line, and the invitation to open it.
    await expect(note.getByText('why?')).toBeVisible();
    await expect(note).toHaveScreenshot('assignment-closed.png');

    // Open: the ranking, with the reason each candidate lost.
    await note.locator('summary').click();
    await expect(note.getByText('role mismatch')).toBeVisible();
    await expect(note).toHaveScreenshot('assignment-open.png');
  });

  test('a graph node names its agent without becoming a departure board', async ({ page }) => {
    await stubApi(page, WITH_TEAM);
    await page.goto('/dashboard');
    await settle(page);

    await page.getByRole('button', { name: 'View as DAG' }).click();
    await expect(page.getByText('Task dependencies')).toBeVisible();
    // React Flow measures the pane and fits the view on the next frame.
    await page.waitForTimeout(400);

    const node = page.locator('.react-flow__node').filter({ hasText: 'TASK-003' }).first();
    await expect(node.getByText('Backend')).toBeVisible();

    await expect(node).toHaveScreenshot('dag-node-assigned.png');
  });
});
