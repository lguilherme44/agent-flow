import {
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineStatus,
  type ReasoningLevel,
  type RunEvent,
  type RunState,
  type TaskState,
} from '../contracts/index.js';

export interface StageView {
  readonly stage: PipelineStage;
  readonly status: PipelineStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  /** What actually ran. Absent for stages that have not run, and for approval. */
  readonly runner?: string;
  readonly model?: string;
  readonly reasoning?: ReasoningLevel;
  readonly attempts?: number;
  readonly errorCode?: string;
  /** Why a `cached` stage was reused. Absent for every other status. */
  readonly reuseReason?: string;
}

/**
 * Reads the pipeline out of the run's own record, and invents nothing.
 *
 * Derived rather than stored, for the reason `status` already derives its
 * progress list from events: `state.stage` is initialised to `discovery` before
 * discovery runs and set to `discovery` again when it finishes, so "about to
 * start" and "finished" are the identical byte on disk. Only the event log
 * distinguishes them.
 *
 * Pure. The server renders this; it does not decide it. A UI that computed stage
 * status from a run's fields would be a second state machine, disagreeing with
 * the first the moment either changed.
 */
export function buildStageTimeline(
  events: readonly RunEvent[],
  state: RunState,
): StageView[] {
  const completed = new Map<string, RunEvent>();
  const failed = new Map<string, RunEvent>();
  const reused = new Map<string, RunEvent>();
  const started = new Map<string, RunEvent>();

  for (const event of events) {
    const stage = event.detail['stage'];
    if (typeof stage !== 'string') continue;
    if (event.type === 'stage_started') started.set(stage, event);
    if (event.type === 'stage_completed') completed.set(stage, event);
    if (event.type === 'stage_failed') failed.set(stage, event);
    if (event.type === 'stage_reused') reused.set(stage, event);
  }

  return PIPELINE_STAGES.map((stage) => {
    if (stage === 'approval') return approvalView(state);
    if (stage === 'implementation') return implementationView(state);

    const done = completed.get(stage);
    if (done !== undefined) return executedView(stage, done, 'completed');

    const broke = failed.get(stage);
    if (broke !== undefined) return executedView(stage, broke, 'failed');

    // Reuse is checked after the terminal outcomes and before `started`: a stage
    // reused earlier and then genuinely re-run in a later revision is described by
    // what it did the second time, not by the shortcut it took the first.
    const fromCache = reused.get(stage);
    if (fromCache !== undefined) return reusedView(stage, fromCache);

    // Running is read from the log *as well as* from `state.stage`, because
    // neither source covers the other's blind spot.
    //
    // `state.stage` alone lags: a run observed mid-flight had it reading
    // `architecture-impact` while the log was already inside `sdd`, and the
    // pipeline showed the stage that was actively generating as `pending`. A
    // `stage_started` with no `stage_completed`, `stage_failed` or `stage_reused`
    // after it is exactly the stage in flight, whether or not the state file has
    // caught up.
    //
    // The log alone is not enough either: between `createRun` and the first
    // `stage_started` there are no events at all, and `state.stage` is the only
    // thing that knows a run has begun. Hence the union — the event wins when it
    // exists, the field answers when nothing has been written yet.
    const begun = started.get(stage);
    if (state.status === 'running' && (begun !== undefined || state.stage === stage)) {
      if (begun === undefined) return { stage, status: 'running' };
      return {
        stage,
        status: 'running',
        startedAt: text(begun.detail['startedAt']) ?? begun.at,
        ...(text(begun.detail['runner']) === undefined
          ? {}
          : { runner: text(begun.detail['runner']) as string }),
        ...(text(begun.detail['model']) === undefined
          ? {}
          : { model: text(begun.detail['model']) as string }),
        ...(text(begun.detail['reasoning']) === undefined
          ? {}
          : { reasoning: text(begun.detail['reasoning']) as ReasoningLevel }),
      };
    }

    return { stage, status: 'pending' };
  });
}

/**
 * A stage satisfied by an artifact that already existed.
 *
 * Carries no duration on purpose: nothing ran, and a duration would invite the
 * reader to compare it with stages that did.
 */
function reusedView(stage: PipelineStage, event: RunEvent): StageView {
  return {
    stage,
    status: 'cached',
    finishedAt: event.at,
    ...(text(event.detail['reason']) === undefined
      ? {}
      : { reuseReason: text(event.detail['reason']) as string }),
  };
}

function executedView(
  stage: PipelineStage,
  event: RunEvent,
  status: 'completed' | 'failed',
): StageView {
  const startedAt = text(event.detail['startedAt']);
  const finishedAt = text(event.detail['finishedAt']) ?? event.at;

  return {
    stage,
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    finishedAt,
    ...(startedAt === undefined
      ? {}
      : { durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) }),
    ...(text(event.detail['runner']) === undefined
      ? {}
      : { runner: text(event.detail['runner']) as string }),
    ...(text(event.detail['model']) === undefined
      ? {}
      : { model: text(event.detail['model']) as string }),
    ...(text(event.detail['reasoning']) === undefined
      ? {}
      : { reasoning: text(event.detail['reasoning']) as ReasoningLevel }),
    // `repairs` since AR-00 renamed StageRunner's internal counter (AR §4.4);
    // `attempts` is the spelling on every event written before that, and reading both
    // is what keeps an existing run's timeline intact. The view's own field name is
    // unchanged, so no surface moves.
    ...(typeof event.detail['repairs'] === 'number'
      ? { attempts: event.detail['repairs'] }
      : typeof event.detail['attempts'] === 'number'
        ? { attempts: event.detail['attempts'] }
        : {}),
    ...(text(event.detail['errorCode']) === undefined
      ? {}
      : { errorCode: text(event.detail['errorCode']) as string }),
  };
}

/**
 * Approval reads the gate, and only the gate.
 *
 * `approved` is a fact the StateStore owns; everything here is a rendering of
 * it. Note that a plan can be waiting for approval more than once — a corrective
 * round reopens the gate — so this is deliberately a function of the current
 * state rather than of whether approval ever happened.
 */
function approvalView(state: RunState): StageView {
  if (state.approved) {
    return {
      stage: 'approval',
      status: 'completed',
      ...(state.approvedAt === undefined ? {} : { finishedAt: state.approvedAt }),
    };
  }

  if (state.status === 'waiting_for_approval') {
    return { stage: 'approval', status: 'waiting_approval' };
  }

  if (state.status === 'plan_rejected') return { stage: 'approval', status: 'failed' };

  return { stage: 'approval', status: 'pending' };
}

/**
 * Implementation is the only stage whose progress lives in the tasks.
 *
 * It runs once per task, so a single stage event cannot describe it: a run with
 * one failed task among nine completed ones is not "completed", and the event
 * log would say so nine times over.
 */
function implementationView(state: RunState): StageView {
  if (state.tasks.length === 0) return { stage: 'implementation', status: 'pending' };

  const states = new Set<TaskState>(state.tasks.map((task) => task.state));

  const status: PipelineStatus = states.has('running')
    ? 'running'
    : states.has('failed')
      ? 'failed'
      : states.has('blocked') || states.has('review_required')
        ? 'blocked'
        : [...states].every((value) => value === 'completed')
          ? 'completed'
          : 'pending';

  return { stage: 'implementation', status };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
