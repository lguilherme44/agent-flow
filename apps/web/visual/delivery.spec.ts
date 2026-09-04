import { test, expect } from '@playwright/test';
import { DELIVERY, FIXTURE_RUN_ID } from './fixtures';
import { settle, stubApi } from './harness';

/**
 * Delivery, photographed for the first time (M7 §57, M8.5 §18).
 *
 * **This panel has existed since M7 and no baseline has ever contained it.** The only
 * delivery fixture in the repository is `DELIVERY_NONE`, whose state is `disabled`, so the
 * component's own guard clause returned `null` in all 296 shots. Under that cover it was
 * styled with ten class names — `card`, `card__header`, `delivery__facts`,
 * `badge--delivery-published` and their neighbours — that no stylesheet in this project
 * defines and that are not Tailwind utilities. It rendered as raw HTML: an unstyled
 * heading, a `<dl>` with browser default margins, a bulleted list.
 *
 * Nothing was going to catch that. A class nobody writes down fails no compiler, no linter
 * and no DOM assertion — the element is there, it simply has no style. A picture is the
 * only instrument that reports it, and a picture needs a fixture that renders the thing.
 *
 * The absent case keeps its own coverage: the reference run still answers `DELIVERY_NONE`
 * everywhere else in this suite, so "no forge means no panel and no tab" stays
 * photographed by every other shot rather than by a special one.
 */

const RUN_URL = `/runs/${FIXTURE_RUN_ID}`;
const WITH_DELIVERY = { [`/api/v1/runs/${FIXTURE_RUN_ID}/delivery`]: DELIVERY };

test.describe('delivery', () => {
  test('a run with no forge carries no Delivery tab', async ({ page }) => {
    // Absent rather than empty, one level up from where the panel already applied it. Most
    // runs deliver nowhere, and a permanently empty tab is the same box on every dashboard
    // forever — it just costs horizontal pixels instead of vertical ones.
    await stubApi(page);
    await page.goto(RUN_URL);
    await settle(page);

    await expect(page.getByRole('tab', { name: 'Delivery' })).toHaveCount(0);
  });

  test('a run that published shows where it went, and what the forge says about it', async ({
    page,
  }) => {
    await stubApi(page, WITH_DELIVERY);
    await page.goto(RUN_URL);
    await settle(page);

    await page.getByRole('tab', { name: 'Delivery' }).click();
    await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible();

    // **The words, as well as the picture.** A screenshot diff has a tolerance and a badge
    // changing from `checks red` to `checks green` fits inside it — and those two are the
    // difference between "a check failed" and "everything passed".
    await expect(page.getByText('checks red')).toBeVisible();
    await expect(page.getByText('lguilherme44/beahub')).toBeVisible();
    await expect(page.getByRole('link', { name: /#413/ })).toBeVisible();

    // The sentence that has to be on the page. A person who sees red and nothing else
    // concludes the run failed; it did not, and the panel says so where they are looking.
    await expect(
      page.getByText(/These are observations\. The local quality decision is already made/),
    ).toBeVisible();

    // Each check under its own reported conclusion, never folded into one verdict.
    await expect(page.getByText('success')).toHaveCount(2);
    await expect(page.getByText('failure')).toHaveCount(1);
    await expect(page.getByText('in progress')).toHaveCount(1);

    await expect(page).toHaveScreenshot('delivery.png', { fullPage: false });
  });

  test('the delivery surface scrolls nothing sideways', async ({ page }) => {
    await stubApi(page, WITH_DELIVERY);
    await page.goto(RUN_URL);
    await settle(page);
    await page.getByRole('tab', { name: 'Delivery' }).click();
    await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  });
});
