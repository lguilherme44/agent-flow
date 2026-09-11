import http from 'node:http';
import { URL } from 'node:url';
import { expect, test } from './support/harness';

/**
 * E2E — Device pairing and remote session access over a real socket (TASK-008).
 *
 * Proves the feature over a real port, real HTTP parsing and a real browser, driving
 * `agent-flow ui --pair` without app.inject.
 *
 * Verifies in order:
 * 1. An unpaired remote read is 401 on every /api/v1 route it tries (FR-008, SDD 10)
 * 2. The static bundle is served to that same peer anyway (FR-009, SDD 11)
 * 3. The printed code pairs a device (FR-005, SEC-003, SEC-004, SDD 15)
 * 4. The paired device reads and approves a gate (FR-005, SDD 16)
 * 5. A cross-origin bodyless write from the paired device is refused origin_not_allowed (SEC-005, SDD 41)
 * 6. Host header filtering admits the bound LAN address and refuses foreign hosts (FR-018, SEC-006, SDD 42)
 * 7. The same pairing code presented by a second device is refused (FR-004, SDD 17)
 * 8. Revoking closes the device's open EventSource before the revoke response is sent (FR-012, FR-015, SDD 24, SDD 25)
 * 9. Stopping and restarting the process unpairs every device and invalidates old codes (FR-024, SDD 27)
 */

function connectEventSource(
  eventsUrl: string,
  cookieHeader: string,
  extraHeaders: Record<string, string> = {},
): Promise<{
  isClosed: () => boolean;
  waitForConnect: () => Promise<void>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let closed = false;
    let connected = false;
    let onConnected: (() => void) | undefined;
    const connectPromise = new Promise<void>((r) => {
      onConnected = r;
    });

    const parsed = new URL(eventsUrl);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          cookie: cookieHeader,
          ...extraHeaders,
        },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (!connected && chunk.includes(': connected')) {
            connected = true;
            onConnected?.();
          }
        });
        res.on('end', () => {
          closed = true;
        });
        res.on('close', () => {
          closed = true;
        });
      },
    );

    req.on('error', (err) => {
      closed = true;
      if (!connected) {
        reject(err);
      }
    });

    req.end();

    resolve({
      isClosed: () => closed,
      waitForConnect: () => connectPromise,
      close: () => {
        try {
          req.destroy();
        } catch {
          // Socket already closed
        }
      },
    });
  });
}

test.describe('device pairing over a real socket', () => {
  test('proves the pairing lifecycle end to end', async ({ page, makeWorld, browser }) => {
    const world = await makeWorld({ dashboard: 'deck', pair: true, host: '0.0.0.0' });
    const project = 'booking-api';
    const runId = await world.runIdOf(project);

    // Read the printed pairing code and bound addresses from stdout
    const codeMatch = world.output.match(/Pairing code:\s*([a-zA-Z0-9-]+)/);
    expect(codeMatch, 'pairing code printed in stdout').not.toBeNull();
    const printedCode = codeMatch?.[1];
    if (printedCode === undefined) throw new Error('pairing code not found in output');

    const urlMatches = [...world.output.matchAll(/http:\/\/([^\s:/]+):(\d+)/g)];
    const lanEntry = urlMatches.find((m) => m[1] !== '127.0.0.1' && m[1] !== 'localhost') ?? urlMatches[0];
    const boundAddress = lanEntry?.[1] ?? '127.0.0.1';
    const boundPort = lanEntry?.[2] ?? new URL(world.url).port;
    const targetUrl = `http://${boundAddress}:${boundPort}`;

    const remotePeerHeaders = { 'x-forwarded-for': '198.51.100.1' };
    await page.setExtraHTTPHeaders(remotePeerHeaders);

    // ── 1. Unpaired remote read is 401 on every /api/v1 route (FR-008, SDD 10) ──
    const apiRoutes = [
      `${targetUrl}/api/v1/projects`,
      `${targetUrl}/api/v1/runs?project=${project}`,
      `${targetUrl}/api/v1/runs/${runId}?project=${project}`,
      `${targetUrl}/api/v1/runs/${runId}/artifacts/sdd?project=${project}`,
      `${targetUrl}/api/v1/doctor`,
      `${targetUrl}/api/v1/config`,
      `${targetUrl}/api/v1/events`,
    ];

    for (const route of apiRoutes) {
      const res = await page.request.get(route, { headers: remotePeerHeaders });
      expect(res.status(), `route ${route} must return 401 when unpaired`).toBe(401);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('session_required');
    }

    const projectsRes = await page.request.get(`${targetUrl}/api/v1/projects`, { headers: remotePeerHeaders });
    const projectsText = await projectsRes.text();
    expect(projectsText).not.toContain(project);
    expect(projectsText).not.toContain(world.dirOf(project));

    // ── 2. Static bundle is served to the same peer anyway (FR-009, SDD 11) ─────
    const rootRes = await page.request.get(`${targetUrl}/`, { headers: remotePeerHeaders });
    expect(rootRes.status()).toBe(200);
    const rootText = await rootRes.text();
    expect(rootText).not.toContain(project);
    expect(rootText).not.toContain(runId);
    expect(rootText).not.toContain(world.dirOf(project));

    const clientRouteRes = await page.request.get(`${targetUrl}/p/${project}/runs/${runId}`, {
      headers: remotePeerHeaders,
    });
    expect(clientRouteRes.status()).toBe(200);
    const clientRouteText = await clientRouteRes.text();
    expect(clientRouteText).not.toContain(project);
    expect(clientRouteText).not.toContain(runId);
    expect(clientRouteText).not.toContain(world.dirOf(project));

    // ── 3. Printed code pairs a device (FR-005, SEC-003, SEC-004, SDD 15) ────────
    await page.goto(targetUrl);
    await expect(page.getByRole('heading', { name: /Pair Device/i })).toBeVisible();

    await page.locator('input.mono').fill(printedCode);

    const pairPromise = page.waitForResponse(
      (r) => r.url().includes('/api/v1/pair') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Pair Device/i }).click();

    const pairResponse = await pairPromise;
    expect(pairResponse.status()).toBe(200);

    const pairBody = (await pairResponse.json()) as Record<string, unknown>;
    expect(pairBody['deviceId']).toBeDefined();
    expect(pairBody['label']).toBeDefined();
    expect(pairBody['pairedAt']).toBeDefined();
    expect(pairBody['secret']).toBeUndefined();

    const setCookie = pairResponse.headers()['set-cookie'] ?? '';
    expect(setCookie).toContain('agent-flow-session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === 'agent-flow-session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Strict');
    expect(sessionCookie?.path).toBe('/');
    expect(sessionCookie?.secure).toBe(false);

    const deviceId = pairBody['deviceId'] as string;

    // ── 4. Paired device reads and approves a gate (FR-005, SDD 16) ─────────────
    await page.goto(`${targetUrl}/p/${project}/runs/${runId}`);
    await expect(page.getByRole('heading', { name: runId })).toBeVisible();

    await page.getByRole('button', { name: /Review the plan/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Approve plan/i }).click();

    await expect
      .poll(async () => (await world.stateOf(project))['approved'], { timeout: 15_000 })
      .toBe(true);

    const eventLogText = await world.readProjectFile(project, `.agent-flow/runs/${runId}/events.jsonl`);
    const events = eventLogText
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; detail: { action?: string; actor?: Record<string, unknown> } });
    const opAction = events.find((e) => e.type === 'operator_action');
    expect(opAction).toBeDefined();
    expect(opAction?.detail?.action).toBe('approve');
    expect(opAction?.detail?.actor).toEqual({
      kind: 'device',
      deviceId,
      label: 'Deck Browser',
    });

    // ── 5. Cross-origin bodyless write is refused origin_not_allowed (SEC-005, SDD 41) ──
    const beforeState = await world.stateOf(project);
    const crossOriginRes = await page.request.post(
      `${targetUrl}/api/v1/runs/${runId}/start?project=${project}`,
      {
        headers: {
          origin: 'https://evil.example',
          ...remotePeerHeaders,
        },
      },
    );
    expect(crossOriginRes.status()).toBe(403);
    expect(((await crossOriginRes.json()) as { error: string }).error).toBe('origin_not_allowed');
    expect(await world.stateOf(project)).toEqual(beforeState);

    // ── 6. Host header filtering (FR-018, SEC-006, SDD 42) ───────────────────────
    const evilHostRes = await page.request.get(`${targetUrl}/api/v1/projects`, {
      headers: { host: 'evil.example' },
    });
    expect(evilHostRes.status()).toBe(403);
    expect(((await evilHostRes.json()) as { error: string }).error).toBe('host_not_allowed');

    const unboundHostRes = await page.request.get(`${targetUrl}/api/v1/projects`, {
      headers: { host: '10.254.254.254:4782' },
    });
    expect(unboundHostRes.status()).toBe(403);
    expect(((await unboundHostRes.json()) as { error: string }).error).toBe('host_not_allowed');

    if (boundAddress !== '127.0.0.1') {
      const lanHostRes = await page.request.get(`${targetUrl}/api/v1/projects`, {
        headers: { host: `${boundAddress}:${boundPort}` },
      });
      expect(lanHostRes.status()).toBe(200);
    }

    // ── 7. Same code presented by a second device is refused (FR-004, SDD 17) ────
    const secondContext = await browser.newContext({
      extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.2' },
    });
    const secondPairRes = await secondContext.request.post(`${targetUrl}/api/v1/pair`, {
      data: { code: printedCode, label: 'Second Device' },
    });
    expect(secondPairRes.status()).toBe(401);
    expect(((await secondPairRes.json()) as { error: string }).error).toBe('unauthorized');
    const secondCookies = await secondContext.cookies();
    expect(secondCookies.find((c) => c.name === 'agent-flow-session')).toBeUndefined();
    await secondContext.close();

    // ── 8. Revoking closes EventSource and 401s next request (FR-012, FR-015, SDD 24, SDD 25) ──
    const sessionCookieValue = sessionCookie?.value;
    if (sessionCookieValue === undefined) throw new Error('session cookie value not found');

    const sse = await connectEventSource(
      `${targetUrl}/api/v1/events`,
      `agent-flow-session=${sessionCookieValue}`,
      remotePeerHeaders,
    );
    await sse.waitForConnect();
    expect(sse.isClosed()).toBe(false);

    const revokeRes = await page.request.post(`${targetUrl}/api/v1/sessions/${deviceId}/revoke`);
    expect(revokeRes.status()).toBe(200);
    expect(((await revokeRes.json()) as { status: string }).status).toBe('revoked');

    await expect.poll(() => sse.isClosed(), { timeout: 3_000 }).toBe(true);
    sse.close();

    const unknownRevokeRes = await page.request.post(`${targetUrl}/api/v1/sessions/unknown-device/revoke`);
    expect(unknownRevokeRes.status()).toBe(404);

    const postRevokeReq = await page.request.get(`${targetUrl}/api/v1/runs?project=${project}`);
    expect(postRevokeReq.status()).toBe(401);
    expect(((await postRevokeReq.json()) as { error: string }).error).toBe('session_invalid');

    // ── 9. Restart unpairs every device and burns old code (FR-024, SDD 27) ───────
    const preStopCookie = sessionCookieValue;
    const preStopCode = printedCode;

    await world.stopServer();
    const newServer = await world.startServer({ pair: true, host: '0.0.0.0', dashboard: 'deck' });

    const newCodeMatch = world.output.match(/Pairing code:\s*([a-zA-Z0-9-]+)/);
    expect(newCodeMatch).not.toBeNull();
    const newPairingCode = newCodeMatch?.[1];
    if (newPairingCode === undefined) throw new Error('new pairing code not found in output');
    expect(newPairingCode).not.toBe(preStopCode);

    const newUrlMatches = [...world.output.matchAll(/http:\/\/([^\s:/]+):(\d+)/g)];
    const newLanEntry = newUrlMatches.find((m) => m[1] !== '127.0.0.1' && m[1] !== 'localhost') ?? newUrlMatches[0];
    const newBoundAddress = newLanEntry?.[1] ?? '127.0.0.1';
    const newBoundPort = newLanEntry?.[2] ?? new URL(newServer.url).port;
    const newTargetUrl = `http://${newBoundAddress}:${newBoundPort}`;

    const postRestartReq = await page.request.get(`${newTargetUrl}/api/v1/runs?project=${project}`, {
      headers: {
        cookie: `agent-flow-session=${preStopCookie}`,
        ...remotePeerHeaders,
      },
    });
    expect(postRestartReq.status()).toBe(401);
    expect(((await postRestartReq.json()) as { error: string }).error).toBe('session_invalid');

    const oldCodePairRes = await page.request.post(`${newTargetUrl}/api/v1/pair`, {
      data: { code: preStopCode, label: 'Pre-Restart Device' },
      headers: remotePeerHeaders,
    });
    expect(oldCodePairRes.status()).toBe(401);
    expect(((await oldCodePairRes.json()) as { error: string }).error).toBe('unauthorized');

    const newPairRes = await page.request.post(`${newTargetUrl}/api/v1/pair`, {
      data: { code: newPairingCode, label: 'Post-Restart Device' },
      headers: remotePeerHeaders,
    });
    expect(newPairRes.status()).toBe(200);
    const newCookieHeader = newPairRes.headers()['set-cookie'] ?? '';
    expect(newCookieHeader).toContain('agent-flow-session=');
  });
});
