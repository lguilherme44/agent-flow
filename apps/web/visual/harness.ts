import { expect, type Page } from '@playwright/test';
import { FIXTURE_NOW, FIXTURE_RUN_ID, ROUTES } from './fixtures';

/**
 * The browser the visual suite looks at.
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
 *
 * Shared between the specs rather than copied into each: two harnesses would
 * stub two slightly different servers, and the difference would show up as a
 * baseline that only moves in one file.
 */
export async function stubApi(
  page: Page,
  /**
   * Route bodies to answer instead of the shared fixtures.
   *
   * The reference run is approved and part-way through execution, which is the
   * composition the design was signed off against — so the gate specs, which need a
   * run still awaiting judgement, say so here rather than by changing the fixture
   * every other screenshot depends on.
   */
  overrides: Record<string, unknown> = {},
): Promise<void> {
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

  const answers = { ...ROUTES, ...overrides };

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = answers[path];

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
export async function settle(page: Page): Promise<void> {
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
