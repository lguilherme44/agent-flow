import type { RunEvent } from '../contracts/index.js';

/**
 * Where a run's wall clock went.
 *
 * Every number below was already on disk — `events.jsonl` timestamps each stage, each
 * task and each human decision, and `result.json` times each validation command — and
 * nothing summed it. A measured run took 337 minutes, of which the model worked 72; the
 * other 265 were validation, a person at a gate, a provider's quota window and re-runs,
 * and the only way to know that was to read the log by hand.
 *
 * **One instant, one cause.** The decomposition partitions the wall clock, so the six
 * kinds always add up to `wallMs` and a bar drawn from them has no overlap and no hole.
 * Tasks can run concurrently, so two activities can share an instant; it is then counted
 * once, under the first of `model`, `rework`, `validation` that was running. The per-stage
 * and per-task tables do not partition anything: they are raw sums, and under parallelism
 * they can exceed the wall clock, which is the honest answer to "how long did planning
 * take" rather than an error.
 *
 * **Model time is an execution: `stage_started` to the `stage_completed` or `stage_failed`
 * that closes it.** A verdict logged after the execution already closed — the planning
 * check's `stage_failed` that follows a `stage_completed` — is not a second execution and
 * adds no time. An execution belongs to the task its `stage_context_measured` names — any
 * stage, since `code-review` runs once per task too — matched by that name among the open
 * executions so parallel tasks are not crossed; an implementation execution with no
 * measurement falls back to the task most recently started and not yet finished.
 *
 * **Rework is every execution beyond the first of the same stage for the same task** — or of
 * the same stage, for a stage that names no task. Five tasks each reviewed once is five
 * first executions, not one and four re-runs. That is model time and model money only:
 * validation is measured from `result.json`, which holds the attempt that stood, so the
 * validation of a superseded attempt is not known and falls into `other`.
 *
 * **Validation** sits at the end of its task: the interval ending at the task's last
 * `task_finished`, as long as its commands' summed durations, and never starting before the
 * task's last model execution ended.
 *
 * **The gap rule.** Any interval with no model execution and no validation running is a
 * gap, and it is attributed whole, by the first of these that holds:
 *
 *   1. the stage outcome logged last at or before the gap opened is a `stage_failed` whose
 *      `errorCode` is `quota_exceeded` or whose `failureClass` is `runner_quota_exhausted`
 *      → `quota`;
 *   2. the gap opened on a gate — the outcome logged last before it is plan review
 *      finished, planning finished with no review after it, a task ended `blocked` or
 *      `review_required`, its recovery exhausted (an escalation), the plan rejected or the run
 *      cancelled — or the run is paused (a `run_paused` with no `run_resumed` since)
 *      → `human`: nothing moves again until somebody does something, including a gap still
 *      open at `now`;
 *   3. a person acted inside the gap (approved, rejected, revised, resumed, requeued,
 *      amended, or any recorded `operator_action`) → `human`;
 *   4. the orchestrator continued on its own inside the gap (a planning repair, a fallback,
 *      a recovery step) → `other`;
 *   5. the gap opened on any other `stage_failed` — a stop nobody has answered → `human`;
 *   6. otherwise → `other`: worktrees, git, integration, the orchestrator's own seconds.
 *
 * **Quota is first, and it is greedy by design: the time after a quota failure counts as
 * quota until someone restarts the run.** A person typically restarts after the window
 * reopens, and the log cannot say when it did. Gates come before the person's own actions
 * only for the label; both are `human`. They come before rule 4 because recovery logs
 * `recovery_started` before it gives up with `recovery_exhausted`, and an escalation must not
 * read as the orchestrator carrying on. Rule 4 sits before rule 5 so the planning check's own
 * `stage_failed`, which is immediately repaired, is not read as a stop.
 *
 * `pause` is a gate that outlives its event: `run_paused` is logged while a stage is still
 * running, and the run stops only when that stage ends, so the marker is carried forward
 * rather than looked for as the gap's opener.
 *
 * Pure, and it decides nothing: like `telemetry.ts` this describes a run and never steers
 * one. Costs are what the runners reported; an execution that reported none adds nothing,
 * and a run where none did carries no cost fields at all rather than a fabricated zero.
 */

export const TIMELINE_KINDS = ['model', 'validation', 'human', 'quota', 'rework', 'other'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineSegment {
  readonly kind: TimelineKind;
  readonly from: string;
  readonly to: string;
  /** An identifier — a stage, a task, the gate or action — never a sentence. */
  readonly label: string;
}

export interface TimelineStage {
  readonly stage: string;
  /** Executions, counting the first. */
  readonly attempts: number;
  /** Summed over every execution; under parallelism this can exceed the wall clock. */
  readonly modelMs: number;
  /** Absent when no execution of this stage reported a cost. */
  readonly costUsd?: number;
  readonly outputTokens?: number;
}

export interface TimelineCommand {
  readonly command: string;
  readonly durationMs: number;
  readonly exitCode: number;
}

export interface TimelineTask {
  readonly task: string;
  /** Implementation executions, counting the first. */
  readonly attempts: number;
  readonly modelMs: number;
  readonly costUsd?: number;
  readonly validationMs: number;
  readonly commands: readonly TimelineCommand[];
}

export interface RunTimeline {
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly wallMs: number;
  /** First executions only; the rest is `reworkMs`. These six add up to `wallMs`. */
  readonly modelMs: number;
  readonly validationMs: number;
  readonly waitingForHumanMs: number;
  readonly quotaWaitMs: number;
  readonly reworkMs: number;
  readonly otherMs: number;
  /** Every execution's reported cost. Absent when no execution reported one. */
  readonly costUsd?: number;
  readonly modelCostUsd?: number;
  readonly reworkCostUsd?: number;
  /** Some execution has no closing event: it is running, or whatever ran it is gone. */
  readonly inFlight: boolean;
  /**
   * Set by the loader, never by this fold: the run says it is working and has been silent
   * past its stage's budget, so open executions were closed at the last event instead of
   * running on to `now`. Absent otherwise.
   */
  readonly stale?: boolean;
  readonly stages: readonly TimelineStage[];
  readonly tasks: readonly TimelineTask[];
  readonly segments: readonly TimelineSegment[];
}

/** What the timeline needs from a task's `result.json`; `TaskResult` satisfies it. */
export interface TimelineTaskResult {
  readonly task: string;
  readonly finishedAt?: string;
  readonly validation: { readonly commands: readonly TimelineCommand[] };
}

/** People. Any of these inside a gap means a person ended it. */
const HUMAN_ACTIONS = new Set([
  'operator_action',
  'run_approved',
  'run_rejected',
  'revision_requested',
  'run_resumed',
  'task_requeued',
  'amendment_recorded',
]);

/** The orchestrator carrying on by itself after something went wrong. */
const AUTOMATIC_CONTINUATIONS = new Set([
  'planning_repair_requested',
  'fallback_used',
  'recovery_started',
  'recovery_step_completed',
  'task_failure_classified',
  'failure_context_built',
  'corrective_task_created',
  'corrective_plan_created',
]);

/** The events a gap's opener is chosen from: what last happened to a stage, task or run. */
const OUTCOMES = new Set([
  'stage_completed',
  'stage_failed',
  'task_finished',
  'run_rejected',
  'run_cancelled',
  'recovery_exhausted',
  'review_budget_exhausted',
  'planning_refused',
]);

/** Openers that hold the run for a person whatever happens inside the gap. */
const STOPS = new Set([
  'run_rejected',
  'run_cancelled',
  'recovery_exhausted',
  'review_budget_exhausted',
  'planning_refused',
]);

const GATED_TASK_STATUSES = new Set(['blocked', 'review_required']);

const IMPLEMENTATION = 'implementation';

type Busy = 'model' | 'rework' | 'validation';
const PRIORITY: Record<Busy, number> = { model: 0, rework: 1, validation: 2 };

interface Timed {
  readonly event: RunEvent;
  readonly ms: number;
  readonly index: number;
}

interface Execution {
  readonly stage: string;
  task: string | undefined;
  start: number;
  end: number | undefined;
  costUsd: number | undefined;
  outputTokens: number | undefined;
  readonly order: number;
  /** The task came from `stage_context_measured`, so a later measurement never re-labels it. */
  named?: boolean;
}

interface Interval {
  readonly kind: Busy;
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

export function buildRunTimeline(
  events: readonly RunEvent[],
  taskResults: readonly TimelineTaskResult[],
  now?: string,
): RunTimeline {
  const timed: Timed[] = [];
  events.forEach((event, index) => {
    const ms = Date.parse(event.at);
    if (Number.isFinite(ms)) timed.push({ event, ms, index });
  });

  if (timed.length === 0) return emptyTimeline();

  const nowMs = now === undefined ? Number.NaN : Date.parse(now);
  const wallStart = Math.min(...timed.map((entry) => entry.ms));
  const lastEvent = Math.max(...timed.map((entry) => entry.ms));
  const wallEnd = Number.isFinite(nowMs) ? Math.max(lastEvent, nowMs) : lastEvent;

  const { executions, inFlight } = pairExecutions(timed, wallEnd);
  const intervals: Interval[] = [];

  // Attempt numbering, in the order the executions began.
  const seen = new Map<string, number>();
  const rework = new Set<Execution>();
  for (const execution of [...executions].sort((a, b) => a.start - b.start || a.order - b.order)) {
    // Per task whenever a task is named: `code-review` runs once per task, and the review of
    // task two is that task's first, not the stage's second.
    const key = execution.task === undefined ? execution.stage : `${execution.stage}:${execution.task}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) rework.add(execution);
    intervals.push({
      kind: count > 1 ? 'rework' : 'model',
      start: execution.start,
      end: execution.end ?? wallEnd,
      label: labelOf(execution),
    });
  }

  const tasks = taskRows(timed, executions, taskResults, intervals);

  const segments = sweep(intervals, wallStart, wallEnd, timed);

  const sums: Record<TimelineKind, number> = {
    model: 0,
    validation: 0,
    human: 0,
    quota: 0,
    rework: 0,
    other: 0,
  };
  for (const segment of segments) {
    sums[segment.kind] += Date.parse(segment.to) - Date.parse(segment.from);
  }
  const wallMs = wallEnd - wallStart;

  const priced = executions.filter((execution) => execution.costUsd !== undefined);
  const costOf = (list: readonly Execution[]) => list.reduce((total, e) => total + (e.costUsd ?? 0), 0);

  return {
    startedAt: new Date(wallStart).toISOString(),
    endedAt: new Date(wallEnd).toISOString(),
    wallMs,
    modelMs: sums.model,
    validationMs: sums.validation,
    waitingForHumanMs: sums.human,
    quotaWaitMs: sums.quota,
    reworkMs: sums.rework,
    // The remainder, by construction, so the six always add up to the wall clock.
    otherMs: wallMs - sums.model - sums.validation - sums.human - sums.quota - sums.rework,
    ...(priced.length === 0
      ? {}
      : {
          costUsd: costOf(priced),
          modelCostUsd: costOf(priced.filter((execution) => !rework.has(execution))),
          reworkCostUsd: costOf(priced.filter((execution) => rework.has(execution))),
        }),
    inFlight,
    stages: stageRows(executions),
    tasks,
    segments,
  };
}

function emptyTimeline(): RunTimeline {
  return {
    wallMs: 0,
    modelMs: 0,
    validationMs: 0,
    waitingForHumanMs: 0,
    quotaWaitMs: 0,
    reworkMs: 0,
    otherMs: 0,
    inFlight: false,
    stages: [],
    tasks: [],
    segments: [],
  };
}

/**
 * Executions, from the log's own pairs.
 *
 * Interval ends are the events' own timestamps rather than the `startedAt`/`finishedAt` in
 * their detail: the two differ by milliseconds, and using the log's clock is what lets a
 * gap find the event that opened it by time alone.
 */
function pairExecutions(
  timed: readonly Timed[],
  wallEnd: number,
): { executions: Execution[]; inFlight: boolean } {
  const executions: Execution[] = [];
  const open: Execution[] = [];
  const unfinishedTasks: string[] = [];

  for (const { event, ms } of timed) {
    const detail = event.detail;
    const stage = text(detail['stage']);

    if (event.type === 'task_started') {
      const task = text(detail['task']);
      if (task !== undefined) unfinishedTasks.push(task);
      continue;
    }
    if (event.type === 'task_finished') {
      const task = text(detail['task']);
      const at = task === undefined ? -1 : unfinishedTasks.lastIndexOf(task);
      if (at >= 0) unfinishedTasks.splice(at, 1);
      continue;
    }
    if (stage === undefined) continue;

    if (event.type === 'stage_started') {
      const execution: Execution = {
        stage,
        // The fallback, overridden by `stage_context_measured`: the earliest started task that
        // no open implementation already belongs to, which is the order parallel tasks begin.
        task:
          stage === IMPLEMENTATION
            ? unfinishedTasks.find(
                (task) => !open.some((other) => other.stage === IMPLEMENTATION && other.task === task),
              )
            : undefined,
        start: ms,
        end: undefined,
        costUsd: undefined,
        outputTokens: undefined,
        order: executions.length,
      };
      executions.push(execution);
      open.push(execution);
      continue;
    }

    if (event.type === 'stage_context_measured') {
      const task = text(detail['task']);
      if (task === undefined) continue;
      // By name first: under parallel tasks the measurements can arrive in another order than
      // the starts, and the execution already guessed for this task is the right one.
      // Otherwise the earliest unnamed, since measurements follow starts in order.
      const unnamed = open.filter((execution) => execution.stage === stage && !execution.named);
      const target = unnamed.find((execution) => execution.task === task) ?? unnamed[0];
      if (target !== undefined) {
        target.task = task;
        target.named = true;
      }
      continue;
    }

    if (event.type !== 'stage_completed' && event.type !== 'stage_failed') continue;

    const candidates = open.filter((execution) => execution.stage === stage);
    const startedAt = Date.parse(text(detail['startedAt']) ?? '');
    let execution: Execution;

    if (candidates.length > 0) {
      const chosen = Number.isFinite(startedAt)
        ? candidates.reduce((best, next) =>
            Math.abs(next.start - startedAt) < Math.abs(best.start - startedAt) ? next : best,
          )
        : candidates[0]!;
      open.splice(open.indexOf(chosen), 1);
      execution = chosen;
    } else if (Number.isFinite(startedAt)) {
      // A run older than `stage_started`: the outcome carries its own start.
      execution = {
        stage,
        task: undefined,
        start: Math.min(startedAt, ms),
        end: undefined,
        costUsd: undefined,
        outputTokens: undefined,
        order: executions.length,
      };
      executions.push(execution);
    } else {
      // A verdict on an execution that already closed — the planning check's
      // `stage_failed` after `stage_completed`. Not a second execution.
      continue;
    }

    execution.end = ms;
    const usage = detail['usage'];
    if (typeof usage === 'object' && usage !== null) {
      const cost = (usage as Record<string, unknown>)['costUsd'];
      const output = (usage as Record<string, unknown>)['outputTokens'];
      if (typeof cost === 'number' && Number.isFinite(cost)) execution.costUsd = cost;
      if (typeof output === 'number' && Number.isFinite(output)) execution.outputTokens = output;
    }
  }

  // Still running: it ends where the clock does.
  for (const execution of open) execution.end = wallEnd;

  return { executions, inFlight: open.length > 0 };
}

function labelOf(execution: Execution): string {
  return execution.task === undefined ? execution.stage : `${execution.stage} ${execution.task}`;
}

function stageRows(executions: readonly Execution[]): TimelineStage[] {
  const rows = new Map<string, { attempts: number; modelMs: number; cost?: number; output?: number }>();

  for (const execution of executions) {
    const row = rows.get(execution.stage) ?? { attempts: 0, modelMs: 0 };
    row.attempts += 1;
    row.modelMs += Math.max(0, (execution.end ?? execution.start) - execution.start);
    if (execution.costUsd !== undefined) row.cost = (row.cost ?? 0) + execution.costUsd;
    if (execution.outputTokens !== undefined) row.output = (row.output ?? 0) + execution.outputTokens;
    rows.set(execution.stage, row);
  }

  return [...rows].map(([stage, row]) => ({
    stage,
    attempts: row.attempts,
    modelMs: row.modelMs,
    ...(row.cost === undefined ? {} : { costUsd: row.cost }),
    ...(row.output === undefined ? {} : { outputTokens: row.output }),
  }));
}

/**
 * Per-task rows, and the validation intervals they contribute to the sweep.
 *
 * The interval is pushed into `intervals` here because it is placed against the task's own
 * events — the last `task_finished` and the last model execution before it.
 */
function taskRows(
  timed: readonly Timed[],
  executions: readonly Execution[],
  results: readonly TimelineTaskResult[],
  intervals: Interval[],
): TimelineTask[] {
  const order: string[] = [];
  const note = (task: string) => {
    if (!order.includes(task)) order.push(task);
  };

  const finishedAt = new Map<string, number>();
  for (const { event, ms } of timed) {
    const task = text(event.detail['task']);
    if (task === undefined) continue;
    if (event.type === 'task_started') note(task);
    if (event.type === 'task_finished') finishedAt.set(task, ms);
  }

  const implementations = executions.filter((execution) => execution.stage === IMPLEMENTATION);
  for (const execution of implementations) if (execution.task !== undefined) note(execution.task);
  for (const result of results) note(result.task);

  return order.map((task) => {
    const own = implementations.filter((execution) => execution.task === task);
    const result = results.find((candidate) => candidate.task === task);
    const commands = (result?.validation.commands ?? []).map((command) => ({
      command: command.command,
      durationMs: command.durationMs,
      exitCode: command.exitCode,
    }));
    const validationMs = commands.reduce((total, command) => total + command.durationMs, 0);

    const end = finishedAt.get(task) ?? Date.parse(result?.finishedAt ?? '');
    if (validationMs > 0 && Number.isFinite(end)) {
      const floor = Math.max(
        Number.NEGATIVE_INFINITY,
        ...own.map((execution) => execution.end ?? execution.start).filter((value) => value <= end),
      );
      const start = Math.max(end - validationMs, floor);
      if (end > start) intervals.push({ kind: 'validation', start, end, label: task });
    }

    const priced = own.filter((execution) => execution.costUsd !== undefined);
    return {
      task,
      attempts: own.length,
      modelMs: own.reduce((total, e) => total + Math.max(0, (e.end ?? e.start) - e.start), 0),
      ...(priced.length === 0
        ? {}
        : { costUsd: priced.reduce((total, e) => total + (e.costUsd ?? 0), 0) }),
      validationMs,
      commands,
    };
  });
}

/**
 * Walks the wall clock once, between every boundary any interval has, and names each piece.
 */
function sweep(
  intervals: readonly Interval[],
  wallStart: number,
  wallEnd: number,
  timed: readonly Timed[],
): TimelineSegment[] {
  const clamp = (value: number) => Math.min(wallEnd, Math.max(wallStart, value));
  // A resume ends a pause mid-gap, so idle time is cut there and each side judged alone.
  const resumes = new Set(
    timed.filter((entry) => entry.event.type === 'run_resumed').map((entry) => clamp(entry.ms)),
  );
  const points = [
    ...new Set([
      wallStart,
      wallEnd,
      ...resumes,
      ...intervals.flatMap((i) => [clamp(i.start), clamp(i.end)]),
    ]),
  ].sort((a, b) => a - b);

  interface Piece {
    kind: Busy | 'gap';
    label: string;
    from: number;
    to: number;
  }
  const pieces: Piece[] = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to <= from) continue;

    const active = intervals
      .filter((interval) => interval.start <= from && interval.end >= to && interval.end > interval.start)
      .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.start - b.start);
    const top = active[0];
    const kind = top?.kind ?? 'gap';
    const label = top?.label ?? '';

    const last = pieces.at(-1);
    const cut = kind === 'gap' && resumes.has(from);
    if (last !== undefined && !cut && last.kind === kind && last.label === label && last.to === from) {
      last.to = to;
    } else {
      pieces.push({ kind, label, from, to });
    }
  }

  return pieces.map((piece) => {
    const named =
      piece.kind === 'gap'
        ? classifyGap(piece.from, piece.to, timed, resumes.has(piece.from))
        : { kind: piece.kind, label: piece.label };
    return {
      kind: named.kind,
      from: new Date(piece.from).toISOString(),
      to: new Date(piece.to).toISOString(),
      label: named.label,
    };
  });
}

/** The gap rule; see the module comment for why the order is what it is. */
function classifyGap(
  from: number,
  to: number,
  timed: readonly Timed[],
  afterResume = false,
): { kind: TimelineKind; label: string } {
  const before = timed.filter((entry) => entry.ms <= from);
  const lastStageOutcome = before
    .filter((entry) => entry.event.type === 'stage_completed' || entry.event.type === 'stage_failed')
    .at(-1);

  // 1. Quota.
  if (lastStageOutcome !== undefined && isQuota(lastStageOutcome.event)) {
    return { kind: 'quota', label: text(lastStageOutcome.event.detail['stage']) ?? '' };
  }

  const opener = before.filter((entry) => OUTCOMES.has(entry.event.type)).at(-1);

  // 2. A gate opened the gap, or the run is paused.
  const gate = opener === undefined ? undefined : gateOf(opener, timed, to);
  if (gate !== undefined) return { kind: 'human', label: gate };
  if (isPaused(before)) return { kind: 'human', label: 'run_paused' };

  // The resume that opened this piece (and its `operator_action`) ended the previous one;
  // it is not an act inside this one.
  const inside = timed.filter(
    (entry) =>
      entry.ms >= from &&
      entry.ms <= to &&
      !(afterResume && entry.ms === from && HUMAN_ACTIONS.has(entry.event.type)),
  );

  // 3. A person acted.
  // The operator's own verb names the wait best: `revise` says more than `amendment_recorded`.
  const action =
    inside.find((entry) => entry.event.type === 'operator_action') ??
    inside.find((entry) => HUMAN_ACTIONS.has(entry.event.type));
  if (action !== undefined) {
    return {
      kind: 'human',
      label:
        action.event.type === 'operator_action'
          ? (text(action.event.detail['action']) ?? action.event.type)
          : action.event.type,
    };
  }

  // 4. The orchestrator carried on by itself.
  if (inside.some((entry) => AUTOMATIC_CONTINUATIONS.has(entry.event.type))) {
    return { kind: 'other', label: '' };
  }

  // 5. A stage failed and nobody has answered it.
  if (opener?.event.type === 'stage_failed') {
    return { kind: 'human', label: `${text(opener.event.detail['stage']) ?? 'stage'} failed` };
  }

  // 6. Everything else.
  return { kind: 'other', label: '' };
}

function gateOf(opener: Timed, timed: readonly Timed[], gapEnd: number): string | undefined {
  const { event } = opener;
  const stage = text(event.detail['stage']);

  if (STOPS.has(event.type)) return event.type;

  if (event.type === 'task_finished') {
    const status = text(event.detail['status']);
    return status !== undefined && GATED_TASK_STATUSES.has(status)
      ? `${text(event.detail['task']) ?? 'task'} ${status}`
      : undefined;
  }

  if (event.type === 'stage_completed') {
    if (stage === 'plan-review') return 'approval';
    if (stage === 'planning') {
      // Planning is a gate only when neither a review nor another plan follows it: a plan
      // the check turned down is repaired at once, and that gap is the orchestrator's.
      const next = timed.find(
        (entry) => entry.ms >= gapEnd && entry.event.type === 'stage_started',
      );
      const nextStage = next === undefined ? undefined : text(next.event.detail['stage']);
      return nextStage === 'plan-review' || nextStage === 'planning' ? undefined : 'approval';
    }
  }

  return undefined;
}

/** A `run_paused` with no `run_resumed` after it, among the events before the gap. */
function isPaused(before: readonly Timed[]): boolean {
  const last = before
    .filter((entry) => entry.event.type === 'run_paused' || entry.event.type === 'run_resumed')
    .at(-1);
  return last?.event.type === 'run_paused';
}

function isQuota(event: RunEvent): boolean {
  return (
    event.type === 'stage_failed' &&
    (event.detail['errorCode'] === 'quota_exceeded' ||
      event.detail['failureClass'] === 'runner_quota_exhausted')
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
