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
  await expect(page.getByText('Agent Flow is running')).toBeVisible();
  return (await heading.textContent()) ?? '';
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
