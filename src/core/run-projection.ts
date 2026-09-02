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

export {
  RUNTIME_STATUSES,
  type ProgressAxes,
  type RunProjection,
  type RuntimeEscalation,
  type RuntimeGate,
  type RuntimeStatus,
} from '../contracts/index.js';
import type {
  ProgressAxes,
  RunProjection,
  RuntimeEscalation,
  RuntimeGate,
} from '../contracts/index.js';

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
  // Before every stage inference below. `cancelled` is terminal, and a chain of `if`s that
  // did not name it would fall through to `implementing` — a stopped run reported as
  // running, with a Resume button on it.
  if (state.status === 'cancelled') return { ...base, status: 'cancelled' };

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
    // C-22: the status is the least of what termination owes the reader.
    return {
      ...base,
      status: 'auto_recovery_exhausted',
      escalation: projectEscalation(events, exhausted),
    };
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
 *
 * **A task left `running` or `interrupted` is resumable work, and asking the DAG alone
 * missed it.** Those two states are what a killed coordinator leaves, and the DAG admits
 * only `queued` and `ready` — so a run crashed mid-graph looked exactly like a run with
 * nothing to do. C-19 then refused `agent-flow run` before the execution lock, which is
 * *before* the recovery that reconciles those tasks: the documented way to resume a
 * crashed run answered "no runnable task in its current state", and every attempt after
 * a crash answered the same. Measured on the wave-graph E2E, where three tasks had
 * integrated and the fourth was in flight.
 *
 * The DAG is still right about what it knows. It knows which tasks are *ready*; it does
 * not know that recovery is about to make one of these runnable, because recovery runs
 * inside `start` and reads durable evidence this projection never sees.
 *
 * A task genuinely running in another process reaches the execution lock and is refused
 * there as `run_busy` — the honest answer, and one this function is not the place to
 * give.
 */
export function isResumable(input: ProjectionInput): boolean {
  const { state } = input;
  if (state.status === 'completed' || state.status === 'failed') return false;
  // Terminal by an operator's decision (PRI-14). Its tasks are deliberately left where
  // they were — `interrupted` for what was running, `queued` for what never started — so
  // both the crash branch below and the DAG would otherwise report this as resumable.
  if (state.status === 'cancelled') return false;
  if (state.status === 'waiting_for_approval') return false;
  // A pause is an operator asking for no new work (PRI-15). The run is resumable in the
  // ordinary sense and must not be *auto*-started, so this reports what a person may do,
  // and `start` refuses until `resume` clears the request.
  if (state.pauseRequestedAt !== undefined) return false;
  // A rejected plan is not executable work, however ready its tasks look. Measured on the
  // evidence run: the corrective round it rejected left FIX-001..003 in `plan.json` with no
  // dependencies and **no entry in `state.tasks`**, so the DAG defaults them to `queued`,
  // finds them ready, and reports a rejected plan as resumable. The action there is to
  // revise, and offering `Resume` would run tasks nobody approved.
  if (state.status === 'plan_rejected') return false;

  const nodes = input.nodes;
  if (nodes === undefined || nodes.length === 0) return true;

  // What a killed coordinator leaves. Checked before the DAG because the DAG cannot see
  // it: recovery decides these, from evidence on disk, inside `start`.
  if (state.tasks.some((task) => task.state === 'running' || task.state === 'interrupted')) {
    return true;
  }

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


/**
 * Assemble the C-22 escalation from the event log (AR-07, AR-08).
 *
 * Nothing is substituted. A run that predates the enrichment carries no counts and no
 * evidence, and it reports none — `attempts: 0` would be a number nobody measured, and a
 * person reading it would act on it.
 */
function projectEscalation(
  events: readonly RunEvent[],
  index: number,
): RuntimeEscalation | undefined {
  const detail = events[index]?.detail;
  if (detail === undefined) return undefined;

  const task = typeof detail['task'] === 'string' ? detail['task'] : '';

  return {
    task,
    failureClass: typeof detail['failureClass'] === 'string' ? detail['failureClass'] : 'unknown',
    counts: numericRecord(detail['counts']),
    evidence: stringList(detail['evidence']),
    attemptedRepairs: repairsFor(events.slice(0, index), task),
    humanAction:
      typeof detail['humanAction'] === 'string' && detail['humanAction'].trim().length > 0
        ? detail['humanAction']
        : 'Read the failed attempt for this task and decide what to change',
  };
}

/**
 * Every repair started for a task, paired with how it ended.
 *
 * A step started and never completed is reported as unresolved rather than omitted: a
 * crash between the two events is exactly the case where under-reporting what the run did
 * would mislead the person cleaning up after it.
 */
function repairsFor(
  before: readonly RunEvent[],
  task: string,
): { step: string; outcome: string }[] {
  const outcomes = new Map<string, string>();
  for (const event of before) {
    if (event.type !== 'recovery_step_completed') continue;
    if (event.detail['task'] !== task) continue;
    const step = event.detail['step'];
    const outcome = event.detail['outcome'];
    if (typeof step === 'string') {
      outcomes.set(step, typeof outcome === 'string' ? outcome : 'completed');
    }
  }

  const repairs: { step: string; outcome: string }[] = [];
  const seen = new Set<string>();
  for (const event of before) {
    if (event.type !== 'recovery_started') continue;
    if (event.detail['task'] !== task) continue;
    const step = event.detail['step'];
    if (typeof step !== 'string' || seen.has(step)) continue;
    seen.add(step);
    repairs.push({ step, outcome: outcomes.get(step) ?? 'did not complete' });
  }

  return repairs;
}

function numericRecord(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
