import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleanView, ProjectView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { CleanPage } from './CleanPage';
import { ptBR as t } from '../../lib/i18n';

/**
 * 7.7 — the screen for the operation that frightens people most.
 *
 * Every assertion reads the DOM. Two of them are the item itself: that nothing can be
 * removed before a preview has been asked for, and that the preview stops being valid the
 * moment the options it was computed from change. A page that kept a stale plan next to a
 * live "Reclaim it" button would be worse than no page.
 */

const projects: ProjectView[] = [
  { id: 'flowcanvas', name: 'Flow Canvas', path: '/wk/flowcanvas', currentRunId: 'AF-2026-009', status: 'running', runCount: 9 },
];

const PLAN: CleanView = {
  dryRun: true,
  keep: 5,
  totalRuns: 9,
  runs: [
    {
      runId: 'AF-2026-001',
      outcome: 'removed',
      reclaim: {
        worktrees: ['task-001-a'],
        worktreesRetained: ['task-002-a'],
        attemptRefs: ['refs/agent-flow/attempt/1'],
        integrationBranch: { kind: 'kept', ref: 'agent-flow/AF-2026-001', head: 'abcdef1234567890' },
        stateRemovable: true,
        failures: [],
      },
    },
    { runId: 'AF-2026-002', outcome: 'locked' },
  ],
  protectedRun: 'AF-2026-009',
  cacheRemoved: false,
  refused: true,
};

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

const serve = (over: { post?: (body: unknown) => Promise<Response> } = {}) => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    if (target.includes('/projects')) return response(projects);
    if (init?.method === 'POST') {
      const body: unknown = JSON.parse(String(init.body));
      return (over.post ?? (() => response(PLAN)))(body);
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

const postBodies = (fetcher: ReturnType<typeof vi.fn>): Record<string, unknown>[] =>
  fetcher.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

describe('the clean page', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  it('will not reclaim anything before a preview has been asked for', async () => {
    serve();
    render(<CleanPage projectId="flowcanvas" />);

    expect(await screen.findByRole('button', { name: t.clean.reclaimIt })).toBeDisabled();
  });

  it('asks for a dry run first, and says so on the wire', async () => {
    const fetcher = serve();
    render(<CleanPage projectId="flowcanvas" />);
    fireEvent.click(await screen.findByRole('button', { name: t.clean.showWhatWouldGo }));

    await waitFor(() => expect(postBodies(fetcher)).toHaveLength(1));
    expect(postBodies(fetcher)[0]).toMatchObject({ dryRun: true, keep: 5 });
  });

  it('names what would go, and what is kept and why', async () => {
    serve();
    render(<CleanPage projectId="flowcanvas" />);
    fireEvent.click(await screen.findByRole('button', { name: t.clean.showWhatWouldGo }));

    const plan = await screen.findByLabelText(t.clean.whatWouldGo);

    // Scoped to the plan, because the option list above says some of the same words —
    // and a query that could not tell them apart would pass on a page that rendered
    // nothing but its own controls.
    const removed = plan.querySelector('[data-run="AF-2026-001"]');
    expect(removed?.textContent).toContain(t.clean.worktreeCount(1));
    // Retention is the §20.3 rule, and the reason is the point.
    expect(removed?.textContent).toContain(t.clean.worktreesRetained(1));
    // §20.4: the branch nobody merged is kept, and named.
    expect(removed?.textContent).toContain(t.clean.branchKept('agent-flow/AF-2026-001'));
    // A run somebody is executing is left alone, and that is not the same refusal.
    expect(plan.querySelector('[data-run="AF-2026-002"]')?.textContent).toContain(t.clean.beingExecuted);
    expect(plan.textContent).toContain('AF-2026-009');
  });

  it('enables the write only once a plan exists', async () => {
    serve();
    render(<CleanPage projectId="flowcanvas" />);
    fireEvent.click(await screen.findByRole('button', { name: t.clean.showWhatWouldGo }));

    await waitFor(() => expect(screen.getByRole('button', { name: t.clean.reclaimIt })).toBeEnabled());
  });

  it('throws the plan away when the options it was computed from change', async () => {
    // The positive control for the rule above, and the reason the rule exists: a preview
    // that outlived its own options would be the most dangerous thing on this page.
    serve();
    render(<CleanPage projectId="flowcanvas" />);
    fireEvent.click(await screen.findByRole('button', { name: t.clean.showWhatWouldGo }));
    await waitFor(() => expect(screen.getByRole('button', { name: t.clean.reclaimIt })).toBeEnabled());

    fireEvent.click(screen.getByLabelText(new RegExp(t.clean.unmergedBranches)));

    expect(screen.getByRole('button', { name: t.clean.reclaimIt })).toBeDisabled();
    expect(screen.queryByLabelText(t.clean.whatWouldGo)).toBeNull();
  });

  it('marks the one option that deletes work', async () => {
    // §20.4: never implied, never a default, and never looking like the others.
    serve();
    render(<CleanPage projectId="flowcanvas" />);

    const danger = (await screen.findByText(t.clean.unmergedBranchesNote)).closest('label');
    expect(danger?.dataset['danger']).toBe('true');
  });

  it('sends the write with the options the plan was computed from', async () => {
    const fetcher = serve();
    render(<CleanPage projectId="flowcanvas" />);

    fireEvent.click(await screen.findByLabelText(new RegExp(t.clean.retainedWorktrees)));
    fireEvent.click(screen.getByRole('button', { name: t.clean.showWhatWouldGo }));
    await waitFor(() => expect(screen.getByRole('button', { name: t.clean.reclaimIt })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: t.clean.reclaimIt }));

    await waitFor(() => expect(postBodies(fetcher)).toHaveLength(2));
    expect(postBodies(fetcher)[0]).toMatchObject({ worktrees: true, dryRun: true });
    expect(postBodies(fetcher)[1]).toMatchObject({ worktrees: true, dryRun: false });
  });

  it('reads back as a receipt once it has actually run', async () => {
    serve({
      post: (body) =>
        response(
          (body as { dryRun?: boolean }).dryRun === true
            ? PLAN
            : { ...PLAN, dryRun: false, protectedRun: undefined, refused: false, runs: [PLAN.runs[0]] },
        ),
    });
    render(<CleanPage projectId="flowcanvas" />);
    fireEvent.click(await screen.findByRole('button', { name: t.clean.showWhatWouldGo }));
    await waitFor(() => expect(screen.getByRole('button', { name: t.clean.reclaimIt })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: t.clean.reclaimIt }));

    expect(await screen.findByLabelText(t.clean.whatWent)).toBeInTheDocument();
    expect(screen.getByText(t.clean.removed)).toBeInTheDocument();
  });

  it('says plainly when there is nothing inside the window', async () => {
    serve({ post: () => response({ ...PLAN, runs: [], protectedRun: undefined, refused: false }) });
    render(<CleanPage projectId="flowcanvas" />);
    fireEvent.click(await screen.findByRole('button', { name: t.clean.showWhatWouldGo }));

    expect(await screen.findByText(t.clean.nothingToRemove)).toBeInTheDocument();
  });

  it('surfaces a refusal rather than looking like it worked', async () => {
    serve({
      post: () => response({ error: 'not_found', message: 'no such project' }, 404),
    });
    render(<CleanPage projectId="flowcanvas" />);
    fireEvent.click(await screen.findByRole('button', { name: t.clean.showWhatWouldGo }));

    expect(await screen.findByText(/no such project/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.clean.reclaimIt })).toBeDisabled();
  });
});
