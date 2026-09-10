import { useState } from 'react';
import type { BlackboardEntryView, CollaborationView, HandoffView, ThreadView } from '@contracts/index.js';
import { api, keys, type RunAddress } from '../../lib/api';
import { useResource } from '../../lib/store';
import { formatRelative } from '../../lib/time';
import { conversationTone, entryTone, handoffTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { Block, Chip, Empty, Notice, Skeleton, Stat } from '../../components/ui';

/**
 * What the agents said to each other, and what they wrote down (7.8, M4-07).
 *
 * **Nothing here folds a log.** A thread's status, a handoff's status and whether an
 * entry was superseded all arrive from the same projections the *prompt* was built from —
 * `core/collaboration/{threads,handoffs,blackboard}.ts`. A component re-deriving one
 * would be a second scheduler in a different costume, and it would be the one that
 * drifts, because the real answer is not on screen.
 *
 * Deliberately not a chat window. A generic message list invites reading a conversation
 * for its own sake; what a person needs is *what is still open* and *what two agents
 * disagree about*, because those are the two things nothing mechanical will settle. So
 * the order is contested entries, then unanswered handoffs, then the threads.
 *
 * M4 ships disabled, and this tab exists for the runs that turn it on. `enabled` and
 * "anything was said" are separate facts and the empty state depends on which: *off*
 * invites the operator to turn it on, and *on, and quiet* does not.
 */
export function CollaborationTab({ address }: { readonly address: RunAddress }) {
  const t = useT();
  const collaboration = useResource<CollaborationView>(keys.collaboration(address), () =>
    api.collaboration(address),
  );
  const data = collaboration.data;

  if (collaboration.error !== undefined) {
    return <Empty error>{t.collab.couldNotRead}</Empty>;
  }
  if (data === undefined) return <Skeleton rows={5} />;

  const contested = data.entries.filter((entry) => entry.status === 'contested');
  const live = data.entries.filter((entry) => entry.status !== 'superseded');
  // Contested entries are drawn in full by the notice above; listing them again below was
  // the same disagreement printed twice.
  const settled = live.filter((entry) => entry.status !== 'contested');
  const unresolved = data.threads.filter((thread) => thread.status !== 'resolved');
  const pending = data.handoffs.filter((handoff) => handoff.status === 'requested');
  /*
    The roster that came with this response, used to spell a handoff's two ends.
    `HandoffView` carries agent *ids* where a message carries `fromName`, so the row read
    `backend → frontend` beside a thread that said `Backend, Frontend` — one screen, two
    vocabularies for the same two agents. Reading the names off the payload's own roster
    is rendering; there is no second source and nothing is derived.
  */
  const named = new Map(data.agents.map((agent) => [agent.id, agent.displayName]));
  const nameOf = (id: string): string => named.get(id) ?? id;

  /*
    Handoffs are counted even though they are projected from the same messages that
    produce threads, so in practice one implies the other. Relying on that coincidence is
    how a panel ends up rendering "nothing said" over a list it was handed.
  */
  if (data.threads.length === 0 && data.entries.length === 0 && data.handoffs.length === 0) {
    return (
      <Empty
        hint={data.enabled ? t.collab.onAndQuiet : t.collab.offHint}
      >
        {t.collab.nothingSaid}
      </Empty>
    );
  }

  return (
    <div className="outcome">
      <div className="telemetry__totals" aria-label={t.telemetry.totals}>
        <Stat label={t.collab.agents} value={String(data.agents.length)} />
        <Stat label={t.collab.threads} value={String(data.threads.length)} />
        <Stat
          label={t.collab.unresolved}
          value={String(unresolved.length)}
          tone={unresolved.length > 0 ? 'warn' : undefined}
        />
        <Stat label={t.collab.liveEntries} value={String(live.length)} />
        <Stat
          label={t.collab.contested}
          value={String(contested.length)}
          tone={contested.length > 0 ? 'warn' : undefined}
        />
      </div>

      {contested.length === 0 ? null : (
        /*
          The one thing on this tab that nothing mechanical resolves, pinned above the
          lists. Both claims and not the ids: a notice that raises an alarm a reader
          cannot act on sends them looking for the argument somewhere else.
        */
        <div className="doctor-section" aria-label={t.collab.contestedAria}>
          <Notice tone="warn" k={t.collab.contestedCount(contested.length)}>
            {t.collab.contestedNotice}
          </Notice>
          <ul className="doctor-list">
            {contested.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ul>
        </div>
      )}

      {pending.length === 0 ? null : (
        <Block title={t.collab.waitingHeading} count={t.collab.handoffCount(pending.length)}>
          <ul className="doctor-list">
            {pending.map((handoff) => (
              <Handoff key={`${handoff.threadId}:${handoff.taskId}`} handoff={handoff} nameOf={nameOf} />
            ))}
          </ul>
        </Block>
      )}

      <Block title={t.collab.threadsHeading} count={t.collab.unresolvedOf(unresolved.length, data.threads.length)}>
        {data.threads.length === 0 ? (
          <p className="faint outcome__none">{t.collab.noThreads}</p>
        ) : (
          // Everything, unresolved first. The card this replaces showed three of them in a
          // 288px box; a tab somebody opened on purpose can afford the rest, and the fold
          // keeps a long run legible.
          [...unresolved, ...data.threads.filter((thread) => thread.status === 'resolved')].map((thread) => (
            <Conversation key={thread.id} thread={thread} />
          ))
        )}
      </Block>

      {settled.length === 0 ? null : (
        <Block title={t.collab.blackboardHeading} count={t.collab.liveAndSuperseded(live.length, data.entries.length - live.length)}>
          <ul className="doctor-list">
            {settled.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
}

function Handoff({ handoff, nameOf }: { readonly handoff: HandoffView; readonly nameOf: (id: string) => string }) {
  const t = useT();
  return (
    <li className="doctor-row" data-task={handoff.taskId} data-status={handoff.status}>
      <span className="doctor-row__name mono">{handoff.taskId}</span>
      <span className="doctor-row__value">
        {nameOf(handoff.from)} → {nameOf(handoff.to)} · {handoff.reason}
      </span>
      <Chip tone={handoffTone(handoff.status)}>{word(t, handoff.status)}</Chip>
    </li>
  );
}

/**
 * One conversation, folded until asked, with the last thing said in the header.
 *
 * The latest message is what says where the exchange stands, and it is what the closed
 * state shows. The whole thread is one click away rather than one HTTP call away, because
 * the endpoint already sent it — this reads the response it has, not a second one.
 */
function Conversation({ thread }: { readonly thread: ThreadView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const latest = thread.messages[thread.messages.length - 1];
  const earlier = thread.messages.length - 1;

  return (
    <div className="thread" data-thread={thread.id} data-status={thread.status}>
      <button type="button" className="thread__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Chip tone={conversationTone(thread.status)}>{word(t, thread.status)}</Chip>
        <span className="thread__task">{thread.subject}</span>
        {thread.taskId === undefined ? null : <Chip tone="ghost" plain>{thread.taskId}</Chip>}
        <span className="thread__meta">
          {thread.participants.join(', ')} · {formatRelative(thread.lastMessageAt, Date.now(), t.time)}
          {earlier > 0 ? ` · ${t.collab.earlier(earlier)}` : ''}
        </span>
      </button>

      {open ? (
        <div className="thread__body">
          {thread.messages.map((message) => (
            <p key={message.id} className="message">
              <b>{message.fromName}</b> <span className="faint">→ {message.to}</span>{' '}
              <Chip tone="ghost" plain>{word(t, message.type)}</Chip>
              {/*
                Plain text, never markup. A message body is written by a model, and
                rendering it as anything else would make a peer's output part of this
                page's DOM.
              */}
              <span className="message__body">{message.body}</span>
              {message.truncated ? <span className="faint"> {t.collab.truncated}</span> : null}
            </p>
          ))}
        </div>
      ) : latest === undefined ? null : (
        <p className="message message--latest">
          <b>{latest.fromName}</b> <span className="faint">→ {latest.to}</span>{' '}
          <span className="message__body">{latest.body}</span>
          {latest.truncated ? <span className="faint"> {t.collab.truncated}</span> : null}
        </p>
      )}
    </div>
  );
}

function Entry({ entry }: { readonly entry: BlackboardEntryView }) {
  const t = useT();
  const detail: string[] = [entry.statement];
  if (entry.rationale !== undefined) detail.push(entry.rationale);
  if (entry.affects.length > 0) detail.push(t.collab.affects(entry.affects.map((audience) => word(t, audience)).join(', ')));

  return (
    <li className="doctor-row" data-entry={entry.id} data-status={entry.status}>
      <span className="doctor-row__name">
        <span className="mono">{entry.id}</span>
        <small className="doctor-note">
          {word(t, entry.kind)} · {entry.authorName}
        </small>
      </span>
      <span className="doctor-row__value">
        <b>{entry.subject}</b> — {detail.join(' · ')}
      </span>
      <Chip tone={entryTone(entry.status)}>{word(t, entry.status)}</Chip>
    </li>
  );
}
