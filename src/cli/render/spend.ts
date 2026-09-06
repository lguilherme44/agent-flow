import type { TelemetryEntry } from '../../contracts/index.js';

/**
 * What a run spent, on the screen a person is already looking at (PRI-19).
 *
 * The numbers arrive on every model response and were parsed and discarded by four
 * adapters — so an orchestrator whose whole job is spending model calls could not answer
 * "what did this cost". They are recorded now; this is where they become visible without
 * anybody opening `events.jsonl`.
 *
 * **Silence is a real answer here.** A run served entirely by runners that report no
 * accounting produces no block at all, rather than a row of zeros: a reader cannot tell a
 * fabricated zero from a free call, and this product would rather say nothing than the
 * wrong thing about money.
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
    if (usage === undefined) continue;
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
  return { inputTokens, outputTokens, cacheReadTokens, costUsd, reporting, total: entries.length, pricedAny };
}

/**
 * The block, or nothing.
 *
 * The cache line is separate from the input line because the two differ by orders of
 * magnitude and only their ratio explains a bill: one measured call read 31,810 cached
 * tokens against 2 fresh ones.
 */
export function renderSpend(spend: RunSpend | undefined): string | undefined {
  if (spend === undefined) return undefined;

  const lines = [
    'Spend',
    `  tokens        ${thousands(spend.inputTokens)} in · ${thousands(spend.outputTokens)} out` +
      (spend.cacheReadTokens > 0 ? ` · ${thousands(spend.cacheReadTokens)} from cache` : ''),
  ];

  // Never a bare figure. §57 forbids this product computing a price, and PRI-19 narrowed
  // that to allow a price the *provider* reported — on the condition that it is presented
  // as the provider's number. It is not a bill: a subscriber pays a flat fee, and this is
  // an API-rate equivalent. A dollar sign with nothing beside it says otherwise.
  lines.push(
    spend.pricedAny
      ? `  cost          $${spend.costUsd.toFixed(4)} as the runner priced it — not necessarily your bill`
      : '  cost          not reported by any runner on this run',
  );

  // Named rather than implied. A total that silently covered two of nine calls is the
  // kind of number somebody budgets against.
  if (spend.reporting < spend.total) {
    lines.push(
      `  measured on   ${String(spend.reporting)} of ${String(spend.total)} calls; the rest reported nothing`,
    );
  }

  return lines.join('\n');
}

function thousands(value: number): string {
  return value.toLocaleString('en-US');
}
