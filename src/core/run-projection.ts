import type { RunEvent, RunState, RunStage, TaskProgress } from '../contracts/index.js';
import { buildDag, readyTasks, type DagNode, type TaskStates } from './dag.js';

/**
 * The run as a person needs to see it — derived, never persisted (AD-48, I-26).
 *
 * `RUN_STATUSES` is unchanged, and that is the decision rather than an omission. The
 * pattern is already established and documented in this repository: `PIPELINE_STAGES`
 * (nine) exists separately from `RUN_STAGES` (eight) so that "a display concern" never
 * becomes "a stage the state machine has to pretend to run". Adding runtime statuses to
 * the persisted enum would mix lifecycle with presentation, and a crash mid-write would
 * persist an *opinion*.
 *
 * Every observability defect in the evidence run was a missing projection, not a missing
 * state: `plan_rejected` persisted while a revision was running, `APPROVED` shown during
 * implementation, `Resume run` offered three times with nothing runnable, overall
 * progress at 100% with verification pending and then *falling* to 67% when corrective
 * tasks were appended.
 *
 * Pure. Both surfaces consume this one function — computing it in the UI would make the
 * UI a source of truth and guarantee that the CLI and the dashboard disagree.
 */

/**
 * What the run is doing right now.
 *
 * Wider than `RunStatus` on purpose: `recovering`, `correcting`, `blocked_on_human` and
 * `auto_recovery_exhausted` are conditions over persisted state, the event log and the
 * DAG. None of them is a lifecycle state, and none is ever written to disk.
 */
export const RUNTIME_STATUSES = [
  'planning',
  'awaiting_human_approval',
  'plan_rejected_revisable',
  'implementing',
  /** At least one task is in an automatic recovery step. */
  'recovering',
  'verifying',
  'reviewing',
  /** A corrective round is in flight. */
  'correcting',
  /** Held at a gate. Carries which gate, and the one action that clears it. */
  'blocked_on_human',
  'auto_recovery_exhausted',
  'complete',
  'failed',
] as const;

export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

/**
 * The three progress axes (C-21).
 *
 * Three values because they answer three questions, and collapsing them into one is what
 * produced a percentage that read 100% with verification pending and then *fell* when
 * corrective tasks were appended. A number that can go down is not progress.
 */
export interface ProgressAxes {
  /** How far along the pipeline the run is: stages reached over stages required. */
  readonly workflow: { readonly done: number; readonly total: number };
  /** Planned tasks completed over planned tasks. Corrective tasks are not counted here. */
  readonly implementation: { readonly done: number; readonly total: number };
  /**
   * Corrective tasks completed over corrective tasks, or `undefined` when none exist.
   *
   * `undefined` rather than `0/0`: a run with no corrective work has no corrective
   * progress, and rendering `0%` would suggest something is pending.
   */
  readonly corrective?: { readonly done: number; readonly total: number };
}

export interface RuntimeGate {
  /** Which gate holds the run. */
  readonly gate: 'approval' | 'task_review' | 'agent_blocked' | 'final_acceptance';
  /** The one action that clears it (AR §3.6). Never "inspect logs". */
  readonly action: string;
  /** The tasks involved, when the gate is about tasks. */
  readonly tasks: readonly string[];
}

export interface RunProjection {
  readonly status: RuntimeStatus;
  /**
   * Whether the DAG yields executable work **now** (C-19).
   *
   * `Resume` is offered if and only if this is true, and `run` refuses before taking the
   * execution lock when it is false. The evidence run took and released the lock three
   * times with nothing runnable, because nothing distinguished "held at a gate" from
   * "resumable".
   */
  readonly resumable: boolean;
  /** Present exactly when the status is `blocked_on_human`. */
  readonly gate?: RuntimeGate;
  readonly progress: ProgressAxes;
  /**
   * Whether the newest review artifact is the one describing the current state (C-20).
   *
   * A review is a statement about one tree at one time. A planning stage that started
   * *after* the review was written supersedes it, and presenting it as current is how
   * `plan_rejected` stayed on screen while revision 2 was already running.
   */
  readonly reviewFreshness: 'current' | 'superseded' | 'absent';
}

export interface ProjectionInput {
  readonly state: RunState;
  /**
   * The task graph, when a plan exists.
   *
   * `DagNode` and nothing more — `core/dag.ts` stays file-agnostic (AD-43), and this
   * module must not be the place a file-shaped field sneaks into the graph.
   */
  readonly nodes?: readonly DagNode[];
  /** Append-only, in order. Read for stage timing and for recovery conditions only. */
  readonly events?: readonly RunEvent[];
  /** When the newest review artifact was written, when one exists. */
  readonly reviewWrittenAt?: string;
}

/** Stages a run must reach before it can be called finished. */
const REQUIRED_STAGES: readonly RunStage[] = [
  'discovery',
  'sdd',
  'planning',
  'plan-review',
  'implementation',
  'verification',
  'final-review',
];

/**
 * The run's runtime condition.
 *
 * Order of the checks is the contract. Terminal states first, then the conditions that
 * *override* a persisted status — a run persisted `approved` is `implementing` once a
 * task has started, and one persisted `plan_rejected` is `planning` while a revision is
 * in flight. The persisted status is consulted last, which is precisely the inversion the
 * evidence run needed: it is a record of the last gate reached, not of what is happening.
 */
export function projectRun(input: ProjectionInput): RunProjection {
  const { state } = input;
  const events = input.events ?? [];
  const tasks = state.tasks;

  const progress = projectProgress(state);
  const reviewFreshness = projectReviewFreshness(input);
  const resumable = isResumable(input);

  const base = { resumable, progress, reviewFreshness };

  if (state.status === 'completed') return { ...base, status: 'complete' };
  if (state.status === 'failed') return { ...base, status: 'failed' };

  if (state.status === 'waiting_for_approval') {
    return {
      ...base,
      status: 'awaiting_human_approval',
      gate: {
        gate: 'approval',
        action: 'Review the plan and run `agent-flow approve`',
        tasks: [],
      },
    };
  }

  if (state.status === 'plan_rejected') {
    // `plan_rejected` while a revision is running is the headline defect of C-20: the
    // rejection is real and historical, and the run is not sitting on it.
    const revising = lastEventIndex(events, 'revision_requested') > lastEventIndex(events, 'revision_completed');
    return { ...base, status: revising ? 'planning' : 'plan_rejected_revisable' };
  }

  const exhausted = lastEventIndex(events, 'recovery_exhausted');
  if (exhausted >= 0 && exhausted > lastEventIndex(events, 'task_requeued')) {
    return { ...base, status: 'auto_recovery_exhausted' };
  }

  if (
    lastEventIndex(events, 'recovery_started') >
    Math.max(
      lastEventIndex(events, 'recovery_step_completed'),
      lastEventIndex(events, 'recovery_exhausted'),
    )
  ) {
    return { ...base, status: 'recovering' };
  }

  const correctiveTasks = tasks.filter((task) => isCorrective(task.id));
  if (
    correctiveTasks.length > 0 &&
    correctiveTasks.some((task) => task.state !== 'completed') &&
    lastEventIndex(events, 'corrective_plan_created') >= 0
  ) {
    return { ...base, status: 'correcting' };
  }

  const gate = projectGate(tasks, resumable);
  if (gate !== undefined) return { ...base, status: 'blocked_on_human', gate };

  if (state.stage === 'verification') return { ...base, status: 'verifying' };
  if (state.stage === 'final-review') return { ...base, status: 'reviewing' };
  if (state.stage === 'implementation') return { ...base, status: 'implementing' };

  return { ...base, status: 'planning' };
}

/**
 * Whether there is executable work right now (C-19).
 *
 * Asked of the DAG rather than of a status, because that is the only thing that knows.
 * A run whose only incomplete task sits in `review_required` has no ready task — the
 * DAG admits only `queued` and `ready` — so `Resume` must not be offered, however
 * unfinished the run looks.
 *
 * A run with no plan yet is resumable: planning itself is the work. An invalid graph is
 * *not*, and it is not an exception either — a plan whose DAG cannot be built cannot be
 * scheduled, and reporting that as "resumable" would send a person to a command that
 * will refuse.
 */
export function isResumable(input: ProjectionInput): boolean {
  const { state } = input;
  if (state.status === 'completed' || state.status === 'failed') return false;
  if (state.status === 'waiting_for_approval') return false;
  // A rejected plan is not executable work, however ready its tasks look. Measured on the
  // evidence run: the corrective round it rejected left FIX-001..003 in `plan.json` with no
  // dependencies and **no entry in `state.tasks`**, so the DAG defaults them to `queued`,
  // finds them ready, and reports a rejected plan as resumable. The action there is to
  // revise, and offering `Resume` would run tasks nobody approved.
  if (state.status === 'plan_rejected') return false;

  const nodes = input.nodes;
  if (nodes === undefined || nodes.length === 0) return true;

  const states: TaskStates = Object.fromEntries(state.tasks.map((task) => [task.id, task.state]));

  try {
    return readyTasks(buildDag(nodes), states).length > 0;
  } catch {
    return false;
  }
}

/**
 * Which human gate holds this run, when one does.
 *
 * Only reached when nothing is runnable: a run with ready work is not gated, whatever
 * else is also true of it. Every branch names an action, because a gate a person cannot
 * clear is indistinguishable from a hang.
 */
function projectGate(
  tasks: readonly TaskProgress[],
  resumable: boolean,
): RuntimeGate | undefined {
  if (resumable) return undefined;

  const review = tasks.filter((task) => task.state === 'review_required').map((task) => task.id);
  if (review.length > 0) {
    return {
      gate: 'task_review',
      action: `Review ${review.join(', ')}, then requeue with \`agent-flow retry\` or accept the outcome`,
      tasks: review,
    };
  }

  const blocked = tasks.filter((task) => task.state === 'blocked').map((task) => task.id);
  if (blocked.length > 0) {
    return {
      gate: 'agent_blocked',
      action: `Answer what ${blocked.join(', ')} reported as blocking, then requeue`,
      tasks: blocked,
    };
  }

  const incomplete = tasks.filter((task) => task.state !== 'completed');
  if (tasks.length > 0 && incomplete.length === 0) {
    return {
      gate: 'final_acceptance',
      action: 'Run `agent-flow review`, then accept and merge',
      tasks: [],
    };
  }

  return undefined;
}

/**
 * The three axes, computed from persisted state alone (C-21).
 *
 * Implementation counts *planned* tasks and corrective progress counts corrective ones,
 * which is what stops an appended corrective task from making a reported percentage
 * fall. The workflow axis is stage-based and monotonic by construction: `RUN_STAGES` is
 * ordered, and a run only ever moves forward through it.
 */
export function projectProgress(state: RunState): ProgressAxes {
  const reached = REQUIRED_STAGES.indexOf(state.stage);
  const planned = state.tasks.filter((task) => !isCorrective(task.id));
  const corrective = state.tasks.filter((task) => isCorrective(task.id));

  return {
    workflow: {
      // `+1` because reaching a stage means it is in progress or done; `stage` points at
      // the last stage reached, never at the next one.
      done: reached < 0 ? 0 : reached + 1,
      total: REQUIRED_STAGES.length,
    },
    implementation: {
      done: planned.filter((task) => task.state === 'completed').length,
      total: planned.length,
    },
    ...(corrective.length === 0
      ? {}
      : {
          corrective: {
            done: corrective.filter((task) => task.state === 'completed').length,
            total: corrective.length,
          },
        }),
  };
}

/**
 * Whether the newest review still describes the current state (C-20).
 *
 * Compared against the last stage *start*, because a stage that started after the review
 * was written may already have changed what the review is about. Timestamps rather than
 * event ordering: the review artifact is a file, and the only thing the two records share
 * is a clock.
 */
function projectReviewFreshness(input: ProjectionInput): RunProjection['reviewFreshness'] {
  if (input.reviewWrittenAt === undefined) return 'absent';

  const written = Date.parse(input.reviewWrittenAt);
  if (Number.isNaN(written)) return 'absent';

  const lastStageStart = (input.events ?? [])
    .filter((event) => event.type === 'stage_started')
    .map((event) => Date.parse(event.at))
    .filter((at) => !Number.isNaN(at))
    .at(-1);

  if (lastStageStart === undefined) return 'current';
  return lastStageStart > written ? 'superseded' : 'current';
}

/**
 * The index of the last event of a type, or `-1`.
 *
 * Index rather than timestamp, because several events in one write can share a
 * millisecond and `events.jsonl` is append-only — so position is the ordering that is
 * actually total.
 */
function lastEventIndex(events: readonly RunEvent[], type: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return index;
  }
  return -1;
}

/**
 * Whether a task id is corrective.
 *
 * By id shape, which is the same discriminator `FixTaskIdSchema` already encodes, so a
 * projection over persisted state needs no plan to tell the two apart.
 */
function isCorrective(id: string): boolean {
  return id.startsWith('FIX-');
}
