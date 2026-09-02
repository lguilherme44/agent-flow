import { AlertTriangle, ArrowRightLeft, MessageSquare, NotebookPen } from 'lucide-react';
import type {
  BlackboardEntryView,
  CollaborationView,
  HandoffView,
  ThreadView,
} from '@contracts/index.js';
import { Badge, Card, Empty, cx } from '../components/ui';
import { formatWhen } from '../lib/format';

/**
 * What the agents said to each other, and what they wrote down (M4-07).
 *
 * **A projection of the server's projection.** Nothing here folds a log, decides a
 * thread's status or works out whether an entry was superseded — all four answers arrive
 * from the same functions the prompt was built from. A component that re-derived any of
 * them would be a second scheduler in a different costume, and it would be the one that
 * drifts, because the real answer is not on screen.
 *
 * Deliberately not a chat window. A generic message list would invite reading a
 * conversation for its own sake; what a person needs from this screen is *what is still
 * open* and *what two agents disagree about*, because those are the two things nothing
 * mechanical will settle.
 */

const THREAD_TONE: Record<string, 'success' | 'warning' | 'info' | 'muted'> = {
  resolved: 'success',
  answered: 'info',
  open: 'warning',
  abandoned: 'muted',
};

const HANDOFF_TONE: Record<string, 'success' | 'danger' | 'warning' | 'muted'> = {
  accepted: 'success',
  rejected: 'danger',
  requested: 'warning',
  expired: 'muted',
};

export function CollaborationPanel(props: {
  collaboration: CollaborationView | undefined;
  className?: string;
}): JSX.Element {
  const view = props.collaboration;
  const threads = view?.threads ?? [];
  const entries = view?.entries ?? [];
  const handoffs = view?.handoffs ?? [];

  const contested = entries.filter((entry) => entry.status === 'contested');
  const live = entries.filter((entry) => entry.status !== 'superseded');
  // Contested entries are rendered in full by the notice above; listing them again here
  // was the same disagreement printed twice, in a card with no room to spare.
  const settled = live.filter((entry) => entry.status !== 'contested');
  const open = threads.filter((thread) => thread.status !== 'resolved');
  // Only what somebody still has to answer. A settled handoff is a fact about the past,
  // and this row is read to decide what happens next.
  const pending = handoffs.filter((handoff) => handoff.status === 'requested');

  return (
    <Card
      title="Collaboration"
      {...(props.className === undefined ? {} : { className: props.className })}
      footer={
        view === undefined ? null : (
          <span>
            {String(threads.length)} thread(s), {String(open.length)} unresolved ·{' '}
            {String(live.length)} live entry(ies)
          </span>
        )
      }
    >
      {/* Handoffs are counted here even though they are projected from the same messages
          that produce threads, so in practice one implies the other. Relying on that
          coincidence is how a component ends up rendering "nothing said" over a list it
          was handed — the test that caught it passed handoffs alone. */}
      {threads.length === 0 && entries.length === 0 && handoffs.length === 0 ? (
        <Empty
          title="Nothing said."
          // The two facts are separate, and the hint depends on which: "off" invites the
          // operator to turn it on, and "on, and quiet" does not. Reporting one as the
          // other would send somebody to edit a setting that is already correct.
          hint={
            view?.enabled === true
              ? 'Agents on this run can talk to each other. None of them needed to.'
              : 'Set collaboration.enabled to let agents on this run talk to each other.'
          }
        />
      ) : (
        // **Bounded, and the footer carries the totals** — the pattern `ArtifactsCard`
        // already set in this row for the same reason. The first version rendered
        // everything, and the screenshot showed a 288-pixel box with the second thread
        // and the whole blackboard cut off below the fold. Every component test passed:
        // "the element exists" is not "the layout is right".
        //
        // What survives the cut is what nothing mechanical settles — contested entries,
        // then unanswered handoffs, then unresolved threads. A resolved conversation is
        // history, and history belongs in the log rather than in the row a person reads
        // before deciding whether the run can move on.
        <div className="flex flex-col gap-2.5">
          {contested.length === 0 ? null : <ContestedNotice entries={contested.slice(0, 3)} total={contested.length} />}
          {pending.length === 0 ? null : <Handoffs handoffs={pending.slice(0, 2)} />}
          {open.length === 0 ? null : <Threads threads={open.slice(0, 3)} />}
          {settled.length === 0 ? null : <Entries entries={settled.slice(0, 3)} />}
        </div>
      )}
    </Card>
  );
}

/**
 * The one thing on this panel that nothing mechanical resolves.
 *
 * Pinned to the top and outside the lists, because a contested pair is a decision waiting
 * for a person — and folding it into a count is how a disagreement between two agents
 * settles itself out of sight.
 */
function ContestedNotice(props: {
  entries: readonly BlackboardEntryView[];
  total: number;
}): JSX.Element {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-2">
      <p className="flex items-center gap-1.5 text-label font-semibold text-warning">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {String(props.total)} contested entry(ies)
      </p>
      <p className="mt-0.5 text-micro text-muted">
        Two agents disagree, and nothing decides it for you. Both are still in every
        prompt that reads them.
      </p>
      {/* The statements, not just the ids. The first screenshot listed `CTR-001 —
          recurrence-expansion by Architect` here and then repeated both entries in the
          blackboard list below with their text — so the notice raised an alarm a reader
          could not act on, and the list said the same thing twice. What a person needs is
          the two claims side by side, which is the whole of the disagreement. */}
      <ul className="mt-1.5 flex flex-col gap-1">
        {props.entries.map((entry) => (
          <li key={entry.id} className="text-micro leading-snug text-text">
            <span className="tabular font-medium">{entry.id}</span>{' '}
            <span className="text-faint">{entry.authorName}:</span>{' '}
            <span className="text-muted">{entry.statement}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Handoffs(props: { handoffs: readonly HandoffView[] }): JSX.Element {
  return (
    <Section icon={<ArrowRightLeft className="h-3.5 w-3.5" aria-hidden />} title="Handoffs">
      <ul className="flex flex-col divide-y divide-border/70">
        {props.handoffs.map((handoff) => (
          <li key={`${handoff.threadId}-${handoff.taskId}`} className="flex items-start gap-2 py-1">
            <Badge tone={HANDOFF_TONE[handoff.status] ?? 'muted'} caps>
              {handoff.status}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-label text-text">
                <span className="tabular">{handoff.taskId}</span>: {handoff.from} →{' '}
                {handoff.to}
              </p>
              <p className="truncate text-micro text-muted">{handoff.reason}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Threads(props: { threads: readonly ThreadView[] }): JSX.Element {
  return (
    <Section icon={<MessageSquare className="h-3.5 w-3.5" aria-hidden />} title="Threads">
      <ul className="flex flex-col divide-y divide-border/70">
        {props.threads.map((thread) => (
          <li key={thread.id} className="py-1.5">
            <div className="flex items-start gap-2">
              <Badge tone={THREAD_TONE[thread.status] ?? 'muted'} caps>
                {thread.status}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-label text-text">{thread.subject}</p>
                <p className="truncate text-micro text-faint">
                  {thread.participants.join(', ')}
                  {thread.taskId === undefined ? '' : ` · ${thread.taskId}`} ·{' '}
                  {formatWhen(thread.lastMessageAt)}
                </p>
              </div>
            </div>
            <LatestMessage thread={thread} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The last thing said in a thread, and how much came before it.
 *
 * **Not the whole exchange, and the first screenshot is why.** Rendering every message of
 * every thread overflowed the card so far that the second thread and the entire blackboard
 * section were cut off the bottom — a panel whose own comment said "deliberately not a
 * chat window" while being one. Every component test passed the whole time, because "the
 * element exists" is not "the layout is right".
 *
 * The latest message is the one that says where the conversation stands. The rest is one
 * HTTP call or one `.jsonl` away for anybody who wants it.
 */
function LatestMessage(props: { thread: ThreadView }): JSX.Element | null {
  const latest = props.thread.messages[props.thread.messages.length - 1];
  if (latest === undefined) return null;

  const earlier = props.thread.messages.length - 1;

  return (
    <p className="mt-0.5 truncate pl-1 text-micro leading-snug text-muted">
      <span className="font-medium text-text">{latest.fromName}</span>{' '}
      <span className="text-faint">→ {latest.to}</span>{' '}
      {/* Plain text, never markup. A message body is written by a model, and rendering it
          as anything but text would make a peer's output part of this page's DOM. */}
      <span className="break-words">{latest.body}</span>
      {latest.truncated ? <span className="text-faint"> [truncated]</span> : null}
      {earlier > 0 ? <span className="text-faint"> · {String(earlier)} earlier</span> : null}
    </p>
  );
}

function Entries(props: { entries: readonly BlackboardEntryView[] }): JSX.Element {
  return (
    <Section icon={<NotebookPen className="h-3.5 w-3.5" aria-hidden />} title="Blackboard">
      <ul className="flex flex-col divide-y divide-border/70">
        {props.entries.map((entry) => (
          <li key={entry.id} className="py-1.5">
            <p className="flex items-center gap-1.5 text-label text-text">
              <span className="tabular font-medium">{entry.id}</span>
              <Badge tone={entry.status === 'contested' ? 'warning' : 'muted'} caps>
                {entry.kind}
              </Badge>
              <span className="truncate">{entry.subject}</span>
            </p>
            <p className="mt-0.5 truncate text-micro text-muted">{entry.statement}</p>
            <p className="mt-0.5 text-micro text-faint">
              {entry.authorName}
              {entry.affects.length === 0 ? '' : ` · affects ${entry.affects.join(', ')}`}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Section(props: {
  icon: JSX.Element;
  title: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section>
      <h3
        className={cx(
          'flex items-center gap-1.5 pb-0.5 text-micro font-semibold uppercase',
          'tracking-caps text-faint',
        )}
      >
        {props.icon}
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}
