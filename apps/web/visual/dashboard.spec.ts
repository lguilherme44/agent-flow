import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_NOW, FIXTURE_RUN_ID, ROUTES } from './fixtures';

/**
 * What the dashboard actually looks like.
 *
 * Every call is answered from `fixtures.ts`, so the run is the same rich one
 * every time: a stage in flight, four models, a corrective task, durations from
 * seconds to minutes, and a log long enough to fill the terminal.
 *
 * The SSE endpoint is replaced rather than stubbed at the network layer. A
 * `fulfill`ed event-stream ends as soon as it is written, `EventSource` treats
 * that as a drop and reconnects, and the topbar would flicker between "running"
 * and "reconnecting" — non-deterministic in exactly the region the screenshot
 * covers.
 */
async function stubApi(page: Page): Promise<void> {
  await page.clock.setFixedTime(FIXTURE_NOW);

  await page.addInitScript(() => {
    class OpenForever {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;

      constructor() {
        // The hook reads the connection state on open, and the topbar renders
        // it. Reporting open immediately is what makes that pixel stable.
        setTimeout(() => this.onopen?.(new Event('open')), 0);
      }

      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    }

    Object.defineProperty(window, 'EventSource', { value: OpenForever, writable: true });
  });

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = ROUTES[path];

    if (body === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not_found', message: `no fixture for ${path}` }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

/** Waits for the parts that arrive asynchronously, so no shot catches a skeleton. */
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FIXTURE_RUN_ID);
  await expect(page.getByRole('list', { name: 'Pipeline' })).toBeVisible();
  // The first row, which is above the fold at every viewport this suite covers.
  // Waiting on a row further down made the 1280 run fail for the honest reason
  // that fewer rows fit — a fact about the viewport, not about the app.
  await expect(page.getByText('Criar entidade Recurrence')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Model usage' })).toBeVisible();
  // Recharts measures its container and draws on the next frame.
  await page.waitForTimeout(300);
}

test.describe('run detail', () => {
  test('the whole composition, nothing selected', async ({ page }) => {
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    await expect(page).toHaveScreenshot('run-detail.png', { fullPage: false });
  });

  test('with a running task open in the inspector', async ({ page }) => {
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    // Scrolled into view first: at 1280 the running task sits below the fold of
    // the table's own scroll container, and clicking it is what the test is for.
    const row = page.getByText('Recurrence Repository');
    await row.scrollIntoViewIfNeeded();
    await row.click();

    await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
    await expect(page.getByText('All tests passed')).toBeVisible();

    await expect(page).toHaveScreenshot('run-detail-inspector.png', { fullPage: false });
  });

  test('the inspector is a pane above 1200 and a drawer below it', async ({ page }, info) => {
    // §66's boundary, checked on both sides. The drawer is chosen in
    // JavaScript, so exactly one inspector exists in the document either way —
    // a CSS-hidden second copy is invisible to the eye and entirely present to
    // a screen reader.
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    const row = page.getByText('Recurrence Repository');
    await row.scrollIntoViewIfNeeded();
    await row.click();

    const width = info.project.use.viewport?.width ?? 0;
    const drawer = page.getByRole('dialog', { name: 'Task inspector' });

    if (width >= 1200) {
      await expect(drawer).toHaveCount(0);
    } else {
      await expect(drawer).toBeVisible();
      // Escape closes it: an overlay that traps the reader is worse than none.
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
    }

    // Either way, one panel describing this task. Never two.
    await expect(page.getByText('Recurrence Repository')).toHaveCount(width >= 1200 ? 2 : 1);
  });

  test('no region scrolls the page sideways', async ({ page }) => {
    // The failure this catches is not subtle in a screenshot and is invisible
    // in a DOM assertion: a column that overflows pushes the whole layout.
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  });

  test('nothing logs an error while rendering', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    expect(errors).toEqual([]);
  });
});

test.describe('runs list', () => {
  test('renders the history', async ({ page }) => {
    await stubApi(page);
    await page.goto('/runs');
    await expect(page.getByRole('link', { name: FIXTURE_RUN_ID })).toBeVisible();

    await expect(page).toHaveScreenshot('runs-list.png', { fullPage: false });
  });
});

test.describe('projects', () => {
  test('renders the registry', async ({ page }) => {
    await stubApi(page);
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'beahub-api' })).toBeVisible();

    await expect(page).toHaveScreenshot('projects.png', { fullPage: false });
  });
});
