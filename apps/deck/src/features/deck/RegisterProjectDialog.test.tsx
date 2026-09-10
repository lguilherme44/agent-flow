import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCandidateView, ProjectRegisteredView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { RegisterProjectDialog } from './RegisterProjectDialog';
import { ptBR as t } from '../../lib/i18n';

/**
 * 7.6 — registering a repository without typing anything.
 *
 * The assertions read the DOM, and two of them are the point of the whole item: that the
 * dialog offers a repository it did not have to be told about, and that the finding which
 * decides whether the first feature can run at all — an install command that rewrites a
 * lockfile the repository does not track — reaches a reader on this surface too. It used
 * to exist only as a line printed by a terminal.
 */

const CANDIDATES: ProjectCandidateView[] = [
  { id: 'fresh', name: 'fresh' },
  { id: 'booking-api', name: 'booking-api' },
];

const REGISTERED: ProjectRegisteredView = {
  project: { id: 'fresh', name: 'fresh', path: '/wk/fresh', currentRunId: null, status: null, runCount: 0 },
  stack: { type: 'node', name: 'fresh' },
  created: ['.agent-flow/config.yaml', 'AGENTS.md'],
  updated: ['.gitignore'],
  skipped: [],
  warnings: [{ kind: 'install_dirties_tree', command: 'npm install' }],
};

// `showModal` is not implemented in jsdom; the dialog only has to be in the tree.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

const serve = (
  over: {
    candidates?: ProjectCandidateView[];
    post?: () => Promise<Response>;
  } = {},
): ReturnType<typeof vi.fn> => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    if (target.includes('/projects/candidates')) return response(over.candidates ?? CANDIDATES);
    if (init?.method === 'POST') return (over.post ?? (() => response(REGISTERED, 201)))();
    return response({});
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

describe('the register-project dialog', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  it('offers the repositories the workspace found', async () => {
    serve();
    render(<RegisterProjectDialog open onClose={() => undefined} />);

    expect(await screen.findByRole('option', { name: 'fresh' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'booking-api' })).toBeInTheDocument();
  });

  it('says plainly what it will write before it writes it', async () => {
    // It writes into a repository somebody cares about. `init` is the first thing
    // agent-flow does there, and a tool that clobbers a hand-written AGENTS.md on first
    // contact does not get a second chance (§7.7).
    serve();
    render(<RegisterProjectDialog open onClose={() => undefined} />);

    expect(await screen.findByText(new RegExp(t.register.whatItWritesBefore))).toBeInTheDocument();
  });

  it('names only an id on the wire, never a directory (§93)', async () => {
    const fetcher = serve();
    render(<RegisterProjectDialog open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: t.register.registerIt }));

    await waitFor(() => {
      expect(fetcher.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
    });
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ candidateId: 'fresh' });
  });

  it('reports what was written, relative to the project', async () => {
    serve();
    render(<RegisterProjectDialog open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: t.register.registerIt }));

    // Waits for the success panel before reading its contents: an exact-string query for
    // a path that has not been rendered yet resolves against the form, not the result.
    await screen.findByText(t.register.isAProjectNow('node'));
    expect(screen.getByText('.agent-flow/config.yaml')).toBeInTheDocument();
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText('.gitignore')).toBeInTheDocument();
  });

  it('carries the warning that would otherwise refuse every task', async () => {
    // PRI-25, on the surface that has no terminal behind it.
    serve();
    render(<RegisterProjectDialog open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: t.register.registerIt }));

    expect(await screen.findByText(t.register.installDirties)).toBeInTheDocument();
    expect(screen.getByText('npm install')).toBeInTheDocument();
  });

  it('says nothing about a lockfile when there is nothing to say', async () => {
    // The positive control for the case above: same dialog, one field different.
    serve({ post: () => response({ ...REGISTERED, warnings: [] }, 201) });
    render(<RegisterProjectDialog open onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: t.register.registerIt }));

    expect(await screen.findByText(t.register.isAProjectNow('node'))).toBeInTheDocument();
    expect(screen.queryByText(t.register.installDirties)).toBeNull();
  });

  it('offers the override only once the server has refused, and explains it', async () => {
    // AR-01: `init` writes files that have to be committed, and that commit moves HEAD out
    // from under a run whose planningBase was frozen at creation. Forcing is a decision,
    // so it is offered after the refusal rather than sitting armed beforehand.
    serve({
      post: () =>
        response(
          {
            error: 'active_run',
            message: 'Run AF-2026-004 is still active (running).',
            action: 'Finish or abandon the run first, or retry with force to proceed anyway.',
            forcible: true,
          },
          409,
        ),
    });
    render(<RegisterProjectDialog open onClose={() => undefined} />);

    expect(screen.queryByText(t.register.proceedAnyway)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: t.register.registerIt }));

    expect(await screen.findByText(/Run AF-2026-004 is still active/)).toBeInTheDocument();
    expect(screen.getByText(t.register.proceedAnyway)).toBeInTheDocument();
  });

  it('explains an empty workspace rather than showing an empty menu', async () => {
    serve({ candidates: [] });
    render(<RegisterProjectDialog open onClose={() => undefined} />);

    expect(await screen.findByText(t.register.nothingToAdd)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.register.registerIt })).toBeDisabled();
  });
});
