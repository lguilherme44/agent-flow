import { describe, it, expect } from 'vitest';
import {
  FetchHubClient,
  HUB_CLIENT_HEADER,
  MCP_CLIENT_NAME,
  type FetchLike,
} from '../../src/adapters/hub/fetch-hub-client.js';
import { CLIENT_HEADER } from '../../src/server/request-guard.js';

/**
 * The MCP server's only way to the hub: HTTP, with a fake `fetch` in place of the network.
 *
 * What is asserted is what the hub reads: the client header that admits a write without an
 * `Origin`, the absence of an `Origin` (so the hub records a gate decision as channel
 * `api`), and an error shape a tool can surface without a stack.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function fakeFetch(
  respond: (call: Call) => { status: number; body?: string } | Error,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const call = { url, method: init.method, headers: { ...init.headers }, body: init.body };
    calls.push(call);
    const answer = respond(call);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      text: () => Promise.resolve(answer.body ?? ''),
    });
  };
  return { fetch, calls };
}

const BASE = 'http://127.0.0.1:4782';

describe('FetchHubClient', () => {
  it('sends the client header the hub admits writes on, and no Origin', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 202, body: '{"id":"job-0001"}' }));
    const client = new FetchHubClient({ baseUrl: BASE, fetch });

    await client.send({ method: 'POST', path: '/runs/AF-2026-001/approve', query: { projectId: 'api' }, body: { x: 1 } });

    const call = calls[0];
    expect(call?.headers[HUB_CLIENT_HEADER]).toBe(MCP_CLIENT_NAME);
    expect(MCP_CLIENT_NAME).toBe('mcp');
    // Any capitalisation: a header named `Origin` would make the hub read this as the Deck.
    expect(Object.keys(call?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain('origin');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.body).toBe('{"x":1}');
  });

  it('names the header exactly as the server reads it', () => {
    // Spelled twice because the adapters may not import the server; this is the drift guard.
    expect(HUB_CLIENT_HEADER).toBe(CLIENT_HEADER);
  });

  it('builds the URL under /api/v1 with the query encoded, and sends no body on a GET', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: '[]' }));
    const client = new FetchHubClient({ baseUrl: `${BASE}/`, fetch });

    const response = await client.send({ method: 'GET', path: '/runs', query: { projectId: 'my-api' } });

    expect(calls[0]?.url).toBe(`${BASE}/api/v1/runs?projectId=my-api`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBeUndefined();
    expect(response).toEqual({ kind: 'ok', status: 200, body: [] });
  });

  it('reports an unreachable hub with its URL, not a stack', async () => {
    const { fetch } = fakeFetch(() => new TypeError('fetch failed'));
    const client = new FetchHubClient({ baseUrl: BASE, fetch });

    const response = await client.send({ method: 'GET', path: '/projects' });

    expect(response).toMatchObject({ kind: 'unreachable', url: BASE });
  });

  it.each([
    [400, 'bad_request'],
    [404, 'not_found'],
    [409, 'run_busy'],
    [500, 'internal'],
  ])('surfaces a %i with the API error code and message', async (status, code) => {
    const { fetch } = fakeFetch(() => ({
      status,
      body: JSON.stringify({ error: code, message: `the ${code} sentence`, action: 'do this' }),
    }));
    const client = new FetchHubClient({ baseUrl: BASE, fetch });

    const response = await client.send({ method: 'GET', path: '/projects' });

    expect(response).toEqual({
      kind: 'http_error',
      status,
      error: code,
      message: `the ${code} sentence`,
      action: 'do this',
    });
  });

  it('keeps the structured detail of a refusal, such as the job a 409 run_busy names', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: JSON.stringify({ error: 'run_busy', message: 'busy', detail: { jobId: 'job-0042', kind: 'start' } }),
    }));
    const client = new FetchHubClient({ baseUrl: BASE, fetch });

    const response = await client.send({ method: 'POST', path: '/runs/AF-2026-001/start' });

    expect(response).toMatchObject({ kind: 'http_error', detail: { jobId: 'job-0042' } });
  });

  it('reports a 2xx whose body is not JSON as not being the hub', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: '<html>router login</html>' }));
    const client = new FetchHubClient({ baseUrl: BASE, fetch });

    const response = await client.send({ method: 'GET', path: '/projects' });

    expect(response).toEqual({ kind: 'not_hub', url: BASE, status: 200 });
  });

  it('keeps an error body that is not the API shape, bounded, under a code named by status', async () => {
    const { fetch } = fakeFetch(() => ({ status: 502, body: `<html>${'x'.repeat(5_000)}</html>` }));
    const client = new FetchHubClient({ baseUrl: BASE, fetch });

    const response = await client.send({ method: 'GET', path: '/projects' });

    expect(response.kind).toBe('http_error');
    if (response.kind !== 'http_error') return;
    expect(response.error).toBe('http_502');
    expect(response.message.length).toBeLessThanOrEqual(500);
  });

  it('reports a hub that does not answer in time, without claiming nothing changed', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new FetchHubClient({ baseUrl: BASE, fetch, timeoutMs: 5 });

    const response = await client.send({ method: 'POST', path: '/runs/AF-2026-001/pause' });

    expect(response).toMatchObject({ kind: 'timeout', url: BASE, timeoutMs: 5 });
  });
});
