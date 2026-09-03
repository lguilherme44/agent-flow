import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MemoryRouter } from 'react-router-dom';
import type { ControlSnapshotView, WorkspaceView } from '@contracts/index.js';
import { ProjectProvider } from '../app/project-context';
import { createQueryClient } from '../app/App';
import { ControlPlanePage } from './ControlPlanePage';

/**
 * The landing page, and the four questions it has to answer in a few seconds (M8 §11).
 *
 * Two of the tests below are about a *count of requests* rather than about pixels, and
 * they are the ones that matter most. A workspace page that reads a full run for every
 * project takes seconds to answer a question about the two that are running, and the way
 * that regression arrives is somebody adding a convenient hook to a row component.
 */

const WORKSPACE: WorkspaceView = {
  projects: [
    {
      projectId: 'beahub-api',
      name: 'beahub-api',
      runId: 'AF-2026-104',
      feature: 'Agendamentos recorrentes',
      status: 'running',
      runtime: 'implementing',
      progress: 50,
      taskCount: 9,
      blockedCount: 0,
      attentionCount: 0,
      teamLoad: { running: 2, capacity: 4 },
      lastActivityAt: '2026-09-03T10:00:00.000Z',
    },
    {
      projectId: 'bflow',
      name: 'bflow',
      runId: 'AF-2026-088',
      feature: 'Retry com backoff',
      status: 'waiting_for_approval',
      runtime: 'awaiting_human_approval',
      progress: 35,
      taskCount: 5,
      blockedCount: 1,
      attentionCount: 2,
      topPriority: 'P1',
      delivery: 'checks_pending',
      lastActivityAt: '2026-09-03T09:00:00.000Z',
    },
    {
      projectId: 'idle-one',
      name: 'idle-one',
      progress: 0,
      taskCount: 0,
      blockedCount: 0,
      attentionCount: 0,
    },
  ],
  observedAt: '2026-09-03T10:05:00.000Z',
};

const SNAPSHOT: ControlSnapshotView = {
  run: {
    projectId: 'bflow',
    runId: 'AF-2026-088',
    feature: 'Retry com backoff',
    stage: 'planning',
    status: 'waiting_for_approval',
    approved: false,
    createdAt: '2026-09-03T08:00:00.000Z',
    updatedAt: '2026-09-03T09:00:00.000Z',
    taskCount: 5,
    completedTasks: 0,
    degradations: 0,
    progress: 35,
    durationMs: 3_600_000,
    degradationDetail: [],
    startedAt: '2026-09-03T08:00:00.000Z',
    isolation: {
      mode: 'worktree',
      parallelism: { requested: 4, effective: 4, clamped: false },
      tasksIntegrated: 0,
    },
    integrationConflicts: [],
    runtime: {
      status: 'awaiting_human_approval',
      resumable: false,
      progress: { workflow: { done: 4, total: 7 }, implementation: { done: 0, total: 5 } },
      reviewFreshness: 'absent',
    },
  },
  cards: [],
  lanes: [],
  attention: [
    {
      id: 'approval_required',
      priority: 'P1',
      kind: 'approval_required',
      what: 'the plan is waiting for a decision',
      why: 'Review the plan and run `agent-flow approve`',
      scope: { runId: 'AF-2026-088' },
      since: '2026-09-03T09:00:00.000Z',
      action: { kind: 'approve', label: 'Review the plan', destructive: false },
      focus: 'plan',
    },
  ],
  team: {
    configured: false,
    members: [],
    totals: {
      assignments: 0,
      reassignments: 0,
      capacityDeferrals: 0,
      ownershipDeferrals: 0,
      candidatesConsidered: 0,
      exclusions: {},
    },
  },
  review: {
    reviewed: false,
    totals: {
      reviews: 0,
      tasksReviewed: 0,
      findings: 0,
      openFindings: 0,
      verifiedFindings: 0,
      staleReviews: 0,
      disputes: 0,
      bySeverity: {},
      byCategory: {},
      byIndependence: {},
    },
    unsatisfiedGates: [],
  },
  delivery: {
    state: 'disabled',
    provider: 'none',
    checks: [],
    checkSummary: { total: 0, green: 0, red: 0, pending: 0 },
    detail: 'no forge is configured',
  },
  observedAt: '2026-09-03T10:05:00.000Z',
};

let routes: Record<string, unknown> = {};
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  routes = {
    '/api/v1/workspace': WORKSPACE,
    '/api/v1/runs/AF-2026-088/control': SNAPSHOT,
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(input);
      const path = input.split('?')[0] ?? input;
      const body = routes[path];

      if (body === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no fixture' }), {
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
        <MemoryRouter initialEntries={['/']}>
          <ProjectProvider>
            <ControlPlanePage />
          </ProjectProvider>
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

describe('the control plane leads with what needs a person', () => {
  it('opens the queue on the most urgent project, not the first one', async () => {
    // A landing page whose default view is "whichever project sorts first" makes the
    // operator do the ranking the projection already did.
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('the plan is waiting for a decision')).toBeInTheDocument();
    });
    expect(screen.getByText(/Needs attention — bflow/)).toBeInTheDocument();
  });

  it('puts the queue above the project list', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    });

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings[0]).toContain('Needs attention');
  });
});

describe('a project row says what is true, and nothing else', () => {
  it('shows the runtime status, progress and the blocked count', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('beahub-api')).toBeInTheDocument();
    });

    expect(screen.getByText('IMPLEMENTING')).toBeInTheDocument();
    expect(screen.getByText('AWAITING HUMAN APPROVAL')).toBeInTheDocument();
    expect(screen.getByText('1 blocked')).toBeInTheDocument();
    // Load derived from running assignments, never a stored flag.
    expect(screen.getByText('2/4')).toBeInTheDocument();
  });

  it('says a project has never run rather than showing an empty run', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('idle-one')).toBeInTheDocument();
    });

    expect(screen.getByText('no active run')).toBeInTheDocument();
    expect(screen.getByText('never run')).toBeInTheDocument();
  });

  it('omits team load rather than printing 0/0', async () => {
    // Absent rather than zero. A run with no team has no load, and rendering `0/0` would
    // invite somebody to wonder which agent is idle.
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('bflow')).toBeInTheDocument();
    });

    expect(screen.queryByText('0/0')).not.toBeInTheDocument();
  });
});

describe('M8-ACC-21 — a workspace is not one read per project', () => {
  it('reads the workspace once and one snapshot, whatever the project count', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('the plan is waiting for a decision')).toBeInTheDocument();
    });

    const workspaceCalls = calls.filter((url) => url.includes('/workspace'));
    const controlCalls = calls.filter((url) => url.includes('/control'));

    expect(workspaceCalls).toHaveLength(1);
    // One, for the project the queue opened on — not one per row. Computing an attention
    // count needs the review, the team and the delivery record, and fifty idle projects
    // paying that is what makes a workspace take seconds.
    expect(controlCalls).toHaveLength(1);
    expect(calls.some((url) => url.includes('/tasks'))).toBe(false);
  });
});
