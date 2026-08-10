import type { RunEvent, ServerEvent } from '../contracts/index.js';
import { StateStore } from '../app/state-store.js';
import type { Clock, FileSystem } from '../ports/index.js';
import type { ProjectRegistry, RegisteredProject } from './project-registry.js';

/**
 * Turns what the workflow already writes into what the browser can subscribe to.
 *
 * There is no second event store here, and that is the whole design. `state.json`
 * stays the source of truth and `events.jsonl` stays the audit trail; this reads
 * both and pushes what changed. Nothing it emits is authoritative — a client that
 * missed an event and re-fetches gets the same answer, because the answer comes
 * from the same files.
 *
 * Polling rather than `fs.watch`. Recursive watching is not portable, the events
 * arrive coalesced and out of order under load, and the cost of being wrong is a
 * dashboard that silently stops updating. Reading a handful of small local files
 * once a second is cheap and cannot miss a write.
 */

export type EventListener = (event: ServerEvent) => void;

export interface EventBus {
  subscribe(listener: EventListener): () => void;
  publish(event: ServerEvent): void;
  readonly size: number;
}

export function createEventBus(): EventBus {
  const listeners = new Set<EventListener>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event) {
      // Copied before iterating: a listener that unsubscribes itself while
      // being notified would otherwise mutate the set mid-loop.
      for (const listener of [...listeners]) listener(event);
    },
    get size() {
      return listeners.size;
    },
  };
}

/**
 * How a run event becomes a UI event (§87).
 *
 * Deliberately total: an event type this table does not know still reaches the
 * browser, as `run.updated`. A new event type added to the workflow must never
 * make the dashboard go quiet — the failure would look exactly like nothing
 * happening.
 */
export function toServerEventType(event: RunEvent): string {
  switch (event.type) {
    case 'run_created':
      return 'run.created';
    case 'run_rejected':
      return 'run.updated';
    case 'run_approved':
      return 'approval.completed';
    case 'stage_started':
      return 'stage.started';
    case 'stage_completed':
      return 'stage.completed';
    case 'stage_failed':
      return 'stage.failed';
    case 'task_started':
      return 'task.started';
    case 'task_finished':
      return taskFinishedType(event);
    case 'degradation_detected':
      return 'run.updated';
    default:
      return 'run.updated';
  }
}

function taskFinishedType(event: RunEvent): string {
  switch (event.detail['status']) {
    case 'completed':
      return 'task.completed';
    case 'blocked':
      return 'task.blocked';
    case 'failed':
      return 'task.failed';
    default:
      return 'task.updated';
  }
}

interface RunCursor {
  /** Events already published, by position in the file. */
  events: number;
  /** Last seen `updatedAt`, to notice a state change with no new event. */
  updatedAt: string;
  status: string;
}

export interface RunWatcherOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly registry: ProjectRegistry;
  readonly bus: EventBus;
  /** Milliseconds between sweeps. */
  readonly intervalMs?: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class RunWatcher {
  private readonly cursors = new Map<string, RunCursor>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;

  constructor(private readonly options: RunWatcherOptions) {}

  /**
   * Reads the current state without publishing it.
   *
   * Called once before the first sweep so a server that starts against a
   * finished run does not replay its entire history to whoever connects first.
   * The dashboard fetches state over HTTP; SSE carries what happens *next*.
   */
  async prime(): Promise<void> {
    await this.sweep({ publish: false });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.sweep({ publish: true });
    }, this.options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);

    // Node keeps the process alive for a pending timer. The server's own
    // listener is what should decide that, not a background poller.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed for tests and for `prime`; the timer calls it with `publish`. */
  async sweep(options: { publish: boolean }): Promise<void> {
    // A sweep that overruns its interval must not overlap with the next one, or
    // the same lines get published twice.
    if (this.sweeping) return;
    this.sweeping = true;

    try {
      for (const project of this.options.registry.all()) {
        await this.sweepProject(project, options.publish);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepProject(project: RegisteredProject, publish: boolean): Promise<void> {
    const store = new StateStore({
      fs: this.options.fs,
      clock: this.options.clock,
      projectDir: project.path,
    });

    let runIds: string[];
    try {
      runIds = await store.listRunIds();
    } catch {
      return;
    }

    for (const runId of runIds) {
      const key = `${project.id}/${runId}`;
      const cursor = this.cursors.get(key);

      let events: RunEvent[];
      try {
        events = await store.readEvents(runId);
      } catch {
        continue;
      }

      let state;
      try {
        state = await store.loadRun(runId);
      } catch {
        continue;
      }

      if (cursor === undefined) {
        this.cursors.set(key, {
          events: events.length,
          updatedAt: state.updatedAt,
          status: state.status,
        });
        // A run seen for the first time after start-up is news; a run seen
        // during priming is not.
        if (publish) {
          this.emit(project, runId, 'run.created', { status: state.status });
        }
        continue;
      }

      if (publish) {
        for (const event of events.slice(cursor.events)) {
          this.emit(project, runId, toServerEventType(event), {
            event: event.type,
            ...event.detail,
          });
        }

        if (state.updatedAt !== cursor.updatedAt) {
          this.emit(project, runId, 'run.updated', {
            status: state.status,
            stage: state.stage,
            approved: state.approved,
          });
        }

        if (state.status !== cursor.status) {
          if (state.status === 'completed') {
            this.emit(project, runId, 'run.completed', {});
          }
          if (state.status === 'failed') this.emit(project, runId, 'run.failed', {});
          if (state.status === 'waiting_for_approval') {
            this.emit(project, runId, 'approval.requested', {});
          }
        }
      }

      cursor.events = events.length;
      cursor.updatedAt = state.updatedAt;
      cursor.status = state.status;
    }
  }

  private emit(
    project: RegisteredProject,
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.options.bus.publish({
      type,
      projectId: project.id,
      runId,
      timestamp: this.options.clock.now(),
      payload,
    });
  }
}
