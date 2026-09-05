import type { RunEvent } from '@contracts/index.js';
import { ms } from './time';

/**
 * The audit log, folded into something a person can scrub.
 *
 * **This module decides nothing.** It reads `events.jsonl` — the trail the workflow already
 * writes, with a timestamp on every line — and turns "these lines happened" into "this
 * stage ran from here to here", "this task's second attempt ended like this", "a person
 * approved the plan at this instant". Every span and every marker below is a line of the
 * log with its `at` read off; none of them is a verdict this app reached.
 *
 * What it produces is *history*. The state of the run **now** is the server's to answer,
 * and the run page asks `/tasks`, `/stages` and `/control` for it. The fold is for the
 * playhead: drag it back, and the screen shows what the log said was true at that instant.
 * Where the two could disagree — a task the log calls `running` whose attempt never wrote
 * an end — the fold says `unknown` rather than guessing, and the live read wins.
 *
 * Pure, and typed against the open `RunEvent` contract. An event type this file has never
 * seen becomes a plain marker with the type as its label; it is never dropped, because a
 * timeline with a hole where something happened is the failure a recorder exists to
 * prevent.
 */

export type SpanOutcome = 'running' | 'completed' | 'failed' | 'reused' | 'unknown';

export interface StageSpan {
  readonly stage: string;
  readonly startedAt: number;
  /** Absent while the stage is still open at the end of the log. */
  readonly endedAt?: number;
  readonly outcome: SpanOutcome;
  readonly runner?: string;
  readonly model?: string;
  readonly role?: string;
}

export interface AttemptSpan {
  readonly task: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  /**
   * The `status` the log wrote on `task_finished`, verbatim, or `running` / `unknown`.
   *
   * A string rather than `TaskState` on purpose: the fold carries what the file says and
   * does not enumerate what a task may be. Rendering maps it to a tone in one place.
   */
  readonly outcome: string;
  readonly runner?: string;
  readonly validationPassed?: boolean;
}

export type MarkerKind =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'revision'
  | 'assigned'
  | 'validated'
  | 'integrated'
  | 'requeued'
  | 'unblocked'
  | 'recovery'
  | 'exhausted'
  | 'finding'
  | 'gate'
  | 'degradation'
  | 'corrective'
  | 'forge'
  | 'lock'
  | 'other';

export interface Marker {
  readonly at: number;
  readonly kind: MarkerKind;
  readonly task?: string;
  readonly stage?: string;
  readonly event: RunEvent;
  /** Position in the log, so two markers at one instant keep a stable order. */
  readonly index: number;
}

export interface Timeline {
  readonly start: number;
  readonly end: number;
  readonly stages: readonly StageSpan[];
  readonly attempts: readonly AttemptSpan[];
  readonly markers: readonly Marker[];
  /** Tasks in the order the log first mentioned them. */
  readonly tasks: readonly string[];
  readonly events: readonly (RunEvent & { readonly at_ms: number; readonly index: number })[];
}

type Stamped = RunEvent & { readonly at_ms: number; readonly index: number };

function stamp(events: readonly RunEvent[]): Stamped[] {
  const out: Stamped[] = [];
  events.forEach((event, index) => {
    const at = ms(event.at);
    if (at !== undefined) out.push({ ...event, at_ms: at, index });
  });
  return out.sort((a, b) => a.at_ms - b.at_ms || a.index - b.index);
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

function taskOf(event: RunEvent): string | undefined {
  return text(event.detail['task']) ?? text(event.detail['taskId']);
}

const MARKERS: Readonly<Record<string, MarkerKind>> = {
  run_created: 'created',
  run_approved: 'approved',
  run_rejected: 'rejected',
  revision_requested: 'revision',
  revision_completed: 'revision',
  task_assigned: 'assigned',
  reviewer_assigned: 'assigned',
  task_attempt_validated: 'validated',
  task_attempt_marker_created: 'validated',
  task_integrated: 'integrated',
  task_requeued: 'requeued',
  task_unblocked: 'unblocked',
  recovery_started: 'recovery',
  recovery_step_completed: 'recovery',
  failure_context_built: 'recovery',
  recovery_exhausted: 'exhausted',
  finding_raised: 'finding',
  quality_gate_evaluated: 'gate',
  degradation_detected: 'degradation',
  corrective_task_created: 'corrective',
  corrective_plan_created: 'corrective',
  corrective_envelope_evaluated: 'corrective',
  execution_lock_acquired: 'lock',
  execution_lock_released: 'lock',
};

/** Types that open or close a span; they are drawn as bars, not ticks. */
const SPAN_TYPES = new Set([
  'stage_started',
  'stage_completed',
  'stage_failed',
  'stage_output_received',
  'stage_reused',
  'task_started',
  'task_finished',
  'task_interrupted',
]);

/** Noise for a timeline: one per stage, always, and it says nothing a person scrubs to. */
const SILENT = new Set(['stage_context_measured', 'planning_base_observation']);

export function buildTimeline(events: readonly RunEvent[], now: number): Timeline {
  const stamped = stamp(events);
  const first = stamped[0];
  const last = stamped[stamped.length - 1];

  const stages: StageSpan[] = [];
  const openStage = new Map<string, number>(); // stage → index into `stages`
  const lastStage = new Map<string, number>(); // stage → newest span, open or closed
  const attempts: AttemptSpan[] = [];
  const openAttempt = new Map<string, number>(); // task → index into `attempts`
  const attemptCount = new Map<string, number>();
  const markers: Marker[] = [];
  const tasks: string[] = [];
  const seenTask = (task: string | undefined): void => {
    if (task !== undefined && !tasks.includes(task)) tasks.push(task);
  };

  for (const event of stamped) {
    const stage = text(event.detail['stage']);
    const task = taskOf(event);
    seenTask(task);

    switch (event.type) {
      case 'stage_started': {
        if (stage === undefined) break;
        const open = openStage.get(stage);
        if (open !== undefined) {
          const previous = stages[open];
          if (previous !== undefined) stages[open] = { ...previous, endedAt: event.at_ms, outcome: 'unknown' };
        }
        openStage.set(stage, stages.length);
        lastStage.set(stage, stages.length);
        stages.push({
          stage,
          startedAt: event.at_ms,
          outcome: 'running',
          ...(text(event.detail['runner']) === undefined ? {} : { runner: text(event.detail['runner']) as string }),
          ...(text(event.detail['model']) === undefined ? {} : { model: text(event.detail['model']) as string }),
          ...(text(event.detail['role']) === undefined ? {} : { role: text(event.detail['role']) as string }),
        });
        break;
      }
      case 'stage_completed':
      case 'stage_output_received':
      case 'stage_failed': {
        if (stage === undefined) break;
        const outcome: SpanOutcome = event.type === 'stage_failed' ? 'failed' : 'completed';
        const open = openStage.get(stage);
        if (open !== undefined) {
          const span = stages[open];
          if (span !== undefined) {
            stages[open] = {
              ...span,
              endedAt: event.at_ms,
              // A failure after a completion at the same instant is the one that matters:
              // the runner answered, and the answer was refused.
              outcome: span.outcome === 'failed' ? 'failed' : outcome,
              ...(span.runner === undefined && text(event.detail['runner']) !== undefined
                ? { runner: text(event.detail['runner']) as string }
                : {}),
              ...(span.model === undefined && text(event.detail['model']) !== undefined
                ? { model: text(event.detail['model']) as string }
                : {}),
            };
          }
          openStage.delete(stage);
          break;
        }

        // No span is open for this stage. Two honest readings remain.
        //
        // The runner answered and the answer was refused: `stage_completed` closed the
        // span an instant ago and `stage_failed` now describes the *same* run of the
        // stage, so the bar it already drew turns red rather than a second bar appearing
        // out of nothing. That is the shape `stage_output_received` was introduced to
        // spell out; logs written before it still carry the pair.
        const newest = lastStage.get(stage);
        const closed = newest === undefined ? undefined : stages[newest];
        if (outcome === 'failed' && closed !== undefined && closed.endedAt !== undefined) {
          stages[newest as number] = { ...closed, outcome: 'failed' };
          break;
        }

        // Otherwise a completion with no start in the log — a legacy line, or a start the
        // cap cut. Drawn from its own `startedAt` when it has one, so the bar is not lost.
        const startedAt = ms(text(event.detail['startedAt'])) ?? event.at_ms;
        lastStage.set(stage, stages.length);
        stages.push({
          stage,
          startedAt,
          endedAt: event.at_ms,
          outcome,
          ...(text(event.detail['runner']) === undefined ? {} : { runner: text(event.detail['runner']) as string }),
          ...(text(event.detail['model']) === undefined ? {} : { model: text(event.detail['model']) as string }),
        });
        break;
      }
      case 'stage_reused': {
        if (stage === undefined) break;
        lastStage.set(stage, stages.length);
        stages.push({ stage, startedAt: event.at_ms, endedAt: event.at_ms, outcome: 'reused' });
        break;
      }
      case 'task_started': {
        if (task === undefined) break;
        const open = openAttempt.get(task);
        if (open !== undefined) {
          const previous = attempts[open];
          if (previous !== undefined) attempts[open] = { ...previous, endedAt: event.at_ms, outcome: 'unknown' };
        }
        const n = (attemptCount.get(task) ?? 0) + 1;
        attemptCount.set(task, n);
        openAttempt.set(task, attempts.length);
        attempts.push({ task, attempt: n, startedAt: event.at_ms, outcome: 'running' });
        break;
      }
      case 'task_interrupted': {
        // The machine stopped, or the attempt limit did: the attempt ended here, and the
        // log says so in its own word. Without this case the bar ran on until the next
        // start overwrote it as `unknown` — four hours of a task that had stopped in nine.
        if (task === undefined) break;
        const open = openAttempt.get(task);
        if (open !== undefined) {
          const span = attempts[open];
          if (span !== undefined) attempts[open] = { ...span, endedAt: event.at_ms, outcome: 'interrupted' };
          openAttempt.delete(task);
        }
        break;
      }
      case 'task_finished': {
        if (task === undefined) break;
        const open = openAttempt.get(task);
        const outcome = text(event.detail['status']) ?? 'unknown';
        const runner = text(event.detail['runner']);
        const validationPassed = event.detail['validationPassed'];
        const patch = {
          endedAt: event.at_ms,
          outcome,
          ...(runner === undefined ? {} : { runner }),
          ...(typeof validationPassed === 'boolean' ? { validationPassed } : {}),
        };
        if (open !== undefined) {
          const span = attempts[open];
          if (span !== undefined) attempts[open] = { ...span, ...patch };
          openAttempt.delete(task);
        } else {
          const n = (attemptCount.get(task) ?? 0) + 1;
          attemptCount.set(task, n);
          attempts.push({ task, attempt: n, startedAt: event.at_ms, ...patch });
        }
        break;
      }
      default:
        break;
    }

    if (SPAN_TYPES.has(event.type) || SILENT.has(event.type)) continue;
    markers.push({
      at: event.at_ms,
      kind: MARKERS[event.type] ?? (event.type.startsWith('forge_') ? 'forge' : 'other'),
      ...(task === undefined ? {} : { task }),
      ...(stage === undefined ? {} : { stage }),
      event,
      index: event.index,
    });
  }

  const start = first?.at_ms ?? now;
  const end = Math.max(last?.at_ms ?? now, start);

  return { start, end, stages, attempts, markers, tasks, events: stamped };
}

/**
 * What the log said was true at `t`.
 *
 * Folds only lines at or before `t`. The task's `state` is the last status the log wrote
 * for it — `running` after a start, the `task_finished` status after an end, `queued`
 * after a requeue, `ready` after an unblock — and `unknown` for a task the plan named that
 * no line has mentioned yet.
 */
export interface StateAt {
  readonly at: number;
  readonly approved: boolean;
  readonly rejected: boolean;
  readonly revision: number;
  readonly tasks: ReadonlyMap<string, { readonly state: string; readonly attempt: number; readonly since: number; readonly agent?: string }>;
  readonly stages: ReadonlyMap<string, SpanOutcome>;
  /** How many log lines are at or before `t`. */
  readonly seen: number;
}

export function stateAt(timeline: Timeline, t: number): StateAt {
  const tasks = new Map<string, { state: string; attempt: number; since: number; agent?: string }>();
  const stages = new Map<string, SpanOutcome>();
  let approved = false;
  let rejected = false;
  let revision = 0;
  let seen = 0;

  for (const event of timeline.events) {
    if (event.at_ms > t) break;
    seen += 1;
    const task = taskOf(event);
    const stage = text(event.detail['stage']);

    switch (event.type) {
      case 'run_approved':
        approved = true;
        rejected = false;
        break;
      case 'run_rejected':
        rejected = true;
        break;
      case 'revision_requested':
        approved = false;
        revision = typeof event.detail['attemptedRevision'] === 'number' ? event.detail['attemptedRevision'] : revision + 1;
        break;
      case 'stage_started':
        if (stage !== undefined) stages.set(stage, 'running');
        break;
      case 'stage_completed':
      case 'stage_output_received':
        if (stage !== undefined && stages.get(stage) !== 'failed') stages.set(stage, 'completed');
        break;
      case 'stage_failed':
        if (stage !== undefined) stages.set(stage, 'failed');
        break;
      case 'stage_reused':
        if (stage !== undefined) stages.set(stage, 'reused');
        break;
      case 'task_started': {
        if (task === undefined) break;
        const previous = tasks.get(task);
        tasks.set(task, {
          state: 'running',
          attempt: (previous?.attempt ?? 0) + 1,
          since: event.at_ms,
          ...(previous?.agent === undefined ? {} : { agent: previous.agent }),
        });
        break;
      }
      case 'task_finished':
      case 'task_interrupted': {
        if (task === undefined) break;
        const previous = tasks.get(task);
        tasks.set(task, {
          state: event.type === 'task_interrupted' ? 'interrupted' : text(event.detail['status']) ?? 'unknown',
          attempt: previous?.attempt ?? 1,
          since: event.at_ms,
          ...(previous?.agent === undefined ? {} : { agent: previous.agent }),
        });
        break;
      }
      case 'task_requeued':
      case 'task_unblocked': {
        if (task === undefined) break;
        const previous = tasks.get(task);
        tasks.set(task, {
          state: event.type === 'task_requeued' ? 'queued' : 'ready',
          attempt: previous?.attempt ?? 0,
          since: event.at_ms,
          ...(previous?.agent === undefined ? {} : { agent: previous.agent }),
        });
        break;
      }
      case 'task_assigned': {
        if (task === undefined) break;
        const previous = tasks.get(task);
        const agent = text(event.detail['agentName']) ?? text(event.detail['agent']) ?? text(event.detail['agentId']);
        tasks.set(task, {
          state: previous?.state ?? 'queued',
          attempt: previous?.attempt ?? 0,
          since: previous?.since ?? event.at_ms,
          ...(agent === undefined ? {} : { agent }),
        });
        break;
      }
      default:
        break;
    }
  }

  return { at: t, approved, rejected, revision, tasks, stages, seen };
}

/** The nearest event instant at or before / after `t`, for keyboard stepping. */
export function neighbour(timeline: Timeline, t: number, direction: -1 | 1): number | undefined {
  const instants = timeline.events.map((event) => event.at_ms);
  if (direction < 0) {
    for (let index = instants.length - 1; index >= 0; index -= 1) {
      const at = instants[index];
      if (at !== undefined && at < t) return at;
    }
    return undefined;
  }
  for (const at of instants) if (at > t) return at;
  return undefined;
}
