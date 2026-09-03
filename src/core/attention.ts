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
  const items: AttentionItem[] = [];
  const { runId } = input;

  if (input.delivery?.state === 'remote_diverged') {
    items.push(
      item({
        kind: 'remote_diverged',
        runId,
        what: 'the remote branch moved under this run',
        // Publishing again would guess which history is right, and one of the two has
        // somebody's work in it. That is why this outranks a human gate.
        why: input.delivery.detail,
        since: input.delivery.syncedAt ?? input.run.updatedAt,
        action: { kind: 'inspect', label: 'Inspect the remote', destructive: false },
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
        what: `${conflict.task} could not be merged`,
        why:
          conflict.previouslyIntegrated === undefined
            ? `conflicting paths: ${conflict.paths.join(', ')}`
            : `${conflict.previouslyIntegrated} integrated first and moved the head; conflicting paths: ${conflict.paths.join(', ')}`,
        since: lastEventAt(input.events, 'task_integration_conflict') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: `Open ${conflict.task}`, destructive: false },
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
        what: `${deferral.taskId} is held by an ownership conflict`,
        why: deferral.detail,
        since: lastEventAt(input.events, 'wave_deferred_for_ownership') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: 'Review the ownership areas', destructive: false },
        focus: 'team',
      }),
    );
  }

  return items;
}

/* ─── P1 — a person is the only thing between the run and progress ─────────── */

function humanGateItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { runId, runtime } = input;

  if (runtime.status === 'awaiting_human_approval') {
    items.push(
      item({
        kind: 'approval_required',
        runId,
        what: 'the plan is waiting for a decision',
        why: runtime.gate?.action ?? 'nothing runs until the gate opens',
        since: lastEventAt(input.events, 'approval_requested') ?? input.run.updatedAt,
        action: { kind: 'approve', label: 'Review the plan', destructive: false },
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
        what: `${escalation.task} exhausted automatic recovery`,
        // The escalation already carries exactly one human action, and it is never
        // "inspect logs" — C-22 spent a milestone on that. Repeating it here rather than
        // writing a new sentence keeps one answer to "what do I do".
        why: `${escalation.failureClass}; ${escalation.attemptedRepairs.length} repair steps tried`,
        since: lastEventAt(input.events, 'recovery_exhausted') ?? input.run.updatedAt,
        action: { kind: 'retry', label: escalation.humanAction, destructive: false },
        focus: 'task',
      }),
    );
  }

  for (const task of input.tasks) {
    if (task.state === 'review_required') {
      items.push(
        item({
          kind: 'task_review_required',
          runId,
          taskId: task.id,
          what: `${task.id} is waiting for a review decision`,
          why: 'the attempt finished and nothing has accepted or requeued it',
          since: lastEventAt(input.events, 'task_finished', task.id) ?? input.run.updatedAt,
          action: { kind: 'inspect', label: `Open ${task.id}`, destructive: false },
          focus: 'task',
        }),
      );
    }

    // Only the agent's own BLOCKED. A task held back by an upstream failure is a
    // consequence of that failure, and raising both would put two rows on screen for one
    // thing to fix.
    if (task.state === 'blocked' && task.blockReason !== 'dependency') {
      items.push(
        item({
          kind: 'agent_blocked',
          runId,
          taskId: task.id,
          what: `${task.id} reported it is blocked`,
          why: 'the SDD does not answer something the task needs; recovery does not release this',
          since: lastEventAt(input.events, 'task_blocked', task.id) ?? input.run.updatedAt,
          action: { kind: 'inspect', label: `Read what ${task.id} asked`, destructive: false },
          focus: 'task',
        }),
      );
    }
  }

  return items;
}

/* ─── P2 — something authoritative failed ──────────────────────────────────── */

function failureItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { runId } = input;

  for (const task of input.tasks) {
    if (task.state !== 'failed') continue;
    items.push(
      item({
        kind: 'task_failed',
        runId,
        taskId: task.id,
        what: `${task.id} failed`,
        why:
          task.attempts > 1
            ? `${task.attempts} attempts, none of which satisfied the contract`
            : 'the attempt did not satisfy the contract',
        since: lastEventAt(input.events, 'task_failed', task.id) ?? input.run.updatedAt,
        action: { kind: 'retry', label: `Requeue ${task.id}`, destructive: false },
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
    const plural = thread.openBlocking === 1 ? 'finding' : 'findings';
    items.push(
      item({
        kind: 'blocking_finding_open',
        runId,
        taskId: thread.taskId,
        what: `${thread.taskId} has ${thread.openBlocking} blocking ${plural}`,
        why: thread.decision.blockedBy.join('; ') || 'the review requested changes',
        since: lastEventAt(input.events, 'review_completed', thread.taskId) ?? input.run.updatedAt,
        action: { kind: 'inspect', label: 'Read the findings', destructive: false },
        focus: 'review',
      }),
    );
  }

  if (input.delivery?.state === 'delivery_failed') {
    items.push(
      item({
        kind: 'delivery_failed',
        runId,
        what: 'delivery to the forge failed',
        why: input.delivery.detail,
        since: input.delivery.syncedAt ?? input.run.updatedAt,
        action: { kind: 'forge_sync', label: 'Retry the sync', destructive: false },
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
  const notRun = gate.status === 'not_run';
  return item({
    kind: notRun ? 'required_gate_not_run' : 'required_gate_failed',
    runId,
    gateId: gate.gateId,
    what: notRun
      ? `required gate \`${gate.gateId}\` did not run`
      : `required gate \`${gate.gateId}\` failed`,
    why:
      gate.detail ??
      (notRun
        ? 'nothing recorded a result for it, which blocks exactly as a failure does'
        : `exit ${gate.exitCode ?? 'non-zero'}`),
    since: lastEventAt(input.events, 'quality_gate_evaluated') ?? input.run.updatedAt,
    action: { kind: 'inspect', label: 'Open the quality gates', destructive: false },
    focus: 'quality',
  });
}

/* ─── P3 — degraded, still moving ──────────────────────────────────────────── */

function degradedItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { runId } = input;

  if (input.runtime.reviewFreshness === 'superseded') {
    items.push(
      item({
        kind: 'review_stale',
        runId,
        what: 'the newest review describes a state this run has moved past',
        why: 'a stage started after it was written, so its verdict is about a different tree',
        since: lastEventAt(input.events, 'stage_started') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: 'Open the review', destructive: false },
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
        what: `the review of ${thread.taskId} is stale`,
        why: 'it names a tree the task has moved past, so its approval does not apply',
        since: lastEventAt(input.events, 'review_completed', thread.taskId) ?? input.run.updatedAt,
        action: { kind: 'inspect', label: 'Open the review thread', destructive: false },
        focus: 'review',
      }),
    );
  }

  if (input.run.pauseRequestedAt !== undefined) {
    items.push(
      item({
        kind: 'run_paused',
        runId,
        what: 'an operator asked this run to stop',
        why: 'no new task starts until it is resumed; the task in flight runs to its end',
        since: input.run.pauseRequestedAt,
        action: { kind: 'resume', label: 'Resume the run', destructive: false },
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
        what: `${taskId} is ready and nothing can take it`,
        why: 'every member whose skills match is at maxConcurrentTasks',
        since: lastEventAt(input.events, 'wave_deferred_for_capacity') ?? input.run.updatedAt,
        action: { kind: 'inspect', label: 'Open the team', destructive: false },
        focus: 'team',
      }),
    );
  }

  for (const degradation of input.run.degradations) {
    items.push(
      item({
        kind: 'degradation_recorded',
        runId,
        what: `this run is degraded: ${degradation.kind}`,
        // Both halves. `reason` is what happened and `impact` is what it costs, and a
        // reader given only the first has to guess whether it matters.
        why: `${degradation.reason} — ${degradation.impact}`,
        since: degradation.detectedAt,
        action: { kind: 'inspect', label: 'Open the run summary', destructive: false },
        focus: 'run',
      }),
    );
  }

  return items;
}

/* ─── P4 — actionable, not urgent ──────────────────────────────────────────── */

function informationalItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { runId, delivery } = input;
  if (delivery === undefined || delivery.state === 'disabled') return items;

  if (delivery.state === 'checks_pending') {
    items.push(
      item({
        kind: 'checks_pending',
        runId,
        what: `${delivery.checkSummary.pending} remote checks have not reported`,
        why: 'remote checks are an observation and never a local verdict',
        since: delivery.syncedAt ?? input.run.updatedAt,
        action: { kind: 'forge_sync', label: 'Sync the delivery', destructive: false },
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
        what: 'this run has finished and nothing has been published',
        why: delivery.detail,
        since: input.run.updatedAt,
        action: { kind: 'forge_publish', label: 'Publish', destructive: false },
        focus: 'delivery',
      }),
    );
  }

  return items;
}

/* ─── helpers ──────────────────────────────────────────────────────────────── */

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
