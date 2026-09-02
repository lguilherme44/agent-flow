import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  BlackboardEntryView,
  CollaborationView,
  HandoffView,
  ThreadView,
} from '@contracts/index.js';
import { CollaborationPanel } from './collaboration';

/**
 * The collaboration panel (M4-07).
 *
 * Every assertion is about what a person *sees*, because the panel's only job is
 * presentation: nothing in it folds a log or decides a status, and a test that reached
 * for a derived value would be testing the server's projection through a component.
 */

const thread = (overrides: Partial<ThreadView> = {}): ThreadView => ({
  id: 'THR-0001',
  status: 'open',
  subject: 'which idempotency key?',
  opener: 'executor.normal',
  taskId: 'TASK-003',
  participants: ['Executor (normal)', 'Architect'],
  messages: [
    {
      id: 'MSG-0001',
      threadId: 'THR-0001',
      from: 'executor.normal',
      fromName: 'Executor (normal)',
      to: 'architect',
      type: 'question',
      taskId: 'TASK-003',
      subject: 'which idempotency key?',
      body: 'the SDD names one but does not say where it is minted',
      truncated: false,
      createdAt: '2026-09-01T12:00:00.000Z',
    },
  ],
  openedAt: '2026-09-01T12:00:00.000Z',
  lastMessageAt: '2026-09-01T12:00:00.000Z',
  ...overrides,
});

const entry = (overrides: Partial<BlackboardEntryView> = {}): BlackboardEntryView => ({
  id: 'DEC-001',
  kind: 'decision',
  status: 'active',
  subject: 'checkout-idempotency',
  author: 'architect',
  authorName: 'Architect',
  statement: 'the API mints the key and the client echoes it',
  affects: ['executor.normal'],
  createdAt: '2026-09-01T12:00:00.000Z',
  ...overrides,
});

const handoff = (overrides: Partial<HandoffView> = {}): HandoffView => ({
  threadId: 'THR-0002',
  taskId: 'TASK-005',
  from: 'executor.normal',
  to: 'executor.complex',
  reason: 'it turned out to touch the scheduler',
  status: 'requested',
  requestedAt: '2026-09-01T12:00:00.000Z',
  ...overrides,
});

const view = (overrides: Partial<CollaborationView> = {}): CollaborationView => ({
  enabled: true,
  agents: [],
  threads: [],
  handoffs: [],
  entries: [],
  ...overrides,
});

describe('CollaborationPanel', () => {
  it('says the feature is off when it is, rather than "nothing happened"', () => {
    // The two are different answers and the hint depends on which: sending somebody to
    // edit a setting that is already correct is worse than saying nothing.
    render(<CollaborationPanel collaboration={view({ enabled: false })} />);

    expect(screen.getByText(/Set collaboration.enabled/)).toBeInTheDocument();
  });

  it('says nobody needed to speak when the feature is on and quiet', () => {
    render(<CollaborationPanel collaboration={view({ enabled: true })} />);

    expect(screen.getByText(/None of them needed to/)).toBeInTheDocument();
  });

  it('renders while the query is still loading, without an error', () => {
    render(<CollaborationPanel collaboration={undefined} />);

    expect(screen.getByText('Nothing said.')).toBeInTheDocument();
  });

  it('shows a thread, its status and what was said', () => {
    render(<CollaborationPanel collaboration={view({ threads: [thread()] })} />);

    expect(screen.getByText('which idempotency key?')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(
      screen.getByText(/the SDD names one but does not say where it is minted/),
    ).toBeInTheDocument();
  });

  it('names the sender by its display name, resolved by the server', () => {
    render(<CollaborationPanel collaboration={view({ threads: [thread()] })} />);

    expect(screen.getByText('Executor (normal)')).toBeInTheDocument();
  });

  it('marks a truncated body rather than showing a sentence that stops', () => {
    const cut = thread({
      messages: [{ ...thread().messages[0]!, truncated: true }],
    });

    render(<CollaborationPanel collaboration={view({ threads: [cut] })} />);

    expect(screen.getByText('[truncated]')).toBeInTheDocument();
  });

  it('puts contested entries above everything, with what they mean', () => {
    // The one piece of collaboration state nothing mechanical resolves. Folding it into
    // a list is how a disagreement between two agents settles itself out of sight.
    render(
      <CollaborationPanel
        collaboration={view({
          entries: [
            entry({ id: 'CTR-001', kind: 'contract', status: 'contested', supersededBy: 'CTR-002' }),
            entry({ id: 'CTR-002', kind: 'contract', status: 'contested', authorName: 'Executor (normal)' }),
          ],
        })}
      />,
    );

    expect(screen.getByText('2 contested entry(ies)')).toBeInTheDocument();
    expect(screen.getByText(/nothing decides it for you/)).toBeInTheDocument();
  });

  it('does not list a superseded entry as live', () => {
    render(
      <CollaborationPanel
        collaboration={view({
          entries: [
            entry({ id: 'DSC-001', kind: 'discovery', status: 'superseded', statement: 'it is linear' }),
            entry({ id: 'DSC-002', kind: 'discovery', status: 'active', statement: 'it is exponential' }),
          ],
        })}
      />,
    );

    expect(screen.queryByText('it is linear')).not.toBeInTheDocument();
    expect(screen.getByText('it is exponential')).toBeInTheDocument();
  });

  it('shows an unanswered handoff with the task it concerns', () => {
    render(<CollaborationPanel collaboration={view({ handoffs: [handoff()] })} />);

    expect(screen.getByText(/TASK-005/)).toBeInTheDocument();
    expect(screen.getByText('requested')).toBeInTheDocument();
    expect(screen.getByText('it turned out to touch the scheduler')).toBeInTheDocument();
  });

  it('counts what is open and what is live in the footer', () => {
    render(
      <CollaborationPanel
        collaboration={view({
          threads: [thread(), thread({ id: 'THR-0002', status: 'resolved' })],
          entries: [entry(), entry({ id: 'DEC-002', status: 'superseded' })],
        })}
      />,
    );

    expect(screen.getByText(/2 thread\(s\), 1 unresolved/)).toBeInTheDocument();
    expect(screen.getByText(/1 live entry\(ies\)/)).toBeInTheDocument();
  });

  it('renders a message body as text and never as markup', () => {
    // A message body is written by a model. Rendering it as anything but text would make
    // a peer's output part of this page's DOM.
    const hostile = thread({
      messages: [
        {
          ...thread().messages[0]!,
          body: '<img src=x onerror="alert(1)"> and <b>bold</b>',
        },
      ],
    });

    const { container } = render(<CollaborationPanel collaboration={view({ threads: [hostile] })} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=/)).toBeInTheDocument();
  });
});
