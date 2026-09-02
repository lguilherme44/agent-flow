import type { AgentMessage, Handoff, HandoffStatus } from '../../contracts/index.js';

/**
 * Who is doing a task, and who was asked to take it over (M4-04).
 *
 * **A projection over the message log, not a third store.** A handoff *is* a conversation
 * — request, then accept or reject — and giving it its own record would mean two accounts
 * of one exchange that a crash between two writes could leave disagreeing. The message log
 * already has every fact; this is a fold over it.
 *
 * Pure. Nothing here writes, and nothing here decides that a task runs — only *who* would
 * run it if it does. The DAG, the plan, the gates and the ordering are untouched.
 */

/**
 * Every handoff in the log, in request order.
 *
 * `runTerminated` turns an unanswered request into `expired`. The distinction is worth the
 * field: a person reading a finished run must not be left waiting for an acceptance that
 * cannot arrive.
 *
 * **A response from anyone but the request's target is not a transition.** It stays in the
 * thread, where a reader sees it, and it moves nothing — there is no state in which a
 * third party can take a task off the agent it was offered to. That is the one rule here
 * whose absence would turn a handoff into a way to seize work.
 */
export function projectHandoffs(
  messages: readonly AgentMessage[],
  options: { readonly runTerminated?: boolean } = {},
): Handoff[] {
  const handoffs: Handoff[] = [];

  for (const request of messages) {
    if (request.type !== 'handoff_request') continue;
    // Guaranteed by the schema's refinement; narrowed here so the types agree without a
    // cast, and so a hand-built message in a test cannot produce a handoff to nobody.
    if (request.to.kind !== 'agent' || request.taskId === undefined) continue;

    const target = request.to.id;
    const settlement = messages.find(
      (message) =>
        message.threadId === request.threadId &&
        (message.type === 'handoff_accepted' || message.type === 'handoff_rejected') &&
        message.from === target,
    );

    const status: HandoffStatus =
      settlement?.type === 'handoff_accepted'
        ? 'accepted'
        : settlement?.type === 'handoff_rejected'
          ? 'rejected'
          : (options.runTerminated ?? false)
            ? 'expired'
            : 'requested';

    handoffs.push({
      threadId: request.threadId,
      taskId: request.taskId,
      from: request.from,
      to: target,
      reason: request.body,
      status,
      requestedAt: request.createdAt,
      ...(settlement === undefined ? {} : { settledAt: settlement.createdAt }),
    });
  }

  return handoffs;
}

/**
 * **`resolveTaskAgent` used to live here and now lives in `core/team/policy.ts`.**
 *
 * M4 put it beside the handoff projection because a handoff was the only thing that could
 * ever move a task, and it was called on every task from the start so that M5 would have
 * a seam rather than a second router. M5 is that milestone: the body moved, the position
 * did not, and there is still exactly one answer to "who executes this task".
 *
 * What stays here is the projection — a handoff is a conversation, and folding one out of
 * the message log is this module's job. Deciding what a handoff *means* is the policy's,
 * and keeping the two apart is what stops an accepted message from being an instruction
 * (I-33).
 */
