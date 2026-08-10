import type { TelemetryEntry } from '../contracts/index.js';

/**
 * Aggregation over operational telemetry.
 *
 * Pure, and deliberately so: these numbers describe a run, they never steer one.
 * Nothing in the workflow reads this module, and nothing should — the moment a
 * decision depends on an aggregate, the aggregate becomes a source of truth that
 * has to be kept correct, and there is already one of those.
 *
 * What it is for is the questions a person asks *afterwards*, and that a
 * dashboard will ask later: where did the time go, which runner did the work,
 * how often did a fallback fire, how often did something have to be retried.
 *
 * No monetary value appears here. Duration and counts are facts this tool
 * actually observed; a price is a guess about someone else's contract.
 */

export interface TelemetryBucket {
  readonly count: number;
  readonly durationMs: number;
  /** Entries whose status is anything other than `completed`. */
  readonly failures: number;
  /** Entries that ran somewhere other than where they were routed. */
  readonly fallbacks: number;
  /** Invocations beyond the first, summed. */
  readonly retries: number;
}

export interface TelemetrySummary {
  readonly entries: number;
  readonly durationMs: number;
  readonly failures: number;
  readonly fallbacks: number;
  readonly retries: number;
  /** Entries that ran below the effort they were configured for (R-15). */
  readonly reasoningClamped: number;
  readonly byRunner: Record<string, TelemetryBucket>;
  /** Keyed by the model the runner reported; entries without one are omitted. */
  readonly byModel: Record<string, TelemetryBucket>;
  readonly byRole: Record<string, TelemetryBucket>;
  readonly byStage: Record<string, TelemetryBucket>;
}

const EMPTY: TelemetryBucket = {
  count: 0,
  durationMs: 0,
  failures: 0,
  fallbacks: 0,
  retries: 0,
};

export function summariseTelemetry(entries: readonly TelemetryEntry[]): TelemetrySummary {
  return {
    entries: entries.length,
    durationMs: sum(entries, (entry) => entry.durationMs),
    failures: entries.filter(isFailure).length,
    fallbacks: entries.filter((entry) => entry.fallback !== undefined).length,
    retries: sum(entries, (entry) => entry.attempts - 1),
    reasoningClamped: entries.filter((entry) => entry.reasoningClamped).length,
    byRunner: groupBy(entries, (entry) => entry.runner),
    byModel: groupBy(entries, (entry) => entry.model),
    byRole: groupBy(entries, (entry) => entry.role),
    byStage: groupBy(entries, (entry) => entry.stage),
  };
}

/**
 * Buckets by a key each entry carries.
 *
 * An entry whose key is absent is left out rather than filed under a made-up
 * label: a runner that reported no model has not told us it uses "unknown", it
 * has told us nothing, and `byModel` counting it would report a model that does
 * not exist.
 */
export function groupBy(
  entries: readonly TelemetryEntry[],
  keyOf: (entry: TelemetryEntry) => string | undefined,
): Record<string, TelemetryBucket> {
  const buckets: Record<string, TelemetryBucket> = {};

  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === undefined) continue;

    const current = buckets[key] ?? EMPTY;
    buckets[key] = {
      count: current.count + 1,
      durationMs: current.durationMs + entry.durationMs,
      failures: current.failures + (isFailure(entry) ? 1 : 0),
      fallbacks: current.fallbacks + (entry.fallback === undefined ? 0 : 1),
      retries: current.retries + (entry.attempts - 1),
    };
  }

  return buckets;
}

/** Duration between two ISO instants, floored at zero. */
export function durationBetween(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);

  // A clock that went backwards, or a timestamp that did not parse, must not
  // produce a negative duration that then poisons every sum it lands in.
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function isFailure(entry: TelemetryEntry): boolean {
  return entry.status !== 'completed';
}

function sum(
  entries: readonly TelemetryEntry[],
  valueOf: (entry: TelemetryEntry) => number,
): number {
  return entries.reduce((total, entry) => total + valueOf(entry), 0);
}
