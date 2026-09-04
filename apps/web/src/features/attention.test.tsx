import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AttentionItem } from '@contracts/index.js';
import { AttentionQueue, AttentionStrip, routeFor } from './attention';

/**
 * The queue, as a person reads it (M8 §16, §17, §62, §63).
 *
 * Nothing here ranks anything. The order, the priority, the sentence and the one
 * recommended action all arrive decided — a component that sorted the queue would be a
 * second authority over what matters, and it would be the one that drifts.
 *
 * What this component must get right is narrower and still worth testing: that the reason
 * survives to the screen, that there is no dismiss, and that an empty queue and an unread
 * one say different things.
 */

const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'approval_required',
  priority: 'P1',
  kind: 'approval_required',
  what: 'the plan is waiting for a decision',
  why: 'Review the plan and run `agent-flow approve`',
  scope: { runId: 'AF-2026-001' },
  since: '2026-09-03T10:00:00.000Z',
  action: { kind: 'approve', label: 'Review the plan', destructive: false },
  focus: 'plan',
  ...overrides,
});

const queue = (items: readonly AttentionItem[], props: { unread?: boolean } = {}) =>
  render(
    <MemoryRouter>
      <AttentionQueue items={items} {...props} />
    </MemoryRouter>,
  );

describe('the queue renders the decision it was handed', () => {
  it('shows what, why, and the one action', () => {
    queue([item()]);

    expect(screen.getByText('the plan is waiting for a decision')).toBeInTheDocument();
    expect(screen.getByText('Review the plan and run `agent-flow approve`')).toBeInTheDocument();
    expect(screen.getByText('Review the plan')).toBeInTheDocument();
  });

  it('states the priority as a word as well as a badge', () => {
    // `P1` is a sort key, not a sentence. A person reading the queue for the first time
    // has no reason to know that P1 outranks P2.
    queue([item()]);

    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.getByText('needs a decision')).toBeInTheDocument();
  });

  it('names the task an item is scoped to', () => {
    queue([item({ scope: { runId: 'AF-2026-001', taskId: 'TASK-004' }, focus: 'task' })]);

    expect(screen.getByText('TASK-004')).toBeInTheDocument();
  });

  it('renders one row per item, in the order it was given', () => {
    // Given, not chosen. Re-sorting here would put a second ordering on screen.
    queue([
      item({ id: 'a', what: 'first thing' }),
      item({ id: 'b', priority: 'P0', what: 'second thing' }),
    ]);

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('first thing');
  });

  it('offers no way to dismiss a blocker', () => {
    // A failed gate, a stale review and a diverged remote go away when the fact does. A
    // row somebody could close is a row that disappears while the problem does not.
    queue([item()]);

    expect(screen.queryByRole('button', { name: /dismiss|close|hide/i })).not.toBeInTheDocument();
  });
});

describe('M8 §63 — empty and unread are different sentences', () => {
  it('says nothing needs attention when the queue is genuinely empty', () => {
    queue([]);

    expect(screen.getByText('No items need attention')).toBeInTheDocument();
  });

  it('says so when it could not be read', () => {
    // "No items need attention" over a failed read is `Everything healthy` with extra
    // steps — the one sentence this milestone exists to prevent.
    queue([], { unread: true });

    expect(screen.getByText('Attention could not be read')).toBeInTheDocument();
    expect(screen.queryByText('No items need attention')).not.toBeInTheDocument();
  });
});

describe('a scope becomes a route, and that is all the browser decides', () => {
  it('sends a task item to the board with the card selected', () => {
    expect(
      routeFor(item({ focus: 'task', scope: { runId: 'AF-2026-001', taskId: 'TASK-004' } })),
    ).toBe('/runs/AF-2026-001?view=board&task=TASK-004');
  });

  it('sends each surface somewhere different', () => {
    const surfaces = ['plan', 'review', 'quality', 'delivery', 'team'] as const;
    const routes = surfaces.map((focus) => routeFor(item({ focus })));

    expect(new Set(routes).size).toBe(surfaces.length);
    for (const route of routes) expect(route).toContain('/runs/AF-2026-001');
  });

  it('carries the project, because a run id is only unique inside one', () => {
    // Two repositories in one workspace both have an AF-2026-001. A link without the
    // project opens whichever the sidebar happens to be pointing at.
    expect(routeFor(item(), 'beahub-api')).toContain('project=beahub-api');
  });
});

describe('M8-ACC-34 — untrusted text renders as text', () => {
  it('does not interpret markup in what or why', () => {
    // `why` quotes a gate detail, a finding, or a sentence a remote wrote. All of it is
    // text a stranger produced.
    const payload = '<img src=x onerror="alert(1)">';
    queue([item({ what: payload, why: payload })]);

    expect(screen.getAllByText(payload).length).toBeGreaterThan(0);
    expect(document.querySelector('img')).toBeNull();
  });
});

/**
 * The strip the run screen renders instead of the panel (M8.5 §9).
 *
 * **The queue was a bordered panel with a title, a count and up to four rows, capped at
 * 22rem.** On a run with three items that is 350 pixels of the always-visible layer, above
 * a board that had 555 — and its title read "Needs attention" over rows whose whole point
 * is that they need attention. The panel is still what the workspace home renders, where
 * it *is* the page; this is what a run screen gets.
 *
 * §9's three cases are the three tests below. Nothing here ranks anything: the ladder, the
 * tie-break and the order are `core/attention.ts`, and a strip that sorted its own rows
 * would be a second queue whose first row disagrees with the queue everywhere else.
 */
describe('the attention strip (M8.5 §9)', () => {
  const strip = (items: readonly AttentionItem[]) =>
    render(
      <MemoryRouter>
        <AttentionStrip items={items} />
      </MemoryRouter>,
    );

  it('renders nothing at all, and reserves no space, when nothing needs a person', () => {
    // "if there is no high-signal item, do not waste vertical space" — and a permanently
    // present empty band is a box that teaches people to ignore the place urgent things
    // appear.
    const { container } = strip([]);

    expect(container).toBeEmptyDOMElement();
  });

  it('leads with one item: what happened, why it matters, one action', () => {
    strip([item()]);

    expect(screen.getByText('the plan is waiting for a decision')).toBeInTheDocument();
    expect(screen.getByText('Review the plan and run `agent-flow approve`')).toBeInTheDocument();
    expect(screen.getByText('Review the plan')).toBeInTheDocument();
    // Priority is a word as well as a colour (§97): a greyscale screenshot and a
    // colour-blind reader need the same answer a glance gets.
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('offers no disclosure when there is only one item to show', () => {
    strip([item()]);

    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('keeps the rest behind a disclosure that says how many', () => {
    strip([
      item({ id: 'a', priority: 'P0', what: 'the integration branch diverged' }),
      item({ id: 'b', what: 'the plan is waiting for a decision' }),
      item({ id: 'c', priority: 'P3', what: 'the run reviewed itself' }),
    ]);

    // The projection's top item leads, and the strip does not re-rank to find it.
    expect(screen.getByText('the integration branch diverged')).toBeInTheDocument();
    expect(screen.queryByText('the run reviewed itself')).toBeNull();

    const more = screen.getByRole('button', { name: /2 more/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the rest when the disclosure is opened', async () => {
    strip([
      item({ id: 'a', what: 'the integration branch diverged' }),
      item({ id: 'b', what: 'a required gate did not run' }),
    ]);

    await userEvent.click(screen.getByRole('button', { name: /1 more/ }));

    expect(screen.getByText('a required gate did not run')).toBeInTheDocument();
  });

  it('offers no dismiss, at either level', () => {
    // A failed gate, a stale review and a diverged remote go away when the *fact* goes
    // away. A row somebody could close is a row that disappears while the problem does not.
    strip([item({ id: 'a' }), item({ id: 'b', what: 'a required gate did not run' })]);

    expect(screen.queryByRole('button', { name: /dismiss|close|ignore/i })).toBeNull();
  });

  it('sends every row to the surface its focus names', () => {
    // The same `routeFor` the panel uses, so a strip row and a queue row cannot land in
    // different places for one object.
    strip([item({ focus: 'review' })]);

    expect(screen.getByRole('link', { name: /the plan is waiting/ })).toHaveAttribute(
      'href',
      expect.stringContaining('panel=review'),
    );
  });
});
