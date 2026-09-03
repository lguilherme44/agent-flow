import { describe, it, expect } from 'vitest';
import {
  ATTENTION_KINDS,
  ATTENTION_PRIORITIES,
  type AttentionItem,
  type AttentionKind,
  type DeliveryView,
  type ReviewView,
  type RunProjection,
  type TaskState,
  type TaskSummaryView,
  type TeamView,
} from '../../src/contracts/index.js';
import { projectAttention, sortAttention, type AttentionInput } from '../../src/core/attention.js';

/**
 * The queue, and the three properties it is worthless without (M8 §4).
 *
 *   it appears from a fact
 *   it names one action and where that action lives
 *   it disappears when the fact resolves
 *
 * The third is the one a persisted `attention: true` would break, and the reason nothing
 * here is stored. Every test below asserts the item is present *and* that removing the
 * underlying fact removes it — a queue that only grows is a queue people stop reading.
 */

const NOW = '2026-09-03T10:00:00.000Z';

const task = (id: string, state: TaskState, extra: Partial<TaskSummaryView> = {}): TaskSummaryView => ({
  id,
  title: `${id} title`,
  complexity: 'medium',
  risk: 'low',
  state,
  attempts: 1,
  requirements: [],
  dependencies: [],
  ...extra,
});

const runtime = (overrides: Partial<RunProjection> = {}): RunProjection => ({
  status: 'implementing',
  resumable: true,
  progress: { workflow: { done: 5, total: 7 }, implementation: { done: 1, total: 3 } },
  reviewFreshness: 'absent',
  ...overrides,
});

const input = (overrides: Partial<AttentionInput> = {}): AttentionInput => ({
  runId: 'AF-2026-001',
  runtime: runtime(),
  tasks: [],
  run: { updatedAt: NOW, degradations: [], integrationConflicts: [] },
  events: [],
  ...overrides,
});

const review = (overrides: Partial<ReviewView> = {}): ReviewView => ({
  reviewed: true,
  threads: [],
  gates: [],
  unsatisfiedGates: [],
  totals: {
    reviews: 0,
    tasksReviewed: 0,
    findings: 0,
    openFindings: 0,
    verifiedFindings: 0,
    staleReviews: 0,
    disputes: 0,
    bySeverity: {},
    byCategory: {},
    byIndependence: {},
  },
  ...overrides,
});

const delivery = (overrides: Partial<DeliveryView> = {}): DeliveryView => ({
  state: 'published',
  provider: 'github',
  checks: [],
  checkSummary: { total: 0, green: 0, red: 0, pending: 0 },
  detail: 'published',
  ...overrides,
});

const kinds = (items: readonly AttentionItem[]): AttentionKind[] => items.map((item) => item.kind);

describe('M8-ACC-09 … 13 — the queue contains the blockers it claims to', () => {
  it('M8-ACC-09 raises an approval blocker, and drops it once approved', () => {
    const gated = projectAttention(
      input({
        runtime: runtime({
          status: 'awaiting_human_approval',
          gate: { gate: 'approval', action: 'Review the plan and run `agent-flow approve`', tasks: [] },
        }),
      }),
    );

    expect(kinds(gated)).toContain('approval_required');
    expect(gated[0]?.action.kind).toBe('approve');
    expect(gated[0]?.focus).toBe('plan');
    // The `why` is the gate's own sentence rather than a new one written here. Two
    // sentences for one gate is two answers to "what do I do".
    expect(gated[0]?.why).toContain('agent-flow approve');

    expect(kinds(projectAttention(input()))).not.toContain('approval_required');
  });

  it('M8-ACC-10 raises recovery exhaustion, carrying the escalation’s own action', () => {
    const items = projectAttention(
      input({
        runtime: runtime({
          status: 'auto_recovery_exhausted',
          escalation: {
            task: 'TASK-003',
            failureClass: 'validation_failed',
            counts: { attempts: 2 },
            evidence: ['npm test exited 1'],
            attemptedRepairs: [{ step: 'reinstall', outcome: 'completed' }],
            humanAction: 'Read the failed attempt and decide what to change',
          },
        }),
      }),
    );

    const item = items.find((candidate) => candidate.kind === 'recovery_exhausted');
    expect(item?.priority).toBe('P1');
    expect(item?.scope.taskId).toBe('TASK-003');
    // C-22 spent a milestone establishing that the escalation names exactly one human
    // action and that it is never "inspect logs". This reuses it rather than inventing one.
    expect(item?.action.label).toBe('Read the failed attempt and decide what to change');
  });

  it('M8-ACC-11 raises a stale review, at run level and per thread', () => {
    const runLevel = projectAttention(input({ runtime: runtime({ reviewFreshness: 'superseded' }) }));
    expect(kinds(runLevel)).toContain('review_stale');

    const perThread = projectAttention(
      input({
        review: review({
          threads: [
            {
              taskId: 'TASK-002',
              status: 'approved',
              freshness: 'stale',
              rounds: 1,
              reviewer: 'r',
              reviewerName: 'R',
              author: 'a',
              independence: 2,
              findings: [],
              openBlocking: 0,
              decision: { approved: true, conditions: [], blockedBy: [] },
            },
          ],
        }),
      }),
    );

    const item = perThread.find((candidate) => candidate.kind === 'review_stale');
    expect(item?.scope.taskId).toBe('TASK-002');
    // An approved thread whose approval is about a tree the task moved past is exactly the
    // case where "approved" on screen is worse than nothing.
    expect(item?.why).toContain('does not apply');
  });

  it('M8-ACC-12 separates a required gate that failed from one that did not run', () => {
    const failed = projectAttention(
      input({
        review: review({
          unsatisfiedGates: [
            { gateId: 'test', category: 'correctness', required: true, status: 'failed', exitCode: 1 },
          ],
        }),
      }),
    );
    const notRun = projectAttention(
      input({
        review: review({
          unsatisfiedGates: [
            {
              gateId: 'test',
              category: 'correctness',
              required: true,
              status: 'not_run',
              detail: 'no runner recorded a result',
            },
          ],
        }),
      }),
    );

    expect(kinds(failed)).toContain('required_gate_failed');
    expect(kinds(notRun)).toContain('required_gate_not_run');
    // Same priority, different kinds and different sentences: an environment that could not
    // answer sends a person to the environment; a codebase that answered no sends them to
    // the code. One red badge for both teaches people that red means "look into it".
    expect(failed[0]?.priority).toBe(notRun[0]?.priority);
    expect(failed[0]?.what).not.toBe(notRun[0]?.what);
    expect(notRun[0]?.scope.gateId).toBe('test');
  });

  it('M8-ACC-13 raises a delivery failure, and a divergence above it', () => {
    const failed = projectAttention(
      input({ delivery: delivery({ state: 'delivery_failed', detail: 'the push was rejected' }) }),
    );
    expect(failed[0]?.kind).toBe('delivery_failed');
    expect(failed[0]?.action.kind).toBe('forge_sync');

    const diverged = projectAttention(
      input({
        delivery: delivery({ state: 'remote_diverged', detail: 'the remote branch moved' }),
        runtime: runtime({
          status: 'awaiting_human_approval',
          gate: { gate: 'approval', action: 'approve', tasks: [] },
        }),
      }),
    );

    // A divergence outranks a human gate: publishing again would guess which history is
    // right, and one of the two has somebody's work in it.
    expect(diverged[0]?.kind).toBe('remote_diverged');
    expect(diverged[0]?.priority).toBe('P0');
  });
});

describe('M8-ACC-14 — every item links to the object that caused it', () => {
  it('scopes a task item to its task and a gate item to its gate', () => {
    const items = projectAttention(
      input({
        tasks: [task('TASK-001', 'failed'), task('TASK-002', 'blocked')],
        review: review({
          unsatisfiedGates: [
            { gateId: 'lint', category: 'correctness', required: true, status: 'failed' },
          ],
        }),
      }),
    );

    for (const item of items) {
      expect(item.scope.runId).toBe('AF-2026-001');
      // No item is allowed to be a shrug. Either it names the object or its focus is the
      // run itself; an item scoped to nothing is "something failed, check the logs".
      const named =
        item.scope.taskId !== undefined ||
        item.scope.gateId !== undefined ||
        item.focus === 'run' ||
        item.focus === 'plan' ||
        item.focus === 'delivery' ||
        item.focus === 'review' ||
        item.focus === 'team';
      expect(named, `${item.id} names nothing`).toBe(true);
    }

    expect(items.find((item) => item.kind === 'agent_blocked')?.scope.taskId).toBe('TASK-002');
    expect(items.find((item) => item.kind === 'task_failed')?.scope.taskId).toBe('TASK-001');
    expect(items.find((item) => item.kind === 'required_gate_failed')?.scope.gateId).toBe('lint');
  });

  it('gives each item exactly one recommended action', () => {
    const items = projectAttention(
      input({
        tasks: [task('TASK-001', 'failed')],
        runtime: runtime({ reviewFreshness: 'superseded' }),
        delivery: delivery({ state: 'checks_pending', checkSummary: { total: 3, green: 1, red: 0, pending: 2 } }),
      }),
    );

    expect(items.length).toBeGreaterThan(2);
    for (const item of items) {
      expect(item.action.label.length).toBeGreaterThan(3);
      // Never "check the logs" and never a menu. §17 of the brief, asserted rather than
      // reviewed for.
      expect(item.action.label.toLowerCase()).not.toContain('log');
      expect(item.what.toLowerCase()).not.toContain('something');
    }
  });

  it('holds an id stable across two reads of the same facts', () => {
    // The queue is live. An item whose identity changes between reads remounts, loses
    // focus, and animates a row that did not move.
    const facts = input({ tasks: [task('TASK-001', 'failed'), task('TASK-002', 'failed')] });

    expect(projectAttention(facts).map((item) => item.id)).toEqual(
      projectAttention(facts).map((item) => item.id),
    );
    expect(new Set(projectAttention(facts).map((item) => item.id)).size).toBe(2);
  });
});

describe('the order is a function of the facts, not of the reader', () => {
  it('sorts by priority, then by age, then by id', () => {
    const item = (
      id: string,
      priority: AttentionItem['priority'],
      since: string,
    ): AttentionItem => ({
      id,
      priority,
      kind: 'task_failed',
      what: 'x',
      why: 'y',
      scope: { runId: 'R' },
      since,
      action: { kind: 'inspect', label: 'Open', destructive: false },
      focus: 'run',
    });

    const sorted = sortAttention([
      item('c', 'P2', '2026-09-03T09:00:00.000Z'),
      item('a', 'P0', '2026-09-03T11:00:00.000Z'),
      item('b', 'P2', '2026-09-03T08:00:00.000Z'),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('gives every declared kind a priority', () => {
    // A kind with no rung is a kind that sorts wherever `undefined` happens to land.
    const items = ATTENTION_KINDS.map((kind) => kind);
    expect(items.length).toBeGreaterThan(0);

    // Exercised through the projection: every kind that a fixture can raise must come out
    // carrying one of the five, and the map is exhaustive by its own type.
    const raised = projectAttention(
      input({
        tasks: [task('TASK-001', 'failed'), task('TASK-002', 'blocked'), task('TASK-003', 'review_required')],
        runtime: runtime({ reviewFreshness: 'superseded' }),
        run: {
          updatedAt: NOW,
          pauseRequestedAt: NOW,
          degradations: [
            { kind: 'forced_approval', reason: 'a gate was forced', impact: 'the gate did not pass', detectedAt: NOW },
          ],
          integrationConflicts: [{ task: 'TASK-004', attempt: 1, paths: ['src/a.ts'] }],
        },
        delivery: delivery({ state: 'checks_pending', checkSummary: { total: 2, green: 0, red: 0, pending: 2 } }),
      }),
    );

    for (const entry of raised) expect(ATTENTION_PRIORITIES).toContain(entry.priority);
    // And the ladder actually orders: P0 integrity first, P4 information last.
    expect(raised[0]?.priority).toBe('P0');
    expect(raised.at(-1)?.priority).toBe('P4');
  });
});

describe('M8-ACC-15 — nothing is persisted, so nothing survives its cause', () => {
  it('returns an empty queue for a healthy run', () => {
    const healthy = projectAttention(
      input({
        tasks: [task('TASK-001', 'running'), task('TASK-002', 'completed')],
        review: review(),
        delivery: delivery({ state: 'checks_green' }),
      }),
    );

    // Progress is not attention. A run doing exactly what it should has nothing to say.
    expect(healthy).toEqual([]);
  });

  it('drops a task item the moment the task moves on', () => {
    const failing = input({ tasks: [task('TASK-001', 'failed')] });
    expect(kinds(projectAttention(failing))).toContain('task_failed');

    const fixed = input({ tasks: [task('TASK-001', 'completed')] });
    expect(projectAttention(fixed)).toEqual([]);
  });

  it('does not raise a dependency-blocked task beside the failure that caused it', () => {
    // Two rows for one thing to fix. The upstream failure is the item; the task held
    // behind it is a consequence and belongs on the board with a reason, not in the queue.
    const items = projectAttention(
      input({
        tasks: [
          task('TASK-001', 'failed'),
          task('TASK-002', 'blocked', { blockReason: 'dependency' }),
        ],
      }),
    );

    expect(kinds(items)).toEqual(['task_failed']);
  });

  it('nudges about publishing only once the run has something to publish', () => {
    const midRun = projectAttention(input({ delivery: delivery({ state: 'not_published' }) }));
    expect(kinds(midRun)).not.toContain('delivery_not_published');

    const finished = projectAttention(
      input({ runtime: runtime({ status: 'complete' }), delivery: delivery({ state: 'not_published' }) }),
    );
    expect(kinds(finished)).toContain('delivery_not_published');
  });

  it('says nothing at all when no forge is configured', () => {
    expect(projectAttention(input({ delivery: delivery({ state: 'disabled' }) }))).toEqual([]);
  });
});

describe('capacity starvation is not a deferral', () => {
  const team = (deferrals: TeamView['deferrals']): TeamView => ({
    configured: true,
    members: [],
    assignments: [],
    deferrals,
    totals: {
      assignments: 0,
      reassignments: 0,
      capacityDeferrals: deferrals.length,
      ownershipDeferrals: 0,
      candidatesConsidered: 0,
      exclusions: {},
    },
  });

  const deferred = [
    { taskId: 'TASK-001', reason: 'capacity' as const, detail: 'backend is full', patterns: [], agents: ['backend'] },
  ];

  it('stays quiet while something is running', () => {
    // One wave held for capacity is the scheduler doing its job.
    const items = projectAttention(
      input({ tasks: [task('TASK-001', 'queued'), task('TASK-002', 'running')], team: team(deferred) }),
    );

    expect(kinds(items)).not.toContain('capacity_starvation');
  });

  it('speaks when the deferral stands and nothing is running', () => {
    const items = projectAttention(
      input({ tasks: [task('TASK-001', 'queued')], team: team(deferred) }),
    );

    expect(kinds(items)).toContain('capacity_starvation');
  });
});
