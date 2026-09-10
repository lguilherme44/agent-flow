import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsView, ProjectView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { AnalyticsPage } from './AnalyticsPage';
import { ptBR as t } from '../../lib/i18n';

/**
 * 7.4 — aggregates over recent runs, on the surface `ui` opens.
 *
 * Two assertions are the item's own scope note rather than decoration. The **scope line**,
 * because the server answers over a bounded window and a chart that silently described
 * twenty of two hundred runs would be lying about its own subject. And the **absence of
 * money**, because that is a declared decision in the contract — a subscriber's flat fee is
 * not a per-token rate, so a total here would be a number nobody is charging.
 */

const projects: ProjectView[] = [
  { id: 'flowcanvas', name: 'Flow Canvas', path: '/wk/flowcanvas', currentRunId: null, status: null, runCount: 4 },
];

const ANALYTICS: AnalyticsView = {
  scope: { projectIds: ['flowcanvas'], runsAvailable: 200, runsConsidered: 50, truncated: true },
  runsByProject: [{ projectId: 'flowcanvas', total: 50, byStatus: { completed: 44, failed: 6 } }],
  tasksByState: { completed: 180, failed: 9 },
  totals: {
    entries: 260,
    durationMs: 7_200_000,
    failures: 9,
    fallbacks: 2,
    retries: 14,
    reasoningClamped: 3,
  },
  byRunner: [{ key: 'agy', count: 260, durationMs: 7_200_000, failures: 9, fallbacks: 2, retries: 14 }],
  byModel: [],
  byRole: [{ key: 'architect', count: 50, durationMs: 3_000_000, failures: 0, fallbacks: 0, retries: 0 }],
  byStage: [
    { key: 'discovery', count: 50, durationMs: 4_000_000, failures: 0, fallbacks: 0, retries: 0 },
    { key: 'planning', count: 50, durationMs: 3_200_000, failures: 9, fallbacks: 2, retries: 14 },
  ],
};

function response(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

const serve = (view: AnalyticsView = ANALYTICS) => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const target = String(input);
    if (target.includes('/projects')) return response(projects);
    return response(view);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

describe('the analytics page', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  it('says how much of the history it is describing', async () => {
    serve();
    render(<AnalyticsPage />);

    expect(await screen.findByText(t.analytics.scope(50, 200, true))).toBeInTheDocument();
    expect(screen.getByText(/50 de 200 runs/)).toBeInTheDocument();
  });

  it('ranks the stages by time, longest first', async () => {
    serve();
    render(<AnalyticsPage />);

    const stages = await screen.findByLabelText(t.telemetry.byStage);
    const names = [...stages.querySelectorAll('.doctor-row__name')].map((node) => node.textContent);
    expect(names).toEqual([t.words.discovery, t.words.planning]);
  });

  it('counts how runs ended, per project', async () => {
    serve();
    render(<AnalyticsPage />);

    const outcomes = await screen.findByLabelText(t.analytics.outcomes);
    expect(outcomes.textContent).toContain(`44 ${t.words.completed}`);
    expect(outcomes.textContent).toContain(`6 ${t.words.failed}`);
  });

  it('shows no monetary figure, and says that is deliberate', async () => {
    // The declared decision, asserted rather than assumed: a page that grew a currency
    // later would have to come and delete this.
    serve();
    render(<AnalyticsPage />);

    expect(await screen.findByText(t.analytics.noFigures)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[$€£]\s?\d/);
  });

  it('narrows to one project when asked, and asks the server again', async () => {
    const fetcher = serve();
    render(<AnalyticsPage />);
    await screen.findByLabelText(t.telemetry.byStage);

    fireEvent.change(screen.getByLabelText(t.common.project), { target: { value: 'flowcanvas' } });

    await waitFor(() => {
      expect(
        fetcher.mock.calls.some(([input]) => String(input).includes('projectId=flowcanvas')),
      ).toBe(true);
    });
  });

  it('says nothing has run rather than drawing empty bars', async () => {
    // The positive control for every section above: same page, one number different.
    serve({ ...ANALYTICS, totals: { ...ANALYTICS.totals, entries: 0 } });
    render(<AnalyticsPage />);

    expect(await screen.findByText(t.analytics.noStageRan)).toBeInTheDocument();
    expect(screen.queryByLabelText(t.telemetry.byStage)).toBeNull();
  });
});
