import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import type { ConfigView } from '@contracts/index.js';
import { ProjectProvider } from '../app/project-context';
import { createQueryClient } from '../app/App';
import { SettingsPage } from './SettingsPage';

/**
 * UI-26 — the effective configuration.
 *
 * The origin is the thing being tested. A settings page that showed values without
 * saying which layer produced them sends people to edit the wrong file, and a page
 * that offered a control for a setting nothing reads is worse than one that says
 * there is no setting.
 */

const CONFIG: ConfigView = {
  sources: {
    globalPath: '/home/dev/.agent-flow/config.yaml',
    globalPresent: true,
    projectPath: '/repo/.agent-flow/config.yaml',
    projectPresent: true,
  },
  sections: [
    {
      id: 'general',
      title: 'General',
      settings: [{ key: 'version', label: 'Config version', value: '1', origin: 'default' }],
    },
    {
      id: 'execution',
      title: 'Execution',
      settings: [
        { key: 'retry.maxAttempts', label: 'Attempts per task', value: '5', origin: 'project' },
        {
          key: 'parallelism.maxTasks',
          label: 'Parallel tasks',
          value: '1',
          origin: 'global',
        },
        {
          key: 'approval.requiredBeforeImplementation',
          label: 'Approval before implementation',
          value: 'not required',
          origin: 'global',
          note: 'implementation can start without a human opening the gate',
        },
      ],
    },
    {
      id: 'models',
      title: 'Models',
      note: 'Role routing has its own page.',
      settings: [],
    },
    { id: 'ui', title: 'UI', note: 'No server-side UI configuration.', settings: [] },
    {
      id: 'retention',
      title: 'Retention',
      note: 'agent-flow clean --keep <n>. There is no retention setting.',
      settings: [],
    },
  ],
};

let routes: Record<string, unknown> = {};

beforeEach(() => {
  routes = { '/api/v1/config': CONFIG, '/api/v1/projects': [] };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = input.split('?')[0] ?? input;
      const body = routes[path];

      if (body === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no config' }), {
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
        <MemoryRouter initialEntries={['/settings']}>
            <ProjectProvider>
            <SettingsPage />
            </ProjectProvider>
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

/** One setting row, scoped by its label — "Global" is also a source-row heading. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest('div') as HTMLElement;
}

describe('settings', () => {
  it('names both config files, and whether each exists', async () => {
    renderPage();

    expect(await screen.findByText('/home/dev/.agent-flow/config.yaml')).toBeInTheDocument();
    expect(screen.getByText('/repo/.agent-flow/config.yaml')).toBeInTheDocument();
  });

  it('says which layer produced each value', async () => {
    renderPage();
    await screen.findByText('Attempts per task');

    // The whole point. "5" alone invites an edit to the global file that would have
    // no effect, because this project overrides it.
    expect(within(row('Attempts per task')).getByText('Project override')).toBeInTheDocument();
    expect(within(row('Parallel tasks')).getByText('Global')).toBeInTheDocument();
    expect(within(row('Config version')).getByText('Default')).toBeInTheDocument();
  });

  it('states the consequence of a setting that has one', async () => {
    renderPage();
    await screen.findByText('Approval before implementation');

    // Approval switched off is not a neutral value, and a page that rendered it as
    // one would be the last place anybody noticed.
    expect(
      screen.getByText('implementation can start without a human opening the gate'),
    ).toBeInTheDocument();
  });

  it('says why a section the spec names has nothing in it', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Models' });

    for (const note of [
      'Role routing has its own page.',
      'No server-side UI configuration.',
      'agent-flow clean --keep <n>. There is no retention setting.',
    ]) {
      expect(screen.getByText(note)).toBeInTheDocument();
    }
  });

  it('sends somebody to the routing page rather than repeating it', async () => {
    renderPage();

    // Two places to read one thing eventually becomes two answers.
    expect(
      await screen.findByRole('link', { name: /Agents & Models/ }),
    ).toHaveAttribute('href', '/agents');
  });

  it('offers no control that would write', async () => {
    renderPage();
    await screen.findByText('Attempts per task');

    // §86 lists PATCH /config and it is not implemented: writing a merged value back
    // means deciding which of three layers it belongs in, and guessing would move a
    // project's override into the global file.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/read-only — edit the files below/)).toBeInTheDocument();
  });

  it('shows a broken config beside the files that would fix it', async () => {
    routes['/api/v1/config'] = {
      sources: CONFIG.sources,
      sections: [],
      configError: 'Invalid /home/dev/.agent-flow/config.yaml: expected a YAML mapping.',
    };
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/expected a YAML mapping/)).toBeInTheDocument();
    // The paths arrive alongside the reason rather than instead of it (§95).
    expect(screen.getByText('/home/dev/.agent-flow/config.yaml')).toBeInTheDocument();
  });

  it('exposes nothing that looks like a secret', async () => {
    renderPage();
    await screen.findByText('Attempts per task');

    expect(document.body.textContent).not.toMatch(
      /auth\.json|credential|api[_-]?key|password|process\.env/i,
    );
  });

  it('says the configuration could not be read rather than showing blank sections', async () => {
    delete routes['/api/v1/config'];
    renderPage();

    expect(
      await screen.findByText('The configuration could not be read.', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
  });
});
