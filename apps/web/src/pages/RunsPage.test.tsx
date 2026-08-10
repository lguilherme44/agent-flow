import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import type { RunSummaryView } from '@contracts/index.js';
import { ProjectProvider } from '../app/project-context';
import { createQueryClient } from '../app/App';
import { RunsPage, filterRuns } from './RunsPage';

/**
 * UI-21 — the runs history.
 *
 * The behaviour worth protecting is not "a table renders". It is that the four
 * distinguishable outcomes stay distinguishable, that the filters narrow rather
 * than refetch, and that an empty list and a filtered-to-nothing list say
 * different things — because "no runs yet" next to an active status filter is the
 * message that sends somebody looking for a bug that is not there.
 */

const RUNS: RunSummaryView[] = [
  {
    projectId: 'demo',
    runId: 'AF-2026-104',
    feature: 'Add weekly recurrence',
    stage: 'implementation',
    status: 'running',
    approved: true,
    createdAt: '2026-08-10T19:34:00.000Z',
    updatedAt: '2026-08-10T20:15:22.000Z',
    taskCount: 9,
    completedTasks: 4,
    degradations: 0,
    progress: 44,
    durationMs: 2_482_000,
  },
  {
    projectId: 'demo',
    runId: 'AF-2026-103',
    feature: 'Cache availability per professional',
    stage: 'final-review',
    status: 'completed',
    approved: true,
    createdAt: '2026-08-09T14:02:00.000Z',
    updatedAt: '2026-08-09T15:30:00.000Z',
    taskCount: 6,
    completedTasks: 6,
    degradations: 2,
    progress: 100,
    durationMs: 5_280_000,
  },
  {
    projectId: 'other',
    runId: 'AF-2026-102',
    feature: 'Product recommendations',
    stage: 'implementation',
    status: 'failed',
    approved: true,
    createdAt: '2026-08-08T09:15:00.000Z',
    updatedAt: '2026-08-08T10:41:00.000Z',
    taskCount: 8,
    completedTasks: 3,
    degradations: 0,
    progress: 38,
    durationMs: 5_160_000,
  },
  {
    projectId: 'other',
    runId: 'AF-2026-101',
    feature: 'Queue metrics on health',
    stage: 'plan-review',
    status: 'waiting_for_approval',
    approved: false,
    createdAt: '2026-08-08T08:00:00.000Z',
    updatedAt: '2026-08-08T08:26:00.000Z',
    taskCount: 5,
    completedTasks: 0,
    degradations: 0,
    progress: 0,
    durationMs: 1_560_000,
  },
];

const PROJECTS = [
  { id: 'demo', name: 'demo', path: '/repo', currentRunId: 'AF-2026-104', status: 'running', runCount: 2 },
  { id: 'other', name: 'other', path: '/other', currentRunId: null, status: null, runCount: 2 },
];

let routes: Record<string, unknown> = {};
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  routes = { '/api/v1/projects': PROJECTS, '/api/v1/runs': RUNS };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(input);
      const path = input.split('?')[0] ?? input;
      const body = routes[path];

      if (body === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no such endpoint' }), {
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
          <MemoryRouter initialEntries={['/runs']}>
            <RunsPage />
          </MemoryRouter>
        </ProjectProvider>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

/** A row by the feature it names, which is what a person scans for. */
function row(feature: string): HTMLElement {
  return screen.getByText(feature).closest('tr') as HTMLElement;
}

describe('the runs history', () => {
  it('shows every run with a status, a stage, progress and a duration', async () => {
    renderPage();

    expect(await screen.findByText('Add weekly recurrence')).toBeInTheDocument();

    // Four runs and a header row.
    expect(screen.getAllByRole('row')).toHaveLength(5);

    const running = row('Add weekly recurrence');
    expect(within(running).getByText('RUNNING')).toBeInTheDocument();
    expect(within(running).getByText('Implementation')).toBeInTheDocument();
    expect(within(running).getByText('4/9')).toBeInTheDocument();
    // 2_482_000ms — two units, never three.
    expect(within(running).getByText('41m22s')).toBeInTheDocument();
  });

  it('keeps completed, running, failed and waiting runs distinguishable', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    // §97: status is icon plus text, so the word is present for every one of
    // them and not only for the ones whose colour happens to differ most.
    expect(within(row('Add weekly recurrence')).getByText('RUNNING')).toBeInTheDocument();
    expect(within(row('Cache availability per professional')).getByText('COMPLETED')).toBeInTheDocument();
    expect(within(row('Product recommendations')).getByText('FAILED')).toBeInTheDocument();
    expect(
      within(row('Queue metrics on health')).getByText('WAITING APPROVAL'),
    ).toBeInTheDocument();
  });

  it('shows how many capabilities a run lost, rather than hiding it in the detail', async () => {
    renderPage();
    await screen.findByText('Cache availability per professional');

    // A completed run that reviewed itself is not the same fact as a completed
    // run, and this list is where somebody chooses which one to open.
    const degraded = row('Cache availability per professional');
    expect(within(degraded).getByText('degradations', { exact: false })).toBeInTheDocument();
  });

  it('narrows by status without asking the server again', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    const before = calls.filter((call) => call.includes('/runs')).length;
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');

    await waitFor(() => {
      expect(screen.queryByText('Add weekly recurrence')).toBeNull();
    });
    expect(screen.getByText('Product recommendations')).toBeInTheDocument();

    // The filter is a question about this screen. Refetching to answer it would
    // make a local decision cost a round trip.
    expect(calls.filter((call) => call.includes('/runs')).length).toBe(before);
  });

  it('narrows by stage, offering only the stages the history reaches', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    const stage = screen.getByLabelText('Stage');
    // Three present in the data — plan-review, implementation, final-review —
    // plus "All stages". Never the eight the pipeline could theoretically hold.
    expect(within(stage).getAllByRole('option')).toHaveLength(4);
    // And in pipeline order, not alphabetical.
    expect(within(stage).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All stages',
      'Plan Review',
      'Implementation',
      'Final Review',
    ]);

    await userEvent.selectOptions(stage, 'final-review');
    await waitFor(() => {
      expect(screen.queryByText('Add weekly recurrence')).toBeNull();
    });
    expect(screen.getByText('Cache availability per professional')).toBeInTheDocument();
  });

  it('searches by run id as well as by feature', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    await userEvent.type(screen.getByLabelText('Search runs'), 'AF-2026-102');

    await waitFor(() => {
      expect(screen.queryByText('Add weekly recurrence')).toBeNull();
    });
    expect(screen.getByText('Product recommendations')).toBeInTheDocument();
  });

  it('refetches for one project when the project filter changes', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    // Project is the app's scope, not a page filter: choosing one has to reach
    // the server, because the sidebar, the breadcrumb and the dashboard all read
    // the same selection.
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'other');

    await waitFor(() => {
      expect(calls.some((call) => call.includes('projectId=other'))).toBe(true);
    });
  });

  it('says nothing matches the filters, which is not the same as no runs', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'plan_rejected');

    expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument();
    expect(screen.queryByText('No runs yet.')).toBeNull();
  });

  it('offers the command that creates one when there are none at all', async () => {
    routes['/api/v1/runs'] = [];
    renderPage();

    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
    expect(screen.getByText(/agent-flow feature/)).toBeInTheDocument();
  });

  it('says what went wrong rather than showing an empty table', async () => {
    delete routes['/api/v1/runs'];
    renderPage();

    // Longer than the default: the query client retries once before giving up, so
    // the error state is deliberately a second or so away. A dashboard that
    // announced failure on the first dropped packet would cry wolf all day.
    expect(
      await screen.findByText('Runs could not be read.', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    // The server's own message, because "request failed" hides the difference
    // between a missing run and a server that is not there (§95).
    expect(screen.getByText('no such endpoint')).toBeInTheDocument();
  });

  it('never asks the API for a path', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    for (const call of calls) {
      expect(call).toMatch(/^\/api\/v1\//);
      expect(call).not.toMatch(/\.\.|\/Users\/|\/etc\//);
    }
  });
});

describe('filterRuns', () => {
  const all = { status: 'all' as const, stage: 'all', query: '' };

  it('returns everything with no filter', () => {
    expect(filterRuns(RUNS, all)).toHaveLength(4);
  });

  it('applies status and stage together rather than either-or', () => {
    expect(
      filterRuns(RUNS, { ...all, status: 'running', stage: 'final-review' }),
    ).toHaveLength(0);
  });

  it('matches a run id case-insensitively', () => {
    expect(filterRuns(RUNS, { ...all, query: 'af-2026-101' }).map((run) => run.runId)).toEqual([
      'AF-2026-101',
    ]);
  });

  it('ignores surrounding whitespace in the query', () => {
    // A pasted run id arrives with a trailing newline more often than not.
    expect(filterRuns(RUNS, { ...all, query: '  AF-2026-101 ' })).toHaveLength(1);
  });
});
