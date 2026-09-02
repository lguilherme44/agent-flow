import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_RUN_ID, RUN } from './fixtures';
import { settle, stubApi } from './harness';

test.describe('run detail', () => {
  test('the whole composition, nothing selected', async ({ page }) => {
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    // The header, the metric strip and the execution summary all count the same
    // tasks. They read from different responses, so a fixture — or a server —
    // that let them drift would put two different truths on one screen.
    await expect(page.getByText('3 / 9')).toHaveCount(2);

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
    //
    // **Scoped to `main`'s non-header children, not to `main`.** The comment above this
    // assertion always said the breadcrumb was excluded as navigation; the selector never
    // excluded it, because `<Topbar>` — and therefore the breadcrumb — is rendered *inside*
    // `<main className="main-content">`. That was harmless until the breadcrumb learned to
    // name the selected task, at which point this counted three and the check had been
    // asserting something other than what it says for as long as it had been failing.
    await expect(
      page.locator('main > *:not(header)').getByText('Recurrence Repository'),
    ).toHaveCount(width >= 1200 ? 2 : 1);
  });

  test('the drawer traps focus, closes on the overlay, and hands focus back', async ({
    page,
  }, info) => {
    // UI-P01, and only meaningful where layout and hit testing are real. Radix
    // supplies the trap; the focus *return* is ours, because a modal Radix dialog
    // restores focus to a `Trigger` and this drawer opens from a table row.
    const width = info.project.use.viewport?.width ?? 0;
    test.skip(width >= 1200, 'the drawer only exists below 1200');

    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    const row = page.getByRole('row').filter({ hasText: 'Recurrence Repository' });
    await row.scrollIntoViewIfNeeded();
    await row.click();

    const drawer = page.getByRole('dialog', { name: 'Task inspector' });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    // Tab all the way round the panel. Every stop has to be inside it: the table
    // is still on screen behind the overlay, and to a keyboard it is still there.
    for (let stop = 0; stop < 12; stop += 1) {
      await page.keyboard.press('Tab');
      const inside = await drawer.evaluate((panel) =>
        panel.contains(document.activeElement),
      );
      expect(inside, `focus left the drawer after ${String(stop + 1)} tabs`).toBe(true);
    }

    // The overlay is the region outside the panel. Clicking the top-left corner
    // of the viewport lands on it at every width the drawer exists at.
    await page.mouse.click(8, 8);
    await expect(drawer).toHaveCount(0);

    // And focus is back on the row, not on the body.
    await expect(row).toBeFocused();
  });

  test('the pipeline says when a stage is scrolled out of sight', async ({ page }, info) => {
    // UI-P02. Nine stages fit on one line at 1440 and do not below it, so the
    // affordance has to appear at exactly the widths where content is hidden —
    // which is why it is measured rather than driven by a breakpoint.
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    const pipeline = page.getByRole('list', { name: 'Pipeline' });
    const hidden = await pipeline.evaluate((row) => row.scrollWidth - row.clientWidth);
    const width = info.project.use.viewport?.width ?? 0;

    // The fade is the sibling gradient, identified by what it is for rather than
    // by a test id: it is the only absolutely-positioned decoration in the panel.
    const fades = page.locator('[aria-label="Pipeline"] ~ span[aria-hidden="true"]');

    if (hidden <= 1) {
      expect(width, 'a row that fits should only fit at the full layout width').toBe(1440);
      await expect(fades).toHaveCount(0);
      return;
    }

    // At the start: one fade, on the right, because that is where the content is.
    await expect(fades).toHaveCount(1);

    await pipeline.evaluate((row) => {
      row.scrollLeft = row.scrollWidth;
    });
    // At the end: one fade, on the left. Never a fade pointing at nothing.
    await expect(fades).toHaveCount(1);
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

  test('nothing clips a value it has room for', async ({ page }) => {
    // Fixed widths are measured, not guessed, and a measurement goes stale the
    // moment a label changes. This is the instrument: anything whose text is wider
    // than the box it was given is reported by name, so "WAITING FOR APPRO…" fails
    // here instead of being noticed in a screenshot months later — or not noticed
    // at all, because an ellipsis looks deliberate.
    //
    // Every element on the page, not only table cells: a panel header truncates
    // the same way, and the first version of this check walked `th, td` only.
    await stubApi(page);

    for (const route of ['/dashboard', '/runs', '/projects', '/agents', '/prompts', '/analytics']) {
      await page.goto(route);
      await expect(page.getByRole('heading').first()).toBeVisible();
      // Recharts and the overflow observers both settle on the next frame.
      await page.waitForTimeout(300);

      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((node) => {
            const style = getComputedStyle(node);
            // Only the elements that promised not to wrap. A `line-clamp` cell is
            // designed to run out of room; a `truncate` cell is designed to fit.
            if (style.textOverflow !== 'ellipsis') return false;
            // A title attribute is an explicit "this may not fit, here is the
            // rest" — the feature title and the path are both that on purpose.
            if (node.hasAttribute('title')) return false;
            return node.scrollWidth > node.clientWidth + 1;
          })
          .map((node) => `${node.tagName.toLowerCase()}: ${node.textContent ?? ''}`),
      );

      expect(clipped, `clipped cells on ${route}`).toEqual([]);
    }
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
    // Five runs and a header. Waiting on the last row rather than the first, so
    // the shot cannot catch a table that is still filling in.
    await expect(page.getByRole('row')).toHaveCount(6);

    await expect(page).toHaveScreenshot('runs-list.png', { fullPage: false });
  });

  test('filters narrow the list without going back to the server', async ({ page }) => {
    const requests: string[] = [];
    await stubApi(page);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/v1/runs')) requests.push(url.pathname + url.search);
    });

    await page.goto('/runs');
    await expect(page.getByRole('row')).toHaveCount(6);
    const before = requests.length;

    await page.getByLabel('Status').selectOption('failed');
    await expect(page.getByRole('row')).toHaveCount(2);
    expect(requests.length, 'a local filter must not cost a round trip').toBe(before);

    await expect(page).toHaveScreenshot('runs-list-filtered.png', { fullPage: false });
  });
});

test.describe('projects', () => {
  test('renders the registry', async ({ page }) => {
    await stubApi(page);
    await page.goto('/projects');
    // Four projects and a header row, one of them never run — the row that has
    // to read as a project rather than as a broken one.
    await expect(page.getByRole('row')).toHaveCount(5);
    const fresh = page.getByRole('row').filter({ hasText: 'company-project' });
    await expect(fresh.getByText('idle')).toBeVisible();
    await expect(fresh.getByText('none finished')).toBeVisible();

    await expect(page).toHaveScreenshot('projects.png', { fullPage: false });
  });

  test('shows runner health once a project is in scope', async ({ page }) => {    await stubApi(page);
    await page.goto('/projects');
    await expect(page.getByRole('row')).toHaveCount(5);

    // Nothing selected: there is no project this would be the health of, and the
    // page does not ask the server for it either.
    await expect(page.getByRole('list', { name: 'Runner health' })).toHaveCount(0);

    const project = page.getByRole('row').filter({ hasText: 'beahub-api' });
    await project.getByRole('button', { name: 'Select' }).click();

    await expect(page.getByRole('list', { name: 'Runner health' })).toBeVisible();
    await expect(page).toHaveScreenshot('projects-selected.png', { fullPage: false });
  });
});

test.describe('agents and models', () => {
  test('renders the routing table', async ({ page }) => {
    await stubApi(page);
    await page.goto('/agents');
    // Nine roles and a header row. §82 names nine; a page showing eight leaves
    // somebody wondering which one is missing and whether that is the bug.
    await expect(page.getByRole('row')).toHaveCount(10);
    await expect(page.getByText('1 role cannot be resolved')).toBeVisible();

    await expect(page).toHaveScreenshot('agents.png', { fullPage: false });
  });
});

test.describe('prompts', () => {
  test('renders the viewer with the first prompt open', async ({ page }) => {
    await stubApi(page);
    await page.goto('/prompts');
    await expect(page.getByText(/A component is affected if/)).toBeVisible();

    await expect(page).toHaveScreenshot('prompts.png', { fullPage: false });
  });
});

test.describe('analytics', () => {
  test('renders the aggregates', async ({ page }) => {
    await stubApi(page);
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Time per stage' })).toBeVisible();
    // Recharts measures its container and draws on the next frame.
    await page.waitForTimeout(300);

    await expect(page).toHaveScreenshot('analytics.png', { fullPage: false });
  });
});

/** The reference run, still awaiting judgement. */
const AWAITING = {
  [`/api/v1/runs/${FIXTURE_RUN_ID}`]: {
    ...RUN,
    status: 'waiting_for_approval',
    approved: false,
    progress: 0,
    completedTasks: 0,
  },
};

test.describe('the human gate', () => {
  test('shows the verdict, the findings and both hashes', async ({ page }) => {
    await stubApi(page, AWAITING);
    await page.goto('/dashboard');
    await settle(page);

    await page.getByRole('button', { name: 'Review & approve' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByText('Plan review: FAIL')).toBeVisible();

    await expect(page).toHaveScreenshot('approval-gate.png', { fullPage: false });
  });

  test('traps focus, closes on Escape, and gives focus back', async ({ page }) => {
    await stubApi(page, AWAITING);
    await page.goto('/dashboard');
    await settle(page);

    const trigger = page.getByRole('button', { name: 'Review & approve' });
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Every tab stop inside the modal. The run behind it is still on screen and,
    // to a keyboard, still there.
    for (let stop = 0; stop < 10; stop += 1) {
      await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((panel) => panel.contains(document.activeElement));
      expect(inside, `focus left the dialog after ${String(stop + 1)} tabs`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Back on the button that opened it, not on the body.
    await expect(trigger).toBeFocused();
  });

  test('will not approve over a refusal until the override is deliberate', async ({ page }) => {
    await stubApi(page, AWAITING);
    await page.goto('/dashboard');
    await settle(page);

    await page.getByRole('button', { name: 'Review & approve' }).click();
    const dialog = page.getByRole('dialog');

    await expect(dialog.getByRole('button', { name: 'Approve Plan' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /Approve over this refusal/i }).check();
    await expect(dialog.getByRole('button', { name: 'Approve over the review' })).toBeEnabled();
  });

  test('asks what should change, and sends only that', async ({ page }) => {
    const posted: { url: string; body: string }[] = [];
    await stubApi(page, AWAITING);
    page.on('request', (request) => {
      if (request.method() === 'POST') {
        posted.push({ url: request.url(), body: request.postData() ?? '' });
      }
    });

    await page.goto('/dashboard');
    await settle(page);

    await page.getByRole('button', { name: 'Revise' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Request revision' })).toBeDisabled();

    await dialog.getByRole('textbox').fill('Split TASK-004 into service and rules.');
    await expect(page).toHaveScreenshot('revision.png', { fullPage: false });
  });
});

test.describe('settings', () => {
  test('renders the effective configuration with its origins', async ({ page }) => {
    await stubApi(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Execution' })).toBeVisible();

    await expect(page).toHaveScreenshot('settings.png', { fullPage: false });
  });
});

/**
 * `prefers-reduced-motion`, from both sides (§97).
 *
 * The control case is not padding: an assertion that nothing moves, run against a
 * page that never moved, passes for the wrong reason — and would keep passing after
 * somebody deleted the base rule. So the first test proves the fixture genuinely
 * animates something before the second one claims it stopped.
 *
 * Durations are read as numbers rather than compared as strings. The rule is written
 * `0.01ms` and Chromium reports it back as `0.00001s`, so an equality check against
 * the authored text would be asserting a serialisation format instead of a fact.
 */
const MOVING_MS = 1;

/** Every element whose computed animation or transition lasts long enough to see. */
async function movingElements(page: Page): Promise<string[]> {
  return page.evaluate((limit) => {
    const asMs = (value: string): number => {
      const text = value.trim();
      const amount = Number.parseFloat(text);
      if (Number.isNaN(amount)) return 0;
      return text.endsWith('ms') ? amount : amount * 1000;
    };

    return [...document.querySelectorAll('body *')]
      .filter((node) => {
        const style = getComputedStyle(node);
        return [style.animationDuration, style.transitionDuration]
          .flatMap((value) => value.split(','))
          .some((value) => asMs(value) > limit);
      })
      .map((node) => `${node.tagName.toLowerCase()}.${node.getAttribute('class') ?? ''}`);
  }, MOVING_MS);
}

test.describe('motion', () => {
  test('stops under reduce, and loses nothing by stopping', async ({ page }) => {
    await stubApi(page);
    await page.goto('/dashboard');
    await settle(page);

    // The control half, on the same DOM rather than in a second test: the fixture
    // has a stage in flight and a running task, so their markers spin. Without
    // this the assertion below would pass just as happily against a page that
    // never moved — including after somebody deleted the base rule.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect((await movingElements(page)).length).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await movingElements(page), 'elements still moving under reduce').toEqual([]);

    // And the reason stopping it is safe rather than lossy: the status was never
    // in the animation. If a future state ever needs its spinner to be legible,
    // this fails — which is the point.
    await expect(page.getByText('RUNNING').first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Pipeline' })).toContainText('running');
  });
});
