import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollaborationView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { Outcome } from './Outcome';
import { ptBR as t } from '../../lib/i18n';

/**
 * What the agents said to each other, and what they wrote down (7.8, M4-07).
 *
 * The feature ships disabled, which is exactly why the empty states carry as many
 * assertions as the content does: for most runs the empty state *is* the screen, and
 * reporting "off" as "quiet" sends somebody to look for a conversation that could never
 * have happened.
 */

const address = { projectId: 'flowcanvas', runId: 'AF-2026-001' };

const collaboration: CollaborationView = {
  enabled: true,
  agents: [
    { id: 'architect', displayName: 'Architect', role: 'architect', runner: 'primary', skills: [] },
    { id: 'backend', displayName: 'Backend', role: 'executor', runner: 'primary', skills: ['sql'] },
    { id: 'frontend', displayName: 'Frontend', role: 'executor', runner: 'primary', skills: ['react'] },
  ],
  threads: [
    {
      id: 'THR-001',
      status: 'open',
      subject: 'Which table owns the recurrence rule?',
      opener: 'backend',
      taskId: 'TASK-004',
      participants: ['Backend', 'Architect'],
      openedAt: '2026-09-08T10:00:00Z',
      lastMessageAt: '2026-09-08T10:05:00Z',
      messages: [
        {
          id: 'MSG-1',
          threadId: 'THR-001',
          from: 'backend',
          fromName: 'Backend',
          to: '@architect',
          type: 'question',
          subject: 'Which table owns the recurrence rule?',
          body: 'The plan puts it on bookings and the SDD puts it on schedules.',
          truncated: false,
          createdAt: '2026-09-08T10:00:00Z',
        },
        {
          id: 'MSG-2',
          threadId: 'THR-001',
          from: 'architect',
          fromName: 'Architect',
          to: 'backend',
          type: 'answer',
          subject: 're: Which table owns the recurrence rule?',
          body: 'Schedules. Bookings reads it.',
          truncated: false,
          createdAt: '2026-09-08T10:05:00Z',
        },
      ],
    },
    {
      id: 'THR-002',
      status: 'resolved',
      subject: 'Naming for the expansion helper',
      opener: 'backend',
      participants: ['Backend'],
      openedAt: '2026-09-08T09:00:00Z',
      lastMessageAt: '2026-09-08T09:10:00Z',
      messages: [
        {
          id: 'MSG-3',
          threadId: 'THR-002',
          from: 'backend',
          fromName: 'Backend',
          to: 'everyone',
          type: 'acknowledge',
          subject: 'Naming for the expansion helper',
          body: 'Settled: expandRule.',
          truncated: false,
          createdAt: '2026-09-08T09:10:00Z',
        },
      ],
    },
  ],
  handoffs: [
    {
      threadId: 'THR-003',
      taskId: 'TASK-011',
      from: 'backend',
      to: 'frontend',
      reason: 'The remaining work is entirely in the form.',
      status: 'requested',
      requestedAt: '2026-09-08T11:00:00Z',
    },
    {
      threadId: 'THR-004',
      taskId: 'TASK-002',
      from: 'frontend',
      to: 'backend',
      reason: 'Needs a migration.',
      status: 'accepted',
      requestedAt: '2026-09-08T08:00:00Z',
      settledAt: '2026-09-08T08:10:00Z',
    },
  ],
  entries: [
    {
      id: 'CTR-001',
      kind: 'contract',
      status: 'contested',
      subject: 'recurrence-expansion',
      author: 'architect',
      authorName: 'Architect',
      statement: 'Expansion happens in the read model.',
      affects: ['TASK-004'],
      createdAt: '2026-09-08T09:30:00Z',
    },
    {
      id: 'CTR-002',
      kind: 'contract',
      status: 'contested',
      subject: 'recurrence-expansion',
      author: 'backend',
      authorName: 'Backend',
      statement: 'Expansion happens at write time.',
      affects: ['TASK-004'],
      createdAt: '2026-09-08T09:40:00Z',
    },
    {
      id: 'DEC-001',
      kind: 'decision',
      status: 'active',
      subject: 'timezone handling',
      author: 'architect',
      authorName: 'Architect',
      statement: 'All stored instants are UTC.',
      rationale: 'The client already converts.',
      affects: [],
      createdAt: '2026-09-08T09:00:00Z',
    },
    {
      id: 'DEC-000',
      kind: 'decision',
      status: 'superseded',
      subject: 'timezone handling',
      author: 'architect',
      authorName: 'Architect',
      statement: 'Store local time.',
      affects: [],
      supersededBy: 'DEC-001',
      createdAt: '2026-09-08T08:30:00Z',
    },
  ],
};

const QUIET: CollaborationView = { enabled: true, agents: [], threads: [], handoffs: [], entries: [] };

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function stub(view: unknown = collaboration, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const target = String(input);
      if (target.includes('/collaboration')) return response(view, status);
      return response({}, 404);
    }),
  );
}

const panel = () =>
  render(<Outcome address={address} tab="collaboration" onTab={() => undefined} reviewFreshness={undefined} />);

describe('what the agents said to each other', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  it('puts the disagreement first, with both claims', async () => {
    // The one thing on this tab nothing mechanical resolves. A notice that raised the
    // alarm and named only the ids would send a reader looking for the argument
    // somewhere else.
    stub();
    panel();

    expect(await screen.findByText(t.collab.contestedNotice)).toBeInTheDocument();
    expect(screen.getByText(/Expansion happens in the read model/)).toBeInTheDocument();
    expect(screen.getByText(/Expansion happens at write time/)).toBeInTheDocument();
  });

  it('shows only the handoff still waiting on somebody, and names both ends', async () => {
    stub();
    panel();

    expect(await screen.findByText('TASK-011')).toBeInTheDocument();
    // A settled handoff is a fact about the past, and this row is read to decide what
    // happens next.
    expect(screen.queryByText('TASK-002')).not.toBeInTheDocument();
    // Found in a screenshot: `HandoffView` carries agent *ids*, so the row read
    // `backend → frontend` beside a thread that said `Backend, Frontend`. The names come
    // off the roster in the same response — the panel has it, and nothing else does.
    expect(screen.getByText(/Backend → Frontend · The remaining work is entirely in the form/)).toBeInTheDocument();
  });

  it('falls back to the id for an agent the roster does not hold', async () => {
    // The control for the line above: a roster lookup that quietly rendered nothing
    // would leave the arrow with a blank on one side.
    stub({ ...collaboration, agents: [] });
    panel();

    expect(await screen.findByText(/backend → frontend/)).toBeInTheDocument();
  });

  it('opens a thread onto the whole exchange, and shows the last line until then', async () => {
    stub();
    panel();

    const head = await screen.findByRole('button', { name: /Which table owns the recurrence rule/ });
    // Closed: the latest message, which is what says where the conversation stands.
    expect(screen.getByText(/Schedules\. Bookings reads it\./)).toBeInTheDocument();
    expect(screen.queryByText(/The plan puts it on bookings/)).not.toBeInTheDocument();

    fireEvent.click(head);

    expect(await screen.findByText(/The plan puts it on bookings/)).toBeInTheDocument();
  });

  it('renders a message body as text, never as markup', async () => {
    // A body is written by a model. Rendering it as anything else would make a peer's
    // output part of this page's DOM.
    stub({
      ...QUIET,
      threads: [
        {
          id: 'THR-009',
          status: 'open',
          subject: 'Injection',
          opener: 'backend',
          participants: ['Backend'],
          openedAt: '2026-09-08T10:00:00Z',
          lastMessageAt: '2026-09-08T10:00:00Z',
          messages: [
            {
              id: 'MSG-9',
              threadId: 'THR-009',
              from: 'backend',
              fromName: 'Backend',
              to: 'everyone',
              type: 'note',
              subject: 'Injection',
              body: '<img src=x onerror="alert(1)"> and **bold**',
              truncated: false,
              createdAt: '2026-09-08T10:00:00Z',
            },
          ],
        },
      ],
    });
    panel();

    const body = await screen.findByText(/onerror/);
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('strong')).toBeNull();
    expect(body.textContent).toContain('<img src=x');
  });

  it('shows a live blackboard entry and leaves the superseded one out', async () => {
    stub();
    panel();

    expect(await screen.findByText(/All stored instants are UTC/)).toBeInTheDocument();
    // A corrected entry is history. The core is explicit that superseded and contested
    // are different, which is why there are three statuses and not two.
    expect(screen.queryByText(/Store local time/)).not.toBeInTheDocument();
    expect(screen.getByText(t.collab.liveAndSuperseded(3, 1))).toBeInTheDocument();
  });

  it('says which of "off" and "quiet" it is', async () => {
    stub(QUIET);
    const view = panel();

    expect(await screen.findByText(t.collab.nothingSaid)).toBeInTheDocument();
    // On, and quiet: nothing to turn on, so the hint does not send anybody to a setting.
    expect(screen.getByText(t.collab.onAndQuiet)).toBeInTheDocument();
    expect(screen.queryByText(t.collab.offHint)).not.toBeInTheDocument();

    view.unmount();
    clearStore();
    stub({ ...QUIET, enabled: false });
    panel();

    expect(await screen.findByText(t.collab.offHint)).toBeInTheDocument();
  });

  it('does not report "nothing said" over a list it was handed', async () => {
    // The coincidence this guards: handoffs are projected from the same messages that
    // produce threads, so in practice one implies the other. The test that caught it in
    // the previous dashboard passed handoffs alone.
    stub({ ...QUIET, handoffs: collaboration.handoffs });
    panel();

    expect(await screen.findByText('TASK-011')).toBeInTheDocument();
    expect(screen.queryByText(t.collab.nothingSaid)).not.toBeInTheDocument();
  });

  it('says it could not be read rather than drawing silence', async () => {
    stub({ message: 'no such run' }, 404);
    panel();

    expect(await screen.findByText(t.collab.couldNotRead)).toBeInTheDocument();
  });
});
