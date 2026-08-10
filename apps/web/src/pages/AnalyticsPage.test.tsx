import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import type { AnalyticsView } from '@contracts/index.js';
import { ProjectProvider } from '../app/project-context';
import { createQueryClient } from '../app/App';
import { AnalyticsPage } from './AnalyticsPage';

/**
 * UI-25 — operational analytics.
 *
 * Every assertion here is about a claim the page must not make: no money, no
 * metric the data cannot support, and no aggregate that hides how much history it
 * actually covers. A wrong number on this page is worse than a missing one,
 * because nothing on screen contradicts it.
 */

const ANALYTICS: AnalyticsView = {
  scope: {
    projectIds: ['demo', 'other'],
    runsAvailable: 40,
    runsConsidered: 25,
    truncated: true,
  },
  runsByProject: [
    { projectId: 'demo', total: 18, byStatus: { completed: 12, failed: 4, running: 2 } },
    { projectId: 'other', total: 7, byStatus: { completed: 7 } },
    // A project with no runs in the window. Filtered out rather than drawn as an
    // empty bar, which would read as "nothing happened here" instead of "nothing
    // in this window".
    { projectId: 'quiet', total: 0, byStatus: {} },
  ],
  tasksByState: { completed: 96, failed: 7, queued: 12, blocked: 2 },
  totals: {
    entries: 214,
    durationMs: 9_845_000,
    failures: 7,
    fallbacks: 3,
    retries: 11,
    reasoningClamped: 4,
  },
  byRunner: [
    { key: 'codex', count: 140, durationMs: 6_100_000, failures: 5, fallbacks: 3, retries: 9 },
    { key: 'claude', count: 74, durationMs: 3_745_000, failures: 2, fallbacks: 0, retries: 2 },
  ],
  byModel: [
    { key: 'GPT-5.6 Terra', count: 96, durationMs: 3_900_000, failures: 3, fallbacks: 1, retries: 5 },
    { key: 'Claude Opus', count: 74, durationMs: 3_745_000, failures: 2, fallbacks: 0, retries: 2 },
    { key: 'GPT-5.6 Sol', count: 44, durationMs: 2_200_000, failures: 2, fallbacks: 2, retries: 4 },
  ],
  byRole: [
    { key: 'executor.complex', count: 30, durationMs: 3_100_000, failures: 3, fallbacks: 1, retries: 6 },
    { key: 'executor.normal', count: 52, durationMs: 2_400_000, failures: 1, fallbacks: 0, retries: 2 },
    { key: 'architect', count: 40, durationMs: 1_900_000, failures: 0, fallbacks: 0, retries: 0 },
    { key: 'executor.trivial', count: 18, durationMs: 400_000, failures: 0, fallbacks: 0, retries: 0 },
  ],
  byStage: [
    { key: 'planning', count: 25, durationMs: 2_600_000, failures: 1, fallbacks: 2, retries: 3 },
    { key: 'discovery', count: 25, durationMs: 1_800_000, failures: 0, fallbacks: 0, retries: 0 },
    { key: 'sdd', count: 25, durationMs: 2_100_000, failures: 0, fallbacks: 0, retries: 0 },
  ],
};

let routes: Record<string, unknown> = {};

beforeEach(() => {
  routes = { '/api/v1/analytics': ANALYTICS, '/api/v1/projects': [] };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = input.split('?')[0] ?? input;
      const body = routes[path];

      if (body === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no analytics' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipPrimitive.Provider>
        <ProjectProvider>
          <MemoryRouter initialEntries={['/analytics']}>
            <AnalyticsPage />
          </MemoryRouter>
        </ProjectProvider>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

function panel(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;
}

describe('analytics', () => {
  it('reports the totals the telemetry actually holds', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Analytics' });

    expect(screen.getByText('214')).toBeInTheDocument();
    expect(screen.getByText('2h44m')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Clamped effort is a degradation, so it gets a number of its own rather than
    // being folded into failures.
    expect(screen.getByText('Effort clamped')).toBeInTheDocument();
  });

  it('says how much history it covers when it covers less than all of it', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Analytics' });

    // A chart describing twenty-five of forty runs while looking like it describes
    // all forty is worse than no chart.
    expect(screen.getByText('25 of 40 runs')).toBeInTheDocument();
  });

  it('says it covers everything when it does', async () => {
    routes['/api/v1/analytics'] = {
      ...ANALYTICS,
      scope: { ...ANALYTICS.scope, runsAvailable: 25, truncated: false },
    };
    renderPage();

    expect(await screen.findByText(/all 25 runs/)).toBeInTheDocument();
    expect(screen.queryByText(/of 40 runs/)).toBeNull();
  });

  it('orders stages by the pipeline, not by duration', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Time per stage' });

    // "Where does the time go" is read against the sequence the run went through.
    // Sorting discovery after planning because it happened to be slower breaks the
    // shape a reader is looking for.
    const rows = within(panel('Time per stage')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent?.split(/\d/)[0]?.trim())).toEqual([
      'Discovery',
      'SDD',
      'Planning',
    ]);
  });

  it('labels time per complexity as time per executor role', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Time per complexity' });

    // The router sends a complex task to `executor.complex`, and that decision is
    // what the run recorded. Inferring complexity any other way would report a
    // routing decision nobody made — so the page says which it is showing.
    const complexity = panel('Time per complexity');
    expect(within(complexity).getByText('by executor role')).toBeInTheDocument();

    // Only the executor roles, and named without the prefix.
    const rows = within(complexity).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(complexity).queryByText(/architect/i)).toBeNull();
  });

  it('groups distribution by model, and says so', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Distribution' });

    const distribution = panel('Distribution');
    expect(within(distribution).getByText('by model')).toBeInTheDocument();
    expect(within(distribution).getByText('GPT-5.6 Terra')).toBeInTheDocument();
    // Runner appears as a footnote, because "which model did the work" and "which
    // provider executed it" are different questions.
    expect(within(distribution).getByText('By runner')).toBeInTheDocument();
  });

  it('falls back to runner when no adapter reported a model', async () => {
    routes['/api/v1/analytics'] = { ...ANALYTICS, byModel: [] };
    renderPage();
    await screen.findByRole('heading', { name: 'Distribution' });

    // Common in practice: a role that pins no model leaves the flag off. A donut
    // labelled "unknown 100%" would be worse than saying what it knows.
    expect(within(panel('Distribution')).getByText('by runner')).toBeInTheDocument();
  });

  it('leaves a project with no runs in the window out of the chart', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Runs per project' });

    // An empty bar reads as "nothing happened here" rather than "nothing in this
    // window", and the two are not the same claim.
    const runs = panel('Runs per project');
    expect(within(runs).getByText('demo')).toBeInTheDocument();
    expect(within(runs).queryByText('quiet')).toBeNull();
  });

  it('says a metric is not available rather than showing it as zero', async () => {
    routes['/api/v1/analytics'] = { ...ANALYTICS, byStage: [] };
    renderPage();
    await screen.findByRole('heading', { name: 'Time per stage' });

    // Nothing recorded it is a different fact from it being zero, and a zero bar
    // asserts the second.
    expect(within(panel('Time per stage')).getByText('Not available yet.')).toBeInTheDocument();
  });

  it('shows no monetary figure anywhere', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Analytics' });

    // Agent Flow observes durations and counts. A price is a guess about a contract
    // between the user and somebody else.
    expect(document.body.textContent).not.toMatch(/cost|price|\$|usd/i);
  });

  it('tells somebody with no history that there is nothing to measure', async () => {
    routes['/api/v1/analytics'] = {
      ...ANALYTICS,
      scope: { projectIds: ['demo'], runsAvailable: 0, runsConsidered: 0, truncated: false },
    };
    renderPage();

    expect(await screen.findByText('Nothing to measure yet.')).toBeInTheDocument();
  });

  it('says analytics could not be read rather than drawing empty charts', async () => {
    delete routes['/api/v1/analytics'];
    renderPage();

    expect(
      await screen.findByText('Analytics could not be read.', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
  });
});
