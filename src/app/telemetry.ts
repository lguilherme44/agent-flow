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
/**
 * A row this fold built and its own schema then refused (D10).
 *
 * **It exists so that dropping one cannot be silent.** The parse used to be
 * `if (parsed.success) entries.push(...)` with no `else`: a row that failed validation was
 * not reported, not counted and not logged — it stopped existing. Measured the hard way,
 * correcting an off-by-one in the repair counter made `repairs` legitimately `0`, the
 * entry's `attempts` field is `min(1)`, every parse failed, and the **telemetry page went
 * blank** with nothing anywhere saying why. Five tests turned red and none of them named
 * the cause.
 *
 * Returned rather than logged, because the app layer has no logger and a read path must
 * not throw: a caller that receives this in its type cannot forget it exists.
 */
export interface DroppedTelemetry {
  readonly kind: 'stage' | 'task';
  /** The stage or task the row was about, so the report names something. */
  readonly subject: string;
  /** Zod's own account of what did not fit. */
  readonly reason: string;
}

export interface TelemetryCollection {
  readonly entries: readonly TelemetryEntry[];
  /** Empty in every healthy run. Non-empty is a contract bug in this fold. */
  readonly dropped: readonly DroppedTelemetry[];
}

export async function collectTelemetry(
  store: StateStore,
  state: RunState,
): Promise<TelemetryCollection> {
  const events = await store.readEventsBestEffort(state.runId);
  const dropped: DroppedTelemetry[] = [];

  const entries = [
    ...stageEntries(state.runId, events, dropped),
    ...(await taskEntries(store, state, events, dropped)),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  return { entries, dropped };
}

/**
 * The usage block on an event's detail, when it carries one that looks like a record.
 *
 * Typed loosely because the detail is `Record<string, unknown>` read off a JSONL file that
 * older runs wrote before this field existed. The schema parse below is the real gate; this
 * only has to avoid throwing on a shape from another era.
 */
function usageOf(detail: Record<string, unknown>): { model?: string } | undefined {
  const usage = detail['usage'];
  return typeof usage === 'object' && usage !== null ? (usage as { model?: string }) : undefined;
}

function stageEntries(
  runId: string,
  events: readonly RunEvent[],
  dropped: DroppedTelemetry[],
): TelemetryEntry[] {
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
      // Configured first, then what the runner said actually answered (PRI-19). The
      // order matters: a pinned model is the operator's declared intent and stays the
      // label, and the fallback is what rescues every run that pinned nothing.
      model: detail['model'] ?? usageOf(detail)?.model,
      reasoning: detail['reasoning'],
      reasoningClamped: detail['reasoningClamped'] ?? false,
      fallback: detail['fallback'],
      startedAt,
      finishedAt,
      durationMs: durationBetween(startedAt, finishedAt),
      status: event.type === 'stage_completed' ? 'completed' : 'failed',
      // A *stage* entry's count is the repair counter, which AR-00 renamed in the event
      // (AR §4.4). `attempts` is the older spelling and is still on disk, so both are
      // read — an existing run's telemetry must not lose a number because a field was
      // renamed. The entry's own field keeps its name; renaming that is a read-model
      // change and belongs to the milestone that owns read models.
      //
      // **Invocations, which is repairs plus the first one.** `repairs` counts re-prompts,
      // so a stage that answered correctly on the first try reports 0 — and this field is
      // `min(1)`. Mapping one straight onto the other made `safeParse` fail and the entry
      // vanish: measured, correcting the repair counter emptied the telemetry page
      // completely, and nothing said why (D10).
      //
      // Events written before that correction are off by one here — their `repairs: 1`
      // meant one attempt and now reads as two. Stated rather than migrated: rewriting an
      // append-only log to make a chart tidier is the worse trade.
      attempts: Number(detail['repairs'] ?? detail['attempts'] ?? 0) + 1,
      ...(detail['errorCode'] === undefined ? {} : { errorCode: detail['errorCode'] }),
      ...(detail['usage'] === undefined ? {} : { usage: detail['usage'] }),
    };

    const parsed = TelemetryEntrySchema.safeParse(candidate);
    if (parsed.success) {
      entries.push(parsed.data);
    } else {
      // Never dropped in silence (D10). A row this fold built and its own schema refused
      // is a contract bug here, not bad data — and the last one emptied the whole page.
      dropped.push({ kind: 'stage', subject: String(detail['stage'] ?? event.type), reason: parsed.error.message });
    }
  }

  return entries;
}

async function taskEntries(
  store: StateStore,
  state: RunState,
  events: readonly RunEvent[],
  dropped: DroppedTelemetry[],
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
      ...(result.model ?? result.usage?.model) === undefined
        ? {}
        : { model: result.model ?? result.usage?.model },
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
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    });

    if (parsed.success) {
      entries.push(parsed.data);
    } else {
      dropped.push({ kind: 'task', subject: task.id, reason: parsed.error.message });
    }
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
