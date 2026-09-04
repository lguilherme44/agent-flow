import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardCardView, BoardLane, TaskSummaryView } from '@contracts/index.js';
import { Board, TaskCard } from './board';
import { NO_FILTER, type TaskFilter } from './task-table';

/**
 * The board, as a person sees it (M8 §22, §40).
 *
 * Every assertion is about what is *on screen*. Nothing here decides a lane — a test that
 * reached for one would be testing `core/board.ts` through a component, and this
 * component's only job is presentation. What it must get right is that the sentence
 * survives, that status is never colour alone, and that the whole thing works with a
 * keyboard, because there is no drag to fall back on.
 */

const task = (id: string, overrides: Partial<TaskSummaryView> = {}): TaskSummaryView => ({
  id,
  title: `${id} title`,
  complexity: 'normal',
  risk: 'low',
  state: 'queued',
  attempts: 1,
  requirements: [],
  dependencies: [],
  ...overrides,
});

const card = (
  id: string,
  lane: BoardLane,
  overrides: Partial<BoardCardView> = {},
): BoardCardView => ({
  task: task(id),
  lane,
  reason: { text: 'planned, not ready to start', cause: 'none' },
  blockingFindings: 0,
  ...overrides,
});

const lanesOf = (cards: readonly BoardCardView[]) =>
  (['backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'unknown'] as const).map(
    (lane) => ({ lane, count: cards.filter((entry) => entry.lane === lane).length }),
  );

function board(cards: readonly BoardCardView[], selected?: string, filter: TaskFilter = NO_FILTER) {
  const onSelect = vi.fn();
  render(
    <Board
      cards={cards}
      lanes={lanesOf(cards)}
      filter={filter}
      {...(selected === undefined ? {} : { selectedTaskId: selected })}
      onSelect={onSelect}
    />,
  );
  return { onSelect };
}

describe('the board renders lanes a screen reader can read', () => {
  it('names every lane with its count', () => {
    board([card('TASK-001', 'done'), card('TASK-002', 'in_progress')]);

    // The count is in the accessible name, so the shape of the board is available without
    // walking every card.
    expect(screen.getByRole('region', { name: 'Done, 1 task' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'In progress, 1 task' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Backlog, 0 tasks' })).toBeInTheDocument();
  });

  it('keeps an empty lane on screen', () => {
    // A board that drops BLOCKED while nothing is blocked changes width as a run
    // progresses, and a column that appears is a column somebody has to notice appearing.
    board([card('TASK-001', 'done')]);

    expect(screen.getByRole('region', { name: 'Blocked, 0 tasks' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Review, 0 tasks' })).toBeInTheDocument();
  });

  /**
   * An empty lane is a heading, not a container (M8.5 §10, §11).
   *
   * **Structural, because appearance is not assertable and this had to be.** The lane used
   * to keep its border, its fill and a full-height scroll region whether or not anything
   * was in it. That was a 104px rail while the board had 555 pixels of page; once the
   * board got the viewport it became a 700px empty rectangle, and three of them — READY,
   * REVIEW and BLOCKED on a healthy run — is half the board rendering nothing, loudly.
   *
   * Restoring the box was mutation-tested against this suite before this test existed:
   * thirteen assertions stayed green, because a class that changes what a box looks like
   * is invisible to every one of them. The `<ul>` is the half of the change a DOM
   * assertion can see, and it is the half that matters — a scroll region with no children
   * is still a box with a background.
   */
  it('draws no card list for a lane with nothing in it', () => {
    board([card('TASK-001', 'done'), card('TASK-002', 'in_progress')]);

    const blocked = screen.getByRole('region', { name: 'Blocked, 0 tasks' });
    expect(within(blocked).queryByRole('list')).toBeNull();

    // And the populated ones still have theirs, so the rule cannot pass by rendering none.
    const done = screen.getByRole('region', { name: 'Done, 1 task' });
    expect(within(done).getByRole('list')).toBeInTheDocument();
  });

  /**
   * The filter the tab strip owns, applied to the board (M8.5 §20).
   *
   * One predicate over three surfaces: `filterTasks`, the same function the table uses,
   * against the card's own `task`. Two predicates over one filter is two definitions of
   * `waiting`.
   */
  it('hides the cards a filter excludes and says so without recounting the lane', () => {
    board(
      [card('TASK-001', 'done'), card('TASK-002', 'done', { task: task('TASK-002', { state: 'running' }) })],
      undefined,
      { query: '', status: 'running' },
    );

    // The card that does not match is gone.
    expect(screen.queryByText('TASK-001')).toBeNull();
    expect(screen.getByText('TASK-002')).toBeInTheDocument();

    // **And the lane still reports what the projection put in it.** A board showing one
    // card under a badge reading `2` looks like a rendering fault; one that recounted the
    // badge would answer a different question from the one `BoardLaneView.count` answers.
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
  });

  it('shows one number when no filter is on', () => {
    board([card('TASK-001', 'done'), card('TASK-002', 'done')]);

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('2 / 2')).toBeNull();
  });

  it('shows the unknown lane only when something is in it', () => {
    board([card('TASK-001', 'done')]);
    expect(screen.queryByRole('region', { name: /^Unknown state/ })).not.toBeInTheDocument();

    board([card('TASK-009', 'unknown')]);
    expect(screen.getByRole('region', { name: 'Unknown state, 1 task' })).toBeInTheDocument();
  });
});

describe('a card carries what changes a decision', () => {
  it('renders the reason the projection gave it', () => {
    // The sentence is the reason this is a board rather than a task table.
    render(
      <TaskCard
        card={card('TASK-005', 'backlog', {
          reason: { text: 'waiting on TASK-004', cause: 'dependency', waitsFor: ['TASK-004'] },
        })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('waiting on TASK-004')).toBeInTheDocument();
  });

  it('states the task state as a word, not only as a colour', () => {
    render(
      <TaskCard
        card={card('TASK-004', 'blocked', { task: task('TASK-004', { state: 'failed' }) })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    // §97: a greyscale screenshot, a colour-blind reader and a glance from across the desk
    // all need the same answer.
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('shows a retry count only once there has been one', () => {
    const { unmount } = render(
      <TaskCard card={card('TASK-001', 'done')} selected={false} onSelect={vi.fn()} />,
    );
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    unmount();

    render(
      <TaskCard
        card={card('TASK-001', 'in_progress', { task: task('TASK-001', { attempts: 3 }) })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders the attention mark the projection put on it, and nothing else', () => {
    const { unmount } = render(
      <TaskCard card={card('TASK-001', 'blocked')} selected={false} onSelect={vi.fn()} />,
    );
    expect(screen.queryByText('P1')).not.toBeInTheDocument();
    unmount();

    render(
      <TaskCard
        card={card('TASK-001', 'blocked', { attention: 'P1' })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('names the agent holding it and the findings against it', () => {
    render(
      <TaskCard
        card={card('TASK-002', 'review', {
          agentId: 'backend',
          agentName: 'Backend',
          blockingFindings: 2,
        })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('2 blocking findings')).toBeInTheDocument();
  });

  it('does not repeat "completed" under a card that is already in Done', () => {
    // The lane says it. A sentence restating the column is a line that costs height and
    // adds nothing, and the board has six columns' worth of height to spend.
    render(
      <TaskCard
        card={card('TASK-001', 'done', { reason: { text: 'completed', cause: 'none' } })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByText('completed')).not.toBeInTheDocument();
  });
});

describe('M8-A12 — the board is operable without a drag', () => {
  it('selects with a keyboard', async () => {
    const user = userEvent.setup();
    const { onSelect } = board([card('TASK-001', 'backlog'), card('TASK-002', 'done')]);

    await user.tab();
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('TASK-001');
  });

  it('reports the selection as pressed rather than only as a border', () => {
    board([card('TASK-001', 'backlog')], 'TASK-001');

    expect(screen.getByRole('button', { name: /TASK-001/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('exposes no draggable element', () => {
    // Dragging BLOCKED → DONE would be the browser writing state, and no domain action
    // means "move this task to that column". So there is nothing to drag, and the
    // accessibility of the board follows from that rather than from a later pass.
    const { container } = render(
      <Board
        cards={[card('TASK-001', 'blocked'), card('TASK-002', 'done')]}
        lanes={lanesOf([card('TASK-001', 'blocked'), card('TASK-002', 'done')])}
        onSelect={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
  });
});

describe('M8-ACC-34 — untrusted text renders as text', () => {
  it('does not interpret markup in a title or a reason', () => {
    // A task title comes from a model and a reason can quote a path a model chose. Both
    // are text a stranger wrote, and both render as characters.
    const payload = '<img src=x onerror="alert(1)">';
    render(
      <TaskCard
        card={card('TASK-001', 'blocked', {
          task: task('TASK-001', { title: payload }),
          reason: { text: `held back by ${payload}`, cause: 'dependency' },
        })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
