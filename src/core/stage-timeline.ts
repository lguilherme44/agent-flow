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

  for (const event of events) {
    const stage = event.detail['stage'];
    if (typeof stage !== 'string') continue;
    if (event.type === 'stage_completed') completed.set(stage, event);
    if (event.type === 'stage_failed') failed.set(stage, event);
  }

  return PIPELINE_STAGES.map((stage) => {
    if (stage === 'approval') return approvalView(state);
    if (stage === 'implementation') return implementationView(state);

    const done = completed.get(stage);
    if (done !== undefined) return executedView(stage, done, 'completed');

    const broke = failed.get(stage);
    if (broke !== undefined) return executedView(stage, broke, 'failed');

    const running = state.stage === stage && state.status === 'running';
    return { stage, status: running ? 'running' : 'pending' };
  });
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
