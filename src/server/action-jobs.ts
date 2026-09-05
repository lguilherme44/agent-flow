import type { ActionError } from '../app/run-actions.js';
import type { Clock } from '../ports/index.js';

/**
 * Long actions, as background jobs (UI-27).
 *
 * Three of the write actions are not requests. Starting a run executes a plan; a
 * revision re-runs the planning pipeline; a review runs verification and two
 * reviewers. All three spawn runner processes and take minutes, and an HTTP
 * handler that awaited one would be holding a socket open past every timeout
 * between the browser and this process.
 *
 * So the adapter differs and the use case does not: `POST /runs/:id/start` calls
 * exactly the function `agent-flow run` calls, and answers 202 with a job id while
 * it proceeds. Progress arrives the way progress already arrives — the run watcher
 * sees `state.json` change and the stream carries it. This registry adds no second
 * channel for run state; it only says whether the job it started is still going and
 * how it ended.
 *
 * A job's own lifecycle goes down the same stream rather than being polled for, and
 * it has to be published here because it is not a run event: a job the workflow
 * refused never touched `state.json`, so the watcher would never see it and a page
 * waiting for the run to change would wait forever. One channel for "something
 * happened", and polling stays what §89 makes it — the fallback for when the stream
 * is down.
 *
 * **One job per run, and that is a correctness guard rather than a nicety.** Two
 * schedulers on one run would both move the same task to `running`, spawn the same
 * agent twice, and write over each other's files. A double-clicked button, two
 * browser tabs and two people on the same machine all produce that, so a second
 * request for a busy run is refused rather than queued: queueing would make the
 * second execution happen later instead of never.
 *
 * What this does *not* guard is a CLI running `agent-flow run` against the same run
 * at the same time. That needs a lock both processes can see, and a lock needs
 * liveness detection to avoid a crashed holder blocking every future run — a
 * subsystem, not a flag. It is a real gap and it is documented as one.
 */

export type JobKind = 'plan' | 'start' | 'revise' | 'review';
export type JobStatus = 'running' | 'completed' | 'failed';

export interface ActionJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly projectId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: JobStatus;
  readonly finishedAt?: string;
  /** Present when the use case refused, or threw. Never a stack trace. */
  readonly error?: ActionError;
  /** A short human summary of what the job produced. */
  readonly summary?: string;
}

export interface JobResult {
  readonly summary?: string;
  readonly error?: ActionError;
}

export interface StartJobRequest {
  readonly kind: JobKind;
  readonly projectId: string;
  readonly runId: string;
  readonly work: () => Promise<JobResult>;
}

export interface ActionJobsOptions {
  readonly clock: Clock;
  /** Called whenever a job starts or finishes, so the stream can carry it. */
  readonly onChange?: (job: ActionJob) => void;
}

export class ActionJobs {
  private readonly byId = new Map<string, ActionJob>();
  private sequence = 0;
  private readonly clock: Clock;
  private readonly onChange: (job: ActionJob) => void;

  constructor(options: ActionJobsOptions) {
    this.clock = options.clock;
    this.onChange = options.onChange ?? ((): void => undefined);
  }

  /**
   * Starts a job, or reports the one already running for that run.
   *
   * The caller distinguishes the two by the shape of the answer rather than by
   * comparing ids, so there is no window in which it could act on a stale one.
   */
  start(request: StartJobRequest): { started: ActionJob } | { busy: ActionJob } {
    const active = this.activeFor(request.projectId, request.runId);
    if (active !== undefined) return { busy: active };

    this.sequence += 1;
    const id = `job-${String(this.sequence).padStart(4, '0')}`;

    const job: ActionJob = {
      id,
      kind: request.kind,
      projectId: request.projectId,
      runId: request.runId,
      startedAt: this.clock.now(),
      status: 'running',
    };
    this.byId.set(id, job);

    // Deliberately not awaited. The whole point is that the response leaves before
    // this does — but the promise is still handled, because an unhandled rejection
    // here would take the server down with it.
    void request
      .work()
      .then((result) => {
        this.finish(id, result.error === undefined ? 'completed' : 'failed', result);
      })
      .catch((error: unknown) => {
        this.finish(id, 'failed', {
          error: {
            code: 'no_run',
            message:
              error instanceof Error
                ? error.message
                : 'The action failed for a reason it did not report.',
          },
        });
      });

    this.onChange(job);

    // Re-read: a use case that failed synchronously has already finished by now,
    // and returning the stale `running` snapshot would report it as in flight.
    return { started: this.byId.get(id) ?? job };
  }

  get(id: string): ActionJob | undefined {
    return this.byId.get(id);
  }

  /** The job in flight for a run, if any. */
  activeFor(projectId: string, runId: string): ActionJob | undefined {
    for (const job of this.byId.values()) {
      if (job.status !== 'running') continue;
      if (job.projectId === projectId && job.runId === runId) return job;
    }
    return undefined;
  }

  /** Every job, newest first. Bounded by whatever this process has done. */
  all(): ActionJob[] {
    return [...this.byId.values()].reverse();
  }

  private finish(id: string, status: JobStatus, result: JobResult): void {
    const job = this.byId.get(id);
    if (job === undefined) return;

    const finished: ActionJob = {
      ...job,
      status,
      finishedAt: this.clock.now(),
      ...(result.summary === undefined ? {} : { summary: result.summary }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };

    this.byId.set(id, finished);
    this.onChange(finished);
  }
}
