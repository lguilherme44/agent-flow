import { en, type Phrases } from './phrases/index.js';
import type {
  AttentionItem,
  AttentionKind,
  AttentionPriority,
  DeliveryView,
  Degradation,
  IntegrationConflictView,
  QualityGateResult,
  ReviewView,
  RunEvent,
  RunProjection,
  TaskSummaryView,
  TeamView,
} from '../contracts/index.js';

/**
 * Of everything true right now, what should a person act on first (M8 §4).
 *
 * Every projection this repository has answers one question well. None of them answers
 * that one, and the dashboard's eight correct panels are exactly the reason: each is right,
 * and together they leave the ordering to whoever is reading. An operator opening the page
 * at 09:00 has to scan a review panel, a delivery panel, a task table and a gate list
 * before learning that the run has been sitting at an approval gate since yesterday.
 *
 * **Nothing here is persisted.** There is no `attention: true`. Every item below is a fold
 * over facts something else already decided, and the moment the fact changes the item is
 * gone — which is also why there is no dismiss: a failed gate that a person could close is
 * a failed gate nobody sees the second time.
 *
 * **The ladder is a policy, not a truth.** P0–P4 is a judgment made once, in one place,
 * with no evidence behind it yet. It is deterministic — an LLM-ranked queue reorders
 * between two reads of identical facts, and reproducibility is the property that makes
 * "this moved to the top" mean something — and it is in one function so that evidence can
 * change it.
 *
 * Pure. No clock, no I/O, no React.
 */

export interface AttentionInput {
  readonly runId: string;
  readonly runtime: RunProjection;
  readonly tasks: readonly TaskSummaryView[];
  /** Persisted run facts the projection does not carry. */
  readonly run: {
    readonly updatedAt: string;
    readonly pauseRequestedAt?: string;
    readonly degradations: readonly Degradation[];
    readonly integrationConflicts: readonly IntegrationConflictView[];
  };
  readonly review?: ReviewView;
  readonly team?: TeamView;
  readonly delivery?: DeliveryView;
  /** Append-only, in order. Read for `since` only — never for a verdict. */
  readonly events: readonly RunEvent[];
  /**
   * The language every sentence below is written in. English when absent.
   *
   * The queue is browser-only — nothing in `src/cli` projects it — but the default is
   * still English, so a caller that forgets gets the language the rest of the product
   * speaks rather than whichever book happened to be imported first.
   */
  readonly say?: Phrases;
}

/** The ladder. One place, so evidence can move it. */
const PRIORITY: Readonly<Record<AttentionKind, AttentionPriority>> = {
  remote_diverged: 'P0',
  integration_conflict: 'P0',
  ownership_conflict: 'P0',

  approval_required: 'P1',
  task_review_required: 'P1',
  agent_blocked: 'P1',
  recovery_exhausted: 'P1',

  task_failed: 'P2',
  required_gate_failed: 'P2',
  required_gate_not_run: 'P2',
  blocking_finding_open: 'P2',
  delivery_failed: 'P2',
  remote_checks_red: 'P2',

  review_stale: 'P3',
  capacity_starvation: 'P3',
  run_paused: 'P3',
  degradation_recorded: 'P3',

  checks_pending: 'P4',
  delivery_not_published: 'P4',
};

const RANK: Readonly<Record<AttentionPriority, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

export function projectAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [
    ...integrityItems(input),
    ...humanGateItems(input),
    ...failureItems(input),
    ...degradedItems(input),
    ...informationalItems(input),
  ];

  return sortAttention(items);
}

/**
 * Deterministic order: priority, then oldest, then scope.
 *
 * The third key exists so two items of the same kind raised in the same millisecond — one
 * write, several tasks — cannot swap places between reads. A queue that reorders on its own
 * is a queue whose top row nobody trusts.
 */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const byPriority = RANK[a.priority] - RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    if (a.since !== b.since) return a.since < b.since ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ─── P0 — acting wrongly here loses work ──────────────────────────────────── */

function integrityItems(input: AttentionInput): AttentionItem[] {
  const say = input.say ?? en;
  const items: AttentionItem[] = [];
  const { runId } = input;

  if (input.delivery?.state === 'remote_diverged') {
    items.push(
      item({
        kind: 'remote_diverged',
        runId,
        what: say.attention.remoteDiverged,
        // Publishing again would guess which history is right, and one of the two has
        // somebody's work in it. That is why this outranks a human gate.
        why: input.delivery.detail,
        since: input.delivery.syncedAt ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.inspectRemote, destructive: false },
        focus: 'delivery',
      }),
    );
  }

  for (const conflict of input.run.integrationConflicts) {
    items.push(
      item({
        kind: 'integration_conflict',
        runId,
        taskId: conflict.task,
        what: say.attention.couldNotMerge(conflict.task),
        why:
          conflict.previouslyIntegrated === undefined
            ? say.attention.conflictingPaths(conflict.paths.join(', '))
            : say.attention.integratedFirst(conflict.previouslyIntegrated, conflict.paths.join(', ')),
        since: lastEventAt(input.events, 'task_integration_conflict') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.open(conflict.task), destructive: false },
        focus: 'task',
      }),
    );
  }

  // An ownership deferral that has outlived the wave it was raised in is no longer the
  // scheduler waiting its turn — two agents want the same exclusive area and neither is
  // giving it up. Only raised for a task that is still not running.
  for (const deferral of input.team?.deferrals ?? []) {
    if (deferral.reason !== 'ownership') continue;
    const task = input.tasks.find((candidate) => candidate.id === deferral.taskId);
    if (task === undefined || task.state === 'completed' || task.state === 'running') continue;
    items.push(
      item({
        kind: 'ownership_conflict',
        runId,
        taskId: deferral.taskId,
        what: say.attention.heldByOwnership(deferral.taskId),
        why: deferral.detail,
        since: lastEventAt(input.events, 'wave_deferred_for_ownership') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.reviewOwnership, destructive: false },
        focus: 'team',
      }),
    );
  }

  return items;
}

/* ─── P1 — a person is the only thing between the run and progress ─────────── */

function humanGateItems(input: AttentionInput): AttentionItem[] {
  const say = input.say ?? en;
  const items: AttentionItem[] = [];
  const { runId, runtime } = input;

  if (runtime.status === 'awaiting_human_approval') {
    items.push(
      item({
        kind: 'approval_required',
        runId,
        what: say.attention.planWaiting,
        why: runtime.gate?.action ?? say.attention.nothingRunsUntilGate,
        since: lastEventAt(input.events, 'approval_requested') ?? input.run.updatedAt,
        action: { kind: 'approve', label: say.attention.reviewThePlan, destructive: false },
        focus: 'plan',
      }),
    );
  }

  if (runtime.status === 'auto_recovery_exhausted' && runtime.escalation !== undefined) {
    const escalation = runtime.escalation;
    items.push(
      item({
        kind: 'recovery_exhausted',
        runId,
        taskId: escalation.task,
        what: say.attention.exhaustedRecovery(escalation.task),
        // The escalation already carries exactly one human action, and it is never
        // "inspect logs" — C-22 spent a milestone on that. Repeating it here rather than
        // writing a new sentence keeps one answer to "what do I do".
        why: say.attention.repairsTried(escalation.failureClass, escalation.attemptedRepairs.length),
        since: lastEventAt(input.events, 'recovery_exhausted') ?? input.run.updatedAt,
        action: { kind: 'retry', label: escalation.humanAction, destructive: false },
        focus: 'task',
      }),
    );
  }

  // A task the escalation already names has one row, not two. Both facts are true —
  // recovery gave up, and the task is waiting for somebody — and the exhaustion is the
  // more specific of the two and carries the action. Measured on AF-2026-002, where
  // TASK-005 produced two P1 rows telling one person to do one thing.
  const escalated =
    runtime.status === 'auto_recovery_exhausted' ? runtime.escalation?.task : undefined;

  for (const task of input.tasks) {
    if (task.state === 'review_required' && task.id !== escalated) {
      items.push(
        item({
          kind: 'task_review_required',
          runId,
          taskId: task.id,
          what: say.attention.waitingForReview(task.id),
          why: say.attention.nothingAcceptedIt,
          since: lastEventAt(input.events, 'task_finished', task.id) ?? input.run.updatedAt,
          action: { kind: 'inspect', label: say.attention.open(task.id), destructive: false },
          focus: 'task',
        }),
      );
    }

    // Only the agent's own BLOCKED. A task held back by an upstream failure is a
    // consequence of that failure, and raising both would put two rows on screen for one
    // thing to fix.
    //
    // **Absence of `blockReason` is not evidence of an agent block**, and reading it that
    // way put a P1 on every task downstream of one failure. `blocked` is two things: a
    // record the executor wrote when a runner answered BLOCKED, and a *condition*
    // `effectiveTaskStates` derives over the graph for everything downstream of a failure.
    // The second never carries a reason, because nothing wrote one. So the graph is asked
    // directly: a task whose own dependencies are stuck is stuck because of them.
    if (task.state === 'blocked' && !heldByUpstream(task, input.tasks)) {
      items.push(
        item({
          kind: 'agent_blocked',
          runId,
          taskId: task.id,
          what: say.attention.reportedBlocked(task.id),
          why: say.attention.sddDoesNotAnswer,
          since: lastEventAt(input.events, 'task_blocked', task.id) ?? input.run.updatedAt,
          action: { kind: 'inspect', label: say.attention.readWhatAsked(task.id), destructive: false },
          focus: 'task',
        }),
      );
    }
  }

  return items;
}

/* ─── P2 — something authoritative failed ──────────────────────────────────── */

function failureItems(input: AttentionInput): AttentionItem[] {
  const say = input.say ?? en;
  const items: AttentionItem[] = [];
  const { runId } = input;

  for (const task of input.tasks) {
    if (task.state !== 'failed') continue;
    items.push(
      item({
        kind: 'task_failed',
        runId,
        taskId: task.id,
        what: say.attention.taskFailed(task.id),
        why:
          task.attempts > 1
            ? say.attention.attemptsNoneSatisfied(task.attempts)
            : say.attention.attemptDidNotSatisfy,
        since: lastEventAt(input.events, 'task_failed', task.id) ?? input.run.updatedAt,
        action: { kind: 'retry', label: say.attention.requeue(task.id), destructive: false },
        focus: 'task',
      }),
    );
  }

  // `unsatisfiedGates` is the server's answer, and it is used rather than recomputed. The
  // sentence `required && status !== 'passed'` lives in one place on purpose (M6 §59); a
  // second copy here would be the second authority this milestone forbids.
  for (const gate of input.review?.unsatisfiedGates ?? []) {
    items.push(gateItem(runId, gate, input));
  }

  for (const thread of input.review?.threads ?? []) {
    if (thread.openBlocking === 0) continue;
    items.push(
      item({
        kind: 'blocking_finding_open',
        runId,
        taskId: thread.taskId,
        what: say.attention.blockingFindings(thread.taskId, thread.openBlocking),
        why: thread.decision.blockedBy.join('; ') || say.attention.reviewRequestedChanges,
        since: lastEventAt(input.events, 'review_completed', thread.taskId) ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.readTheFindings, destructive: false },
        focus: 'review',
      }),
    );
  }

  if (input.delivery?.state === 'checks_red') {
    const summary = input.delivery.checkSummary;
    items.push(
      item({
        kind: 'remote_checks_red',
        runId,
        what: say.attention.remoteChecksFailed(summary.red),
        // The sentence carries the separation rather than relying on the reader to know
        // it. A remote check is an observation; the local workflow already approved or it
        // would not have published.
        why: say.attention.deliveryNotLocalQuality,
        since: input.delivery.syncedAt ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.openTheDelivery, destructive: false },
        focus: 'delivery',
      }),
    );
  }

  if (input.delivery?.state === 'delivery_failed') {
    items.push(
      item({
        kind: 'delivery_failed',
        runId,
        what: say.attention.deliveryFailed,
        why: input.delivery.detail,
        since: input.delivery.syncedAt ?? input.run.updatedAt,
        // **Named as a command rather than offered as a button**, and that is M7's
        // boundary rather than a gap here: every *write* to a forge stays behind the CLI
        // so the local server never holds a token. An action a surface cannot perform is
        // worse than no action at all — it teaches people the queue is decorative.
        action: { kind: 'forge_sync', label: say.attention.runForgeSync, destructive: false },
        focus: 'delivery',
      }),
    );
  }

  return items;
}

/**
 * A required gate, and the distinction M6 paid for.
 *
 * `not_run` is not `failed` and is never `passed`. Both block, and both are P2 — but they
 * are different kinds with different sentences, because an environment that could not
 * answer sends a person to the environment and a codebase that answered no sends them to
 * the code.
 */
function gateItem(runId: string, gate: QualityGateResult, input: AttentionInput): AttentionItem {
  const say = input.say ?? en;
  const notRun = gate.status === 'not_run';
  return item({
    kind: notRun ? 'required_gate_not_run' : 'required_gate_failed',
    runId,
    gateId: gate.gateId,
    what: notRun ? say.attention.gateDidNotRun(gate.gateId) : say.attention.gateFailed(gate.gateId),
    why:
      gate.detail ??
      (notRun
        ? say.attention.nothingRecordedResult
        : say.attention.exitCode(gate.exitCode === undefined ? 'non-zero' : String(gate.exitCode))),
    since: lastEventAt(input.events, 'quality_gate_evaluated') ?? input.run.updatedAt,
    action: { kind: 'inspect', label: say.attention.openQualityGates, destructive: false },
    focus: 'quality',
  });
}

/* ─── P3 — degraded, still moving ──────────────────────────────────────────── */

function degradedItems(input: AttentionInput): AttentionItem[] {
  const say = input.say ?? en;
  const items: AttentionItem[] = [];
  const { runId } = input;

  if (input.runtime.reviewFreshness === 'superseded') {
    items.push(
      item({
        kind: 'review_stale',
        runId,
        what: say.attention.reviewMovedPast,
        why: say.attention.stageStartedAfter,
        since: lastEventAt(input.events, 'stage_started') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.openTheReview, destructive: false },
        focus: 'review',
      }),
    );
  }

  for (const thread of input.review?.threads ?? []) {
    if (thread.freshness !== 'stale') continue;
    items.push(
      item({
        kind: 'review_stale',
        runId,
        taskId: thread.taskId,
        what: say.attention.reviewOfIsStale(thread.taskId),
        why: say.attention.namesATreeMovedPast,
        since: lastEventAt(input.events, 'review_completed', thread.taskId) ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.openTheReviewThread, destructive: false },
        focus: 'review',
      }),
    );
  }

  if (input.run.pauseRequestedAt !== undefined) {
    items.push(
      item({
        kind: 'run_paused',
        runId,
        what: say.attention.operatorAskedToStop,
        why: say.attention.noNewTaskStarts,
        since: input.run.pauseRequestedAt,
        action: { kind: 'resume', label: say.attention.resumeTheRun, destructive: false },
        focus: 'run',
      }),
    );
  }

  // Starvation, not a deferral. One wave held for capacity is the scheduler working; a
  // task still deferred with idle members and nothing running is a configuration problem.
  const starving = capacityStarvation(input);
  for (const taskId of starving) {
    items.push(
      item({
        kind: 'capacity_starvation',
        runId,
        taskId,
        what: say.attention.readyAndNobodyTakes(taskId),
        why: say.attention.everyMemberAtCapacity,
        since: lastEventAt(input.events, 'wave_deferred_for_capacity') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: say.attention.openTheTeam, destructive: false },
        focus: 'team',
      }),
    );
  }

  for (const degradation of input.run.degradations) {
    items.push(
      item({
        kind: 'degradation_recorded',
        runId,
        what: say.attention.runIsDegraded(degradation.kind),
        // Both halves. `reason` is what happened and `impact` is what it costs, and a
        // reader given only the first has to guess whether it matters.
        why: say.attention.reasonAndImpact(degradation.reason, degradation.impact),
        since: degradation.detectedAt,
        action: { kind: 'inspect', label: say.attention.openTheRunSummary, destructive: false },
        focus: 'run',
      }),
    );
  }

  return items;
}

/* ─── P4 — actionable, not urgent ──────────────────────────────────────────── */

function informationalItems(input: AttentionInput): AttentionItem[] {
  const say = input.say ?? en;
  const items: AttentionItem[] = [];
  const { runId, delivery } = input;
  if (delivery === undefined || delivery.state === 'disabled') return items;

  if (delivery.state === 'checks_pending') {
    items.push(
      item({
        kind: 'checks_pending',
        runId,
        what: say.attention.checksPending(delivery.checkSummary.pending),
        why: say.attention.checksAreObservation,
        since: delivery.syncedAt ?? input.run.updatedAt,
        action: { kind: 'forge_sync', label: say.attention.runForgeSync, destructive: false },
        focus: 'delivery',
      }),
    );
  }

  // Only once the run has something worth publishing. A plan awaiting approval that has
  // not been published is not a thing anybody should be nudged about.
  if (delivery.state === 'not_published' && input.runtime.status === 'complete') {
    items.push(
      item({
        kind: 'delivery_not_published',
        runId,
        what: say.attention.finishedNothingPublished,
        why: delivery.detail,
        since: input.run.updatedAt,
        action: {
          kind: 'forge_publish',
          label: say.attention.runForgePublish,
          destructive: false,
        },
        focus: 'delivery',
      }),
    );
  }

  return items;
}

/* ─── helpers ──────────────────────────────────────────────────────────────── */

/**
 * Whether this task is blocked *because something it depends on is*.
 *
 * Asked of the dependencies the task already carries rather than of the DAG, for the same
 * reason the board does not re-derive readiness: `TaskSummaryView` is produced by the one
 * function every reader goes through, and a second traversal here would be a second answer.
 */
function heldByUpstream(
  task: TaskSummaryView,
  tasks: readonly TaskSummaryView[],
): boolean {
  if (task.blockReason === 'dependency') return true;
  // An explicit record from the executor outranks the graph: the agent said so.
  if (task.blockReason === 'agent') return false;

  const stuck = new Set(
    tasks.filter((entry) => entry.state === 'failed' || entry.state === 'blocked').map((entry) => entry.id),
  );
  return task.dependencies.some((dependency) => stuck.has(dependency));
}

/**
 * Ready tasks that were deferred for capacity and that nothing has since picked up.
 *
 * Deliberately narrow. A deferral is normal; a deferral standing while the run has no
 * running task at all is the case where the configuration cannot ever satisfy the plan.
 */
function capacityStarvation(input: AttentionInput): string[] {
  if (input.team === undefined) return [];
  if (input.tasks.some((task) => task.state === 'running')) return [];

  const deferred = new Set(
    input.team.deferrals.filter((entry) => entry.reason === 'capacity').map((entry) => entry.taskId),
  );

  return input.tasks
    .filter((task) => deferred.has(task.id) && task.state !== 'completed')
    .map((task) => task.id)
    .sort();
}

/**
 * The most recent event of a type, optionally about a task.
 *
 * Returns `undefined` rather than a substitute when nothing recorded it. The caller falls
 * back to the run's `updatedAt` and that fallback is *visible* in the code — a timestamp
 * nobody measured, printed as if it were one, is how "since yesterday" becomes wrong.
 */
function lastEventAt(
  events: readonly RunEvent[],
  type: string,
  taskId?: string,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== type) continue;
    if (taskId !== undefined && event.detail['task'] !== taskId) continue;
    return event.at;
  }
  return undefined;
}

/**
 * Build an item, and derive its id from its cause.
 *
 * The id has to survive a re-read of unchanged facts: the queue is live, and an item whose
 * identity changes remounts, loses focus and animates a row that did not move.
 */
function item(fields: {
  kind: AttentionKind;
  runId: string;
  taskId?: string;
  findingId?: string;
  agentId?: string;
  gateId?: string;
  what: string;
  why: string;
  since: string;
  action: AttentionItem['action'];
  focus: AttentionItem['focus'];
}): AttentionItem {
  const scope = {
    runId: fields.runId,
    ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    ...(fields.findingId === undefined ? {} : { findingId: fields.findingId }),
    ...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
    ...(fields.gateId === undefined ? {} : { gateId: fields.gateId }),
  };

  const discriminator = [fields.taskId, fields.findingId, fields.agentId, fields.gateId]
    .filter((part): part is string => part !== undefined)
    .join(':');

  return {
    id: discriminator.length > 0 ? `${fields.kind}:${discriminator}` : fields.kind,
    priority: PRIORITY[fields.kind],
    kind: fields.kind,
    what: fields.what,
    why: fields.why,
    scope,
    since: fields.since,
    action: fields.action,
    focus: fields.focus,
  };
}
