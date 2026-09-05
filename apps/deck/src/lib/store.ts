import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A small resource cache, keyed by URL.
 *
 * Deck reads a dozen endpoints and keeps none of their state: every screen is a rendering
 * of what the server said last. What the cache adds is *sharing* — two components asking
 * for the same run get one request — and *invalidation*, which is how a server-sent event
 * turns into a repaint. It deliberately has no mutation API beyond `invalidate`: the
 * browser never writes a run's state into memory, it asks again.
 *
 * Nothing here is clever about staleness. A key is fresh until something invalidates it
 * or its own `refreshMs` elapses; a re-fetch keeps the last good answer on screen until
 * the new one lands, so the page never flashes to empty between two truths.
 */

interface Entry {
  data: unknown;
  error: Error | undefined;
  fetchedAt: number;
  inflight: Promise<void> | undefined;
  fetcher: (() => Promise<unknown>) | undefined;
  /** Bumped by `invalidate`; a subscriber whose seen version is behind re-fetches. */
  version: number;
}

const entries = new Map<string, Entry>();
const subscribers = new Map<string, Set<() => void>>();

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { data: undefined, error: undefined, fetchedAt: 0, inflight: undefined, fetcher: undefined, version: 0 };
    entries.set(key, entry);
  }
  return entry;
}

function notify(key: string): void {
  for (const listener of [...(subscribers.get(key) ?? [])]) listener();
}

function load(key: string): Promise<void> {
  const entry = entryFor(key);
  if (entry.inflight !== undefined) return entry.inflight;
  const fetcher = entry.fetcher;
  if (fetcher === undefined) return Promise.resolve();

  const version = entry.version;
  entry.inflight = fetcher()
    .then((data) => {
      // A response that raced an invalidation is still the newest thing we have; keep
      // it, and let the version mismatch trigger one more fetch.
      entry.data = data;
      entry.error = undefined;
      entry.fetchedAt = Date.now();
    })
    .catch((error: unknown) => {
      entry.error = error instanceof Error ? error : new Error(String(error));
    })
    .finally(() => {
      entry.inflight = undefined;
      notify(key);
      if (entry.version !== version && (subscribers.get(key)?.size ?? 0) > 0) void load(key);
    });
  return entry.inflight;
}

/**
 * Marks every key the predicate accepts as stale, and re-fetches the ones on screen.
 *
 * Keys nobody is subscribed to are dropped rather than refreshed — a run page that was
 * closed an hour ago has no business generating requests.
 */
export function invalidate(predicate: (key: string) => boolean = () => true): void {
  for (const [key, entry] of entries) {
    if (!predicate(key)) continue;
    entry.version += 1;
    if ((subscribers.get(key)?.size ?? 0) > 0) void load(key);
    else if (entry.inflight === undefined) entries.delete(key);
  }
}

/** For tests, and for a full reset on workspace change. */
export function clearStore(): void {
  entries.clear();
}

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  /** True only while nothing has ever been received for this key. */
  readonly loading: boolean;
  /** True while a re-fetch is in flight and something older is on screen. */
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

/**
 * Several resources at once, for a list whose length the caller does not control.
 *
 * Hooks cannot be called in a loop, and a page that wants the attention items of every
 * project with any has exactly that loop. One subscription per entry, all in one effect,
 * and one map back — the same cache, the same invalidation, no second mechanism.
 */
export function useResources<T>(
  entries: readonly { readonly key: string; readonly fetcher: () => Promise<T> }[],
): ReadonlyMap<string, Resource<T>> {
  const [, bump] = useState(0);
  const fetchers = useRef(new Map<string, () => Promise<T>>());
  for (const entry of entries) fetchers.current.set(entry.key, entry.fetcher);
  const signature = entries.map((entry) => entry.key).join('\n');

  useEffect(() => {
    const keys = signature === '' ? [] : signature.split('\n');
    const listener = (): void => bump((n) => n + 1);
    for (const key of keys) {
      const entry = entryFor(key);
      entry.fetcher = () => fetchers.current.get(key)?.() ?? Promise.reject(new Error('no fetcher'));
      let set = subscribers.get(key);
      if (set === undefined) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(listener);
      if (entry.fetchedAt === 0 || entry.error !== undefined) void load(key);
    }
    return () => {
      for (const key of keys) {
        const set = subscribers.get(key);
        set?.delete(listener);
        if (set?.size === 0) subscribers.delete(key);
      }
    };
  }, [signature]);

  const out = new Map<string, Resource<T>>();
  for (const { key } of entries) {
    const entry = entryFor(key);
    out.set(key, {
      data: entry.data as T | undefined,
      error: entry.error,
      loading: entry.fetchedAt === 0 && entry.error === undefined,
      refreshing: entry.inflight !== undefined && entry.fetchedAt !== 0,
      refresh: () => void load(key),
    });
  }
  return out;
}

export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: { readonly refreshMs?: number } = {},
): Resource<T> {
  const [, bump] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (key === null) return;
    const entry = entryFor(key);
    entry.fetcher = () => fetcherRef.current();

    const listener = (): void => bump((n) => n + 1);
    let set = subscribers.get(key);
    if (set === undefined) {
      set = new Set();
      subscribers.set(key, set);
    }
    set.add(listener);

    if (entry.fetchedAt === 0 || entry.error !== undefined) void load(key);

    let timer: ReturnType<typeof setInterval> | undefined;
    if (options.refreshMs !== undefined) {
      timer = setInterval(() => void load(key), options.refreshMs);
    }

    return () => {
      set?.delete(listener);
      if (set?.size === 0) subscribers.delete(key);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [key, options.refreshMs]);

  const refresh = useCallback(() => {
    if (key !== null) void load(key);
  }, [key]);

  if (key === null) {
    return { data: undefined, error: undefined, loading: false, refreshing: false, refresh };
  }

  const entry = entryFor(key);
  return {
    data: entry.data as T | undefined,
    error: entry.error,
    loading: entry.fetchedAt === 0 && entry.error === undefined,
    refreshing: entry.inflight !== undefined && entry.fetchedAt !== 0,
    refresh,
  };
}
