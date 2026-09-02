import type { Clock } from '../ports/index.js';
import type { StateStore } from './state-store.js';

/**
 * Pause and cancel, made real across processes (PRI-14, PRI-15).
 *
 * **The problem this exists for is that the operator and the run are not the same
 * process.** A run executes under `agent-flow run` in one terminal or inside a server job;
 * `agent-flow cancel` is typed in another terminal, or clicked in a browser. There is no
 * in-memory controller for the second to abort.
 *
 * So the intent goes on disk — `pauseRequestedAt`, or the terminal `cancelled` status —
 * and the process that is *executing* watches for it. `state.json` is already the run's
 * single source of truth and already polled by the dashboard's run watcher; this is the
 * same fact read by the one participant that can act on it.
 *
 * Two signals, because pause and cancel are different operations:
 *
 * ```text
 * pause   →  dispatch.abort()                       stop starting work
 * cancel  →  dispatch.abort() + terminate.abort()   …and end what is running
 * ```
 *
 * Collapsing them would make a pause kill the task in flight, which is the one thing pause
 * is defined not to do: its work is already paid for and its result file is written once,
 * at the end.
 */

/** How often the executing process asks whether somebody has changed its mind. */
export const DEFAULT_LIFECYCLE_POLL_MS = 2_000;

export interface LifecycleWatch {
  /** Aborted by a pause **or** a cancel. The scheduler stops dispatching. */
  readonly signal: AbortSignal;
  /** Aborted only by a cancel. Ends running attempts and their process trees. */
  readonly terminateSignal: AbortSignal;
  /** True once either intent was observed. For the message the run ends with. */
  observed(): 'paused' | 'cancelled' | undefined;
  /** Stops polling. Idempotent, and safe to call from a `finally`. */
  stop(): void;
}

export interface LifecycleWatchOptions {
  readonly store: StateStore;
  readonly runId: string;
  readonly intervalMs?: number;
  /**
   * Injected so a test drives the clock instead of waiting on one.
   *
   * Takes the delay and resolves after it. `setTimeout` in production; in a test, a latch
   * the test releases.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Watches a run's persisted lifecycle intent for as long as it is executing.
 *
 * Failure to read is **not** an abort. A transient read error — the state file being
 * replaced by an atomic rename at the moment of the poll — would otherwise cancel a
 * healthy run, and "the orchestrator stopped because it briefly could not read a file" is
 * a far worse outcome than "the pause took one more poll to arrive".
 */
export function watchLifecycle(options: LifecycleWatchOptions): LifecycleWatch {
  const dispatch = new AbortController();
  const terminate = new AbortController();
  const intervalMs = options.intervalMs ?? DEFAULT_LIFECYCLE_POLL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let seen: 'paused' | 'cancelled' | undefined;
  let stopped = false;

  const poll = async (): Promise<void> => {
    while (!stopped && seen === undefined) {
      await sleep(intervalMs);
      if (stopped) return;

      let state;
      try {
        state = await options.store.loadRun(options.runId);
      } catch {
        // See the note above: a read that failed is not an intent to stop.
        continue;
      }

      // Cancel first. A run that was paused and then cancelled must terminate, and the
      // reverse order would settle on `paused` and leave the agent running.
      if (state.status === 'cancelled') {
        seen = 'cancelled';
        dispatch.abort();
        terminate.abort();
        return;
      }

      if (state.pauseRequestedAt !== undefined) {
        seen = 'paused';
        dispatch.abort();
        return;
      }
    }
  };

  void poll();

  return {
    signal: dispatch.signal,
    terminateSignal: terminate.signal,
    observed: () => seen,
    stop: () => {
      stopped = true;
    },
  };
}

/**
 * The task states a cancel rewrites, and what it rewrites them to.
 *
 * `running` becomes `interrupted`, which already exists, already means "was running and
 * nothing is executing it", and already transitions to `queued`. Inventing a `cancelled`
 * task state would add one whose only difference is *why* it stopped — and the why belongs
 * in the event log.
 *
 * `queued` stays `queued`. Those tasks never started; there is nothing to record about
 * them, and moving them to a terminal state would erase the plan's remaining work from a
 * run somebody may want to read.
 */
export function tasksAfterCancel<T extends { readonly state: string }>(
  tasks: readonly T[],
): T[] {
  return tasks.map((task) =>
    task.state === 'running' ? { ...task, state: 'interrupted' } : task,
  );
}

/** Present-tense description of an intent, for a message a person reads. */
export function describeIntent(
  state: { readonly status: string; readonly pauseRequestedAt?: string },
  clock: Clock,
): string {
  if (state.status === 'cancelled') return `cancelled as of ${clock.now()}`;
  return state.pauseRequestedAt === undefined
    ? 'running'
    : `paused since ${state.pauseRequestedAt}`;
}
