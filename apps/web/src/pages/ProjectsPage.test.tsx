import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectView, RunnerHealthView } from '@contracts/index.js';
import { ProjectProvider } from '../app/project-context';
import { createQueryClient } from '../app/App';
import { ProjectsPage } from './ProjectsPage';

/**
 * UI-22 — the project registry.
 *
 * Two properties matter more than the layout. A project with no runs has to
 * render as a project rather than as a broken row, because that is what every
 * project looks like the minute after `agent-flow init`. And runner health must
 * not be fetched per row: the shallow check spawns a CLI per runner, so a list of
 * ten projects would spawn twenty processes to draw a status dot.
 */

const PROJECTS: ProjectView[] = [
  {
    id: 'beahub-api',
    name: 'beahub-api',
    path: '/Users/dev/wk/beahub-api',
    stack: 'node',
    currentRunId: 'AF-2026-104',
    status: 'running',
    lastRun: {
      runId: 'AF-2026-103',
      feature: 'Cache availability',
      status: 'completed',
      stage: 'final-review',
      updatedAt: '2026-08-09T15:30:00.000Z',
    },
    runCount: 12,
  },
  {
    id: 'fresh',
    name: 'fresh',
    path: '/Users/dev/wk/fresh',
    currentRunId: null,
    status: null,
    runCount: 0,
  },
];

const RUNNER_HEALTH: RunnerHealthView[] = [
  { id: 'claude', installed: true, executable: true, auth: 'available', version: '2.1.226' },
  { id: 'codex', installed: true, executable: false, auth: 'not_configured' },
];

let routes: Record<string, unknown> = {};
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  routes = { '/api/v1/projects': PROJECTS, '/api/v1/runners/health': RUNNER_HEALTH };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(input);
      const path = input.split('?')[0] ?? input;
      const body = routes[path];

      if (body === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no registry' }), {
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
          <MemoryRouter initialEntries={['/projects']}>
            <ProjectsPage />
          </MemoryRouter>
        </ProjectProvider>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

describe('the project registry', () => {
  it('shows path, stack, current run and last run for a project that has both', async () => {
    renderPage();
    await screen.findByText('beahub-api');

    const project = row('beahub-api');
    expect(within(project).getByText('/Users/dev/wk/beahub-api')).toBeInTheDocument();
    expect(within(project).getByText('node')).toBeInTheDocument();
    expect(within(project).getByText('12 runs')).toBeInTheDocument();

    // Current and last are different runs, and §81 asks for both: a project can
    // have something in flight and something finished at the same time.
    expect(within(project).getByRole('link', { name: 'AF-2026-104' })).toBeInTheDocument();
    expect(within(project).getByRole('link', { name: 'AF-2026-103' })).toBeInTheDocument();
    expect(within(project).getByText('RUNNING')).toBeInTheDocument();
  });

  it('renders a project that has never run as idle, not as broken', async () => {
    renderPage();
    await screen.findByText('fresh');

    const project = row('fresh');
    expect(within(project).getByText('idle')).toBeInTheDocument();
    expect(within(project).getByText('none finished')).toBeInTheDocument();
    expect(within(project).getByText('not detected')).toBeInTheDocument();
    expect(within(project).getByText('0 runs')).toBeInTheDocument();
  });

  it('opens the current run and selects the project it belongs to', async () => {
    renderPage();
    await screen.findByText('beahub-api');

    // Otherwise the breadcrumb reads "all projects" while showing one project's
    // run, which describes no particular thing.
    await userEvent.click(within(row('beahub-api')).getByRole('link', { name: 'AF-2026-104' }));
    await waitFor(() => {
      expect(calls.some((call) => call.includes('projectId=beahub-api'))).toBe(true);
    });
  });

  it('asks for runner health once, and only for the project in scope', async () => {
    renderPage();
    await screen.findByText('beahub-api');

    // Nothing is selected yet, so there is no project whose runners this would be
    // describing. Health is scoped, because a project may override which runners
    // it uses — one project's answer is not another's.
    expect(screen.getByText('Select a project to see its runner health')).toBeInTheDocument();

    await userEvent.click(within(row('beahub-api')).getByRole('button', { name: 'Select' }));

    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'Runner health' })).toBeInTheDocument();
    });

    // One request per selected project, never one per row: the shallow check
    // spawns a CLI per runner and a list would multiply that by every project.
    expect(calls.filter((call) => call.includes('/runners/health'))).toHaveLength(1);
  });

  it('shows a runner that is installed but unusable as degraded, not as fine', async () => {
    renderPage();
    await screen.findByText('beahub-api');
    await userEvent.click(within(row('beahub-api')).getByRole('button', { name: 'Select' }));

    const health = await screen.findByRole('list', { name: 'Runner health' });
    // codex is installed and neither executable nor authenticated. A green dot
    // there is the failure R-16 exists to prevent: DEGRADED becoming invisible.
    expect(within(health).getByText('codex')).toHaveClass('text-warning');
    expect(within(health).getByText('claude')).toHaveClass('text-success');
  });

  it('keeps Add Project disabled and says why', async () => {
    renderPage();
    await screen.findByText('beahub-api');

    // The write API of UI-27 covers run actions. Registering a project is not one
    // of them, and a button that looked like it worked would be worse than this.
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeDisabled();
  });

  it('tells somebody with no projects what to run', async () => {
    routes['/api/v1/projects'] = [];
    renderPage();

    expect(await screen.findByText('No Agent Flow project found.')).toBeInTheDocument();
    expect(screen.getByText(/agent-flow init/)).toBeInTheDocument();
  });

  it('says the registry could not be read rather than showing nothing', async () => {
    delete routes['/api/v1/projects'];
    renderPage();

    expect(
      await screen.findByText(
        'The project registry could not be read.',
        {},
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('no registry')).toBeInTheDocument();
  });

  it('never sends a path back to the server', async () => {
    renderPage();
    await screen.findByText('beahub-api');

    // The page displays a path because §81 asks for it. It travels one way: the
    // browser's whole vocabulary for a project is the id the server issued.
    for (const call of calls) {
      expect(call).toMatch(/^\/api\/v1\//);
      expect(call).not.toMatch(/\/Users\/|\.\./);
    }
  });
});
