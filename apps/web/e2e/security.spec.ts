import { expect, openDashboard, test } from './support/harness';

/**
 * E2E — the request guard, over a real socket (PRI-05).
 *
 * `test/server/request-guard.test.ts` proves the decision table through `app.inject`,
 * which builds a request object in memory. This suite proves the same thing through a
 * listening port, a real HTTP parse and the real `agent-flow ui` process — the three
 * layers a synthetic request skips, and the ones where a header can be rewritten,
 * normalised or dropped before a hook ever sees it.
 *
 * The request every case here is a variation of is the one that used to answer 202:
 *
 * ```
 * POST /api/v1/runs/:id/start   (no body, foreign Origin)  →  202 {"status":"running"}
 * ```
 *
 * `start` spawns coding agents with write permission inside the repository. So the
 * assertion that matters is not only the status code — it is that the run did not move.
 */

const CLIENT_HEADER = 'x-agent-flow-client';

test.describe('the request guard, over a real port', () => {
  test('refuses the bodyless cross-origin start, and the run does not move', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();
    await world.cli('booking-api', ['approve']);

    const runId = await world.runIdOf('booking-api');
    const before = await world.stateOf('booking-api');

    const response = await page.request.post(
      `${world.url}/api/v1/runs/${runId}/start?project=booking-api`,
      { headers: { origin: 'https://evil.example' } },
    );

    expect(response.status()).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe('origin_not_allowed');

    // The part that actually matters. A 403 with a job already running would be a
    // guard that reports rather than one that guards.
    expect(await world.stateOf('booking-api')).toEqual(before);
  });

  test('refuses a request that names a host this server was not told about', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();

    // DNS rebinding, at the layer it actually arrives on: the browser believes it is
    // same-origin, so `Origin` and `Host` agree and CORS is out of the picture. Only
    // the host guard is left, and it is why the read endpoints are covered too — this
    // one returns the absolute path of every repository the server can see.
    const response = await page.request.get(`${world.url}/api/v1/projects`, {
      headers: { host: 'evil.example' },
    });

    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain('booking-api');
  });

  test('refuses a write with neither an Origin nor the client header', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();
    const runId = await world.runIdOf('booking-api');

    const response = await page.request.post(
      `${world.url}/api/v1/runs/${runId}/reject?project=booking-api`,
      { data: { reason: 'from nowhere' } },
    );

    expect(response.status()).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe('origin_missing');
    expect((await world.stateOf('booking-api'))['status']).not.toBe('rejected');
  });

  test('sends no CORS header, so nothing it answers is readable cross-origin', async ({
    page,
    makeWorld,
  }) => {
    const world = await makeWorld();

    const response = await page.request.get(`${world.url}/api/v1/health`, {
      headers: { origin: 'https://evil.example' },
    });

    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('the dashboard itself still writes, which is the point', async ({ page, makeWorld }) => {
    const world = await makeWorld();

    // Through the browser, not through `page.request`: this is the real bundle making a
    // real same-origin `fetch` with the header it ships with. A guard the product cannot
    // get past is not a guard, it is an outage.
    await openDashboard(page, world);
    await page.getByRole('button', { name: /Approve/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /Approve Plan/i }).click();
    await expect(dialog).toHaveCount(0);

    await expect
      .poll(async () => (await world.stateOf('booking-api'))['approved'], { timeout: 15_000 })
      .toBe(true);
  });

  test('a headless client gets in on the client header alone', async ({ page, makeWorld }) => {
    const world = await makeWorld();
    const runId = await world.runIdOf('booking-api');

    const response = await page.request.post(
      `${world.url}/api/v1/runs/${runId}/reject?project=booking-api`,
      { data: { reason: 'from a script' }, headers: { [CLIENT_HEADER]: 'e2e' } },
    );

    expect(response.status()).toBe(200);
  });
});
