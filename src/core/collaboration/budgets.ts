import type { CollaborationConfig, CollaborationRejection } from '../../contracts/index.js';

/**
 * What stops an agent conversation from running forever (M4, I-31).
 *
 * Every function here answers one question — may this one more thing be admitted — and
 * answers it from numbers the caller already has. Pure, so the bound is a property of the
 * rule rather than of the order the caller happened to check things in.
 *
 * **`undefined` means admitted**, following `permissionReadiness`: a refusal is a value
 * with a reason attached, and an admission has nothing to say. A boolean would have made
 * every call site invent its own explanation, and AR §3.6 is explicit that "something
 * failed" is a contract violation — a budget that runs out has to name which one and what
 * clears it.
 *
 * The budgets themselves are deliberately small. A conversation that has needed twelve
 * messages about one task is not converging, and the thirteenth is not the one that fixes
 * it — the same reasoning as `recovery.maxIdenticalFailures`, applied to talking.
 */

export interface BudgetRefusal {
  readonly rejection: CollaborationRejection;
  /** The configuration key that ran out. Never a paraphrase — a person greps for this. */
  readonly budget: string;
  readonly limit: number;
  /** The one specific action that clears it. "Check your budgets" is not one. */
  readonly action: string;
}

export interface MessageAdmission {
  readonly config: CollaborationConfig;
  /** Messages already recorded for this task, across all of its attempts. */
  readonly alreadyForTask: number;
  /**
   * Messages already in the thread this one would join.
   *
   * Absent when the message opens a new thread, which has no depth to exceed. Absent is
   * not zero for a reader, but the arithmetic is the same and the distinction costs
   * nothing here.
   */
  readonly threadDepth?: number;
}

export function admitMessage(input: MessageAdmission): BudgetRefusal | undefined {
  const { config } = input;

  if (input.alreadyForTask >= config.maxMessagesPerTask) {
    return {
      rejection: 'budget_exhausted',
      budget: 'collaboration.maxMessagesPerTask',
      limit: config.maxMessagesPerTask,
      action:
        `This task has already posted ${String(config.maxMessagesPerTask)} messages. Read them, ` +
        'answer what is open, or raise collaboration.maxMessagesPerTask if the work genuinely ' +
        'needs more.',
    };
  }

  // Checked second, because a task that has run out of messages altogether has run out
  // for every thread — reporting the depth of one of them would name the smaller problem.
  if (input.threadDepth !== undefined && input.threadDepth >= config.maxThreadDepth) {
    return {
      rejection: 'thread_depth_exceeded',
      budget: 'collaboration.maxThreadDepth',
      limit: config.maxThreadDepth,
      action:
        `This thread is ${String(config.maxThreadDepth)} messages deep and is not converging. ` +
        'Decide it yourself, or record the decision on the blackboard so it stops being asked.',
    };
  }

  return undefined;
}

export interface HandoffAdmission {
  readonly config: CollaborationConfig;
  /**
   * Handoffs already *accepted* for this task.
   *
   * Accepted, not requested: a target that said no cost the task nothing, and counting a
   * refusal against the budget would punish the task for the target's decision.
   */
  readonly alreadyForTask: number;
}

export function admitHandoff(input: HandoffAdmission): BudgetRefusal | undefined {
  if (input.alreadyForTask < input.config.maxHandoffsPerTask) return undefined;

  return {
    rejection: 'budget_exhausted',
    budget: 'collaboration.maxHandoffsPerTask',
    limit: input.config.maxHandoffsPerTask,
    action:
      `This task has already been handed off ${String(input.config.maxHandoffsPerTask)} times. ` +
      'Assign it deliberately, or split it — a task nobody will take is usually two tasks.',
  };
}

export interface EntryAdmission {
  readonly config: CollaborationConfig;
  readonly alreadyInRun: number;
}

export function admitEntry(input: EntryAdmission): BudgetRefusal | undefined {
  if (input.alreadyInRun < input.config.maxBlackboardEntriesPerRun) return undefined;

  return {
    rejection: 'budget_exhausted',
    budget: 'collaboration.maxBlackboardEntriesPerRun',
    limit: input.config.maxBlackboardEntriesPerRun,
    action:
      `This run holds ${String(input.config.maxBlackboardEntriesPerRun)} blackboard entries, ` +
      'which is more than any prompt can carry. Supersede what is stale, or raise ' +
      'collaboration.maxBlackboardEntriesPerRun and accept a larger context bill.',
  };
}

/**
 * Whether an outbox file is small enough to be parsed at all.
 *
 * Checked against the file's *size on disk*, before it is read, because the failure being
 * prevented is a two-gigabyte file becoming a two-gigabyte string. A schema cannot defend
 * against a file it has already been handed.
 */
export function admitOutboxSize(
  config: CollaborationConfig,
  bytes: number,
): BudgetRefusal | undefined {
  if (bytes <= config.maxOutboxBytes) return undefined;

  return {
    rejection: 'budget_exhausted',
    budget: 'collaboration.maxOutboxBytes',
    limit: config.maxOutboxBytes,
    action:
      `The outbox is ${String(bytes)} bytes, over collaboration.maxOutboxBytes ` +
      `(${String(config.maxOutboxBytes)}), and was not read. An agent writing that much is ` +
      'pasting output rather than saying something — reference the artifact instead.',
  };
}
