import { describe, it, expect } from 'vitest';
import { projectReviews, EMPTY_REVIEW } from '../../../src/core/review/view.js';
import {
  AgentMessageSchema,
  QualityConfigSchema,
  ReviewRecordSchema,
  RunEventSchema,
  type AgentMessage,
  type ReviewRecord,
  type RunEvent,
} from '../../../src/contracts/index.js';

/**
 * The one projection the CLI, the API and the dashboard all read (M6-09, M6-ACC-21).
 *
 * **Freshness is answered here and nowhere else.** It used to be decided in the browser,
 * by `apps/web/src/lib/review-freshness.ts`, from whichever fields it happened to have —
 * which is exactly what §59 names as forbidden. Identity against the integrated tree is
 * the only thing that answers it, and this is the only place that knows both halves.
 *
 * Nothing here decides whether a change proceeds. It carries the decision so a reader
 * sees the same verdict the workflow acted on, rather than one computed a second time.
 */

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return ReviewRecordSchema.parse({
    id: 'REV-0001',
    runId: 'AF-2026-001',
    taskId: 'TASK-003',
    round: 1,
    reviewer: 'reviewer',
    author: 'backend',
    independence: 3,
    reviewedTree: TREE_A,
    verdict: 'approve',
    findings: [],
    createdAt: '2026-09-02T12:00:00.000Z',
    ...overrides,
  });
}

const FINDING = {
  id: 'FIND-0001',
  severity: 'high' as const,
  type: 'correctness',
  description: 'the retry re-sends a consumed body',
  suggestedAction: 'buffer it first',
  evidence: [],
};

function event(type: string, detail: Record<string, unknown>): RunEvent {
  return RunEventSchema.parse({ at: '2026-09-02T12:10:00.000Z', type, detail });
}

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: 'AF-2026-001',
    threadId: 'THR-0001',
    from: 'backend',
    to: { kind: 'agent', id: 'reviewer' },
    type: 'acknowledge',
    subject: 're',
    body: 'noted',
    references: [{ kind: 'finding', id: 'FIND-0001' }],
    createdAt: '2026-09-02T12:05:00.000Z',
    ...overrides,
  });
}

const PASSING = [
  event('quality_gate_evaluated', { gate: 'test', category: 'unit', required: true, status: 'passed', exitCode: 0 }),
];

function project(input: {
  reviews?: ReviewRecord[];
  messages?: AgentMessage[];
  events?: RunEvent[];
  trees?: Record<string, string>;
  quality?: Record<string, unknown>;
}) {
  return projectReviews({
    reviews: input.reviews ?? [review()],
    messages: input.messages ?? [],
    events: input.events ?? PASSING,
    quality: QualityConfigSchema.parse(input.quality ?? {}),
    integratedTrees: new Map(Object.entries(input.trees ?? { 'TASK-003': TREE_A })),
  });
}

describe('a run that reviewed nothing', () => {
  it('is not an empty review', () => {
    // "No reviewer" and "reviewed and found nothing" are different states, and a screen
    // that conflated them would invite an operator to fix a configuration that is right.
    expect(projectReviews({ reviews: [], messages: [], events: [], quality: QualityConfigSchema.parse({}) })).toEqual(
      EMPTY_REVIEW,
    );
    expect(EMPTY_REVIEW.reviewed).toBe(false);
  });
});

describe('a thread carries what a reader needs first', () => {
  it('names the reviewer, the author and the independence achieved', () => {
    const [thread] = project({}).threads;

    expect(thread?.reviewer).toBe('reviewer');
    expect(thread?.author).toBe('backend');
    expect(thread?.independence).toBe(3);
  });

  it('is approved when the decision approves, not when the reviewer did', () => {
    // I-44: a reviewer's `approve` over a failed gate is not an approval.
    const failing = [
      event('quality_gate_evaluated', { gate: 'test', category: 'unit', required: true, status: 'failed', exitCode: 1 }),
    ];

    expect(project({}).threads[0]?.status).toBe('approved');
    expect(project({ events: failing }).threads[0]?.status).not.toBe('approved');
  });

  it('asks for changes while a blocking finding is open', () => {
    const withFinding = review({ verdict: 'changes_requested', findings: [FINDING] });

    expect(project({ reviews: [withFinding] }).threads[0]?.status).toBe('changes_requested');
  });

  it('is awaiting recheck once every finding has been answered and fixed', () => {
    const withFinding = review({ verdict: 'changes_requested', findings: [FINDING] });
    const events = [
      ...PASSING,
      event('corrective_task_created', { task: 'TASK-003', finding: 'FIND-0001', correctiveTask: 'FIX-001' }),
      event('task_finished', { task: 'FIX-001', status: 'completed' }),
    ];

    expect(project({ reviews: [withFinding], events }).threads[0]?.status).toBe('awaiting_recheck');
  });

  it('is blocked when the reviewer said so', () => {
    const blocked = review({ verdict: 'blocked', findings: [{ ...FINDING, severity: 'critical' }] });

    expect(project({ reviews: [blocked] }).threads[0]?.status).toBe('blocked');
  });

  it('counts the rounds', () => {
    const second = review({ id: 'REV-0002', round: 2, reviewedTree: TREE_A });

    expect(project({ reviews: [review(), second] }).threads[0]?.rounds).toBe(2);
  });
});

describe('freshness is identity, and it is answered here', () => {
  it('is current when the review read the tree that is integrated', () => {
    expect(project({}).threads[0]?.freshness).toBe('current');
  });

  it('is stale when the tree moved after the review', () => {
    expect(project({ trees: { 'TASK-003': TREE_B } }).threads[0]?.freshness).toBe('stale');
  });

  it('is unverifiable rather than stale when either side has no commit', () => {
    // A sequential run has no tree. Calling that stale would refuse every sequential
    // review on the strength of a measurement nobody took.
    const { reviewedTree, ...sequential } = review();
    void reviewedTree;

    expect(project({ reviews: [ReviewRecordSchema.parse(sequential)] }).threads[0]?.freshness).toBe(
      'unverifiable',
    );
    expect(project({ trees: {} }).threads[0]?.freshness).toBe('unverifiable');
  });

  it('refuses to approve a stale review', () => {
    const thread = project({ trees: { 'TASK-003': TREE_B } }).threads[0];

    expect(thread?.decision.approved).toBe(false);
    expect(thread?.decision.blockedBy).toContain('the review read the tree that is integrated');
  });
});

describe('the totals a header and a CLI line both read', () => {
  it('counts findings by severity, category and independence', () => {
    const withFindings = review({
      verdict: 'changes_requested',
      findings: [FINDING, { ...FINDING, id: 'FIND-0002', severity: 'low', type: 'ux' }],
    });

    const totals = project({ reviews: [withFindings] }).totals;

    expect(totals.findings).toBe(2);
    expect(totals.bySeverity).toEqual({ high: 1, low: 1 });
    expect(totals.byCategory).toEqual({ correctness: 1, ux: 1 });
    expect(totals.byIndependence).toEqual({ '3': 1 });
  });

  it('counts what is open, verified, disputed and stale', () => {
    const withFinding = review({ verdict: 'changes_requested', findings: [FINDING] });
    const disputed = message({ type: 'review_feedback', body: 'I disagree' });

    const totals = project({ reviews: [withFinding], messages: [disputed] }).totals;

    expect(totals.disputes).toBe(1);
    expect(totals.openFindings).toBe(0);
    expect(totals.staleReviews).toBe(0);
  });

  it('is deterministic — two reads of one log agree', () => {
    expect(project({})).toEqual(project({}));
  });
});

describe('gates come from the audit trail, not from a second evaluation', () => {
  it('reports what the run recorded', () => {
    const [gate] = project({}).gates;

    expect(gate).toMatchObject({ gateId: 'test', required: true, status: 'passed' });
  });

  it('takes the latest word on a gate that ran twice', () => {
    const twice = [
      event('quality_gate_evaluated', { gate: 'test', category: 'unit', required: true, status: 'failed' }),
      event('quality_gate_evaluated', { gate: 'test', category: 'unit', required: true, status: 'passed' }),
    ];

    expect(project({ events: twice }).gates[0]?.status).toBe('passed');
  });
});

describe('one thread per task', () => {
  it('groups reviews by the change they are about', () => {
    const other = review({ id: 'REV-0002', taskId: 'TASK-009' });
    const view = project({ reviews: [review(), other], trees: { 'TASK-003': TREE_A, 'TASK-009': TREE_A } });

    expect(view.threads.map((thread) => thread.taskId)).toEqual(['TASK-003', 'TASK-009']);
    expect(view.totals.tasksReviewed).toBe(2);
  });
});
