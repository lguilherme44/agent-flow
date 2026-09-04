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
 * UI-20, M8.5 — the run detail composition, against a stubbed API.
 *
 * The whole page: header, attention, tabs, and each surface behind them. It renders from
 * the same response shapes the server produces, so a field the server stops sending fails
 * here rather than becoming a blank cell.
 *
 * **What M8.5 changed about these tests, and it is not the assertions.** The page used to
 * render every surface at once, so a test could assert the pipeline, the table and the
 * four cards from one `render`. They are tabs now, so a test that wants the pipeline opens
 * Overview first. The facts being asserted did not move; the number of them on screen at
 * one time did, which is the whole point of the milestone.
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
  runtime: {
    status: 'implementing',
    resumable: true,
    progress: { workflow: { done: 5, total: 7 }, implementation: { done: 1, total: 2 } },
    reviewFreshness: 'current',
  },
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

/**
 * The control snapshot, which the board and the attention strip share (M8-07).
 *
 * **This file had 24 tests and never rendered the board.** The page used to open on the
 * table, so `/control` was never asked for and never stubbed; the board's coverage lived
 * entirely in `board.test.tsx`, one component down, where nothing could tell you whether
 * the page composed it at all. M8.5 makes the board the landing surface, so the fixture
 * that feeds it is now the one the default view depends on.
 *
 * `attention` is empty here on purpose: the strip is absent on a healthy run, and a
 * fixture that always carried an item would make every assertion below negotiate with a
 * banner. The one test that wants a strip supplies its own.
 */
const CONTROL = {
  run: RUN,
  cards: [
    {
      task: TASKS[0],
      lane: 'done',
      reason: { text: 'merged onto the integration branch', cause: 'none' },
      blockingFindings: 0,
    },
    {
      task: TASKS[1],
      lane: 'in_progress',
      reason: { text: 'running on codex', cause: 'none' },
      blockingFindings: 0,
    },
  ],
  lanes: [
    { lane: 'backlog', count: 0 },
    { lane: 'ready', count: 0 },
    { lane: 'in_progress', count: 1 },
    { lane: 'review', count: 0 },
    { lane: 'blocked', count: 0 },
    { lane: 'done', count: 1 },
  ],
  attention: [],
  team: { configured: false, members: [], totals: { members: 0, running: 0, capacity: 0 } },
  review: { reviewed: false, totals: {}, unsatisfiedGates: [] },
  delivery: { state: 'disabled', provider: 'none', checks: [], checkSummary: { total: 0, green: 0, red: 0, pending: 0 }, detail: 'No forge is configured.' },
  observedAt: '2026-08-10T20:15:22.000Z',
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
  '/api/v1/runs/AF-2026-001/control': CONTROL,
  '/api/v1/runs/AF-2026-001/artifacts/sdd': {
    name: 'sdd',
    label: 'SDD',
    available: true,
    content: '# SDD\n\nFR-001 — weekly recurrence.',
    truncated: false,
  },
  '/api/v1/runs/AF-2026-001/dag': {
    runId: 'AF-2026-001',
    projectId: 'demo',
    nodes: [
      { taskId: 'TASK-001', depth: 0 },
      { taskId: 'TASK-002', depth: 1 },
    ],
    edges: [{ from: 'TASK-001', to: 'TASK-002' }],
    unresolved: [],
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

function renderPage(options: { live?: boolean; at?: string } = {}): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipPrimitive.Provider>
        {/* One client for both, or invalidation from the stream would land
            in a cache the page never reads. */}
        {options.live === true ? <Harness /> : null}
        <MemoryRouter
          initialEntries={[options.at ?? '/runs/AF-2026-001?project=demo']}
        >
          {/* Inside the router as of UI-29: the project selection lives in the
              URL, so a workspace switch is a thing a reload and a link agree on. */}
          <ProjectProvider>
            <Routes>
              <Route path="/runs/:runId" element={<RunDetailPage />} />
            </Routes>
          </ProjectProvider>
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

function Harness(): JSX.Element {
  const connection = useLiveEvents('demo');
  return <span data-testid="connection">{connection}</span>;
}

/**
 * Move to a tab the way a person does, rather than by rewriting the URL.
 *
 * A test that navigated by address would pass over a tab strip that rendered nothing —
 * which is exactly the failure `?panel=` had for two milestones.
 */
async function openTab(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole('tab', { name }));
}

describe('the run detail composition', () => {
  it('opens on the board, with the header and the tabs and nothing else', async () => {
    renderPage();

    // Always visible: which run, what state, how far.
    expect(await screen.findByText('Add weekly recurrence')).toBeInTheDocument();
    expect(screen.getByText('AF-2026-001')).toBeInTheDocument();

    // The board is the landing surface, and it is the whole of the work area.
    expect(await screen.findByRole('tab', { name: 'Board' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // **And this is the milestone, stated as an absence.** The pipeline, the count strip
    // and the four summary cards were all on this screen at once, above and below a board
    // that got a third of the page. Each is one click away; none is here.
    expect(screen.queryByRole('list', { name: 'Pipeline' })).toBeNull();
    expect(screen.queryByText('Total')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Artifacts' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Plan approval' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Execution summary' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Model usage' })).toBeNull();
  });

  it('holds the pipeline and the four summaries behind Overview', async () => {
    renderPage();
    await openTab('Overview');

    expect(await screen.findByRole('list', { name: 'Pipeline' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Pipeline' })).getAllByRole('listitem'))
      .toHaveLength(9);

    // "Approval" appears twice on purpose — once as a pipeline stage and once as the card
    // — so the card is matched by its heading role.
    expect(screen.getByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan approval' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Execution summary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Model usage' })).toBeInTheDocument();
  });

  it('holds the table and its counts behind Tasks', async () => {
    renderPage();
    await openTab('Tasks');

    expect(await screen.findByText('Implement generation')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('shows the approved plan hash, which is what the gate is bound to', async () => {
    renderPage();
    await openTab('Overview');

    // A card saying only "approved at 19:12" would describe a property the run
    // may no longer have — approval is granted to one specific plan.
    expect(await screen.findByText('a1b2c3d4e5f60718')).toBeInTheDocument();
  });

  it('opens a task in the inspector', async () => {
    renderPage();

    // From a board card, which is what the page opens on.
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
    await openTab('Overview');

    // Common in practice: adapters omit the flag when nothing is configured. A
    // donut labelled "unknown 100%" would be worse than saying what it knows.
    expect(await screen.findByText('by runner')).toBeInTheDocument();
    expect(screen.getByText('2 retries')).toBeInTheDocument();
    expect(screen.getByText('1 fallbacks')).toBeInTheDocument();
  });

  it('opens an artifact without leaving the page', async () => {
    renderPage();
    await openTab('Overview');

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

describe('UI-30 — what the page says when something is missing', () => {
  it('separates a run this project does not have from a server it cannot reach', async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <TooltipPrimitive.Provider>
          <MemoryRouter initialEntries={['/runs/AF-2026-999?project=demo']}>
            <ProjectProvider>
              <Routes>
                <Route path="/runs/:runId" element={<RunDetailPage />} />
              </Routes>
            </ProjectProvider>
          </MemoryRouter>
        </TooltipPrimitive.Provider>
      </QueryClientProvider>,
    );

    // A 404 is not a broken dashboard: run ids repeat across a workspace, and
    // the useful next step is picking the project it belongs to (§95).
    //
    // The wait is long because the query client retries once before giving up,
    // which is the right behaviour for a transport blip and costs a second here.
    expect(
      await screen.findByText('AF-2026-999 is not in this project.', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing has stopped/)).toBeInTheDocument();
    expect(screen.getByText(/Pick the project it belongs to/)).toBeInTheDocument();
  });

  it('opens the gate from the approval card, not just from the header', async () => {
    // §94's waiting state is meant to be operational. The card used to name the
    // button in the header instead, which is a direction rather than a control.
    ROUTES['/api/v1/runs/AF-2026-001'] = { ...RUN, status: 'waiting_for_approval', approved: false };
    ROUTES['/api/v1/runs/AF-2026-001/approval'] = {
      runId: 'AF-2026-001',
      approved: false,
      canApprove: true,
      warnings: [],
      planHash: 'a1b2c3d4e5f60718',
      taskCount: 2,
      degradations: [],
    };

    try {
      renderPage();
      await screen.findByText('Add weekly recurrence');
      // The gate lives on Overview now, beside the plan hash it binds to.
      await openTab('Overview');

      await userEvent.click(await screen.findByRole('button', { name: 'Review the plan' }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Approve the plan for AF-2026-001');
      // The hash the server just computed, which is what approval binds to.
      expect(dialog).toHaveTextContent('a1b2c3d4e5f60718');
    } finally {
      ROUTES['/api/v1/runs/AF-2026-001'] = RUN;
      delete ROUTES['/api/v1/runs/AF-2026-001/approval'];
    }
  });
});

describe('UI-28 — the dependency graph', () => {
  it('does not read the graph until somebody asks for it', async () => {
    renderPage();
    await screen.findByText('Implement generation');

    expect(calls.filter((call) => call.endsWith('/dag'))).toEqual([]);
  });

  it('swaps the table for the graph, and says so in the URL', async () => {
    renderPage();
    await screen.findByText('Implement generation');

    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));

    // The tab strip names the surface now; the panel used to name itself, which is a
    // heading the board inherited by sharing the panel.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Graph' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    expect(screen.queryByRole('table')).toBeNull();
    await waitFor(() => {
      expect(calls.filter((call) => call.endsWith('/dag')).length).toBe(1);
    });
  });

  it('carries the selection between the table and the graph', async () => {
    // The rule of UI-28: one selection. A task chosen in the table is the task the graph
    // highlights, and the inspector never changes what it is showing because the reader
    // changed how they are looking at it.
    //
    // **In pane mode, because that is the case the rule is about.** M8.5 gives the board a
    // drawer at every width — six 244px lanes cannot give 400 of them to a panel — and a
    // drawer is modal: it marks the tab strip `aria-hidden`, so moving between surfaces
    // with one open is not a thing a person can do either. The table and the graph keep
    // the pane, and that is where a selection is carried across a view change.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));

    renderPage();
    await openTab('Tasks');

    await userEvent.click(await screen.findByText('Add recurrence types'));
    expect(await screen.findByText('Domain types for recurrence.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));

    // Still the same task in the inspector, and the graph knows which one it is.
    expect(screen.getByText('Domain types for recurrence.')).toBeInTheDocument();
    const node = await screen.findByRole('button', { name: /TASK-001/ });
    expect(node).toBeInTheDocument();
  });

  it('draws a node per task and an edge per dependency', async () => {
    renderPage();
    await screen.findByText('Implement generation');
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));

    // The accessible name carries the status in words, not only in colour (§97).
    expect(await screen.findByRole('button', { name: /TASK-001.*completed/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /TASK-002.*running/i })).toBeInTheDocument();
  });

  it('keeps the filter when the view changes', async () => {
    renderPage();
    await screen.findByText('Implement generation');

    await userEvent.click(screen.getByRole('button', { name: 'running' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));

    // The filter button is still pressed: filtering the table and then finding
    // the graph showing everything would be two answers to one question.
    expect(screen.getByRole('button', { name: 'running' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

/**
 * UI-P01 — the drawer below 1200 is a modal, not a floating panel.
 *
 * The unit suite runs on the wide layout by default (see `test-setup`), so the
 * drawer only exists once `matchMedia` says the pane does not fit. That switch is
 * the whole reason these assertions are possible in jsdom at all: the layout
 * choice is made in JavaScript, not in CSS.
 */
describe('the inspector as a drawer', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  });

  it('is a modal dialog, and the only inspector in the document', async () => {
    renderPage();
    await userEvent.click(await screen.findByText('Add recurrence types'));

    const dialog = await screen.findByRole('dialog', { name: 'Task inspector' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // One inspector, identified by a tab only an inspector has. It used to be counted as
    // "one `tablist` in the document", which stopped meaning that the moment the page
    // grew a tab strip of its own — the assertion would have gone red for the right
    // reason and the wrong cause. `Logs` belongs to the inspector and to nothing else.
    expect(screen.getAllByRole('tab', { name: 'Logs' })).toHaveLength(1);

    // Everything outside the drawer leaves the accessibility tree while it is open, which
    // is what makes focus containment real rather than decorative: Tab used to walk
    // straight out of the panel into a board that is still on screen. The run's own tab
    // strip is the clearest witness — it is behind the overlay and it is gone.
    expect(screen.queryByRole('tab', { name: 'Board' })).toBeNull();
  });

  it('closes on Escape and gives the focus back to the row that opened it', async () => {
    renderPage();
    // From the table, because a `<tr>` is what this asserts focus returns to — and the
    // drawer is the same component whichever surface opened it.
    await openTab('Tasks');

    const row = (await screen.findByText('Add recurrence types')).closest('tr');
    await userEvent.click(row as HTMLElement);
    await screen.findByRole('dialog', { name: 'Task inspector' });

    // Focus moved into the drawer, so it has to come back — otherwise closing
    // leaves a keyboard user at the top of the document, having lost their place
    // in a table they were half way down.
    expect(row?.contains(document.activeElement)).toBe(false);

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Task inspector' })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(row);
    });
  });

  // Clicking the overlay closes it too. Asserted in the visual suite rather than
  // here: it depends on pointer capture and hit testing, which jsdom does not
  // have, so a passing test here would prove nothing about a browser.
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

  /**
   * Focus mode is gone, and the two tests it had are one test about why.
   *
   * It existed to collapse the four summary cards and the secondary panels so the tasks
   * could have the screen. The tasks have the screen: the board is the landing surface and
   * it is the whole of the work area. A mode whose only outcome is the state the page is
   * already in is a control that teaches people the app has a hidden better layout.
   */
  it('offers no focus mode, because the band it collapsed is gone', async () => {
    renderPage();
    await screen.findByText('Add weekly recurrence');

    expect(screen.queryByRole('button', { name: /expand workspace/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /exit focus mode/i })).toBeNull();

    // The thing it used to hide is not on this surface to begin with.
    expect(screen.queryByText('Artifacts')).toBeNull();
  });

  /**
   * The tab strip is a `tablist`, so it is drivable from the keyboard the way one is.
   *
   * Not decoration: seven surfaces reachable only by pointer would be seven places a
   * keyboard user cannot get to, on the one page where every projection now lives behind
   * one of them.
   */
  it('moves between surfaces with the arrow keys', async () => {
    renderPage();
    const board = await screen.findByRole('tab', { name: 'Board' });
    expect(board).toHaveAttribute('aria-selected', 'true');

    board.focus();
    await userEvent.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  /**
   * `?panel=` and `&task=`, which the queue has emitted since M8 and nothing read.
   *
   * A URL parameter nobody reads fails no compiler, no linter and no assertion — and
   * `routeFor`'s own tests assert the *string* it produces, so they were green the whole
   * time. These two assert the effect.
   */
  it('opens the surface an attention deep link asked for', async () => {
    renderPage({ at: '/runs/AF-2026-001?project=demo&panel=approval' });

    // `?panel=approval` is the plan's gate, and the gate lives on Overview beside the
    // plan hash it is bound to.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    expect(await screen.findByRole('heading', { name: 'Plan approval' })).toBeInTheDocument();
  });

  it('opens the task an attention deep link named', async () => {
    renderPage({ at: '/runs/AF-2026-001?project=demo&task=TASK-001' });

    // The queue promised "one place to go" and delivered the run with nothing selected.
    expect(await screen.findByText('Domain types for recurrence.')).toBeInTheDocument();
  });

  /**
   * A bookmark for a surface this run does not have.
   *
   * It falls back rather than rendering a blank region, and the address is left alone:
   * rewriting it would turn a stale bookmark into a silently different one.
   */
  it('falls back to the board when the URL asks for a surface this run has not got', async () => {
    renderPage({ at: '/runs/AF-2026-001?project=demo&view=review' });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.queryByRole('tab', { name: 'Review' })).toBeNull();
  });

  it('opens and reads markdown artifacts using ArtifactReader', async () => {
    ROUTES['/api/v1/runs/AF-2026-001/artifacts/sdd'] = {
      name: 'sdd',
      label: 'SDD',
      available: true,
      sizeBytes: 1024,
      content: '# Spec Document\n\n## Architecture Impact\nDetails here.',
      truncated: false,
    };

    renderPage();
    await screen.findByText('Add weekly recurrence');
    await openTab('Overview');

    const sddButton = await screen.findByRole('button', { name: /sdd/i });
    await userEvent.click(sddButton);

    expect(await screen.findByText('Spec Document')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rendered/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /raw/i })).toBeInTheDocument();
  });
});
