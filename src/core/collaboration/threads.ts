import type { AgentId, AgentMessage, MessageThread, ThreadStatus } from '../../contracts/index.js';

/**
 * A conversation, derived from the message log (M4-03).
 *
 * **Derived, never persisted**, which is the same decision `run-projection.ts` makes about
 * a run's status and for the same reason: a stored thread status is a second truth that a
 * crash between two writes can leave contradicting the log. The log is append-only and
 * total; everything a reader wants about a thread is a fold over it.
 *
 * **Thread status has no workflow authority** (I-27). A run does not wait for a thread, no
 * gate reads one, and an unresolved thread fails nothing. It is conversational
 * bookkeeping, and it is a relevance signal for the context builder — an unanswered
 * question the next attempt should see, rather than a settled one it should not.
 *
 * Pure, and deterministic: the same log always produces the same threads in the same
 * order, because the order is the log's own.
 */

/**
 * Every thread in the log, oldest first.
 *
 * `runTerminated` is what turns an unfinished thread into an *abandoned* one rather than a
 * permanently open one. The difference matters to a person reading a finished run: "open"
 * invites them to wait for an answer that is never coming.
 */
export function projectThreads(
  messages: readonly AgentMessage[],
  options: { readonly runTerminated?: boolean } = {},
): MessageThread[] {
  const byThread = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    const existing = byThread.get(message.threadId);
    if (existing === undefined) byThread.set(message.threadId, [message]);
    else existing.push(message);
  }

  const threads: MessageThread[] = [];

  for (const [id, thread] of byThread) {
    const opening = thread[0];
    // Unreachable through the store, which never writes an empty group. Guarded rather
    // than asserted because this function is also called with hand-built input by tests
    // and by the read model, and a crash there would be a worse answer than a skip.
    if (opening === undefined) continue;

    const participants = [...new Set(thread.map((message) => message.from))];
    const last = thread[thread.length - 1];

    threads.push({
      id,
      status: statusOf(thread, opening.from, options.runTerminated ?? false),
      opener: opening.from,
      subject: opening.subject,
      ...(opening.taskId === undefined ? {} : { taskId: opening.taskId }),
      messages: thread,
      participants,
      openedAt: opening.createdAt,
      lastMessageAt: last?.createdAt ?? opening.createdAt,
    });
  }

  return threads;
}

/**
 * Where a thread stands.
 *
 * The order of the checks is the contract, terminal first:
 *
 *   - **resolved** — the *opener* acknowledged. Only the opener, because "this answered my
 *     question" is a statement only the person who asked can make; letting the answerer
 *     close its own answer would make every thread resolve itself.
 *   - **abandoned** — the run ended and nobody acknowledged. Not a failure; a fact.
 *   - **answered** — somebody other than the opener answered. Excluding the opener is what
 *     stops a follow-up from its own author reading as a reply.
 *   - **open** — otherwise.
 */
function statusOf(
  thread: readonly AgentMessage[],
  opener: AgentId,
  runTerminated: boolean,
): ThreadStatus {
  const acknowledged = thread.some(
    (message) => message.type === 'acknowledge' && message.from === opener,
  );
  if (acknowledged) return 'resolved';

  if (runTerminated) return 'abandoned';

  const answered = thread.some(
    (message) => message.type === 'answer' && message.from !== opener,
  );
  return answered ? 'answered' : 'open';
}

/**
 * The threads this agent should be shown, and nothing else (M4-06).
 *
 * Three reasons a thread is relevant, and each is a fact about *this* attempt rather than
 * a similarity score:
 *
 *   - it was addressed to this agent, or to its role, or to everyone, and nobody has
 *     answered — somebody asked and is waiting;
 *   - this agent opened it and it is not resolved — this agent is waiting;
 *   - it concerns this task.
 *
 * **Set arithmetic, not a model call**, and that is a deliberate divergence from the
 * charter's §7. The relevance signal here is structural — recipient, opener, task id — and
 * ranking six messages with a model would buy nondeterminism and a second ranking
 * authority next to `RepositoryRetriever`. If a run ever produces enough traffic that
 * structural selection overflows the byte budget, ranking is the right answer *then*, and
 * the budget's overflow counter is what will say so.
 */
export function threadsFor(
  threads: readonly MessageThread[],
  audience: { readonly agentId: AgentId; readonly role: string; readonly taskId?: string },
): MessageThread[] {
  return threads.filter((thread) => {
    if (thread.status === 'resolved') return false;

    if (thread.taskId !== undefined && thread.taskId === audience.taskId) return true;
    if (thread.opener === audience.agentId) return true;

    return thread.messages.some((message) => {
      if (message.from === audience.agentId) return false;
      if (message.to.kind === 'everyone') return true;
      if (message.to.kind === 'role') return message.to.role === audience.role;
      return message.to.id === audience.agentId;
    });
  });
}
