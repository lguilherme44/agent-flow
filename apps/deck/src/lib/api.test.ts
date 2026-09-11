import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getJson, keys, onUnauthorized } from './api';

/**
 * A read that hangs has to end (PRI-28).
 *
 * `fetch` has no default timeout, and `store.ts` keeps one promise per key:
 *
 * ```ts
 * if (entry.inflight !== undefined) return entry.inflight;
 * ```
 *
 * So a request that never answers is not a failure, it is a *pending* — every later
 * attempt hands back the same dead promise, nothing retries it and nothing reports it, and
 * the screen shows a skeleton for the life of the tab. It happened on a Crew screen across
 * a server restart, while every endpoint answered in milliseconds from a fresh tab.
 *
 * An abort rejects, the store records an error, and a key with an error is re-fetched the
 * next time something subscribes to it. The recovery path already existed; nothing could
 * reach it.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getJson', () => {
  it('gives every read a deadline', async () => {
    // Typed with the parameters it will be asked about: the Deck's own tsconfig is stricter
    // than the root's, and `mock.calls[0]?.[1]` on a zero-arity mock is a tuple index that
    // cannot exist. The root suite passed and `build:deck` did not.
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getJson('/projects');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('rejects when the deadline passes, rather than hanging', async () => {
    vi.useFakeTimers();
    try {
      // A server that accepted the connection and never answered — the shape that wedged
      // the screen. Resolved by the abort, never by the response.
      const fetchMock = vi.fn(
        async (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'TimeoutError'));
            });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = getJson('/runners/models');
      const settled = vi.fn();
      void pending.then(settled, settled);

      // Still open at nineteen seconds: `/runners/models` spawns a CLI and was measured at
      // 3.6s, so a bound that fired early would break the healthy case it exists to protect.
      await vi.advanceTimersByTimeAsync(19_000);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('branches on 401 throwing an ApiError that notifies onUnauthorized and contains no secret', async () => {
    const unauthorizedHandler = vi.fn();
    const unsubscribe = onUnauthorized(unauthorizedHandler);

    try {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'session_required',
              message: 'This server requires an active device session for remote access.',
              action: 'Pair this device using the code printed in the server terminal.',
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      );
      vi.stubGlobal('fetch', fetchMock);

      let caughtError: unknown = undefined;
      try {
        await getJson('/runs');
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ApiError);
      const apiErr = caughtError as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.code).toBe('session_required');
      expect(apiErr.isUnauthorized).toBe(true);
      expect(apiErr.detail).toBeUndefined();

      expect(unauthorizedHandler).toHaveBeenCalledTimes(1);
      expect(unauthorizedHandler).toHaveBeenCalledWith(apiErr);
    } finally {
      unsubscribe();
    }
  });

  it('provides keys.sessions() that is URL-shaped and carries no credential', () => {
    const urlKey = keys.sessions();
    expect(urlKey).toMatch(/\/sessions\?lang=/);
    expect(urlKey).not.toMatch(/secret|token|cookie|auth/i);
  });

  it('posts pair request and gets sessions and revokes session without secrets', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const target = String(input);
      if (target.includes('/pair') && init?.method === 'POST') {
        return new Response(JSON.stringify({ deviceId: 'dev_123', label: 'Phone', pairedAt: 1000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, deviceId: 'dev_123', label: 'Phone' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('/sessions')) {
        return new Response(JSON.stringify([{ deviceId: 'dev_123', label: 'Phone', pairedAt: 1000, lastSeenAt: 2000 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pairRes = await api.pair('abcd-efgh-ijkl', 'Phone');
    expect(pairRes).toEqual({ deviceId: 'dev_123', label: 'Phone', pairedAt: 1000 });

    const sessions = await api.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.deviceId).toBe('dev_123');

    const revokeRes = await api.revokeSession('dev_123');
    expect(revokeRes.ok).toBe(true);
  });
});
