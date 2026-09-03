import { test, expect } from '@playwright/test';
import {
  CONTROL,
  FIXTURE_RUN_ID,
  GATED_CONTROL,
  GATED_RUN_ID,
  LARGE_CONTROL,
  LARGE_TASK_LIST,
  TASKS,
} from './fixtures';
import { stubApi } from './harness';

/**
 * The control plane, as an operator meets it (M8 §42, §43).
 *
 * A picture rather than DOM assertions, for the reason the rest of this suite exists: the
 * component tests all pass while a lane can still clip its own heading, a reason line can
 * wrap to four rows, or five columns can push the sixth off a laptop. "The element exists"
 * is not "the layout is right".
 *
 * **Text assertions accompany every shot, and that is not belt-and-braces.** A screenshot
 * diff has a tolerance, and a badge changing from `NOT RUN` to `FAILED` fits inside it.
 * Those words are the ones an operator acts on, so they are asserted as text as well as
 * photographed (M8 §43).
 */

const BOARD_URL = `/runs/${FIXTURE_RUN_ID}?view=board`;

/**
 * The board is a rendering of the tasks, so it is ready when a card carrying one of them
 * is. Waiting on a lane heading would pass against an empty board.
 */
async function boardSettled(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIXTURE_RUN_ID);
  await expect(page.getByRole('button', { name: /TASK-001/ })).toBeVisible();
}

test.describe('control plane', () => {
  test('the workspace home leads with what needs a person', async ({ page }) => {
    // The queue opens on the most urgent project, which in this fixture is the one waiting
    // at a gate. Stubbing its snapshot is what makes the shot a picture of the page rather
    // than of a failed read — the two are deliberately distinguishable now, and this test
    // is about the first.
    await stubApi(page, { [`/api/v1/runs/${GATED_RUN_ID}/control`]: GATED_CONTROL });
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page).toHaveScreenshot('control-home.png', { fullPage: false });

    // The queue is the first thing on the page, above the project list. That ordering is
    // the milestone: a landing page that opens with a static list of projects answers none
    // of the four questions an operator arrives with.
    const headings = await page.locator('main h2').allTextContents();
    expect(headings[0]).toContain('Needs attention');
  });

  test('the board places every task in exactly one lane, with a reason', async ({ page }) => {
    await stubApi(page);
    await page.goto(BOARD_URL);
    await boardSettled(page);

    // Every lane is a labelled region carrying its count, so a screen reader gets the
    // shape of the board without walking every card.
    for (const lane of ['Backlog', 'Ready', 'In progress', 'Review', 'Blocked', 'Done']) {
      await expect(page.getByRole('region', { name: new RegExp(`^${lane}, `) })).toBeVisible();
    }

    // The sum, checked against the fixture rather than against itself. A board rendering a
    // task twice and a board dropping one both look plausible.
    const cards = page.getByRole('button', { name: /TASK-\d+|FIX-\d+/ });
    await expect(cards).toHaveCount(TASKS.length);

    await expect(page).toHaveScreenshot('board.png', { fullPage: false });
  });

  test('a card says why it is where it is', async ({ page }) => {
    await stubApi(page);
    await page.goto(BOARD_URL);
    await boardSettled(page);

    // The sentence, asserted as text. It is the reason this is a board rather than a task
    // table, and a pixel tolerance would not notice it disappearing.
    const waiting = CONTROL.cards.find((card) => card.reason.cause === 'dependency');
    if (waiting !== undefined) {
      await expect(page.getByText(waiting.reason.text, { exact: false }).first()).toBeVisible();
    }

    const running = CONTROL.cards.find((card) => card.lane === 'in_progress');
    if (running !== undefined) {
      await expect(page.getByText(running.reason.text, { exact: false }).first()).toBeVisible();
    }
  });

  test('a selected card opens the inspector beside the board', async ({ page }, info) => {
    // Only from 1200, which is where the inspector is a pane rather than a drawer. Below
    // it the drawer is a modal dialog and correctly marks the rest of the page
    // `aria-hidden` — so "the board is still there" stops being a question the
    // accessibility tree can answer, and asserting it would be asserting the opposite of
    // what a modal is for. The drawer case has its own test below.
    test.skip(
      (info.project.use.viewport?.width ?? 0) < 1200,
      'the inspector is a drawer below 1200',
    );

    await stubApi(page);
    await page.goto(BOARD_URL);
    await boardSettled(page);

    await page.getByRole('button', { name: /TASK-003/ }).first().click();

    // Still the board, with a selection — not a navigation. The board and the table share
    // the filter and the selection precisely so moving between them keeps your place.
    await expect(page.getByRole('region', { name: /^Done, / })).toBeVisible();
    await expect(page).toHaveScreenshot('board-selected.png', { fullPage: false });
  });

  test('M8-ACC-20 — a hundred tasks stay operable and each appears once', async ({ page }) => {
    await stubApi(page, {
      [`/api/v1/runs/${FIXTURE_RUN_ID}/control`]: LARGE_CONTROL,
      [`/api/v1/runs/${FIXTURE_RUN_ID}/tasks`]: LARGE_TASK_LIST,
    });
    await page.goto(BOARD_URL);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIXTURE_RUN_ID);

    // Every task, exactly once. A board that renders one twice and a board that drops one
    // both look plausible at this size, which is precisely why the count is asserted
    // rather than eyeballed.
    const cards = page.getByRole('button', { name: /^TASK-\d{3}/ });
    await expect(cards).toHaveCount(LARGE_TASK_LIST.length);

    // And the lane counts still sum to it: the header the operator reads must agree with
    // the cards under it.
    const counts = await page
      .getByRole('region', { name: /, \d+ tasks?$/ })
      .evaluateAll((nodes) =>
        nodes
          .map((node) => Number(/, (\d+) tasks?$/.exec(node.getAttribute('aria-label') ?? '')?.[1] ?? '0'))
          .reduce((sum, value) => sum + value, 0),
      );
    expect(counts).toBe(LARGE_TASK_LIST.length);

    await expect(page).toHaveScreenshot('board-large.png', { fullPage: false });
  });

  test('the board is operable with no drag and no mouse', async ({ page }, info) => {
    await stubApi(page);
    await page.goto(BOARD_URL);
    await boardSettled(page);

    // There is no drag handler anywhere: dragging BLOCKED → DONE would be the browser
    // writing state, and no domain action means "move this task to that column". So the
    // whole board is buttons, and a keyboard reaches all of it — which is what makes the
    // board accessible by construction rather than by a later pass.
    const first = page.getByRole('button', { name: /TASK-\d+/ }).first();
    await first.focus();
    await expect(first).toBeFocused();
    await first.press('Enter');

    // The outcome differs by width and both are correct, so both are asserted. Above 1200
    // the inspector is a pane and the card stays in the accessibility tree pressed; below
    // it the inspector is a modal drawer, which hides the board behind it — which is what a
    // modal is for. What the two share is that a keyboard alone opened the task.
    if ((info.project.use.viewport?.width ?? 0) >= 1200) {
      await expect(first).toHaveAttribute('aria-pressed', 'true');
    } else {
      await expect(page.getByRole('dialog')).toBeVisible();
    }
  });
});
