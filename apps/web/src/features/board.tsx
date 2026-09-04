import { useMemo, type JSX } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { BoardCardView, BoardLane, BoardLaneView } from '@contracts/index.js';
import { Badge, Empty, cx } from '../components/ui';
import { useHorizontalOverflow } from '../hooks/use-horizontal-overflow';
import { taskTone, type Tone } from '../lib/status';
import { filterTasks, NO_FILTER, type TaskFilter } from './task-table';

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
  /**
   * The filter the tab strip owns, shared with the graph and the table (M8.5 §20).
   *
   * **The lane count stays the projection's, and the header shows both numbers while a
   * filter is on.** A board displaying two cards under a badge reading `4` would look
   * like a rendering fault; one that recounted the badge would answer a different
   * question from the one `BoardLaneView.count` answers, which is how many tasks are
   * genuinely in that lane. `2 / 4` is the only honest pair.
   *
   * The predicate is `filterTasks`, the same function the table uses, applied to the
   * card's own `task`. Two predicates over one filter is two definitions of `waiting`.
   */
  filter?: TaskFilter;
}): JSX.Element {
  const filter = props.filter ?? NO_FILTER;
  const filtering = filter.query.trim() !== '' || filter.status !== 'all';

  const byLane = useMemo(() => {
    const kept = new Set(
      filterTasks(
        props.cards.map((card) => card.task),
        filter,
      ).map((entry) => entry.id),
    );
    const grouped = new Map<BoardLane, BoardCardView[]>();
    for (const lane of LANE_ORDER) grouped.set(lane, []);
    for (const card of props.cards) {
      if (kept.has(card.task.id)) grouped.get(card.lane)?.push(card);
    }
    return grouped;
  }, [props.cards, filter]);

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

  if (props.cards.length === 0) return <EmptyBoard />;

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
            filtering={filtering}
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

/**
 * The edge gradient that says "there is more this way".
 *
 * **`from-bg`, and the ground it fades to is why.** It was `from-surface`, which was right
 * while the board lived inside a `Panel`; M8.5 puts it straight onto the page, so the
 * gradient was fading to a colour two steps lighter than the thing behind it and read as a
 * pale smear at the lane edge rather than as an edge. Caught in the 1200 baseline with the
 * inspector open, which is the one width where the board genuinely overflows — a fade to
 * the wrong colour is invisible in a DOM assertion and obvious in a picture.
 */
function LaneFade(props: { side: 'left' | 'right' }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cx(
        'pointer-events-none absolute inset-y-0 z-10 w-10 max-lg:hidden',
        props.side === 'left'
          ? 'left-0 bg-gradient-to-r from-bg to-transparent'
          : 'right-0 bg-gradient-to-l from-bg to-transparent',
      )}
    />
  );
}

function Lane(props: {
  lane: BoardLane;
  cards: readonly BoardCardView[];
  count: number;
  filtering: boolean;
  selectedTaskId?: string;
  onSelect: (taskId: string) => void;
}): JSX.Element {
  const label = LANE_LABEL[props.lane];
  // The lane's *own* emptiness, which is what decides its width, is now "nothing to show
  // here" rather than "nothing is here": a filter that hid every card in IN PROGRESS
  // should collapse it exactly as an idle run does, or the board keeps 244 pixels for a
  // column the reader has just asked not to see.
  const empty = props.cards.length === 0;
  // Both numbers while a filter is on, one when it is not. `2 / 4` says the projection
  // put four tasks in this lane and the filter is showing two of them; `2` alone would be
  // a recount, and `4` over two cards would look broken.
  const shown =
    props.filtering && props.count !== props.cards.length
      ? `${String(props.cards.length)} / ${String(props.count)}`
      : String(props.count);

  return (
    <section
      // A landmark with its count in the accessible name, so a screen reader gets the
      // shape of the board without walking every card (M8 §40).
      aria-label={`${label}, ${String(props.count)} ${props.count === 1 ? 'task' : 'tasks'}`}
      className={cx(
        'flex min-h-0 shrink-0 flex-col max-lg:w-full',
        // **An empty lane is not a container, so it stops being drawn as one.** It used to
        // keep a border and a filled background, which was a 104px rail while the board
        // was 555px tall and became a 700px empty rectangle once the board got the
        // viewport. Three of those — READY, REVIEW, BLOCKED on a healthy run — is half the
        // board rendering nothing, loudly. The heading and the zero stay, because a lane
        // that vanished would change the board's width as a run progresses and a column
        // that appears is a column somebody has to notice appearing.
        empty
          ? 'w-[104px] opacity-60'
          : 'w-[244px] rounded-lg border border-border bg-surface-2',
      )}
    >
      <header className={cx('shrink-0 px-3 py-2', empty ? '' : 'border-b border-border')}>
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
            {shown}
          </Badge>
        </div>
        {empty ? null : <p className="mt-0.5 text-micro text-faint">{LANE_HINT[props.lane]}</p>}
      </header>

      {/* No body at all when there is nothing in it. A scroll region with zero children is
          still a box with a background, and it was the box doing the shouting. */}
      {empty ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
        </div>
      )}
    </section>
  );
}

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
        // **Lifted, not sunken.** The card was `bg-surface` (#0b111c) on a lane of
        // `bg-surface-2` (#0f1622) — darker than the thing it sits on, which reads as a
        // hole punched in the column rather than a card resting in it. `surface-3` is the
        // step above the lane, which is the direction elevation actually goes.
        'w-full rounded-md border bg-surface-3 p-2.5 text-left transition-colors',
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
