import type {
  AttentionItem,
  BoardCardView,
  BoardLane,
  BoardLaneView,
  BoardReason,
  ReviewThreadView,
  RunProjection,
  TaskSummaryView,
  WaveDeferralView,
} from '../contracts/index.js';
import { ATTENTION_PRIORITIES, BOARD_LANES } from '../contracts/index.js';

import { en, type Phrases } from './phrases/index.js';

/**
 * Where each task is, and why — the one function that decides it (M8 §5, T1).
 *
 * **The columns are not state.** There is no `task.column` and there will not be one: a
 * lane is a question about the task's state, the DAG, the run and the wave that formed,
 * all of which move. A stored column is a copy that goes stale the moment any of them does,
 * and after a crash it is the copy claiming a task is somewhere it is not.
 *
 * **The reason is the point.** Every sentence this file produces was already known by
 * something — the DAG knew the task waits on TASK-004, `TeamView.deferrals` knew the wave
 * held it for capacity, the review thread knew two findings block it. None of them was
 * ever joined to the card an operator was looking at, and a board without that join is a
 * task table with rounded corners.
 *
 * Pure. No clock, no I/O, no React. Both the CLI and the dashboard read what this returns;
 * neither derives it, because two derivations of one lane is two boards.
 */

export interface BoardContext {
  /** The run's runtime condition. `interrupted` reads differently depending on it. */
  readonly runtime: RunProjection;
  /**
   * Unmet dependencies per task, in plan order.
   *
   * Unmet rather than all: "waiting on TASK-001, TASK-004" where TASK-001 finished an hour
   * ago is a sentence that sends somebody to look at the wrong task.
   */
  readonly waitingOn: ReadonlyMap<string, readonly string[]>;
  /** What a wave would not take, and why (M5). */
  readonly deferrals: readonly WaveDeferralView[];
  /** Review threads, for the `review` lane's sentence and the blocking count. */
  readonly threads: readonly ReviewThreadView[];
  /** The assignment in force per task, when the run recorded one. */
  readonly assignments: ReadonlyMap<string, { readonly agentId: string; readonly agentName: string }>;
}

/**
 * The lane, from the task's state and the three things the task alone cannot know.
 *
 * An exhaustive switch with a `never` check at the end, so adding a `TaskState` to the
 * union is a compile error rather than a silent fall into `backlog`. `unknown` exists for
 * the runtime case the type system cannot cover — a state written by a build that knew one
 * this one does not — because a task nobody can see is worse than a task in a lane
 * labelled honestly.
 */
export function boardLane(task: TaskSummaryView, context: BoardContext): BoardLane {
  const state = task.state;

  switch (state) {
    case 'completed':
      return 'done';

    case 'running':
      return 'in_progress';

    case 'review_required':
      return 'review';

    case 'blocked':
    case 'failed':
      // One lane rather than two. From an operator's chair they are the same situation —
      // the task is not moving and a person decides what happens next — and the card's
      // reason line carries which of the two it is.
      return 'blocked';

    case 'interrupted':
      // **Lane depends on the run, and that is deliberate.** `interrupted` is what a killed
      // coordinator leaves. While the run executes, recovery reconciles it and the task is
      // genuinely in progress; while nothing executes, it is waiting for a person and
      // calling that "in progress" would show motion where there is none.
      return isExecuting(context.runtime) ? 'in_progress' : 'blocked';

    case 'queued':
    case 'ready':
      // `awaitingIntegration` is validated work that has not merged yet — the state
      // `TaskState` has no name for, and the one a person watching a parallel run most
      // needs to see. It is progress, not readiness.
      if (task.awaitingIntegration === true) return 'in_progress';
      // **Readiness is not re-derived here.** `ready` is a condition over the graph that
      // §22 refuses to persist, and `effectiveTaskStates` — the one function every reader
      // goes through — has already answered it by the time a `TaskSummaryView` exists. A
      // board that asked the DAG again would be a second answer to "what may start", and
      // the first time the two disagreed the operator would be reading a column describing
      // a decision nobody made.
      return state === 'ready' ? 'ready' : 'backlog';

    default: {
      const exhaustive: never = state;
      void exhaustive;
      return 'unknown';
    }
  }
}

/**
 * The sentence, and where it comes from.
 *
 * Ordered by what an operator can act on: a human gate outranks a dependency, and a
 * dependency outranks a wave deferral, because the last one resolves itself and the first
 * two do not.
 */
export function boardReason(
  task: TaskSummaryView,
  lane: BoardLane,
  context: BoardContext,
  say: Phrases = en,
): BoardReason {
  if (lane === 'done') return { text: say.board.completed, cause: 'none' };

  if (lane === 'unknown') {
    return {
      text: say.board.unknownState(task.state),
      cause: 'unknown',
    };
  }

  if (lane === 'blocked') {
    if (task.state === 'failed') {
      return { text: say.board.failed(task.attempts), cause: 'failure' };
    }
    if (task.state === 'interrupted') {
      return {
        text: say.board.interruptedByStop,
        cause: 'human',
      };
    }
    // `blockReason` distinguishes the agent answering BLOCKED from an upstream failure
    // holding this task back. Only the second is ever released by recovery, so telling
    // them apart is the difference between waiting and acting.
    //
    // **And absence is not evidence of the first.** `blocked` is two things: a record the
    // executor wrote when a runner answered BLOCKED, and a condition `blockedByFailure`
    // derives over the graph for everything downstream of a failure. Only the record
    // carries a reason, so reading absence as "the agent asked for help" put that sentence
    // on the card of every task the agent never touched. The unmet dependencies answer it.
    const waiting = context.waitingOn.get(task.id) ?? [];
    if (task.blockReason !== 'agent' && (task.blockReason === 'dependency' || waiting.length > 0)) {
      return {
        text:
          waiting.length > 0
            ? say.board.heldBackBy(waiting.join(', '))
            : say.board.heldByUpstreamFailure,
        cause: 'dependency',
        ...(waiting.length > 0 ? { waitsFor: waiting } : {}),
      };
    }
    return {
      text: say.board.agentReportedSdd,
      cause: 'human',
    };
  }

  if (lane === 'review') {
    const thread = context.threads.find((candidate) => candidate.taskId === task.id);
    if (thread === undefined) {
      return { text: say.board.waitingForReviewDecision, cause: 'review' };
    }
    if (thread.openBlocking > 0) {
      return {
        text: say.board.changesRequested(thread.openBlocking),
        cause: 'review',
      };
    }
    if (thread.freshness === 'stale') {
      return {
        text: say.board.reviewMovedPast,
        cause: 'review',
      };
    }
    return { text: say.board.inReviewRound(thread.rounds), cause: 'review' };
  }

  if (lane === 'in_progress') {
    if (task.awaitingIntegration === true) {
      return { text: say.board.waitingToMerge, cause: 'integration' };
    }
    if (task.state === 'interrupted') {
      return { text: say.board.interruptedWillRequeue, cause: 'attempt' };
    }
    return {
      text: say.board.running(task.attempts, task.workspaceActive === true),
      cause: 'attempt',
    };
  }

  if (lane === 'ready') {
    // A ready task that is not running was held by *something*, and M5 recorded which.
    // The most recent deferral wins: a task deferred for capacity in one wave and for
    // ownership in the next is waiting on the second.
    const deferral = lastDeferral(context.deferrals, task.id);
    if (deferral !== undefined) return deferralReason(deferral, say);
    return { text: say.board.readyToStart, cause: 'none' };
  }

  // backlog
  const waiting = context.waitingOn.get(task.id) ?? [];
  if (waiting.length > 0) {
    return { text: say.board.waitingOn(waiting.join(', ')), cause: 'dependency', waitsFor: waiting };
  }
  return { text: say.board.plannedNotReady, cause: 'none' };
}

/**
 * Every card, with its lane, its sentence, who holds it and what a review found.
 *
 * `attention` is joined here rather than in a component, because a card marking itself by
 * scanning a second list is the join that goes wrong the first time one of the two is a
 * frame behind the other.
 */
export function projectBoard(
  tasks: readonly TaskSummaryView[],
  context: BoardContext,
  attention: readonly AttentionItem[] = [],
  say: Phrases = en,
): BoardCardView[] {
  // The most urgent priority per task. Ranked explicitly rather than compared as strings:
  // `'P0' < 'P1'` happens to be true and would stop being true the day a `P10` exists.
  const rank = (priority: AttentionItem['priority']): number => ATTENTION_PRIORITIES.indexOf(priority);
  const worst = new Map<string, AttentionItem['priority']>();
  for (const item of attention) {
    const taskId = item.scope.taskId;
    if (taskId === undefined) continue;
    const held = worst.get(taskId);
    if (held === undefined || rank(item.priority) < rank(held)) worst.set(taskId, item.priority);
  }

  return tasks.map((task) => {
    const lane = boardLane(task, context);
    const assignment = context.assignments.get(task.id);
    const thread = context.threads.find((candidate) => candidate.taskId === task.id);
    const priority = worst.get(task.id);

    return {
      task,
      lane,
      reason: boardReason(task, lane, context, say),
      ...(assignment === undefined
        ? {}
        : { agentId: assignment.agentId, agentName: assignment.agentName }),
      blockingFindings: thread?.openBlocking ?? 0,
      ...(priority === undefined ? {} : { attention: priority }),
    };
  });
}

/**
 * Lane counts, in lane order, including the empty ones.
 *
 * Empty lanes are returned rather than omitted: a board that hides `BLOCKED` when nothing
 * is blocked changes width as a run progresses, and a column that appears is a column
 * somebody has to notice appearing.
 */
export function laneCounts(cards: readonly BoardCardView[]): BoardLaneView[] {
  return BOARD_LANES.map((lane) => ({
    lane,
    count: cards.filter((card) => card.lane === lane).length,
  }));
}

/** Whether the run is doing work right now, for the `interrupted` decision above. */
function isExecuting(runtime: RunProjection): boolean {
  return (
    runtime.status === 'implementing' ||
    runtime.status === 'recovering' ||
    runtime.status === 'correcting' ||
    runtime.status === 'verifying'
  );
}

function lastDeferral(
  deferrals: readonly WaveDeferralView[],
  taskId: string,
): WaveDeferralView | undefined {
  for (let index = deferrals.length - 1; index >= 0; index -= 1) {
    const deferral = deferrals[index];
    if (deferral?.taskId === taskId) return deferral;
  }
  return undefined;
}

function deferralReason(deferral: WaveDeferralView, say: Phrases): BoardReason {
  if (deferral.reason === 'capacity') {
    const who =
      deferral.agents.length > 0 ? deferral.agents.join(', ') : say.board.everyEligibleAgent;
    return { text: say.board.heldOneWave(who), cause: 'capacity' };
  }

  const area =
    deferral.patterns.length > 0 ? deferral.patterns.join(', ') : say.board.anExclusiveArea;
  const holder = deferral.waitsFor === undefined ? '' : say.board.heldBy(deferral.waitsFor);
  return { text: say.board.ownershipConflict(area, holder), cause: 'ownership' };
}
