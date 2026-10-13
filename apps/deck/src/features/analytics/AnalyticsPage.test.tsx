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
  byRunner: [{ key: 'agy', count: 260, durationMs: 7_200_000, failures: 9, fallbacks: 2, retries: 14, inputTokens: 0, outputTokens: 0, usageReporting: 0 }],
  byModel: [],
  byRole: [{ key: 'architect', count: 50, durationMs: 3_000_000, failures: 0, fallbacks: 0, retries: 0, inputTokens: 0, outputTokens: 0, usageReporting: 0 }],
  byRoleModel: [],
  byEffort: [],
  quality: [],
  byStage: [
    { key: 'discovery', count: 50, durationMs: 4_000_000, failures: 0, fallbacks: 0, retries: 0, inputTokens: 0, outputTokens: 0, usageReporting: 0 },
    { key: 'planning', count: 50, durationMs: 3_200_000, failures: 9, fallbacks: 2, retries: 14, inputTokens: 0, outputTokens: 0, usageReporting: 0 },
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
    expect(screen.getByText(/50 de 200 execuções/)).toBeInTheDocument();
  });

  it('names a model by its id, verbatim', async () => {
    // Measured on the real page, 23/09/2026: the model list read "claude opus 5 5" — the
    // humaniser meant for stage tokens turned the id's hyphens into spaces, and the one
    // string a person copies into the Crew page stopped being copyable.
    serve({
      ...ANALYTICS,
      byModel: [{ key: 'claude-opus-5-5', count: 2, durationMs: 1_000_000, failures: 0, fallbacks: 0, retries: 0, inputTokens: 0, outputTokens: 0, usageReporting: 0 }],
    });
    render(<AnalyticsPage />);

    const models = await screen.findByLabelText(t.telemetry.byModel);
    expect([...models.querySelectorAll('.doctor-row__name')].map((node) => node.textContent)).toEqual(['claude-opus-5-5']);
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

  it('shows no monetary figure', async () => {
    // The declared decision, asserted rather than assumed: a page that grew a currency
    // later would have to come and delete this. The paragraph explaining it on the page
    // went on 23/09/2026 — it explained a feature that does not exist.
    serve();
    render(<AnalyticsPage />);

    await screen.findByLabelText(t.telemetry.byStage);
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

  // Dogfood 08/10 (Luis): which model to put in which role, decided with data.
  it('shows what each role × model spent in tokens, and what each model’s code looked like', async () => {
    serve({
      ...ANALYTICS,
      byRoleModel: [
        {
          key: 'executor.normal · claude-sonnet-5-5',
          count: 4,
          durationMs: 1_000_000,
          failures: 0,
          fallbacks: 0,
          retries: 1,
          inputTokens: 120_000,
          outputTokens: 8_000,
          usageReporting: 4,
        },
      ],
      byEffort: [],
      quality: [{ model: 'claude-sonnet-5-5', tasks: 4, firstAttempt: 3, reviewed: 4, findings: { high: 1, medium: 2 } }],
    });
    render(<AnalyticsPage />);

    const roles = await screen.findByLabelText(t.analytics.byRoleModel);
    expect(roles.textContent).toContain('executor.normal · claude-sonnet-5-5');
    expect(roles.textContent).toContain(t.telemetry.tokens(120_000, 8_000));

    const quality = screen.getByLabelText(t.analytics.quality);
    expect(quality.textContent).toContain('claude-sonnet-5-5');
    expect(quality.textContent).toContain(t.analytics.firstAttempt(3, 4));
    expect(quality.textContent).toContain(`1 ${t.words.high}`);
    expect(quality.textContent).toContain(`2 ${t.words.medium}`);
  });

  it('reads a hub that does not send the new sections yet', async () => {
    // An older hub answers without them; the page must still draw what it has.
    const legacy = Object.fromEntries(
      Object.entries(ANALYTICS).filter(([key]) => !['byRoleModel', 'byEffort', 'quality'].includes(key)),
    ) as unknown as AnalyticsView;
    serve(legacy);
    render(<AnalyticsPage />);

    expect(await screen.findByLabelText(t.telemetry.byStage)).toBeInTheDocument();
    expect(screen.queryByLabelText(t.analytics.quality)).toBeNull();
  });

  it('says nothing has run rather than drawing empty bars', async () => {
    // The positive control for every section above: same page, one number different.
    serve({ ...ANALYTICS, totals: { ...ANALYTICS.totals, entries: 0 } });
    render(<AnalyticsPage />);

    expect(await screen.findByText(t.analytics.noStageRan)).toBeInTheDocument();
    expect(screen.queryByLabelText(t.telemetry.byStage)).toBeNull();
  });
});
