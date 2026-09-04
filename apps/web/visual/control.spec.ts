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

  test('a selected card opens the inspector over the board, not beside it', async ({ page }) => {
    /**
     * **The board gets a drawer at every width, and that is M8.5 correcting itself.**
     *
     * The inspector used to be a pane from 1200 up, sharing the row with whichever surface
     * was open. Photographed at 1200 with a card selected, that put a 400px panel beside a
     * board whose lanes are 244px each: 560px of board, which is two lanes and a sliver,
     * with `IN PROGRESS` sliced down its middle. A surface built from fixed-width columns
     * cannot give away a column and a half.
     *
     * The table and the graph keep the pane, and that is not an inconsistency: a table
     * reflows its own columns and a canvas refits its own viewport, and both are genuinely
     * better beside the detail than under it, because comparing a row to its log is the
     * reason to open one. Their case is `run-detail-inspector.png`.
     */
    await stubApi(page);
    await page.goto(BOARD_URL);
    await boardSettled(page);

    await page.getByRole('button', { name: /TASK-003/ }).first().click();

    const drawer = page.getByRole('dialog', { name: 'Task inspector' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    // The board is behind it and correctly out of the accessibility tree — which is what a
    // modal is for, and why this asserts the drawer rather than the lanes.
    await expect(page.getByRole('region', { name: /^Done, / })).toHaveCount(0);

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

  test('the board is operable with no drag and no mouse', async ({ page }) => {
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

    // One outcome at every width as of M8.5: the board's inspector is a modal drawer, and
    // a modal hides what is behind it. What matters here is that a keyboard alone opened
    // the task — no pointer, and no drag to fall back on.
    await expect(page.getByRole('dialog', { name: 'Task inspector' })).toBeVisible();

    // And it closes the way every dismissible surface in this app closes.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(first).toBeFocused();
  });
});

/**
 * 390 × 844 — the width M8's spec named and never photographed (§41).
 *
 * **One project rather than four.** The viewport is set inside the test, so running this
 * under every project would produce four identical images of the same 390px page and four
 * baselines to keep in step for no information. Pinned to `desktop-1440` so there is
 * exactly one `*-mobile.png` per platform, generated in the same two environments as every
 * other shot here.
 *
 * What the first probe found, before any of these assertions existed: the sidebar was a
 * fixed 240px column that never collapsed, so at 390 it took 62% of the screen and left the
 * content 150. The run id read `AF-2026…`, a task card's title read `Gerar pr…`, and the
 * attention queue wrapped to one word per line. The board had stacked its lanes below 1024
 * since M8 landed — the shell around it had not, so the stacking bought nothing.
 */
test.describe('control plane at 390', () => {
  const MOBILE = { width: 390, height: 844 };

  test.beforeEach(async ({ page }, info) => {
    test.skip(
      (info.project.use.viewport?.width ?? 0) !== 1440,
      'the viewport is set in the test; one project owns the baseline',
    );
    await page.setViewportSize(MOBILE);
  });

  /**
   * The mechanical half of §41: nothing may make the *page* scroll sideways.
   *
   * Deliberately `documentElement` and nothing else. The pipeline and the board scroll
   * inside their own regions on purpose and are measured to do so; asserting no scrollable
   * element anywhere would forbid the design rather than the defect. What is forbidden is
   * the document itself being wider than the window, which is the shape of a layout that
   * has overflowed.
   */
  async function pageOverflow(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  }

  test('M8-ACC-31 the home leads with attention, and the page does not scroll sideways', async ({
    page,
  }) => {
    await stubApi(page, { [`/api/v1/runs/${GATED_RUN_ID}/control`]: GATED_CONTROL });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    // Attention first, at the top, before the project list — the ordering is the milestone
    // and it has to survive the narrowest viewport rather than only the widest.
    const headings = await page.locator('main h2').allTextContents();
    expect(headings[0]).toContain('Needs attention');

    // What, why and the one action, all legible rather than merely present.
    await expect(page.getByText('the plan is waiting for a decision')).toBeVisible();
    await expect(page.getByText('Review the plan', { exact: true })).toBeVisible();
    await expect(page.getByText('P1', { exact: true })).toBeVisible();

    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page).toHaveScreenshot('control-home-mobile.png');
  });

  test('M8-ACC-31 the board stacks its lanes and keeps every count', async ({ page }) => {
    await stubApi(page);
    await page.goto(BOARD_URL);
    await expect(page.getByRole('button', { name: /TASK-001/ })).toBeVisible();

    // §8 — the six lane names, as text, because a screenshot tolerance would not notice one
    // of them changing meaning. Every lane carries its count in the accessible name, so a
    // screen reader gets the shape of the board without walking every card.
    for (const lane of ['Backlog', 'Ready', 'In progress', 'Review', 'Blocked', 'Done']) {
      await expect(page.getByRole('region', { name: new RegExp(`^${lane}, `) })).toBeVisible();
    }

    // Stacked, not a six-column board squeezed into 390px. Read from the boxes rather than
    // from a class name: a media query that stops applying is invisible to a class assertion
    // and obvious to this one.
    const lefts = await page
      .getByRole('region', { name: /, \d+ tasks?$/ })
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().x)));
    expect(lefts.length).toBeGreaterThanOrEqual(6);
    expect(new Set(lefts).size, `lanes are side by side at 390: ${lefts.join(', ')}`).toBe(1);

    // The status an operator reads first, and the action they reach for — both on screen.
    await expect(page.getByText('IMPLEMENTING')).toBeVisible();
    await expect(page.getByRole('button', { name: /Resume run/ })).toBeVisible();

    // **The five-count strip is not on this surface any more, and its absence is the
    // point.** On the board it was the *second* statement of the same numbers — `TOTAL 9 ·
    // COMPLETED 3 · RUNNING 2 · WAITING 4 · FAILED 0` directly above lane badges reading
    // `BACKLOG 4 · READY 0 · IN PROGRESS 2 · REVIEW 0 · BLOCKED 0 · DONE 3` — one run, two
    // partitions, on a 390px screen. The counts that matter here are the lane badges,
    // asserted through the accessible names above, and the strip has the Tasks tab to
    // itself where nothing else counts the run.
    for (const label of ['Total', 'Completed', 'Waiting', 'Failed']) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }

    // And it is one tab away, whole, with the count that used to fall off the end.
    await page.getByRole('tab', { name: 'Tasks' }).click();
    for (const label of ['Total', 'Completed', 'Running', 'Waiting', 'Failed']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole('tab', { name: 'Board' }).click();
    await expect(page.getByRole('button', { name: /TASK-001/ })).toBeVisible();

    // A card's reason, which is the sentence the whole board exists to carry.
    await expect(page.getByText('waiting on TASK-004').first()).toBeVisible();

    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page).toHaveScreenshot('board-mobile.png');
  });

  test('navigation is one button away, and closes the way everything else does', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto(BOARD_URL);
    await expect(page.getByRole('button', { name: /TASK-001/ })).toBeVisible();

    // §41: nothing important is hidden to make the layout fit. Every destination in the
    // product is in this drawer and nowhere else, so "behind one button" is the bar.
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).not.toBeVisible();

    const toggle = page.getByRole('button', { name: 'Open the navigation' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();

    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Runs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close the navigation' }).first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(nav).not.toBeVisible();

    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('a task opens in the inspector at 390', async ({ page }) => {
    await stubApi(page);
    await page.goto(BOARD_URL);
    await page.getByRole('button', { name: /TASK-003/ }).first().click();

    // Below 1200 the inspector is a drawer, which is a modal dialog — so the assertion is
    // that the dialog opened, not that the board is still in the accessibility tree.
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page).toHaveScreenshot('inspector-mobile.png');
  });
});
