import { describe, it, expect } from 'vitest';
import { renderSpend, summariseSpend } from '../../src/cli/render/spend.js';
import type { TelemetryEntry } from '../../src/contracts/index.js';
import { summariseConduct } from '../../src/core/telemetry.js';

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
      conduct: {
        turns: { total: 0, reporting: 0, of: 2 },
        permissionDenials: { count: 0, tools: [], reporting: 0, of: 2 },
      },
    });
  });

  it('does not count turns or denials as measured spend (P1.2)', () => {
    // agy with no token block yields `{ turns }`, a Claude error envelope
    // `{ permissionDenials }`. Neither said anything about cost, and counting them would
    // print `0 in · 0 out` for calls nobody measured.
    const silent = [entry({ turns: 2 }), entry({ permissionDenials: { count: 0, tools: [] } })];
    expect(summariseSpend(silent)).toBeUndefined();

    // POSITIVE CONTROL: one entry that did report tokens is measured, and only that one.
    const spend = summariseSpend([...silent, entry({ inputTokens: 10 })]);
    expect(spend?.reporting).toBe(1);
    expect(spend?.total).toBe(3);
  });

  it('carries the same conduct summary the telemetry summary does', () => {
    const entries = [entry({ inputTokens: 1, turns: 2 }), entry({ permissionDenials: { count: 1, tools: ['Write'] } })];
    expect(summariseSpend(entries)?.conduct).toEqual(summariseConduct(entries));
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

  it('returns nothing for nothing', () => {
    expect(renderSpend(undefined)).toBeUndefined();
  });
});

describe('renderSpend: turns and permission denials (P1.2)', () => {
  const lineOf = (rendered: string | undefined, label: string): string | undefined =>
    rendered?.split('\n').find((line) => line.trimStart().startsWith(label));

  it('says turns and denials were not reported when no runner reported them', () => {
    const rendered = renderSpend(summariseSpend([entry({ inputTokens: 5, outputTokens: 1 })]));

    expect(rendered).toBe(
      [
        'Spend',
        '  tokens        5 in · 1 out',
        '  cost          not reported by any runner on this run',
        '  turns         not reported by any runner on this run',
        '  permission denials  not reported by any runner on this run',
      ].join('\n'),
    );
  });

  it('names partial coverage for turns', () => {
    const rendered = renderSpend(
      summariseSpend([entry({ inputTokens: 1, turns: 2 }), entry({ inputTokens: 1, turns: 3 }), entry({ inputTokens: 1 })]),
    );

    expect(lineOf(rendered, 'turns')).toBe('  turns         5; measured on 2 of 3 calls');
  });

  it('prints the total alone when every call reported turns', () => {
    const rendered = renderSpend(summariseSpend([entry({ inputTokens: 1, turns: 2 })]));
    expect(lineOf(rendered, 'turns')).toBe('  turns         2');
  });

  it('says "none" for a reported zero, which is not the same as silence', () => {
    const rendered = renderSpend(
      summariseSpend([entry({ inputTokens: 1, permissionDenials: { count: 0, tools: [] } })]),
    );

    expect(lineOf(rendered, 'permission denials')).toBe('  permission denials  none');
  });

  it('prints the count and the denied tools, with coverage', () => {
    const rendered = renderSpend(
      summariseSpend([
        entry({ inputTokens: 1, permissionDenials: { count: 2, tools: ['Write'] } }),
        entry({ inputTokens: 1, permissionDenials: { count: 1, tools: ['Bash', 'Write'] } }),
        entry({ inputTokens: 1 }),
      ]),
    );

    expect(lineOf(rendered, 'permission denials')).toBe(
      '  permission denials  3 (Write, Bash); measured on 2 of 3 calls',
    );
  });

  it('prints a count with no names when no denial named its tool', () => {
    const rendered = renderSpend(
      summariseSpend([entry({ inputTokens: 1, permissionDenials: { count: 2, tools: [] } })]),
    );

    expect(lineOf(rendered, 'permission denials')).toBe('  permission denials  2');
  });

  it('still prints no block at all when nothing reported spend', () => {
    // Turns alone do not open the block: it is the spend block, and it stays silent (PRI-19).
    expect(renderSpend(summariseSpend([entry({ turns: 4 }), entry()]))).toBeUndefined();
  });
});
