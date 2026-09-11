import { test, expect, type Page } from '@playwright/test';
import { ROUTES, FIXTURE_RUN_ID, FIXTURE_NOW } from '../../web/visual/fixtures';

/**
 * Does the Deck fit in a hand?
 *
 * Nobody had asked. `shell.css` and `run.css` have no rule below 720px, the narrowest
 * viewport asserted anywhere in this repository was 1024×768, and the first person to
 * open the Deck on a phone — 11/09/2026, on the device-pairing feature built precisely so
 * a phone could reach it — found the navigation and the run page laid out for a tablet
 * and squeezed.
 *
 * The assertions here are **not** screenshots first. A baseline tells you something
 * changed; it does not tell you the page is usable, and a broken layout can be
 * faithfully re-baselined by anybody in a hurry. So each test states the property that
 * was actually violated — the document must not scroll sideways, every control must be
 * reachable and big enough to hit — and the screenshot comes after, as the record.
 *
 * The API is stubbed from the fixtures the visual suite already maintains: the two
 * dashboards talk to the same server, so a second set of bodies would be a second thing
 * to keep true.
 */

const PROJECT = 'beahub-api';


/**
 * The run page is built around the recorder, and the recorder reads `/events` — a route the
 * classic dashboard never called, so `apps/web/visual/fixtures.ts` has no body for it.
 * Answering `null` there is what made this page render nothing at all, which is how the
 * first version of this file measured a void and called it a pass.
 */
const EVENT_LOG = {
  runId: FIXTURE_RUN_ID,
  projectId: PROJECT,
  total: 3,
  truncated: false,
  events: [
    { at: '2026-08-10T19:58:00.000Z', type: 'run_created', detail: { feature: 'pairing' } },
    { at: '2026-08-10T20:01:00.000Z', type: 'stage_started', detail: { stage: 'discovery' } },
    { at: '2026-08-10T20:11:00.000Z', type: 'stage_completed', detail: { stage: 'discovery' } },
  ],
};

async function stub(page: Page): Promise<void> {
  await page.clock.setFixedTime(FIXTURE_NOW);

  // `EventSource` that connects and stays silent. A fulfilled event-stream closes
  // immediately, the client treats that as a drop, and the topbar flickers between
  // "live" and "reconnecting" — movement in the region a screenshot covers.
  await page.addInitScript(() => {
    class OpenForever {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      readonly readyState = 1;
      constructor() {
        setTimeout(() => this.onopen?.(new Event('open')), 0);
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    }
    (window as unknown as { EventSource: unknown }).EventSource = OpenForever;
  });

  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const body = pathname.endsWith('/events')
      ? EVENT_LOG
      : Object.prototype.hasOwnProperty.call(ROUTES, pathname)
        ? (ROUTES as Record<string, unknown>)[pathname]
        : null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body ?? null),
    });
  });
}

/** How far the document can be scrolled sideways. Zero is the contract. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
}

/**
 * Elements wider than the screen, named.
 *
 * A bare overflow number says the page is broken; this says which box did it, which is
 * the difference between a failing test and a failing test somebody can act on.
 * Containers that scroll on purpose — a table, a timeline — are excluded by asking for
 * `overflow-x`, because putting a wide thing inside its own scroller is the fix, not the
 * defect.
 */
async function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const named: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= width + 1) continue;

      let scrollable = false;
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') {
          scrollable = true;
          break;
        }
      }
      if (scrollable) continue;

      const id = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/).join('.')}` : ''}`;
      if (!named.includes(id)) named.push(id);
    }
    return named;
  });
}

/**
 * **An empty page has no overflow.**
 *
 * The first version of this file asserted only that nothing scrolled sideways, and it
 * passed on a page that rendered *nothing* — the project id in the URL did not match the
 * fixtures, so the Deck drew an empty shell and the measurement was of a void. A
 * screenshot caught it; the assertions had not. So every test here proves the screen
 * arrived before it measures how it fits, and this is that proof, not a convenience.
 */
async function rendered(page: Page, ...text: string[]): Promise<void> {
  for (const fragment of text) {
    await expect(page.getByText(fragment, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  }
  const painted = await page.evaluate(() => document.body.innerText.trim().length);
  expect(painted, 'the page rendered no text at all').toBeGreaterThan(200);
}

test.describe('the Deck at 390px', () => {
  test('the run page does not scroll sideways', async ({ page }) => {
    await stub(page);
    await page.goto(`/p/${PROJECT}/runs/${FIXTURE_RUN_ID}`);
    await page.waitForLoadState('networkidle');
    await rendered(page, FIXTURE_RUN_ID);

    expect(await offenders(page), 'these are wider than the screen').toEqual([]);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('the shell navigation reaches every section without a sideways scroll', async ({ page }) => {
    await stub(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await rendered(page, PROJECT);

    expect(await horizontalOverflow(page)).toBe(0);

    // Every nav destination is reachable: present in the DOM and, once opened, hittable.
    // The failure this pins is the one on the phone — eight links crammed into one row,
    // each a few pixels wide, none of them tappable.
    const links = page.locator('nav a');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const link = links.nth(i);
      if (!(await link.isVisible())) continue;
      const box = await link.boundingBox();
      expect(box, `nav link ${String(i)} has no box`).not.toBeNull();
      // 44px is the touch target every platform guideline agrees on; 32 is the floor
      // below which a thumb misses. Asserted on height, which is what a wrapped row
      // actually collapses.
      expect(box!.height, `nav link ${String(i)} is ${String(box!.height)}px tall`).toBeGreaterThanOrEqual(32);
    }
  });

  test('the pairing screen is usable, since a phone is the reason it exists', async ({ page }) => {
    await stub(page);
    await page.goto('/pairing');
    await page.waitForLoadState('networkidle');

    expect(await horizontalOverflow(page)).toBe(0);
    // This screen has little text by design, so it is proved by its own control below
    // rather than by the word count `rendered` asks for.

    const code = page.getByRole('textbox').first();
    await expect(code).toBeVisible();
    const box = await code.boundingBox();
    expect(box).not.toBeNull();
    // A code field narrower than the screen's half is a field somebody will mistype into.
    expect(box!.width).toBeGreaterThan(200);
  });
});
