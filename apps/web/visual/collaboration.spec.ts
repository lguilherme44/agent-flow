import { test, expect } from '@playwright/test';
import { FIXTURE_RUN_ID } from './fixtures';
import { stubApi, settle } from './harness';

/**
 * The collaboration panel, as a person sees it (M4-07).
 *
 * A picture rather than DOM assertions, for the reason the rest of this suite exists: the
 * component tests all passed while this panel could still have clipped a message, wrapped
 * a badge onto its own line, or drawn the contested notice in a colour that reads as
 * decoration. "The element exists" is not "the layout is right".
 *
 * The fixture is composed to put every branch in one frame — an answered thread, an open
 * one, a pending handoff, a plain decision and a contested pair — because the branch whose
 * styling is easiest to get wrong is the one nobody photographs.
 */

test.describe('collaboration', () => {
  test('the panel, with a contested decision and an open thread', async ({ page }) => {
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    // Located through its heading rather than by a role name: `Card` renders a
    // `<section>` with an `<h2>`, and a section only becomes a named region with an
    // explicit `aria-label`. Adding one to every card in the product is an
    // accessibility improvement worth making and is not this milestone's to make.
    const panel = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Collaboration' }),
    });
    await panel.scrollIntoViewIfNeeded();

    // The one line whose absence would be a silent product failure: two agents disagree
    // and nothing mechanical settles it, so the screen has to say so.
    await expect(panel.getByText('2 contested entry(ies)')).toBeVisible();
    await expect(panel.getByText(/nothing decides it for you/)).toBeVisible();

    await expect(panel).toHaveScreenshot('collaboration-panel.png');
  });

  test('a run whose agents never spoke says which of the two reasons it is', async ({ page }) => {
    await stubApi(page, {
      [`/api/v1/runs/${FIXTURE_RUN_ID}/collaboration`]: {
        enabled: false,
        agents: [],
        threads: [],
        handoffs: [],
        entries: [],
      },
    });
    await page.goto('/dashboard');
    await settle(page);

    // The panel is not rendered at all when there is nothing in it. That is the point:
    // a project that has not opted in sees exactly the bottom row it saw before M4, and
    // an always-empty card for a feature that ships off would be a box on every
    // dashboard forever.
    await expect(page.getByRole('heading', { name: 'Collaboration' })).toHaveCount(0);
  });
});
