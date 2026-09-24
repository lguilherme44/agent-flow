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
  /** Turns and permission denials, as the runners reported them (P1.2). */
  readonly conduct: RunConduct;
}

/**
 * How the calls behaved, as opposed to what they cost (P1.2): how many turns the runners
 * said they took, and how many tool calls they said were denied.
 *
 * **`reporting` and `of` travel with every total**, for the same reason `RunSpend` keeps
 * them apart: most runners report neither field, and a total of 3 turns over nine calls of
 * which one reported is not a run that took 3 turns. `reporting: 0` is the honest shape of
 * "nobody said", and it is what a run older than these fields reads as.
 */
export interface RunConduct {
  readonly turns: { readonly total: number; readonly reporting: number; readonly of: number };
  readonly permissionDenials: {
    readonly count: number;
    /** Every denied tool name, once, in the order the entries first named it. */
    readonly tools: readonly string[];
    readonly reporting: number;
    readonly of: number;
  };
}

/**
 * Totals turns and denials over the entries that reported them, and only those.
 *
 * An entry without a field adds nothing and is not counted: inferring a `0` for a runner
 * that never reports turns would make its calls look free of them. An entry that reported
 * `{ count: 0, tools: [] }` is counted — "no denials" is an answer, and a different one
 * from silence.
 */
export function summariseConduct(entries: readonly TelemetryEntry[]): RunConduct {
  let turnsTotal = 0;
  let turnsReporting = 0;
  let deniedCount = 0;
  let deniedReporting = 0;
  const tools: string[] = [];

  for (const entry of entries) {
    const usage = entry.usage;
    if (usage?.turns !== undefined) {
      turnsTotal += usage.turns;
      turnsReporting += 1;
    }
    if (usage?.permissionDenials !== undefined) {
      deniedCount += usage.permissionDenials.count;
      deniedReporting += 1;
      for (const tool of usage.permissionDenials.tools) {
        if (!tools.includes(tool)) tools.push(tool);
      }
    }
  }

  return {
    turns: { total: turnsTotal, reporting: turnsReporting, of: entries.length },
    permissionDenials: { count: deniedCount, tools, reporting: deniedReporting, of: entries.length },
  };
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
    conduct: summariseConduct(entries),
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

/**
 * What a run spent, as the runners reported it (PRI-19).
 *
 * **Here rather than in `cli/render/`, and that move is the whole of why the dashboard
 * could not show a cost.** The projection was pure and correct and lived one directory
 * inside the CLI, so the only surface that could reach it was the terminal — an
 * orchestrator whose entire job is spending model calls answered "what did this cost"
 * on exactly one screen, and it was not the one `agent-flow ui` opens. Rendering stays
 * in the CLI; deciding the numbers is core's, so both surfaces read one answer.
 *
 * **Silence is a real answer.** A run served entirely by runners that report no
 * accounting produces `undefined`, not a row of zeros: a reader cannot tell a fabricated
 * zero from a free call, and this product would rather say nothing than the wrong thing
 * about money.
 */
export interface RunSpend {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  /** How many entries reported anything at all, out of how many ran. */
  readonly reporting: number;
  readonly total: number;
  /** Whether any entry reported a cost, as opposed to only tokens. */
  readonly pricedAny: boolean;
  /** The same `summariseConduct` answer the telemetry summary carries, so the two agree. */
  readonly conduct: RunConduct;
}

/**
 * Totals across every stage and task, counting only what was actually reported.
 *
 * `reporting` and `total` are kept apart on purpose. A run where one of two runners prices
 * its calls has a real number and an incomplete one, and a total presented as though it
 * covered everything would understate the run by however much the silent runner cost.
 */
export function summariseSpend(entries: readonly TelemetryEntry[]): RunSpend | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let reporting = 0;
  let pricedAny = false;

  for (const entry of entries) {
    const usage = entry.usage;
    // A usage block is not necessarily a spend report (P1.2). agy with no token block
    // yields `{ turns }`, and a Claude error envelope `{ permissionDenials }`; counting
    // either here would print a fabricated `0 in · 0 out` and claim a call was measured
    // when nothing about its cost was said.
    if (usage === undefined || !reportsSpend(usage)) continue;
    reporting += 1;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    if (usage.costUsd !== undefined) {
      costUsd += usage.costUsd;
      pricedAny = true;
    }
  }

  if (reporting === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd,
    reporting,
    total: entries.length,
    pricedAny,
    conduct: summariseConduct(entries),
  };
}

type RunUsage = NonNullable<TelemetryEntry['usage']>;

/** The usage fields that describe spend. `turns` and `permissionDenials` do not. */
const SPEND_FIELDS = [
  'model',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
] as const satisfies readonly (keyof RunUsage)[];

function reportsSpend(usage: RunUsage): boolean {
  return SPEND_FIELDS.some((field) => usage[field] !== undefined);
}
