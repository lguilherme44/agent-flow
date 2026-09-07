import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson } from './api';

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
});
