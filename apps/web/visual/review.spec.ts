import { test, expect } from '@playwright/test';
import { FIXTURE_RUN_ID, REVIEW } from './fixtures';
import { stubApi, settle } from './harness';

/**
 * The review surfaces, as a person sees them (§57).
 *
 * A picture rather than DOM assertions, for the reason the rest of this suite exists: the
 * component tests all passed while this panel could still clip a finding, wrap a severity
 * badge onto its own line, or draw `not run` in the same grey as `not applicable` — which
 * would make absence of evidence read as absence of relevance.
 *
 * **The review is an override rather than the shared fixture.** Putting one in `ROUTES`
 * would add a card to every screenshot in the suite and move every baseline at once. Most
 * runs have no reviewer, so the shared fixture is the honest default.
 */

const WITH_REVIEW = { [`/api/v1/runs/${FIXTURE_RUN_ID}/review`]: REVIEW };

/**
 * The panel, on the tab M8.5 moved it to.
 *
 * It used to be a second row under the four summary cards, 1300 pixels below the fold on a
 * page that also carried the pipeline, the board and four more panels. The tab is what
 * that absence became — a run with a reviewer has one, a run without has none, and the
 * "absent rather than empty" discipline the panel already applied to itself now decides
 * whether there is a door at all.
 */
async function panel(page: import('@playwright/test').Page) {
  await stubApi(page, WITH_REVIEW);
  await page.goto('/dashboard');
  await settle(page);

  await page.getByRole('tab', { name: 'Review' }).click();

  const card = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Review' }),
  });
  await expect(card).toBeVisible();
  return card;
}

test.describe('review', () => {
  test('the panel, with an unsatisfied gate above three changes', async ({ page }) => {
    const card = await panel(page);

    // The line whose absence would be a silent product failure: a required gate that did
    // not run is not a gate that passed, and it must not read as a detail.
    await expect(card.getByText('2 required gate(s) unsatisfied')).toBeVisible();
    await expect(card.getByText(/no command is configured/)).toBeVisible();
    // Status in words, not colour alone (§97).
    await expect(card.getByText('changes requested')).toBeVisible();
    // Exact, because the footer also counts stale reviews and a loose match finds both.
    await expect(card.getByText('stale', { exact: true })).toBeVisible();

    await expect(card).toHaveScreenshot('review-panel.png');
  });

  test('a change with its findings open', async ({ page }) => {
    const card = await panel(page);
    const thread = card.locator('details').filter({ hasText: 'TASK-003' });
    await thread.locator('summary').click();

    // Exact: the id also appears in the "Blocked:" line, which is the detail rather than
    // the condition's name — and that difference is the point of the line.
    await expect(thread.getByText('FIND-0001', { exact: true })).toBeVisible();
    await expect(thread.getByText('critical', { exact: true })).toBeVisible();
    await expect(thread.getByText('src/server/routes.ts:84')).toBeVisible();

    await expect(thread).toHaveScreenshot('review-findings-open.png');
  });

  test('a change awaiting a recheck, with the fix already named', async ({ page }) => {
    // `fixed` without a corrective task is a claim; with one it is a thing to go and read.
    const card = await panel(page);
    const thread = card.locator('details').filter({ hasText: 'TASK-004' });
    await thread.locator('summary').click();

    await expect(thread.getByText('→ FIX-001')).toBeVisible();
    await expect(thread.getByText(/read bbbbbbbb and cccccccc is integrated/)).toBeVisible();

    await expect(thread).toHaveScreenshot('review-awaiting-recheck.png');
  });

  test('every gate, including the two that did not run', async ({ page }) => {
    const card = await panel(page);
    const gates = card.locator('div').filter({ hasText: 'Quality gates' }).last();

    await expect(gates.getByText('not run')).toBeVisible();
    await expect(gates.getByText('not applicable')).toBeVisible();
    // §30, and the reason the panel exists: `failed` and `not run` are different news.
    // A picture is the only thing that can show they do not render alike.
    await expect(gates.getByText('failed')).toBeVisible();
    await expect(gates.getByText('passed').first()).toBeVisible();

    await expect(gates).toHaveScreenshot('review-quality-gates.png');
  });
});

/**
 * The two states the panel must be able to show and had no picture of (§30).
 *
 * `approved` is in the shared fixture and was only ever seen collapsed, and a *green*
 * review is the state a person sees most often once the product works — the one whose
 * layout nobody checks because nothing is wrong in it.
 */
test.describe('review — the states that are not problems', () => {
  test('an approved change, opened', async ({ page }) => {
    const card = await panel(page);
    const thread = card.locator('details').filter({ hasText: 'TASK-005' });
    await thread.locator('summary').click();

    await expect(thread.getByText('approved')).toBeVisible();
    // No badge, no blocked line, no corrective task — absence is the design here, and it
    // is exactly the kind of thing a DOM test cannot tell from a broken render.
    await expect(thread.getByText('Blocked:')).toHaveCount(0);

    await expect(thread).toHaveScreenshot('review-approved.png');
  });
})
