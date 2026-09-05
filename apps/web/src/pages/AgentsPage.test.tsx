import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import type { RoleRouteView, RunnerHealthView, RunnerView } from '@contracts/index.js';
import { ProjectProvider } from '../app/project-context';
import { createQueryClient } from '../app/App';
import { AgentsPage } from './AgentsPage';

/**
 * UI-23 — the routing table.
 *
 * The assertions here are about honesty rather than layout. All nine roles have to
 * be present, primary and fallback have to be separable, a clamped effort has to
 * read as a loss rather than as the configured value, and a role that cannot
 * resolve has to be visible without taking the other eight down with it — because
 * that is the state somebody opens this page in.
 */

const AGENTS: RoleRouteView[] = [
  {
    role: 'architect',
    configKeys: ['roles', 'architect'],
    prompts: ['discovery', 'architecture-impact'],
    requiresReadOnly: true,
    requiresWorkingDirectory: false,
    requiresNativeStructuredOutput: false,
    configured: { runner: 'claude', model: 'Claude Opus', reasoning: 'high', timeoutSeconds: 900 },
    resolved: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'prompted',
    },
    fallback: {
      runner: 'codex',
      model: 'GPT-5.6 Sol',
      reasoning: 'high',
      reasoningClamped: false,
      structuredOutput: 'native',
    },
  },
  {
    role: 'sdd',
    configKeys: ['roles', 'sdd'],
    prompts: ['sdd'],
    requiresReadOnly: true,
    requiresWorkingDirectory: false,
    requiresNativeStructuredOutput: false,
    configured: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'very_high',
      timeoutSeconds: 1_200,
    },
    // Configured very_high, resolved high: the runner cannot do the effort asked
    // for, which is a degradation the run records (R-15).
    resolved: {
      runner: 'claude',
      model: 'Claude Opus',
      reasoning: 'high',
      reasoningClamped: true,
      structuredOutput: 'prompted',
    },
    fallbackAbsent: 'not_configured',
  },
  {
    role: 'planner',
    configKeys: ['roles', 'planner'],
    prompts: ['planning'],
    requiresReadOnly: true,
    requiresWorkingDirectory: false,
    requiresNativeStructuredOutput: true,
    configured: { runner: 'nowhere', reasoning: 'high', timeoutSeconds: 900 },
    error: {
      kind: 'unknown_runner',
      message: 'Role "planner" is configured to use runner "nowhere", which is not registered.',
    },
    fallbackAbsent: 'unusable',
  },
  ...(['planReviewer', 'executor.trivial', 'executor.normal', 'executor.complex', 'verification', 'finalReviewer'].map(
    (role): RoleRouteView => ({
      role,
      configKeys: role.startsWith('executor.') ? ['roles', 'executors', role.split('.')[1] ?? ''] : ['roles', role],
      prompts: role.startsWith('executor.') ? ['implementation'] : [role],
      requiresReadOnly: !role.startsWith('executor.'),
      requiresWorkingDirectory: role.startsWith('executor.'),
      requiresNativeStructuredOutput: false,
      configured: { runner: 'codex', reasoning: 'medium', timeoutSeconds: 900 },
      resolved: {
        runner: 'codex',
        reasoning: 'medium',
        reasoningClamped: false,
        structuredOutput: 'native',
      },
      fallbackAbsent: 'disabled',
    }),
  ) as RoleRouteView[]),
];

const RUNNERS: RunnerView[] = [
  { id: 'claude', provider: 'claude-code-cli', reasoningLevels: ['high'], structuredOutput: 'prompted' },
  { id: 'codex', provider: 'codex-cli', reasoningLevels: ['medium', 'high'], structuredOutput: 'native' },
];

const HEALTH: RunnerHealthView[] = [
  { id: 'claude', installed: true, executable: true, auth: 'available', version: '2.1.226' },
  { id: 'codex', installed: true, executable: true, auth: 'not_configured' },
];

let routes: Record<string, unknown> = {};
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  routes = {
    '/api/v1/agents': AGENTS,
    '/api/v1/runners': RUNNERS,
    '/api/v1/runners/health': HEALTH,
    '/api/v1/projects': [],
    '/api/v1/config': { sections: [] },
    '/api/v1/analytics': {
      scope: { projectIds: [], runsAvailable: 0, runsConsidered: 0, truncated: false },
      runsByProject: [],
      tasksByState: {},
      totals: { entries: 0, durationMs: 0, failures: 0, fallbacks: 0, retries: 0, reasoningClamped: 0 },
      byRunner: [],
      byModel: [],
      byRole: [],
      byStage: [],
    },
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(input);
      const path = input.split('?')[0] ?? input;
      const body = routes[path];

      if (body === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no routing table' }), {
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
        <MemoryRouter initialEntries={['/agents']}>
            <ProjectProvider>
            <AgentsPage />
            </ProjectProvider>
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

function row(role: string): HTMLElement {
  return screen.getByText(role).closest('tr') as HTMLElement;
}

describe('the routing table', () => {
  it('shows all nine logical roles', async () => {
    renderPage();
    await screen.findByText('architect');

    // §82 names nine. A page showing eight leaves somebody wondering which one is
    // missing and whether that is the bug.
    for (const role of [
      'architect',
      'sdd',
      'planner',
      'planReviewer',
      'executor.trivial',
      'executor.normal',
      'executor.complex',
      'verification',
      'finalReviewer',
    ]) {
      expect(screen.getByText(role)).toBeInTheDocument();
    }
  });

  it('separates the logical role, the runner and the physical provider', async () => {
    renderPage();
    await screen.findByText('architect');

    const architect = row('architect');
    // The role is the identifier the config uses; the runner is the id; the
    // provider is the adapter behind it. Three columns, never collapsed — and the
    // provider is the only place a provider name appears in this app.
    expect(within(architect).getByText('claude')).toBeInTheDocument();
    expect(within(architect).getByText('claude-code-cli')).toBeInTheDocument();
    expect(within(architect).getByText('Claude Opus')).toBeInTheDocument();
  });

  it('shows a clamped effort as a loss, not as the effort that was asked for', async () => {
    renderPage();
    await screen.findByText('sdd');

    const sdd = row('sdd');
    // Configured very_high, would run at high. Printing "very high" here would be
    // reporting an intention as a fact.
    expect(within(sdd).getByText('high')).toBeInTheDocument();
    expect(within(sdd).getByText('very_high')).toBeInTheDocument();
  });

  it('names the primary and the fallback separately', async () => {
    renderPage();
    await screen.findByText('architect');

    const architect = row('architect');
    // Model first, runner second — the same hierarchy the rest of the product now uses.
    expect(within(architect).getByText(/GPT-5.6 Sol · codex/)).toBeInTheDocument();
  });

  it('distinguishes a fallback that is off from one that cannot serve the role', async () => {
    renderPage();
    await screen.findByText('planner');

    // `resolveFallback` returns undefined for both, and they are not the same
    // news: one is a choice, the other is a configuration mistake.
    expect(within(row('planner')).getByText('configured, unusable')).toBeInTheDocument();
    expect(within(row('verification')).getByText('fallback is off')).toBeInTheDocument();
    expect(within(row('sdd')).getByText('none configured')).toBeInTheDocument();
  });

  it('shows an unresolvable role without hiding the ones that resolve', async () => {
    renderPage();
    await screen.findByText('planner');

    expect(within(row('planner')).getByText('Unknown Runner')).toBeInTheDocument();
    expect(screen.getByText('1 role cannot be resolved')).toBeInTheDocument();
    // And the rest still render.
    expect(within(row('architect')).getByText('claude-code-cli')).toBeInTheDocument();
  });

  it('reports a runner that is installed but unauthenticated as degraded', async () => {
    renderPage();
    await screen.findByText('verification');

    // codex is installed and executable with no auth. A green "ready" there is how
    // DEGRADED quietly becomes the normal state (R-16).
    // The tone is on the chip; the word is the truncating span inside it.
    expect(within(row('verification')).getByText('Not Configured').parentElement).toHaveClass(
      'text-warning',
    );
    expect(within(row('architect')).getByText('ready').parentElement).toHaveClass('text-success');
  });

  it('keeps editing disabled and says where the configuration lives', async () => {
    renderPage();
    await screen.findByText('architect');

    // The write API of UI-27 covers run actions, not configuration. A control that
    // looked editable and discarded the change would be worse than a disabled one.
    expect(screen.getByRole('button', { name: 'Edit routing' })).toBeDisabled();
  });

  it('makes no request that could spend quota', async () => {
    renderPage();
    await screen.findByText('architect');

    // Resolution, identity and shallow health. Nothing here invokes a runner —
    // `doctor --deep` is the explicit, one-off act that does.
    expect(calls.every((call) => call.startsWith('/api/v1/'))).toBe(true);
    expect(calls.some((call) => call.includes('deep'))).toBe(false);
  });

  it('says the table could not be read rather than showing nine blank rows', async () => {
    delete routes['/api/v1/agents'];
    renderPage();

    expect(
      await screen.findByText('The routing table could not be read.', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('no routing table')).toBeInTheDocument();
  });

  it('renders Context Intelligence section with strict zero-authority boundary', async () => {
    renderPage();
    await screen.findByText('Workflow Agents');

    expect(screen.getByText('Context Intelligence & Advisory')).toBeInTheDocument();
    expect(screen.getByText('Strict Authority Boundary')).toBeInTheDocument();
    expect(screen.getByText(/Safe Bypass/i)).toBeInTheDocument();
  });

  it('shows the model a role pins, whatever runner it points at', async () => {
    // **This test used to assert the opposite, and the opposite was false.** It expected
    // `Unobservable` for the AGY runner, from a browser helper that hardcoded
    // `runner === 'agy'` — a provider name deciding a model question in the browser, which
    // §14 forbids, and factually wrong besides: `AgyRunner` passes `--model` straight
    // through to the CLI and its own capability table is keyed by real model families.
    // A pinned AGY model is exactly as observable as a pinned Claude one.
    routes['/api/v1/agents'] = AGENTS.map((route) =>
      route.role === 'executor.complex'
        ? {
            ...route,
            configured: { ...route.configured, runner: 'agy', model: 'gemini-3.1-pro-high' },
            resolved: { ...route.resolved!, runner: 'agy', model: 'gemini-3.1-pro-high' },
          }
        : route,
    );

    renderPage();

    expect(await screen.findByText('gemini-3.1-pro-high')).toBeInTheDocument();
    expect(screen.queryByText('Unobservable')).toBeNull();
  });

  it('says a role pins no model rather than naming its runner', async () => {
    // The substitution Issue #21 forbids by name: a runner id where a model belongs.
    routes['/api/v1/agents'] = AGENTS.map((route) =>
      route.role === 'executor.complex'
        ? {
            ...route,
            configured: { ...route.configured, runner: 'agy', model: undefined },
            resolved: { ...route.resolved!, runner: 'agy', model: undefined },
          }
        : route,
    );

    renderPage();
    await screen.findByText('executor.complex');

    // Scoped to the row, because other roles in the fixture pin no model either — and a
    // page-wide `findByText` over a string several rows produce is a query that would keep
    // passing after the row under test stopped rendering it.
    const complex = row('executor.complex');
    expect(within(complex).getByText('no model pinned')).toBeInTheDocument();

    // The runner still has its own column; what it may not do is stand in for the model.
    expect(within(complex).getByText('no model pinned').textContent).not.toContain('agy');
  });

  it('handles Utility disabled state correctly', async () => {
    routes['/api/v1/config'] = {
      sections: [
        {
          id: 'utility',
          title: 'Utility',
          settings: [{ key: 'enabled', value: 'false', origin: 'default' }],
        },
      ],
    };
    renderPage();
    expect(await screen.findByText(/Status: Disabled/i)).toBeInTheDocument();
  });

  it('handles configured but unobserved utility state', async () => {
    routes['/api/v1/config'] = {
      sections: [
        {
          id: 'utility',
          title: 'Utility',
          settings: [
            { key: 'enabled', value: 'true', origin: 'default' },
            { key: 'provider', value: 'openai-compatible', origin: 'config' },
            { key: 'model', value: 'qwen2.5-coder:7b', origin: 'config' },
            { key: 'endpoint', value: 'http://127.0.0.1:11434/v1', origin: 'config' },
          ],
        },
      ],
    };
    renderPage();
    expect(await screen.findByText(/Status: Configured \(Not observed\)/i)).toBeInTheDocument();
    expect(screen.getByText('qwen2.5-coder:7b')).toBeInTheDocument();
    expect(screen.getAllByText('Not observed').length).toBeGreaterThanOrEqual(2);
  });

  it('handles observed effective provider and model with configured != effective', async () => {
    routes['/api/v1/config'] = {
      sections: [
        {
          id: 'utility',
          title: 'Utility',
          settings: [
            { key: 'enabled', value: 'true', origin: 'default' },
            { key: 'provider', value: 'openai-compatible', origin: 'config' },
            { key: 'model', value: 'qwen2.5-coder:7b', origin: 'config' },
            { key: 'endpoint', value: 'http://127.0.0.1:11434/v1', origin: 'config' },
          ],
        },
      ],
    };
    routes['/api/v1/analytics'] = {
      scope: { projectIds: [], runsAvailable: 1, runsConsidered: 1, truncated: false },
      runsByProject: [],
      tasksByState: {},
      totals: { entries: 1, durationMs: 100, failures: 0, fallbacks: 0, retries: 0, reasoningClamped: 0 },
      byRunner: [],
      byModel: [],
      byRole: [],
      byStage: [],
      context: {
        basis: 'estimated_operational_not_billing',
        scope: { runsObserved: 1, observations: 1, observationLimit: 256, eventLogsTruncated: 0, truncated: false },
        aggregate: {
          stage: 'aggregate',
          source: 'aggregate',
          provenance: 'aggregate',
          effectiveProvider: 'openai-compatible',
          effectiveModel: 'qwen2.5-coder:14b-instruct',
        },
      },
    };
    renderPage();
    expect(await screen.findByText(/Status: Available \(Observed\)/i)).toBeInTheDocument();
    expect(screen.getByText('qwen2.5-coder:7b')).toBeInTheDocument(); // configured
    expect(screen.getByText('qwen2.5-coder:14b-instruct')).toBeInTheDocument(); // effective observed
  });

  it('sanitizes endpoints and never exposes secret keys or query credentials', async () => {
    routes['/api/v1/config'] = {
      sections: [
        {
          id: 'utility',
          title: 'Utility',
          settings: [
            { key: 'enabled', value: 'true', origin: 'config' },
            {
              key: 'endpoint',
              value:
                'https://user:supersecretpass@api.openai.com/v1?api_key=sk-proj-secret123',
              origin: 'config',
            },
          ],
        },
      ],
    };
    renderPage();
    expect(await screen.findByText('https://api.openai.com/v1')).toBeInTheDocument();
    expect(screen.queryByText(/supersecretpass/)).toBeNull();
    expect(screen.queryByText(/sk-proj-secret123/)).toBeNull();
  });
});
