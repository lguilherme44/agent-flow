import {
  TelemetryEntrySchema,
  WorkflowRoleSchema,
  type RunEvent,
  type RunState,
  type TelemetryEntry,
} from '../contracts/index.js';
import { durationBetween } from '../core/telemetry.js';
import type { StateStore } from './state-store.js';

/**
 * Operational telemetry, derived rather than recorded.
 *
 * `TelemetryEntry` existed in the contracts with no producer at all, and the
 * obvious fix — a third file written alongside the state and the event log —
 * would have been the wrong one. Three writers means three things that can
 * disagree, and the two that already exist are the ones that must win.
 *
 * So telemetry is a projection. Stage entries come from the events the stage
 * runner already appends; task entries come from the result files the executor
 * already writes. Delete every derived number and it reappears identically on
 * the next read, because nothing here is stored — which is also why nothing here
 * can be silently wrong about a run.
 *
 * The implementation stage is deliberately absent from the stage entries. It
 * runs once per task, and each of those is already a task entry carrying its
 * own id, validation outcome and provenance; counting both would double every
 * implementation call in every aggregate.
 */
export async function collectTelemetry(
  store: StateStore,
  state: RunState,
): Promise<TelemetryEntry[]> {
  const events = await store.readEvents(state.runId);

  return [
    ...stageEntries(state.runId, events),
    ...(await taskEntries(store, state, events)),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function stageEntries(runId: string, events: readonly RunEvent[]): TelemetryEntry[] {
  const entries: TelemetryEntry[] = [];

  for (const event of events) {
    if (event.type !== 'stage_completed' && event.type !== 'stage_failed') continue;

    const detail = event.detail;
    const stage = detail['stage'];
    if (stage === 'implementation') continue;

    const startedAt = text(detail['startedAt']);
    const finishedAt = text(detail['finishedAt']) ?? event.at;
    // Events written before provenance was recorded on them. Skipped rather
    // than filled in: an entry inventing a runner or an effort is worse than a
    // gap, because a gap is visibly a gap.
    if (startedAt === undefined) continue;

    const candidate = {
      runId,
      kind: 'stage' as const,
      stage,
      role: detail['role'],
      runner: detail['runner'],
      model: detail['model'],
      reasoning: detail['reasoning'],
      reasoningClamped: detail['reasoningClamped'] ?? false,
      fallback: detail['fallback'],
      startedAt,
      finishedAt,
      durationMs: durationBetween(startedAt, finishedAt),
      status: event.type === 'stage_completed' ? 'completed' : 'failed',
      attempts: detail['attempts'] ?? 1,
      ...(detail['errorCode'] === undefined ? {} : { errorCode: detail['errorCode'] }),
    };

    const parsed = TelemetryEntrySchema.safeParse(candidate);
    if (parsed.success) entries.push(parsed.data);
  }

  return entries;
}

async function taskEntries(
  store: StateStore,
  state: RunState,
  events: readonly RunEvent[],
): Promise<TelemetryEntry[]> {
  const roles = rolesOf(events);
  const entries: TelemetryEntry[] = [];

  for (const task of state.tasks) {
    const result = await store.readTaskResult(state.runId, task.id);
    if (result === null) continue;

    // The role is the router's decision, recorded when the task started. A task
    // whose start was never logged has no role to report, and guessing one from
    // its complexity would be reporting a routing decision nobody made.
    const role = roles.get(task.id);
    if (role === undefined) continue;

    const parsed = TelemetryEntrySchema.safeParse({
      runId: state.runId,
      kind: 'task',
      stage: 'implementation',
      taskId: result.task,
      role,
      runner: result.runner,
      ...(result.model === undefined ? {} : { model: result.model }),
      reasoning: result.reasoning,
      reasoningClamped: result.reasoningClamped,
      ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: durationBetween(result.startedAt, result.finishedAt),
      status: result.status,
      // Attempts live on the run, not on the result: a retried task overwrites
      // its own file, so the count of tries is only knowable from the state.
      attempts: Math.max(1, task.attempts),
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    });

    if (parsed.success) entries.push(parsed.data);
  }

  return entries;
}

/** Task id → the role the router chose, from `task_started`. */
function rolesOf(events: readonly RunEvent[]): Map<string, string> {
  const roles = new Map<string, string>();

  for (const event of events) {
    if (event.type !== 'task_started') continue;

    const task = text(event.detail['task']);
    const role = WorkflowRoleSchema.safeParse(event.detail['role']);
    if (task !== undefined && role.success) roles.set(task, role.data);
  }

  return roles;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
