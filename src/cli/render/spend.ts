import { summariseSpend, type RunSpend } from '../../core/telemetry.js';

/**
 * What a run spent, on the screen a person is already looking at (PRI-19).
 *
 * **The projection moved to `core/telemetry.ts`; only the rendering is still here.** It
 * was pure and correct and lived inside the CLI, so the only surface that could reach it
 * was the terminal — an orchestrator whose entire job is spending model calls answered
 * "what did this cost" on exactly one screen, and not the one `agent-flow ui` opens.
 * Deciding the numbers is core's; turning them into lines is this module's.
 *
 * Re-exported rather than re-declared, so `status.ts` and every existing import keep
 * resolving against one definition.
 */
export { summariseSpend, type RunSpend };


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
