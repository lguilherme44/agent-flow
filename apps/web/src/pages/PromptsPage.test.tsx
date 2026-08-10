import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import type { PromptContentView, PromptView } from '@contracts/index.js';
import { createQueryClient } from '../app/App';
import { PromptsPage, filterPrompts } from './PromptsPage';

/**
 * UI-24 — the read-only prompt viewer.
 *
 * The interesting assertions are about what the page must *not* claim. Prompts
 * carry no version, so nothing may present one; the implementation prompt serves
 * three roles, so no single role may be shown as its owner; and a prompt whose
 * front matter will not parse must appear beside the reason rather than vanish.
 */

const PROMPTS: PromptView[] = [
  {
    name: 'implementation',
    source: 'prompts/implementation.md',
    sizeBytes: 3_005,
    updatedAt: '2026-08-09T22:56:00.000Z',
    digest: 'a1b2c3d4e5f6',
    permissions: 'write',
    outputFormat: 'json',
    requiredVars: ['task', 'sdd'],
    nativeStructuredOutput: false,
    roles: ['executor.trivial', 'executor.normal', 'executor.complex'],
    stages: [],
  },
  {
    name: 'planning',
    source: 'prompts/planning.md',
    sizeBytes: 5_040,
    updatedAt: '2026-08-09T22:56:00.000Z',
    digest: '0f0e0d0c0b0a',
    permissions: 'read-only',
    outputFormat: 'json',
    requiredVars: ['sdd', 'repositoryMap'],
    nativeStructuredOutput: true,
    roles: ['planner'],
    stages: ['planning'],
  },
  {
    name: 'broken',
    source: 'prompts/broken.md',
    sizeBytes: 12,
    updatedAt: '2026-08-09T22:56:00.000Z',
    digest: 'ffffffffffff',
    permissions: 'unknown',
    outputFormat: 'unknown',
    requiredVars: [],
    nativeStructuredOutput: false,
    roles: [],
    stages: [],
    error: 'Prompt "broken" has no front matter.',
  },
];

const CONTENT: Record<string, PromptContentView> = {
  implementation: {
    ...(PROMPTS[0] as PromptView),
    content: '# Implementation\n\nImplement {{task}} against {{sdd}}.',
    truncated: false,
  },
  planning: {
    ...(PROMPTS[1] as PromptView),
    content: '# Planning\n\nBreak the SDD into tasks.',
    truncated: false,
  },
};

let routes: Record<string, unknown> = {};

beforeEach(() => {
  routes = { '/api/v1/prompts': PROMPTS, ...contentRoutes() };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = input.split('?')[0] ?? input;
      const body = routes[path];

      if (body === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no prompts' }), {
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

function contentRoutes(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(CONTENT).map(([name, body]) => [`/api/v1/prompts/${name}`, body]),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipPrimitive.Provider>
        <MemoryRouter initialEntries={['/prompts']}>
          <PromptsPage />
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

describe('the prompt viewer', () => {
  it('opens the first prompt rather than an empty pane', async () => {
    renderPage();

    // A viewer that opens blank makes the reader perform a click whose only
    // possible outcome is the one they already wanted.
    expect(await screen.findByText(/Implement \{\{task\}\}/)).toBeInTheDocument();
  });

  it('shows a digest and never a version', async () => {
    renderPage();
    await screen.findByText(/Implement \{\{task\}\}/);

    // §83 asks for a version. Prompts declare none, and a field nothing enforces
    // and nothing reads is worse than absent — so the identity shown is the one
    // that cannot go stale.
    expect(screen.getByText('Digest')).toBeInTheDocument();
    expect(screen.getByText('a1b2c3d4e5f6')).toBeInTheDocument();
    expect(screen.queryByText(/^version$/i)).toBeNull();
  });

  it('names all three roles that share the implementation prompt', async () => {
    renderPage();
    await screen.findByText(/Implement \{\{task\}\}/);

    // Its front matter cannot say which role it belongs to, because it belongs to
    // three. The server derives them from the stage definitions instead.
    const roles = screen.getByText('Roles').closest('div') as HTMLElement;
    expect(within(roles).getByText(/executor.trivial, executor.normal, executor.complex/))
      .toBeInTheDocument();

    // And it is not a pipeline stage at all, which is a real difference rather
    // than a gap.
    const stages = screen.getByText('Stages').closest('div') as HTMLElement;
    expect(within(stages).getByText('per task, not a stage')).toBeInTheDocument();
  });

  it('switches prompt when another is chosen', async () => {
    renderPage();
    await screen.findByText(/Implement \{\{task\}\}/);

    await userEvent.click(screen.getByRole('button', { name: /planning/ }));

    expect(await screen.findByText(/Break the SDD into tasks/)).toBeInTheDocument();
    expect(screen.getByText('0f0e0d0c0b0a')).toBeInTheDocument();
  });

  it('marks a prompt that writes, because most of them may not', async () => {
    renderPage();
    await screen.findByText(/Implement \{\{task\}\}/);

    // `permissions: write` is the one prompt allowed to change the repository.
    // Showing it as just another prompt would hide the only distinction that
    // affects what a runner is permitted to do (§35).
    expect(screen.getByText('write')).toBeInTheDocument();
  });

  it('shows a prompt whose front matter will not parse, beside the reason', async () => {
    renderPage();
    await screen.findByText(/Implement \{\{task\}\}/);

    await userEvent.click(screen.getByRole('button', { name: /broken/ }));

    // Hiding it would make the one prompt needing attention the one that
    // disappears. There is no content route for it, so the pane says so.
    await waitFor(() => {
      expect(screen.getByText('Prompt "broken" has no front matter.')).toBeInTheDocument();
    });
  });

  it('searches by role as well as by name', async () => {
    renderPage();
    await screen.findByText(/Implement \{\{task\}\}/);

    await userEvent.type(screen.getByLabelText('Search prompts'), 'planner');

    // "Which prompt does the planner use" is the question somebody has while
    // looking at a plan they do not like.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /broken/ })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /planning/ })).toBeInTheDocument();
  });

  it('tells somebody with no prompts that the installation is incomplete', async () => {
    routes['/api/v1/prompts'] = [];
    renderPage();

    expect(await screen.findByText('No prompts found.')).toBeInTheDocument();
  });
});

describe('filterPrompts', () => {
  it('returns everything for an empty query', () => {
    expect(filterPrompts(PROMPTS, '   ')).toHaveLength(3);
  });

  it('matches a stage name', () => {
    expect(filterPrompts(PROMPTS, 'planning').map((prompt) => prompt.name)).toEqual(['planning']);
  });

  it('matches nothing rather than everything when the query is unknown', () => {
    expect(filterPrompts(PROMPTS, 'zzz')).toEqual([]);
  });
});
