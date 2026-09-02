import type {
  AgentId,
  AgentIdentity,
  AgentMessage,
  Handoff,
  HandoffStatus,
  WorkflowRole,
} from '../../contracts/index.js';
import { admitHandoff, type BudgetRefusal } from './budgets.js';
import type { CollaborationConfig } from '../../contracts/index.js';

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

/** Why a task is going to the agent it is going to. Recorded, never inferred later. */
export type AssignmentReason =
  | 'routed'
  | 'handoff'
  | 'handoff_not_enabled'
  | 'handoff_refused_capability'
  | 'handoff_budget_exhausted';

export interface TaskAssignment {
  readonly agentId: AgentId;
  readonly reason: AssignmentReason;
  /** The handoff that was honoured or refused, when one was considered. */
  readonly handoff?: Handoff;
  /** Present when a handoff was refused, with the action that would allow it. */
  readonly refusal?: string;
}

export interface ResolveTaskAgentInput {
  readonly taskId: string;
  /** What `core/router.ts` decided. The default, and the fallback for every refusal. */
  readonly routedRole: WorkflowRole;
  readonly handoffs: readonly Handoff[];
  readonly config: CollaborationConfig;
  /** Resolves an agent id to its identity, or `undefined` if nobody configured it. */
  readonly agentOf: (id: AgentId) => AgentIdentity | undefined;
  /**
   * Whether this agent's (runner, model) pair can do the work the task needs.
   *
   * A predicate rather than a capability map, so this module stays pure and provider-free:
   * the caller owns `resolveRole`, which owns the capability question, and a second
   * implementation of it here would be a second answer.
   */
  readonly canImplement: (agent: AgentIdentity) => boolean;
}

/**
 * Who executes this task — **the one answer, asked unconditionally** (M4-04).
 *
 * Called on every task whether or not handoffs are enabled, and that is deliberate. A
 * function that existed only while a flag was on would be the "built, tested and never
 * called" shape the architecture rules already had to be extended to catch. So the seam is
 * always live, `routed` is what it returns for almost every task, and the *policy* is what
 * the flag moves.
 *
 * The rules, in order:
 *
 *   1. No accepted handoff → the router's answer.
 *   2. `handoffsReassignExecution` off → the router's answer, and the reason says so.
 *      **Off by default**, because re-routing execution from model output is an
 *      ownership transfer and ownership is not a model's to decide. The record is still
 *      complete; only the authority is withheld.
 *   3. Over `maxHandoffsPerTask` → the router's answer. A task being passed around is a
 *      task nobody will take, which is usually two tasks.
 *   4. The target cannot implement → the router's answer, and the refusal names why. A
 *      handoff to an agent whose runner has no working directory would produce an attempt
 *      that cannot begin.
 *   5. Otherwise → the target.
 *
 * The DAG, the plan, the gates and the ordering are untouched on every branch: this
 * changes *who*, never *whether* or *when*.
 */
export function resolveTaskAgent(input: ResolveTaskAgentInput): TaskAssignment {
  const routed: TaskAssignment = { agentId: input.routedRole, reason: 'routed' };

  const forTask = input.handoffs.filter((handoff) => handoff.taskId === input.taskId);
  const accepted = forTask.filter((handoff) => handoff.status === 'accepted');
  const latest = accepted[accepted.length - 1];
  if (latest === undefined) return routed;

  if (!input.config.handoffsReassignExecution) {
    return { ...routed, reason: 'handoff_not_enabled', handoff: latest };
  }

  const budget: BudgetRefusal | undefined = admitHandoff({
    config: input.config,
    // The accepted ones, because a rejected offer cost nothing and refusing to consider
    // the next one because of it would punish the target for saying no.
    alreadyForTask: accepted.length - 1,
  });
  if (budget !== undefined) {
    return {
      ...routed,
      reason: 'handoff_budget_exhausted',
      handoff: latest,
      refusal: budget.action,
    };
  }

  const agent = input.agentOf(latest.to);
  if (agent === undefined || !input.canImplement(agent)) {
    return {
      ...routed,
      reason: 'handoff_refused_capability',
      handoff: latest,
      refusal:
        `"${latest.to}" accepted ${latest.taskId} and cannot implement it — its runner does ` +
        'not offer what an implementation task needs. The task stays with the role the ' +
        'router chose.',
    };
  }

  return { agentId: agent.id, reason: 'handoff', handoff: latest };
}
