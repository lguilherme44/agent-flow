import { describe, it, expect } from 'vitest';
import { renderSpend, summariseSpend } from '../../src/cli/render/spend.js';
import type { TelemetryEntry } from '../../src/contracts/index.js';

/**
 * What a run spent, on the screen (PRI-19).
 *
 * The finding was not that the numbers were hard to get. Every Claude Code response
 * carries `usage` and `total_cost_usd`, the adapter parsed the envelope already, and the
 * only mention of `usage` in four adapters was a regex looking for the words "usage
 * limit". These assertions are mostly about the *absences*: what the renderer must refuse
 * to say when a runner reported nothing.
 */

const entry = (usage?: TelemetryEntry['usage']): TelemetryEntry =>
  ({
    runId: 'AF-2026-001',
    kind: 'stage',
    stage: 'discovery',
    role: 'architect',
    runner: 'claude',
    reasoning: 'high',
    reasoningClamped: false,
    startedAt: '2026-09-05T10:00:00.000Z',
    finishedAt: '2026-09-05T10:02:00.000Z',
    durationMs: 120_000,
    status: 'completed',
    attempts: 1,
    ...(usage === undefined ? {} : { usage }),
  }) as TelemetryEntry;

describe('summariseSpend', () => {
  it('totals only what was reported', () => {
    const spend = summariseSpend([
      entry({ inputTokens: 2, outputTokens: 9, cacheReadTokens: 31810, costUsd: 0.1524 }),
      entry({ inputTokens: 20735, outputTokens: 1, cacheReadTokens: 0 }),
    ]);

    expect(spend).toEqual({
      inputTokens: 20737,
      outputTokens: 10,
      cacheReadTokens: 31810,
      costUsd: 0.1524,
      reporting: 2,
      total: 2,
      pricedAny: true,
    });
  });

  it('says nothing at all when no runner reported anything', () => {
    // Not a row of zeros. A reader cannot tell a fabricated zero from a free call, and
    // this is the one subject where guessing has a bill attached.
    expect(summariseSpend([entry(), entry()])).toBeUndefined();
  });

  it('counts the calls it measured apart from the calls that ran', () => {
    const spend = summariseSpend([entry({ inputTokens: 100 }), entry(), entry()]);
    expect(spend?.reporting).toBe(1);
    expect(spend?.total).toBe(3);
  });
});

describe('renderSpend', () => {
  it('shows tokens, cache and cost', () => {
    const rendered = renderSpend(
      summariseSpend([entry({ inputTokens: 2, outputTokens: 9, cacheReadTokens: 31810, costUsd: 0.1524 })]),
    );

    expect(rendered).toContain('31,810 from cache');
    expect(rendered).toContain('$0.1524');
  });

  it('never prints a figure without saying whose it is (§57, PRI-19)', () => {
    // §57 forbids this product computing a price and the prohibition stands. What PRI-19
    // narrowed is the case where the *provider* reported one — allowed, on the condition
    // that it is labelled as the provider's rather than as the operator's bill, because a
    // subscriber pays a flat fee and this is an API-rate equivalent.
    const rendered = renderSpend(summariseSpend([entry({ costUsd: 0.1524 })])) ?? '';

    const dollars = rendered.split('\n').find((line) => line.includes('$'));
    expect(dollars).toBeDefined();
    expect(dollars).toContain('as the runner priced it');
    expect(dollars).toContain('not necessarily your bill');
  });

  it('does not print a cost of zero when no runner priced its calls', () => {
    // `agy` reports tokens and no cost. `$0.0000` would read as free.
    const rendered = renderSpend(summariseSpend([entry({ inputTokens: 20735, outputTokens: 1 })]));

    expect(rendered).toContain('not reported by any runner');
    expect(rendered).not.toContain('$0');
  });

  it('names the coverage when part of the run went unmeasured', () => {
    const rendered = renderSpend(summariseSpend([entry({ inputTokens: 100 }), entry(), entry()]));
    expect(rendered).toContain('measured on   1 of 3 calls');
  });

  it('stays silent on a run nothing reported', () => {
    expect(renderSpend(summariseSpend([entry()]))).toBeUndefined();
  });

  it('omits the cache clause when nothing was served from cache', () => {
    const rendered = renderSpend(summariseSpend([entry({ inputTokens: 5, outputTokens: 5, cacheReadTokens: 0 })]));
    expect(rendered).not.toContain('cache');
  });
});
