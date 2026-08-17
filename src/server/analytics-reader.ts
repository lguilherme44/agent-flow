import type {
  AnalyticsView,
  ContextTelemetryObservation,
  MetricBucketView,
  RunState,
  TelemetryEntry,
} from '../contracts/index.js';
import { StateStore } from '../app/state-store.js';
import { collectTelemetry } from '../app/telemetry.js';
import { summariseTelemetry, type TelemetryBucket } from '../core/telemetry.js';
import { aggregateContextTelemetry, aggregateContextOutcomes } from '../core/context-telemetry.js';
import type { Clock, FileSystem } from '../ports/index.js';
import type { RegisteredProject } from './project-registry.js';
import {
  CONTEXT_TELEMETRY_BASIS,
  ContextTelemetryReader,
} from './context-telemetry-reader.js';

/**
 * Operational analytics (§84, UI-25) — a projection, never a store.
 *
 * `TelemetryEntry` is already derived rather than recorded: stage entries come out
 * of the event log the stage runner writes, task entries out of the result files
 * the executor writes. This adds nothing to that. It reads the same files across
 * several runs and aggregates them with the same pure function the run detail uses,
 * which is what makes the numbers here and the numbers on a run's own page
 * incapable of disagreeing.
 *
 * Two things it deliberately does not do.
 *
 * It does not invent a metric the data cannot support. "Time per complexity" is
 * reported as time per *executor role*, because that is the routing decision the
 * run actually recorded — `executor.complex` is what a complex task was sent to,
 * and inferring complexity from anything else would be reporting a decision nobody
 * made. It reports no cost at any level: Agent Flow observes durations and counts,
 * and a price is a guess about somebody else's contract.
 *
 * And it does not read unbounded history. The most recent runs are aggregated and
 * the bound is reported in `scope`, so a chart cannot silently describe twenty of
 * two hundred runs while looking like it describes all of them.
 */

/** How many runs an aggregate covers when the caller does not say. */
export const DEFAULT_ANALYTICS_RUNS = 25;
export const MAX_CONTEXT_TELEMETRY_ANALYTICS_OBSERVATIONS = 256;

export interface AnalyticsReaderOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
}

export class AnalyticsReader {
  constructor(private readonly options: AnalyticsReaderOptions) {}

  async aggregate(
    projects: readonly RegisteredProject[],
    limit = DEFAULT_ANALYTICS_RUNS,
  ): Promise<AnalyticsView> {
    const entries: TelemetryEntry[] = [];
    const tasksByState: Record<string, number> = {};
    const runsByProject: AnalyticsView['runsByProject'] = [];
    const contextObservations: ContextTelemetryObservation[] = [];

    let runsAvailable = 0;
    let runsConsidered = 0;
    let contextRunsObserved = 0;
    let contextEventLogsTruncated = 0;
    let contextObservationsTruncated = false;

    for (const project of projects) {
      const store = new StateStore({
        fs: this.options.fs,
        clock: this.options.clock,
        projectDir: project.path,
      });
      const contextReader = new ContextTelemetryReader({
        fs: this.options.fs,
        projectDir: project.path,
      });

      // Newest first, so a bound drops the oldest history rather than an
      // arbitrary slice of it.
      const ids = await store.listRunIds();
      runsAvailable += ids.length;

      const byStatus: Record<string, number> = {};
      let total = 0;

      for (const runId of ids.slice(0, limit)) {
        let state: RunState;
        try {
          state = await store.loadRun(runId);
        } catch {
          // One unreadable run must not take the whole chart down. It is counted
          // in `runsAvailable` and absent from everything else, which is the
          // honest treatment: it happened, and nothing about it can be measured.
          continue;
        }

        total += 1;
        runsConsidered += 1;
        byStatus[state.status] = (byStatus[state.status] ?? 0) + 1;

        for (const task of state.tasks) {
          tasksByState[task.state] = (tasksByState[task.state] ?? 0) + 1;
        }

        try {
          entries.push(...(await collectTelemetry(store, state)));
        } catch {
          // A malformed historical audit line cannot take analytics down.
        }

        const context = await contextReader.read(runId);
        if (context !== undefined) {
          if (context.observations.length > 0) contextRunsObserved += 1;
          if (context.scope.truncated) contextEventLogsTruncated += 1;
          for (const observation of context.observations) {
            if (contextObservations.length === MAX_CONTEXT_TELEMETRY_ANALYTICS_OBSERVATIONS) {
              contextObservationsTruncated = true;
              break;
            }
            contextObservations.push(observation);
          }
        }
      }

      runsByProject.push({ projectId: project.id, total, byStatus });
    }

    const summary = summariseTelemetry(entries);

    const contextAggregate =
      contextObservations.length === 0
        ? undefined
        : aggregateContextTelemetry(contextObservations);
    const contextOutcomes =
      contextObservations.length > 0 ? aggregateContextOutcomes(contextObservations) : undefined;
    const context =
      (contextObservations.length > 0 && contextAggregate !== undefined) ||
      contextEventLogsTruncated > 0
        ? {
            basis: CONTEXT_TELEMETRY_BASIS,
            scope: {
              runsObserved: contextRunsObserved,
              observations: contextObservations.length,
              observationLimit: MAX_CONTEXT_TELEMETRY_ANALYTICS_OBSERVATIONS,
              eventLogsTruncated: contextEventLogsTruncated,
              truncated: contextObservationsTruncated || contextEventLogsTruncated > 0,
            },
            ...(contextAggregate === undefined ? {} : { aggregate: contextAggregate }),
            ...(contextOutcomes === undefined ? {} : { outcomes: contextOutcomes }),
          }
        : undefined;


    return {
      scope: {
        projectIds: projects.map((project) => project.id),
        runsAvailable,
        runsConsidered,
        truncated: runsConsidered < runsAvailable,
      },
      runsByProject,
      tasksByState,
      totals: {
        entries: summary.entries,
        durationMs: summary.durationMs,
        failures: summary.failures,
        fallbacks: summary.fallbacks,
        retries: summary.retries,
        reasoningClamped: summary.reasoningClamped,
      },
      byRunner: buckets(summary.byRunner),
      byModel: buckets(summary.byModel),
      byRole: buckets(summary.byRole),
      byStage: buckets(summary.byStage),
      ...(context === undefined ? {} : { context }),
    };
  }
}

/**
 * A record of buckets as a sorted array.
 *
 * An array rather than the record the summary holds, for two reasons: a chart
 * needs a stable order, and `Record` ordering is an implementation detail nobody
 * should be reading meaning into. Sorted by duration, because "where did the time
 * go" is the question every one of these answers.
 */
function buckets(source: Readonly<Record<string, TelemetryBucket>>): MetricBucketView[] {
  return Object.entries(source)
    .map(([key, bucket]) => ({ key, ...bucket }))
    .sort((a, b) => b.durationMs - a.durationMs || a.key.localeCompare(b.key));
}
