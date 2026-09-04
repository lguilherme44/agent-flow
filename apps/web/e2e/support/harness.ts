import { expect, test as base, type Page, type Request } from '@playwright/test';
import { createWorld, type World, type WorldOptions } from './world';

/**
 * The E2E fixture: a world per test, torn down whatever happened.
 *
 * A factory rather than a ready-made world, because the scenarios need different
 * ones — a workspace of two projects, a project with no runs, a run whose executor
 * points at a missing binary — and building all of that for every test would pay
 * for six servers to answer one question.
 *
 * Teardown is registered *before* the test body, not inside it: a spec that fails
 * halfway must still leave no server holding a port and no directory in `/tmp`.
 */
export const test = base.extend<{
  makeWorld: (options?: WorldOptions) => Promise<World>;
}>({
  makeWorld: async ({}, use) => {
    const worlds: World[] = [];

    await use(async (options?: WorldOptions) => {
      const world = await createWorld(options);
      worlds.push(world);
      return world;
    });

    for (const world of worlds) await world.dispose();
  },
});

export { expect };

/** Where the dashboard settles: the run header carries the id. */
export async function openDashboard(page: Page, world: World, path = '/dashboard'): Promise<string> {
  await page.goto(`${world.url}${path}`);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(/^AF-\d{4}-\d{3}$/);
  // The stream, not a timer. Everything after this can rely on an event arriving
  // rather than on a poll eventually noticing.
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return (await heading.textContent()) ?? '';
}

/**
 * Move to a run surface the way a person does (M8.5).
 *
 * A run page draws one surface at a time now: the board opens, and the pipeline, the
 * table, the summaries, the review, the delivery record and the team are tabs beside it.
 * A spec that wants a `<tr>` or the stage list says so, and says it by clicking the tab
 * rather than by rewriting the address — a test that navigated by URL would pass over a
 * tab strip that rendered nothing, which is exactly the failure `?panel=` had for two
 * milestones.
 */
export async function openSurface(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

/** The task table, which is where `getByRole('row')` finds a task. */
export async function openTasks(page: Page): Promise<void> {
  await openSurface(page, 'Tasks');
  await expect(page.getByRole('table')).toBeVisible();
}

/** The pipeline, the plan, the artifacts and the model spend. */
export async function openOverview(page: Page): Promise<void> {
  await openSurface(page, 'Overview');
  await expect(page.getByRole('list', { name: 'Pipeline' })).toBeVisible();
}

/** Records every request the browser makes, for the assertions that are about that. */
export function recordRequests(page: Page): {
  readonly all: Array<{ method: string; url: string; body: string }>;
  countOf(pathname: string): number;
} {
  const all: Array<{ method: string; url: string; body: string }> = [];

  page.on('request', (request: Request) => {
    all.push({ method: request.method(), url: request.url(), body: request.postData() ?? '' });
  });

  return {
    all,
    countOf: (pathname) =>
      all.filter((entry) => new URL(entry.url).pathname === pathname).length,
  };
}

/** Console errors and page exceptions, which no scenario is allowed to produce. */
export function recordConsole(page: Page): string[] {
  const problems: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));

  return problems;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((done) => {
    setTimeout(done, ms);
  });
}
