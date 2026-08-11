import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createQueryClient } from './App';
import { Shell } from './Shell';
import { StubEventSource } from '../test-setup';

/**
 * UI-29 — the shell, serving a workspace rather than one project.
 *
 * The sidebar is the whole workspace view of §65: several projects, what each
 * one is doing, and a switch that takes the rest of the screen with it.
 */

const PROJECTS = [
  {
    id: 'beahub-api',
    name: 'BeaHub API',
    path: '/wk/beahub-api',
    currentRunId: 'AF-2026-104',
    status: 'running',
    runCount: 12,
  },
  {
    id: 'beahub-web',
    name: 'BeaHub Web',
    path: '/wk/beahub-web',
    currentRunId: null,
    status: null,
    runCount: 3,
  },
  {
    id: 'bflow',
    name: 'BFlow',
    path: '/wk/bflow',
    currentRunId: 'AF-2026-088',
    status: 'waiting_for_approval',
    runCount: 4,
  },
];

const ROUTES: Record<string, unknown> = {
  '/api/v1/projects': PROJECTS,
  '/api/v1/runs': [],
  '/api/v1/runners/health': [
    { id: 'codex', installed: true, executable: true, auth: 'available' },
  ],
};

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(input);
      const path = input.split('?')[0] ?? input;
      const body = ROUTES[path];

      return Promise.resolve(
        new Response(JSON.stringify(body ?? { error: 'not_found', message: 'no' }), {
          status: body === undefined ? 404 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  StubEventSource.instances.length = 0;
});

function renderShell(entry = '/dashboard'): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipPrimitive.Provider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/dashboard" element={<span>page</span>} />
              <Route path="/runs/:runId" element={<span>run page</span>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

function projectButton(name: string): HTMLElement {
  return within(screen.getByRole('list')).getByRole('button', { name: new RegExp(name) });
}

describe('the workspace sidebar', () => {
  it('says what each project is doing, not only that it exists', async () => {
    // §65 draws a name and a run per row. A column of names and coloured dots
    // answers "which of these needs me" only by hovering each one in turn.
    renderShell();

    expect(await screen.findByText('BeaHub API')).toBeInTheDocument();
    expect(screen.getByText('AF-2026-104 running')).toBeInTheDocument();
    expect(screen.getByText('AF-2026-088 waiting approval')).toBeInTheDocument();
    // A project that has never run is idle, not blank.
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('scopes the stream to the selected project, and re-opens it on a switch', async () => {
    renderShell();
    await screen.findByText('BeaHub API');

    // Nothing selected: the stream carries the whole workspace, which is what a
    // sidebar showing every project needs.
    expect(StubEventSource.instances.at(-1)?.url).toBe('/api/v1/events');

    await userEvent.click(projectButton('BeaHub API'));

    await waitFor(() => {
      expect(StubEventSource.instances.at(-1)?.url).toBe(
        '/api/v1/events?projectId=beahub-api',
      );
    });
  });

  it('re-asks the API for the project that is now in scope', async () => {
    renderShell();
    await screen.findByText('BeaHub API');

    await userEvent.click(projectButton('BFlow'));

    await waitFor(() => {
      expect(calls.some((call) => call.includes('projectId=bflow'))).toBe(true);
    });
    // And never for a path. The browser's whole vocabulary is the id the
    // registry issued (§93).
    for (const call of calls) expect(call).not.toMatch(/\/wk\/|\.\./);
  });

  it('asks for runner health once, not once per project row', async () => {
    // The check spawns a CLI per runner. Doing it per row would make opening a
    // workspace of ten projects cost ten times that, for a sidebar.
    renderShell();
    await screen.findByText('BeaHub API');

    await waitFor(() => {
      expect(calls.filter((call) => call.includes('/runners/health'))).toHaveLength(1);
    });
  });

  it('leaves a run behind when the project changes', async () => {
    // The project is named in the breadcrumb as well as in the sidebar, so the
    // wait is scoped to the list rather than to the word.
    renderShell('/runs/AF-2026-104?project=beahub-api');
    await waitFor(() => {
      expect(projectButton('BeaHub API')).toBeInTheDocument();
    });
    expect(screen.getByText('run page')).toBeInTheDocument();

    await userEvent.click(projectButton('BFlow'));

    // AF-2026-104 belongs to the other project. Staying would ask BFlow for a
    // run it does not have.
    await waitFor(() => {
      expect(screen.queryByText('run page')).toBeNull();
    });
  });

  it('says a runner is unavailable in words, and claims no fallback (§94)', async () => {
    // §94's example reads "Codex unavailable. Workflow can continue using Claude
    // fallback." — and the second sentence is a claim this indicator cannot make.
    // Whether a fallback exists is per role, configurable, and may be off; Agents
    // & Models resolves it. A coloured dot is not a status either (§97).
    ROUTES['/api/v1/runners/health'] = [
      { id: 'codex', installed: false, executable: false, auth: 'not_configured' },
      { id: 'claude', installed: true, executable: true, auth: 'available' },
    ];

    try {
      renderShell();

      const warning = await screen.findByRole('link', { name: /1 runner unavailable/ });
      expect(warning).toHaveAttribute('href', '/agents');
      expect(screen.queryByText(/fallback/i)).toBeNull();
    } finally {
      ROUTES['/api/v1/runners/health'] = [
        { id: 'codex', installed: true, executable: true, auth: 'available' },
      ];
    }
  });

  it('says once that a project id is unknown, rather than once per query', async () => {
    // Every page under an unknown id would otherwise render "could not be read"
    // for each of its queries — which describes a server problem rather than the
    // real one: the id is fine, it is not one this workspace knows (§95).
    renderShell('/dashboard?project=gone');

    expect(
      await screen.findByText('This server has no project called gone.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show the whole workspace' }));

    await waitFor(() => {
      expect(screen.queryByText('This server has no project called gone.')).toBeNull();
    });
  });

  it('says so when the workspace turned up nothing', async () => {
    ROUTES['/api/v1/projects'] = [];
    try {
      renderShell();
      expect(await screen.findByText('No Agent Flow project found.')).toBeInTheDocument();
    } finally {
      ROUTES['/api/v1/projects'] = PROJECTS;
    }
  });
});
