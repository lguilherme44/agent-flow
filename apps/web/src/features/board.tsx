import { useMemo, type JSX } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { BoardCardView, BoardLane, BoardLaneView } from '@contracts/index.js';
import { Badge, Empty, cx } from '../components/ui';
import { useHorizontalOverflow } from '../hooks/use-horizontal-overflow';
import { taskTone, type Tone } from '../lib/status';

/**
 * The operational board (M8 §5, §18 … §23).
 *
 * **Every lane and every sentence arrives from `core/board.ts`.** This file maps a lane to
 * a heading and a card to markup, and decides nothing else — a component that worked out
 * which column a task belongs in would be a second task-state machine, and it would be the
 * one that drifts, because the real one is not on screen.
 *
 * **There is no drag.** Dragging BLOCKED → DONE would be the browser writing state, and no
 * domain action means "move this task to that column". Reassignment is M5's and stays
 * there; WIP is M5 capacity and is not re-invented here. So the board is fully operable
 * from the keyboard by construction rather than by an accessibility pass — there is
 * nothing to make accessible that a link does not already do.
 */

/**
 * Lane headings, in board order.
 *
 * `unknown` is last and is rendered only when it has cards. It exists because a task
 * carrying a state this build does not recognise must be visible somewhere: silently
 * defaulting it to BACKLOG hides it among tasks that have simply not started.
 */
const LANE_ORDER: readonly BoardLane[] = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'blocked',
  'done',
  'unknown',
];

const LANE_LABEL: Record<BoardLane, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  unknown: 'Unknown state',
};

/**
 * What each column means, for the person reading it for the first time.
 *
 * A column called "Ready" that holds a task nothing is running looks broken until you know
 * that ready means the graph allows it, not that a wave admitted it.
 */
const LANE_HINT: Record<BoardLane, string> = {
  backlog: 'planned, dependencies not met',
  ready: 'the graph allows it; a wave has not taken it',
  in_progress: 'assigned, running or integrating',
  review: 'waiting on a review decision',
  blocked: 'a person decides what happens next',
  done: 'merged onto the integration branch',
  unknown: 'a state this build does not recognise',
};

const LANE_TONE: Record<BoardLane, Tone> = {
  backlog: 'muted',
  ready: 'info',
  in_progress: 'primary',
  review: 'warning',
  blocked: 'danger',
  done: 'success',
  unknown: 'warning',
};

export function Board(props: {
  cards: readonly BoardCardView[];
  lanes: readonly BoardLaneView[];
  selectedTaskId?: string;
  onSelect: (taskId: string) => void;
  className?: string;
}): JSX.Element {
  const byLane = useMemo(() => {
    const grouped = new Map<BoardLane, BoardCardView[]>();
    for (const lane of LANE_ORDER) grouped.set(lane, []);
    for (const card of props.cards) grouped.get(card.lane)?.push(card);
    return grouped;
  }, [props.cards]);

  const counts = useMemo(
    () => new Map(props.lanes.map((lane) => [lane.lane, lane.count])),
    [props.lanes],
  );
  const { ref, overflow } = useHorizontalOverflow();

  // `unknown` is hidden when empty, and only then. Every other lane stays: a board that
  // drops BLOCKED while nothing is blocked changes width as a run progresses, and a column
  // that appears is a column somebody has to notice appearing.
  const visible = LANE_ORDER.filter(
    (lane) => lane !== 'unknown' || (counts.get('unknown') ?? 0) > 0,
  );

  return (
    <div className={cx('relative flex min-h-0 flex-1', props.className)}>
      <div
        ref={ref}
        className={cx(
          // Horizontal scroll inside the board's own region, never on the page body.
          'flex min-h-0 flex-1 gap-3 overflow-x-auto p-3',
          // Below the lane boundary the columns stack. Six 244px lanes need 1520px, and
          // squeezing them produces six columns nobody can read rather than one they can.
          'max-lg:flex-col max-lg:overflow-x-visible max-lg:overflow-y-auto',
        )}
      >
        {visible.map((lane) => (
          <Lane
            key={lane}
            lane={lane}
            cards={byLane.get(lane) ?? []}
            count={counts.get(lane) ?? 0}
            {...(props.selectedTaskId === undefined ? {} : { selectedTaskId: props.selectedTaskId })}
            onSelect={props.onSelect}
          />
        ))}
      </div>

      {/* The affordance, driven by measurement rather than by a breakpoint — the same one
          the pipeline uses, for the same reason: a row whose last column ends flush at the
          edge reads as the whole board, and then nobody looks for BLOCKED behind it.
          Six lanes do not fit at 1440 beside a 240px sidebar, and squeezing them to fit is
          how a card's title gets three words per line. */}
      {overflow.left ? <LaneFade side="left" /> : null}
      {overflow.right ? <LaneFade side="right" /> : null}
    </div>
  );
}

function LaneFade(props: { side: 'left' | 'right' }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cx(
        'pointer-events-none absolute inset-y-0 z-10 w-10 max-lg:hidden',
        props.side === 'left'
          ? 'left-0 bg-gradient-to-r from-surface to-transparent'
          : 'right-0 bg-gradient-to-l from-surface to-transparent',
      )}
    />
  );
}

function Lane(props: {
  lane: BoardLane;
  cards: readonly BoardCardView[];
  count: number;
  selectedTaskId?: string;
  onSelect: (taskId: string) => void;
}): JSX.Element {
  const label = LANE_LABEL[props.lane];
  const empty = props.cards.length === 0;

  return (
    <section
      // A landmark with its count in the accessible name, so a screen reader gets the
      // shape of the board without walking every card (M8 §40).
      aria-label={`${label}, ${String(props.count)} ${props.count === 1 ? 'task' : 'tasks'}`}
      className={cx(
        'flex min-h-0 shrink-0 flex-col rounded-lg border border-border bg-surface-2 max-lg:w-full',
        // An empty lane keeps its heading and its zero and gives the width back. Six full
        // lanes need 1520px and the row has 1126; the lanes with nothing in them are the
        // ones that can pay for that, and hiding them instead would make the board change
        // width as a run progresses.
        empty ? 'w-[104px]' : 'w-[244px]',
      )}
    >
      <header className="shrink-0 border-b border-border px-3 py-2">
        <div className={cx('flex gap-2', empty ? 'flex-col items-start' : 'items-baseline justify-between')}>
          {/* A collapsed rail is 104px, and "In progress" at the label size needs 88 of
              them plus padding — it wrapped, which made that lane's header a line taller
              than its neighbours and knocked the whole row out of alignment. */}
          <h3
            className={cx(
              'font-semibold uppercase tracking-caps text-muted',
              empty ? 'whitespace-nowrap text-micro' : 'text-label',
            )}
          >
            {label}
          </h3>
          <Badge tone={empty ? 'muted' : LANE_TONE[props.lane]} className="tabular">
            {props.count}
          </Badge>
        </div>
        {empty ? null : <p className="mt-0.5 text-micro text-faint">{LANE_HINT[props.lane]}</p>}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {props.cards.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {props.cards.map((card) => (
              <li key={card.task.id}>
                <TaskCard
                  card={card}
                  selected={card.task.id === props.selectedTaskId}
                  onSelect={props.onSelect}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * One card, carrying only what changes a decision (M8 §22).
 *
 * Not every field the task has. The inspector holds the rest, and a card that showed
 * everything would be a table row with a border — which is what the board was supposed to
 * improve on.
 */
export function TaskCard(props: {
  card: BoardCardView;
  selected: boolean;
  onSelect: (taskId: string) => void;
}): JSX.Element {
  const { card } = props;
  const task = card.task;

  return (
    <button
      type="button"
      onClick={() => {
        props.onSelect(task.id);
      }}
      aria-pressed={props.selected}
      className={cx(
        'w-full rounded-md border bg-surface p-2.5 text-left transition-colors',
        'hover:border-border-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        props.selected ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="tabular text-micro font-medium text-muted">{task.id}</span>
        <span className="flex shrink-0 items-center gap-1">
          {card.attention === undefined ? null : (
            // The join is the projection's; the card only renders it. A component that
            // scanned the queue for its own id would be the join that goes wrong the first
            // time one of the two lists is a frame behind.
            <Badge tone={card.attention === 'P3' || card.attention === 'P4' ? 'info' : 'danger'} caps>
              <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
              {card.attention}
            </Badge>
          )}
          {task.attempts > 1 ? (
            <Badge tone="warning" className="tabular">
              <RotateCcw className="h-2.5 w-2.5" aria-hidden />
              {task.attempts}
            </Badge>
          ) : null}
        </span>
      </div>

      <p className="mt-1 line-clamp-2 text-body-lg font-medium text-text">{task.title}</p>

      {/* The sentence. The reason this is a board and not a task table. */}
      {card.reason.cause === 'none' && card.lane === 'done' ? null : (
        <p className="mt-1.5 text-label leading-snug text-muted">{card.reason.text}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-faint">
        {/* State as a word, never as colour alone. */}
        <Badge tone={taskTone(task.state)} caps>
          {task.state.replace(/_/g, ' ')}
        </Badge>
        {card.agentName === undefined ? null : <span>{card.agentName}</span>}
        {task.risk === 'high' ? <span className="text-warning">high risk</span> : null}
        {card.blockingFindings === 0 ? null : (
          <span className="text-danger">
            {card.blockingFindings} blocking {card.blockingFindings === 1 ? 'finding' : 'findings'}
          </span>
        )}
      </div>
    </button>
  );
}

export function EmptyBoard(): JSX.Element {
  return <Empty title="No plan yet" hint="A board appears once planning has written one." />;
}
