import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@contracts/index.js';
import { API_BASE } from '../lib/api';
import { applyServerEvent } from '../lib/live-updates';

export type ConnectionState = 'connecting' | 'live' | 'polling';

/** How often to re-ask when the stream is down (§89). */
export const POLL_INTERVAL_MS = 10_000;

/**
 * Subscribes to the run stream and refreshes what it invalidates.
 *
 * Polling is the fallback, never the default. A dashboard that polls every ten
 * seconds *looks* live until you watch a task finish and count to nine — and the
 * whole point of the stream is that the moment something happens is the moment
 * it appears.
 *
 * The connection state is returned rather than hidden, because a stream that
 * silently died and a run that is simply idle look identical on screen. One of
 * those the user should know about.
 */
export function useLiveEvents(projectId?: string): ConnectionState {
  const client = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const url =
      projectId === undefined
        ? `${API_BASE}/events`
        : `${API_BASE}/events?projectId=${encodeURIComponent(projectId)}`;

    const source = new EventSource(url);

    const stopPolling = (): void => {
      if (pollTimer.current !== undefined) {
        clearInterval(pollTimer.current);
        pollTimer.current = undefined;
      }
    };

    const startPolling = (): void => {
      if (pollTimer.current !== undefined) return;
      pollTimer.current = setInterval(() => {
        void client.invalidateQueries();
      }, POLL_INTERVAL_MS);
    };

    source.onopen = () => {
      setConnection('live');
      stopPolling();
    };

    source.onerror = () => {
      // EventSource reconnects on its own. Polling covers the gap rather than
      // replacing it, and stops again as soon as the stream is back.
      setConnection('polling');
      startPolling();
    };

    source.onmessage = (message: MessageEvent<string>) => {
      handle(message.data);
    };

    // The server names every event, so `onmessage` alone would miss all of them
    // — `EventSource` routes a named event to its own listener and nowhere else.
    const named = [
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
    ];

    const listener = (message: Event): void => {
      handle((message as MessageEvent<string>).data);
    };
    for (const type of named) source.addEventListener(type, listener);

    function handle(raw: string): void {
      try {
        applyServerEvent(client, JSON.parse(raw) as ServerEvent);
      } catch {
        // A malformed frame is not worth tearing the stream down for. The next
        // one, or the poll fallback, will bring the screen back in line.
      }
    }

    return () => {
      for (const type of named) source.removeEventListener(type, listener);
      source.close();
      stopPolling();
    };
  }, [client, projectId]);

  return connection;
}
