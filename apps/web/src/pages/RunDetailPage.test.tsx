import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProjectProvider } from '../app/project-context';
import { createQueryClient } from '../app/App';
import { RunDetailPage } from './RunDetailPage';
import { StubEventSource } from '../test-setup';
import { useLiveEvents } from '../hooks/use-live-events';

/**
 * UI-20 — the run detail composition, against a stubbed API.
 *
 * The whole page: header, pipeline, metrics, table, inspector, bottom cards. It
 * renders from the same response shapes the server produces, so a field the
 * server stops sending fails here rather than becoming a blank cell.
 */

const RUN = {
  projectId: 'demo',
  runId: 'AF-2026-001',
  feature: 'Add weekly recurrence',
  stage: 'implementation',
  status: 'running',
  approved: true,
  approvedAt: '2026-08-10T19:12:00.000Z',
  approvedPlanHash: 'a1b2c3d4e5f60718',
  createdAt: '2026-08-10T19:34:00.000Z',
  updatedAt: '2026-08-10T20:15:22.000Z',
  taskCount: 2,
  completedTasks: 1,
  degradations: 0,
  degradationDetail: [],
  progress: 50,
  startedAt: '2026-08-10T19:34:00.000Z',
  durationMs: 2_482_000,
};

const STAGES = [
  { stage: 'discovery', status: 'completed', runner: 'claude', durationMs: 149_467 },
  { stage: 'architecture-impact', status: 'completed', runner: 'claude' },
  { stage: 'sdd', status: 'completed', runner: 'claude' },
  { stage: 'planning', status: 'completed', runner: 'codex' },
  { stage: 'plan-review', status: 'completed', runner: 'claude' },
  { stage: 'approval', status: 'completed' },
  { stage: 'implementation', status: 'running' },
  { stage: 'verification', status: 'pending' },
  { stage: 'final-review', status: 'pending' },
];

const TASKS = [
  {
    id: 'TASK-001',
    title: 'Add recurrence types',
    complexity: 'trivial',
    risk: 'low',
    state: 'completed',
    attempts: 1,
    requirements: ['FR-001'],
    dependencies: [],
    runner: 'codex',
    reasoning: 'medium',
    durationMs: 62_000,
    validationPassed: true,
  },
  {
    id: 'TASK-002',
    title: 'Implement generation',
    complexity: 'normal',
    risk: 'medium',
    state: 'running',
    attempts: 1,
    requirements: ['FR-001'],
    dependencies: ['TASK-001'],
    runner: 'codex',
  },
];

const TASK_DETAIL = {
  ...TASKS[0],
  description: 'Domain types for recurrence.',
  acceptanceCriteria: ['Types compile.'],
  validation: ['test'],
  validationExpectation: 'pass',
  files: [],
  filesChanged: ['src/recurrence.ts'],
  notes: [],
  startedAt: '2026-08-10T19:56:42.000Z',
  finishedAt: '2026-08-10T19:57:44.000Z',
  reasoningClamped: false,
  commands: [
    { command: 'npm test', exitCode: 0, durationMs: 4_200, stdout: '18 passed', stderr: '' },
  ],
  log: ['stage=implementation runner=codex', 'attempt=1 ok durationMs=62000'],
};

const ARTIFACTS = [
  { name: 'sdd', label: 'SDD', available: true, sizeBytes: 4_200 },
  { name: 'plan', label: 'Plan', available: true, sizeBytes: 2_100 },
  { name: 'finalReview', label: 'Final Review', available: false },
];

const TELEMETRY = {
  entries: [],
  summary: {
    entries: 6,
    durationMs: 900_000,
    failures: 0,
    fallbacks: 1,
    retries: 2,
    reasoningClamped: 0,
    byRunner: {
      claude: { count: 4, durationMs: 600_000, failures: 0, fallbacks: 0, retries: 0 },
      codex: { count: 2, durationMs: 300_000, failures: 0, fallbacks: 1, retries: 2 },
    },
    byModel: {},
    byRole: {},
    byStage: {},
  },
};

const ROUTES: Record<string, unknown> = {
  '/api/v1/projects': [
    { id: 'demo', name: 'demo', path: '/repo', currentRunId: 'AF-2026-001', status: 'running' },
  ],
  '/api/v1/runs/AF-2026-001': RUN,
  '/api/v1/runs/AF-2026-001/stages': STAGES,
  '/api/v1/runs/AF-2026-001/tasks': TASKS,
  '/api/v1/runs/AF-2026-001/tasks/TASK-001': TASK_DETAIL,
  '/api/v1/runs/AF-2026-001/artifacts': ARTIFACTS,
  '/api/v1/runs/AF-2026-001/telemetry': TELEMETRY,
  '/api/v1/runs/AF-2026-001/artifacts/sdd': {
    name: 'sdd',
    label: 'SDD',
    available: true,
    content: '# SDD\n\nFR-001 — weekly recurrence.',
    truncated: false,
  },
};

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = input.split('?')[0] ?? input;
      calls.push(path);

      const body = ROUTES[path];
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
  StubEventSource.instances.length = 0;
});

function renderPage(options: { live?: boolean } = {}): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipPrimitive.Provider>
        <ProjectProvider>
          {/* One client for both, or invalidation from the stream would land
              in a cache the page never reads. */}
          {options.live === true ? <Harness /> : null}
          <MemoryRouter initialEntries={['/runs/AF-2026-001']}>
            <Routes>
              <Route path="/runs/:runId" element={<RunDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ProjectProvider>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

function Harness(): JSX.Element {
  const connection = useLiveEvents('demo');
  return <span data-testid="connection">{connection}</span>;
}

describe('the run detail composition', () => {
  it('renders header, pipeline, metrics, table and the bottom row', async () => {
    renderPage();

    // Run Header
    expect(await screen.findByText('Add weekly recurrence')).toBeInTheDocument();
    expect(screen.getByText('AF-2026-001')).toBeInTheDocument();

    // Stage Pipeline — nine stages, approval included
    expect(await screen.findByRole('list', { name: 'Pipeline' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Pipeline' })).getAllByRole('listitem'))
      .toHaveLength(9);

    // Task Metrics and Task Table
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(await screen.findByText('Implement generation')).toBeInTheDocument();

    // Bottom cards. "Approval" appears twice on purpose — once as a pipeline
    // stage and once as the card — so the card is matched by its heading role.
    expect(screen.getByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan approval' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Execution summary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Model usage' })).toBeInTheDocument();
  });

  it('shows the approved plan hash, which is what the gate is bound to', async () => {
    renderPage();

    // A card saying only "approved at 19:12" would describe a property the run
    // may no longer have — approval is granted to one specific plan.
    expect(await screen.findByText('a1b2c3d4e5f60718')).toBeInTheDocument();
  });

  it('opens a task in the inspector', async () => {
    renderPage();

    await userEvent.click(await screen.findByText('Add recurrence types'));

    expect(await screen.findByText('Domain types for recurrence.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Logs' })).toBeInTheDocument();
    expect(await screen.findByText(/attempt=1 ok/)).toBeInTheDocument();
  });

  it('shows validation as an exit code beside the verdict', async () => {
    renderPage();

    await userEvent.click(await screen.findByText('Add recurrence types'));
    await userEvent.click(screen.getByRole('tab', { name: /^Tests/ }));

    // A test-first task is done correctly when its commands fail, so the raw
    // exit code has to be visible rather than translated into pass/fail.
    expect(await screen.findByText('exit 0')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('falls back to grouping model usage by runner when no model was reported', async () => {
    renderPage();

    // Common in practice: adapters omit the flag when nothing is configured. A
    // donut labelled "unknown 100%" would be worse than saying what it knows.
    expect(await screen.findByText('by runner')).toBeInTheDocument();
    expect(screen.getByText('2 retries')).toBeInTheDocument();
    expect(screen.getByText('1 fallbacks')).toBeInTheDocument();
  });

  it('opens an artifact without leaving the page', async () => {
    renderPage();

    // "SDD" is also a pipeline stage, so the click is scoped to the card. Both
    // spellings being the same is the point — the stage that produced it and the
    // artifact it produced should not read as two different things.
    const card = (await screen.findByRole('heading', { name: 'Artifacts' })).closest('section');
    await userEvent.click(within(card as HTMLElement).getByText('SDD'));

    expect(await screen.findByText(/FR-001 — weekly recurrence/)).toBeInTheDocument();
  });

  it('never asks the API for a path', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    // The browser names a project and a run; it has no vocabulary for a
    // directory, which is what makes the registry the whole security model.
    for (const call of calls) {
      expect(call).toMatch(/^\/api\/v1\//);
      expect(call).not.toMatch(/\.\.|\/Users\/|\/etc\//);
    }
  });
});

describe('live updates', () => {
  it('subscribes to the stream for the selected project', () => {
    renderPage({ live: true });

    const source = StubEventSource.instances.at(-1);
    expect(source?.url).toBe('/api/v1/events?projectId=demo');
  });

  it('refreshes what an event invalidated, rather than patching from it', async () => {
    renderPage({ live: true });
    await screen.findByText('Add weekly recurrence');
    await screen.findByText('Implement generation');

    const before = calls.filter((call) => call.endsWith('/tasks')).length;

    act(() => {
      StubEventSource.instances.at(-1)?.emit('task.completed', {
        type: 'task.completed',
        projectId: 'demo',
        runId: 'AF-2026-001',
        timestamp: '2026-08-10T20:16:00.000Z',
        payload: { task: 'TASK-002' },
      });
    });

    // The event carries no state. What it triggers is a re-read from the server,
    // out of the same files the CLI reads.
    await waitFor(() => {
      expect(calls.filter((call) => call.endsWith('/tasks')).length).toBeGreaterThan(before);
    });
  });

  it('says it is polling when the stream drops, rather than looking idle', async () => {
    renderPage({ live: true });

    const source = StubEventSource.instances.at(-1);
    act(() => {
      source?.onerror?.(new Event('error'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('connection')).toHaveTextContent('polling');
    });
  });
});
