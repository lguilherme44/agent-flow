import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunTelemetryView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { TelemetryTab } from './Telemetry';
import { ptBR as t } from '../../lib/i18n';

/**
 * 7.4 — what a stage cost, and what its prompt was made of.
 *
 * The two assertions that carry the item are the last two: that the AR-09 context
 * estimates reach a reader at all — the previous dashboard's hand-written response type
 * had dropped the field, so it was served and drawn nowhere — and that *absent* is
 * rendered as "not observed" rather than as a comfortable zero.
 */

const address = { projectId: 'flowcanvas', runId: 'AF-2026-001' };

const TELEMETRY: RunTelemetryView = {
  entries: [],
  summary: {
    entries: 6,
    durationMs: 300_000,
    failures: 1,
    fallbacks: 0,
    retries: 2,
    reasoningClamped: 1,
    byStage: {
      discovery: { count: 1, durationMs: 200_000, failures: 0, fallbacks: 0, retries: 0 },
      planning: { count: 1, durationMs: 100_000, failures: 1, fallbacks: 0, retries: 2 },
    },
    byRunner: { agy: { count: 6, durationMs: 300_000, failures: 1, fallbacks: 0, retries: 2 } },
    byModel: {},
    byRole: { architect: { count: 1, durationMs: 200_000, failures: 0, fallbacks: 0, retries: 0 } },
  },
  context: {
    basis: 'estimated_operational_not_billing',
    scope: { eventsScanned: 120, eventLimit: 500, observations: 1, truncated: false },
    observations: [
      {
        stage: 'retrieval',
        source: 'repository_retrieval',
        provenance: 'adapter_observation',
        estimatedInputTokens: 21_500,
        estimatedAvoidedTokens: 8_000,
        filesBefore: 240,
        filesAfter: 18,
      },
    ],
  },
};

function response(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const serve = (view: RunTelemetryView) => {
  vi.stubGlobal('fetch', vi.fn(() => response(view)));
};

describe('the run telemetry tab', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  it('says how long the run took in total', async () => {
    serve(TELEMETRY);
    render(<TelemetryTab address={address} />);

    // Scoped: the same duration appears again as a bar label further down, and a query
    // that could not tell the two apart would pass on a page with no totals at all.
    const totals = await screen.findByLabelText(t.telemetry.totals);
    expect(totals.textContent).toContain(t.telemetry.totalTime);
    expect(totals.textContent).toContain('5m');
  });

  it('breaks the time down by stage, longest first', async () => {
    serve(TELEMETRY);
    render(<TelemetryTab address={address} />);

    const stages = await screen.findByLabelText(t.telemetry.byStage);
    const names = [...stages.querySelectorAll('.doctor-row__name')].map((node) => node.textContent);
    expect(names).toEqual([t.words.discovery, t.words.planning]);
  });

  it('names a retry and a failure rather than folding them into the duration', async () => {
    serve(TELEMETRY);
    render(<TelemetryTab address={address} />);

    const stages = await screen.findByLabelText(t.telemetry.byStage);
    expect(stages.textContent).toContain(t.telemetry.retried(2));
    expect(stages.textContent).toContain(t.telemetry.failed(1));
  });

  it('says a missing model list is a configuration, not a gap', async () => {
    // AD-13 recommends pinning no model, which is exactly the shape that leaves this
    // bucket empty — and an empty section with no sentence reads as a broken page.
    serve(TELEMETRY);
    render(<TelemetryTab address={address} />);

    expect(await screen.findByLabelText(t.telemetry.byModel)).toHaveTextContent(t.telemetry.noModelReported);
  });

  it('draws what the prompt was made of, by source', async () => {
    // The AR-09 half. It is the answer to "why did that stage cost so much", and it was
    // served with nothing anywhere reading it.
    serve(TELEMETRY);
    render(<TelemetryTab address={address} />);

    const context = await screen.findByLabelText(t.telemetry.promptMadeOf);
    expect(context.textContent).toContain(t.words.repository_retrieval);
    expect(context.textContent).toMatch(new RegExp(t.telemetry.tokensIn('21[.,]500')));
    expect(context.textContent).toMatch(new RegExp(t.telemetry.tokensAvoided('8[.,]000')));
    expect(context.textContent).toContain(t.telemetry.files(240, 18));
    // Never a bill, and it says so where the numbers are.
    expect(context.textContent).toContain('nunca uma conta');
  });

  it('treats absent context as not observed, never as zero', async () => {
    // The positive control for the section above, and the contract's own rule: a run whose
    // log was capped, or which predates the recorder, has told us nothing.
    const { context, ...withoutContext } = TELEMETRY;
    expect(context).toBeDefined();
    serve(withoutContext);
    render(<TelemetryTab address={address} />);

    expect(await screen.findByText(t.telemetry.noContextRecorded)).toBeInTheDocument();
    expect(screen.queryByLabelText(t.telemetry.promptMadeOf)).toBeNull();
  });

  it('says nothing has run rather than drawing an empty chart', async () => {
    serve({ ...TELEMETRY, summary: { ...TELEMETRY.summary, entries: 0 } });
    render(<TelemetryTab address={address} />);

    expect(await screen.findByText(t.telemetry.nothingRunYet)).toBeInTheDocument();
  });
});
