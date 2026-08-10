import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import {
  approvalCoversPlan,
  approveRun,
  checkApproval,
  planHash,
} from '../../src/app/approval.js';
import { PlanSchema, ReviewResultSchema, RunStateSchema } from '../../src/contracts/index.js';

const plan = (taskTitle = 'Do it') =>
  PlanSchema.parse({
    feature: 'f',
    tasks: [
      {
        id: 'TASK-001',
        title: taskTitle,
        description: 'Implements FR-001.',
        complexity: 'normal',
        risk: 'low',
        dependencies: [],
        requirements: ['FR-001'],
        acceptanceCriteria: ['It works.'],
        validation: [],
      },
    ],
  });

const review = (overrides: Record<string, unknown> = {}) =>
  ReviewResultSchema.parse({
    verdict: 'PASS',
    independence: 'cross-provider',
    reviewer: { runner: 'codex', reasoning: 'high' },
    findings: [],
    ...overrides,
  });

const state = (overrides: Record<string, unknown> = {}) =>
  RunStateSchema.parse({
    runId: 'AF-2026-001',
    feature: 'f',
    stage: 'plan-review',
    status: 'waiting_for_approval',
    createdAt: '2026-08-09T20:00:00.000Z',
    updatedAt: '2026-08-09T20:00:00.000Z',
    ...overrides,
  });

describe('planHash', () => {
  it('is stable for the same plan', () => {
    expect(planHash(plan())).toBe(planHash(plan()));
  });

  it('changes when the plan changes', () => {
    // The gate is about a specific document. If the hash did not move, a revise
    // after approval would leave the gate satisfied for something nobody read.
    expect(planHash(plan('Do it'))).not.toBe(planHash(plan('Do something else')));
  });
});

describe('checkApproval', () => {
  it('allows approval after a passing review', () => {
    const result = checkApproval(state(), plan(), review());
    expect(result.allowed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('refuses when there is no run', () => {
    expect(checkApproval(null, plan(), review()).refusal?.kind).toBe('no_run');
  });

  it('refuses when no plan exists yet', () => {
    expect(checkApproval(state(), null, review()).refusal?.kind).toBe('no_plan');
  });

  it('refuses when the plan was never reviewed', () => {
    expect(checkApproval(state(), plan(), null).refusal?.kind).toBe('review_missing');
  });

  it('refuses when the review failed', () => {
    const failed = review({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'high',
          type: 'missing_test',
          description: 'No test covers cancellation.',
          suggestedAction: 'Add one.',
        },
      ],
    });

    const result = checkApproval(state(), plan(), failed);
    expect(result.allowed).toBe(false);
    expect(result.refusal?.kind).toBe('review_failed');
  });

  it('refuses to approve twice', () => {
    const approved = state({ approved: true, status: 'approved', approvedPlanHash: 'abc' });
    expect(checkApproval(approved, plan(), review()).refusal?.kind).toBe('already_approved');
  });
});

describe('warnings shown before signing off (R-16)', () => {
  it('surfaces every degradation recorded on the run', () => {
    // A degraded run is still approvable, but the person approving should know
    // what was lost before they sign, not afterwards.
    const degraded = state({
      degradations: [
        {
          kind: 'runner_unavailable_with_fallback',
          reason: 'runner "codex" is not usable',
          impact: 'roles configured for codex ran on claude',
          detectedAt: '2026-08-09T20:00:00.000Z',
        },
      ],
    });

    const result = checkApproval(degraded, plan(), review());

    expect(result.allowed).toBe(true);
    expect(result.warnings.join(' ')).toContain('codex');
    expect(result.warnings.join(' ')).toContain('ran on claude');
  });

  it('warns when the review was not genuinely independent', () => {
    const result = checkApproval(
      state(),
      plan(),
      review({ independence: 'same-provider-fresh-context' }),
    );

    expect(result.allowed).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/same-provider/i);
  });

  it('stays silent when nothing was lost', () => {
    expect(checkApproval(state(), plan(), review()).warnings).toEqual([]);
  });
});

describe('approveRun', () => {
  async function store() {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/repo' });
    const run = await store.createRun('f');
    return { store, run };
  }

  it('records the hash of the approved plan', async () => {
    const { store: s, run } = await store();
    const approved = await approveRun(s, run.runId, plan());

    expect(approved.approved).toBe(true);
    expect(approved.approvedPlanHash).toBe(planHash(plan()));
    expect(approved.status).toBe('approved');
  });

  it('records when the gate was opened (V-10 regression)', async () => {
    // Was written as `approvedAt: undefined` with a Clock already in reach.
    // The moment a human approved is the one fact an audit trail cannot
    // reconstruct from anything else.
    const { store: s, run } = await store();
    const approved = await approveRun(s, run.runId, plan());

    expect(approved.approvedAt).toBe('2026-08-09T20:00:00.000Z');
  });

  it('stamps a new time on re-approval', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const s = new StateStore({ fs, clock, projectDir: '/repo' });
    const run = await s.createRun('f');

    await approveRun(s, run.runId, plan());
    clock.advance(3_600_000);

    // A revise clears the approval; approving again is a new decision.
    await s.updateRun(run.runId, (state) => ({
      ...state,
      approved: false,
      approvedAt: undefined,
      approvedPlanHash: undefined,
      status: 'waiting_for_approval',
    }));
    const reapproved = await approveRun(s, run.runId, plan());

    expect(reapproved.approvedAt).toBe('2026-08-09T21:00:00.000Z');
  });

  it('logs the approval as an event', async () => {
    const { store: s, run } = await store();
    await approveRun(s, run.runId, plan());

    const events = await s.readEvents(run.runId);
    const approval = events.find((event) => event.type === 'run_approved');
    expect(approval?.detail['taskCount']).toBe(1);
    expect(approval?.detail['forced']).toBe(false);
  });

  it('marks a forced approval as forced, so the decision is attributable', async () => {
    // Overriding a failed review is allowed. Doing it invisibly is not.
    const { store: s, run } = await store();
    await approveRun(s, run.runId, plan(), { forced: true });

    const events = await s.readEvents(run.runId);
    expect(events.find((event) => event.type === 'run_approved')?.detail['forced']).toBe(true);
  });

  it('survives a reload', async () => {
    const { store: s, run } = await store();
    await approveRun(s, run.runId, plan());
    expect((await s.loadRun(run.runId)).approvedPlanHash).toBe(planHash(plan()));
  });
});

describe('approvalCoversPlan', () => {
  it('accepts the plan that was approved', () => {
    const approved = state({ approved: true, approvedPlanHash: planHash(plan()) });
    expect(approvalCoversPlan(approved, plan())).toBe(true);
  });

  it('rejects a plan edited after approval', () => {
    // The concrete protection: approving, then revising, then running must not
    // execute work the human never saw.
    const approved = state({ approved: true, approvedPlanHash: planHash(plan()) });
    expect(approvalCoversPlan(approved, plan('Different work entirely'))).toBe(false);
  });

  it('rejects an unapproved run', () => {
    expect(approvalCoversPlan(state(), plan())).toBe(false);
  });
});
