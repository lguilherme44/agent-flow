import { useEffect, useRef, useState } from 'react';
import type { ServerEvent } from '@contracts/index.js';
import { API_BASE } from './api';
import { invalidate } from './store';

export type Connection = 'connecting' | 'live' | 'polling';

/** How often to re-ask everything while the stream is down. */
export const POLL_INTERVAL_MS = 10_000;

/** Bursts of events land within milliseconds; one repaint is enough for all of them. */
const COALESCE_MS = 120;

/**
 * The event types the server names. `EventSource` routes a named event to its own
 * listener and nowhere else, so `onmessage` alone would hear none of them.
 */
const NAMED = [
  'run.created',
  'run.updated',
  'run.completed',
  'run.failed',
  'stage.started',
  'stage.completed',
  'stage.failed',
  'task.queued',
  'task.started',
  'task.updated',
  'task.completed',
  'task.failed',
  'task.blocked',
  'approval.requested',
  'approval.completed',
  'runner.health_changed',
  'log.appended',
  'job.started',
  'job.finished',
];

/**
 * Which cache keys an event makes stale.
 *
 * Coarse on purpose. A run event invalidates everything about that run and the two lists
 * that summarise it; a runner event invalidates runner health. Precision here would be a
 * second model of which endpoint depends on which file, and the server already answers
 * every one of them from the same files.
 */
export function affectedBy(event: ServerEvent): (key: string) => boolean {
  if (event.type === 'runner.health_changed') return (key) => key.includes('/runners/');
  const run = `/runs/${event.runId}`;
  return (key) =>
    key.includes(run) ||
    key.includes('/workspace') ||
    key.includes('/projects') ||
    /\/runs(\?|$)/.test(key);
}

/**
 * Subscribes to the run stream and re-reads what it touches.
 *
 * Polling is the fallback, never the default. When the stream errors, a ten-second
 * invalidation covers the gap and the shell says so; when it reopens, polling stops.
 * The three states are returned rather than hidden, because a stream that died and a run
 * that is simply idle look identical on screen, and only one of them is news.
 */
export function useLive(projectId?: string): Connection {
  const [connection, setConnection] = useState<Connection>('connecting');
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const pending = useRef<{ predicates: ((key: string) => boolean)[]; timer: ReturnType<typeof setTimeout> | undefined }>({
    predicates: [],
    timer: undefined,
  });

  useEffect(() => {
    const source = new EventSource(
      projectId === undefined
        ? `${API_BASE}/events`
        : `${API_BASE}/events?projectId=${encodeURIComponent(projectId)}`,
    );

    const stopPolling = (): void => {
      if (poll.current !== undefined) clearInterval(poll.current);
      poll.current = undefined;
    };
    const startPolling = (): void => {
      if (poll.current !== undefined) return;
      poll.current = setInterval(() => invalidate(), POLL_INTERVAL_MS);
    };

    const flush = (): void => {
      const predicates = pending.current.predicates;
      pending.current = { predicates: [], timer: undefined };
      if (predicates.length === 0) return;
      invalidate((key) => predicates.some((accepts) => accepts(key)));
    };

    const handle = (raw: string): void => {
      let event: ServerEvent;
      try {
        event = JSON.parse(raw) as ServerEvent;
      } catch {
        return;
      }
      pending.current.predicates.push(affectedBy(event));
      if (pending.current.timer === undefined) pending.current.timer = setTimeout(flush, COALESCE_MS);
    };

    source.onopen = () => {
      setConnection('live');
      stopPolling();
      // Anything that happened while the stream was down is on disk already.
      invalidate();
    };
    source.onerror = () => {
      setConnection('polling');
      startPolling();
    };
    source.onmessage = (message: MessageEvent<string>) => handle(message.data);

    const listener = (message: Event): void => handle((message as MessageEvent<string>).data);
    for (const type of NAMED) source.addEventListener(type, listener);

    return () => {
      for (const type of NAMED) source.removeEventListener(type, listener);
      source.close();
      stopPolling();
      if (pending.current.timer !== undefined) clearTimeout(pending.current.timer);
    };
  }, [projectId]);

  return connection;
}
