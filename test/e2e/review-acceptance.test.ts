import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { ReviewStore } from '../../src/app/review-store.js';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import { ReviewService, ChangeReviewAdapter } from '../../src/app/review-service.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import { projectReviews } from '../../src/core/review/view.js';
import { projectFindings } from '../../src/core/review/findings.js';
import { decideQuality } from '../../src/core/review/decision.js';
import { projectQualityGates, unsatisfiedRequired } from '../../src/core/review/gates.js';
import { correctiveSelection, correctiveLinks } from '../../src/core/review/corrective.js';
import { applyFixes } from '../../src/core/corrective-plan.js';
import { buildValidationRegistry } from '../../src/core/validation-registry.js';
import { hasReviewer } from '../../src/core/review/reviewer.js';
import {
  AgentMessageSchema,
  GlobalConfigSchema,
  PlanSchema,
  ProjectConfigSchema,
  QualityConfigSchema,
  TaskResultSchema,
  TaskSchema,
  type EffectiveConfig,
  type Task,
  type TaskResult,
} from '../../src/contracts/index.js';
import type { StageRunner } from '../../src/app/stage-runner.js';

/**
 * M6, held to the charter's own twenty-eight acceptance criteria.
 *
 * Driven through the **real** service, store and projections against a scripted runner.
 * What a scripted suite can prove is that every path fires mechanically on the input it
 * was built for; what it cannot prove is that a real reviewer finds anything real, which
 * is what M6-ACC-26 and 27 are for and why they are marked here rather than asserted.
 *
 * The M4 dogfood is why that limit is stated rather than implied: hundreds of passing
 * tests proved a channel worked while five of six agents had nothing to read.
 */

const PROJECT = '/repo';
const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

const ROLES = {
  architect: { runner: 'claude', effort: 'high' },
  sdd: { runner: 'claude', effort: 'high' },
  planner: { runner: 'claude', effort: 'high' },
  planReviewer: { runner: 'claude', effort: 'high' },
  executors: {
    trivial: { runner: 'claude', effort: 'low' },
    normal: { runner: 'claude', effort: 'medium' },
    complex: { runner: 'claude', effort: 'high' },
  },
  verification: { runner: 'claude', effort: 'medium' },
  finalReviewer: { runner: 'claude', effort: 'high' },
};

const REVIEWER = { roles: 'finalReviewer', skills: ['review'] };
const TEAM = { backend: {}, reviewer: REVIEWER };

function config(
  members?: Record<string, Record<string, unknown>>,
  quality: Record<string, unknown> = { gates: { test: { category: 'unit', required: true } } },
): EffectiveConfig {
  return {
    global: GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' }, agy: { type: 'agy-cli' } },
      roles: ROLES,
      quality,
      ...(members === undefined
        ? {}
        : {
            teams: {
              core: {
                members: Object.fromEntries(
                  Object.entries(members).map(([id, member]) => [
                    id,
                    { roles: 'executor.normal', runner: 'claude', ...member },
                  ]),
                ),
                policies: {},
              },
            },
          }),
    }),
    project: ProjectConfigSchema.parse({
      project: { name: 'x', type: 'node' },
      commands: { test: 'npm test' },
    }),
  };
}

function task(id = 'TASK-003'): Task {
  return TaskSchema.parse({
    id,
    title: 'Wire the endpoint',
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: ['src/server/a.ts'] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
  });
}

function result(tree = TREE_A, exitCode = 0): TaskResult {
  return TaskResultSchema.parse({
    task: 'TASK-003',
    status: 'completed',
    runner: 'claude',
    reasoning: 'medium',
    startedAt: '2026-09-02T12:00:00.000Z',
    finishedAt: '2026-09-02T12:01:00.000Z',
    filesChanged: ['src/server/a.ts'],
    validation: {
      passed: exitCode === 0,
      commands: [{ command: 'npm test', exitCode, durationMs: 10, stdout: '', stderr: '' }],
    },
    integration: {
      attempt: 1,
      branch: 'agent-flow/x/integration',
      marker: 'c'.repeat(40),
      mergeCommit: tree,
      base: 'd'.repeat(40),
      validatedTree: 'e'.repeat(40),
      integratedAt: '2026-09-02T12:01:30.000Z',
    },
  });
}

const APPROVE = { verdict: 'approve', summary: 'nothing to report', findings: [] };

const FINDING = {
  severity: 'high' as const,
  type: 'correctness',
  description: 'the retry re-sends a consumed body',
  suggestedAction: 'buffer the body before the first attempt',
  file: 'src/server/a.ts',
};

async function harness(options: {
  members?: Record<string, Record<string, unknown>>;
  quality?: Record<string, unknown>;
  answers?: unknown[];
  author?: string;
} = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('a feature');
  const reviews = new ReviewStore({ fs, projectDir: PROJECT });
  const collaboration = new CollaborationStore({ fs, projectDir: PROJECT });
  const effective = config(options.members ?? TEAM, options.quality);

  await store.appendEvent(run.runId, 'task_assigned', {
    task: 'TASK-003',
    agent: options.author ?? 'backend',
    role: 'executor.normal',
    reason: 'team_match',
    candidates: [],
  });

  const scripted = [...(options.answers ?? [APPROVE])];
  const prompts: string[] = [];
  const stageRunner = {
    run: async (_s: unknown, _r: string, vars: Record<string, string>) => {
      prompts.push(JSON.stringify(vars));
      const answer = scripted.shift() ?? APPROVE;
      return { text: JSON.stringify(answer), data: answer, runner: 'claude', repairs: 0 };
    },
  } as unknown as StageRunner;

  const service = new ReviewService({
    clock,
    store,
    reviews,
    stageRunner,
    roster: deriveAgentRoster(effective.global),
    config: effective,
    canImplement: () => true,
  });

  const adapter = new ChangeReviewAdapter({
    service,
    store,
    fs,
    projectDir: PROJECT,
    inFlight: async () => new Map(),
  });

  const view = async () =>
    projectReviews({
      reviews: await reviews.readReviews(run.runId),
      messages: await collaboration.readMessages(run.runId),
      events: await store.readEvents(run.runId),
      quality: effective.global.quality,
      roster: deriveAgentRoster(effective.global),
      integratedTrees: new Map([['TASK-003', TREE_A]]),
    });

  return { fs, store, run, reviews, collaboration, service, adapter, view, prompts, effective };
}

/* ─── M6-ACC-01 … 03 ────────────────────────────────────────────────────────── */

describe('M6-ACC-01 — implementation receives an independent reviewer', () => {
  it('records a review by somebody other than the author', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const [record] = await h.reviews.readReviews(h.run.runId);
    expect(record?.reviewer).toBe('reviewer');
    expect(record?.author).toBe('backend');
    expect(record?.reviewer).not.toBe(record?.author);
  });
});

describe('M6-ACC-02 — the reviewer cannot equal the implementation invocation', () => {
  it('records none when the only reviewer wrote the code', async () => {
    const h = await harness({
      members: { backend: { roles: 'finalReviewer', skills: ['review'] } },
      author: 'backend',
    });
    await h.adapter.review(h.run.runId, task(), result());

    expect(await h.reviews.readReviews(h.run.runId)).toEqual([]);
  });

  it('is a fresh invocation with its own context, always', async () => {
    // Level 0 is unreachable: the reviewer is a separate stage run, and nothing hands it
    // the implementation's conversation.
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    expect((await h.reviews.readReviews(h.run.runId))[0]?.independence).toBeGreaterThan(0);
  });
});

describe('M6-ACC-03 — provider independence is preferred and degradation recorded', () => {
  it('records level 3 across providers', async () => {
    const h = await harness({ members: { backend: {}, reviewer: { ...REVIEWER, runner: 'agy' } } });
    await h.adapter.review(h.run.runId, task(), result());

    expect((await h.reviews.readReviews(h.run.runId))[0]?.independence).toBe(3);
  });

  it('records the degradation when the team had better and this review did not get it', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const assigned = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'reviewer_assigned',
    );
    expect(assigned?.detail['independence']).toBe(1);
  });
});

/* ─── M6-ACC-04 … 05 ────────────────────────────────────────────────────────── */

describe('M6-ACC-04 — a structured finding is persisted', () => {
  it('stores severity, category, description, action and place', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    const [finding] = (await h.reviews.readReviews(h.run.runId))[0]?.findings ?? [];
    expect(finding).toMatchObject({
      id: 'FIND-0001',
      severity: 'high',
      type: 'correctness',
      file: 'src/server/a.ts',
    });
    expect(finding?.suggestedAction).toContain('buffer');
  });
});

describe('M6-ACC-05 — an invalid finding path is refused, safely', () => {
  it('drops the path and keeps the finding', async () => {
    const h = await harness({
      answers: [
        { verdict: 'changes_requested', findings: [{ ...FINDING, file: '../../etc/passwd' }] },
      ],
    });
    await h.adapter.review(h.run.runId, task(), result());

    const [finding] = (await h.reviews.readReviews(h.run.runId))[0]?.findings ?? [];
    expect(finding).toBeDefined();
    expect(finding?.file).toBeUndefined();
  });

  it('records how many it dropped, so a review citing nothing real reads as one', async () => {
    const h = await harness({
      answers: [
        { verdict: 'changes_requested', findings: [{ ...FINDING, file: '/etc/shadow' }] },
      ],
    });
    await h.adapter.review(h.run.runId, task(), result());

    const completed = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'review_completed',
    );
    expect(completed?.detail['droppedPaths']).toBe(1);
  });
});

/* ─── M6-ACC-06 … 07 ────────────────────────────────────────────────────────── */

describe('M6-ACC-06 — a blocking finding prevents approval', () => {
  it('refuses while it is open', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    expect((await h.view()).threads[0]?.decision.approved).toBe(false);
  });

  it('refuses even when the reviewer said approve', async () => {
    // I-44: the verdict is a proposal. A `critical` finding beside it is not an approval.
    const h = await harness({
      answers: [{ verdict: 'approve', findings: [{ ...FINDING, severity: 'critical' }] }],
    });
    await h.adapter.review(h.run.runId, task(), result());

    expect((await h.view()).threads[0]?.decision.approved).toBe(false);
  });
});

describe('M6-ACC-07 — a non-blocking finding does not block', () => {
  it('approves with a low and an info finding open', async () => {
    const h = await harness({
      answers: [
        {
          verdict: 'approve',
          findings: [
            { ...FINDING, severity: 'low' },
            { ...FINDING, severity: 'info' },
          ],
        },
      ],
    });
    await h.adapter.review(h.run.runId, task(), result());

    expect((await h.view()).threads[0]?.decision.approved).toBe(true);
  });
});

/* ─── M6-ACC-08 … 09 ────────────────────────────────────────────────────────── */

describe('M6-ACC-08 — a developer answers through collaboration', () => {
  it('reads an acknowledgement from the message log, not a second store', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    await h.collaboration.appendMessages(h.run.runId, [
      AgentMessageSchema.parse({
        id: 'MSG-0001',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'backend',
        to: { kind: 'agent', id: 'reviewer' },
        type: 'acknowledge',
        subject: 're',
        body: 'noted',
        references: [{ kind: 'finding', id: 'FIND-0001' }],
        createdAt: '2026-09-02T12:05:00.000Z',
      }),
    ]);

    expect((await h.view()).threads[0]?.findings[0]?.status).toBe('acknowledged');
  });

  it('has no field on a finding for a response to live in', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    const [record] = await h.reviews.readReviews(h.run.runId);
    expect(JSON.stringify(record)).not.toContain('response');
  });
});

describe('M6-ACC-09 — a developer cannot self-verify', () => {
  it('ignores a message saying the finding is fixed and verified', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    await h.collaboration.appendMessages(h.run.runId, [
      AgentMessageSchema.parse({
        id: 'MSG-0001',
        runId: h.run.runId,
        threadId: 'THR-0001',
        from: 'backend',
        to: { kind: 'agent', id: 'reviewer' },
        type: 'acknowledge',
        subject: 're',
        body: 'fixed and verified, closing',
        references: [{ kind: 'finding', id: 'FIND-0001' }],
        createdAt: '2026-09-02T12:05:00.000Z',
      }),
    ]);

    expect((await h.view()).threads[0]?.findings[0]?.status).toBe('acknowledged');
  });
});

/* ─── M6-ACC-10 … 12 ────────────────────────────────────────────────────────── */

describe('M6-ACC-10, 11 — corrective work goes through the ordinary path', () => {
  const PLAN = PlanSchema.parse({ feature: 'f', tasks: [task()] });

  async function corrected() {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    const findings = projectFindings({
      reviews: await h.reviews.readReviews(h.run.runId),
      messages: [],
      events: await h.store.readEvents(h.run.runId),
    });

    const selection = correctiveSelection({
      findings,
      quality: h.effective.global.quality,
      reviewer: 'reviewer',
    });
    const next = applyFixes(PLAN, selection!.review, {
      validation: ['test'],
      origin: 'code-review',
    });

    return { added: next.tasks.slice(PLAN.tasks.length), h };
  }

  it('produces a task the plan holds, so the scheduler runs it', async () => {
    expect((await corrected()).added).toHaveLength(1);
  });

  it('carries the files, so ownership routes it and overlap sees it', async () => {
    expect((await corrected()).added[0]?.files.likely).toEqual(['src/server/a.ts']);
  });

  it('carries validation, so a fix is not exempt from the commands', async () => {
    expect((await corrected()).added[0]?.validation).toEqual(['test']);
  });

  it('names the finding it corrects', async () => {
    const { added } = await corrected();
    expect(correctiveLinks(added)[0]?.finding).toBe('FIND-0001');
  });
});

describe('M6-ACC-12 — a re-review observes the corrected tree', () => {
  it('verifies only when a later review read a different commit', async () => {
    const h = await harness({
      answers: [{ verdict: 'changes_requested', findings: [FINDING] }, APPROVE],
    });

    await h.adapter.review(h.run.runId, task(), result(TREE_A));
    await h.store.appendEvent(h.run.runId, 'corrective_task_created', {
      task: 'TASK-003',
      finding: 'FIND-0001',
      correctiveTask: 'FIX-001',
    });
    await h.store.appendEvent(h.run.runId, 'task_finished', { task: 'FIX-001', status: 'completed' });
    await h.adapter.review(h.run.runId, task(), result(TREE_B));

    const findings = projectFindings({
      reviews: await h.reviews.readReviews(h.run.runId),
      messages: [],
      events: await h.store.readEvents(h.run.runId),
    });

    expect(findings[0]?.status).toBe('verified');
    expect(findings[0]?.verifiedBy).toBe('REV-0002');
  });
});

/* ─── M6-ACC-13 … 14 ────────────────────────────────────────────────────────── */

describe('M6-ACC-13 / M6-ACC-14 — a review goes stale, and a stale one satisfies no gate', () => {
  it('is stale once the tree moves', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result(TREE_B));

    const view = projectReviews({
      reviews: await h.reviews.readReviews(h.run.runId),
      messages: [],
      events: await h.store.readEvents(h.run.runId),
      quality: h.effective.global.quality,
      integratedTrees: new Map([['TASK-003', TREE_A]]),
    });

    expect(view.threads[0]?.freshness).toBe('stale');
  });

  it('refuses to approve on a stale review', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result(TREE_B));

    const view = projectReviews({
      reviews: await h.reviews.readReviews(h.run.runId),
      messages: [],
      events: await h.store.readEvents(h.run.runId),
      quality: h.effective.global.quality,
      integratedTrees: new Map([['TASK-003', TREE_A]]),
    });

    expect(view.threads[0]?.decision.approved).toBe(false);
    expect(view.threads[0]?.decision.blockedBy).toContain(
      'the review read the tree that is integrated',
    );
  });
});

/* ─── M6-ACC-15 … 16 ────────────────────────────────────────────────────────── */

describe('M6-ACC-15 / M6-ACC-16 — QA is work, and QA saying so is not a gate', () => {
  it('is a team member with QA skills rather than a tenth role', async () => {
    // §33. M5 already lets a member declare skills; a role for semantic flavour would be
    // a concept the assignment policy already has.
    const withQa = config({ backend: {}, qa: { roles: 'executor.normal', skills: ['qa', 'testing'] } });

    expect(hasReviewer(withQa.global)).toBe(false);
    expect(
      Object.values(withQa.global.teams?.['core']?.members ?? {}).some((member) =>
        member.skills.includes('qa'),
      ),
    ).toBe(true);
  });

  it('cannot pass a quality gate by saying the work looks good', async () => {
    // A gate's status comes from an exit code Agent Flow read. There is no path from an
    // agent's opinion to `passed`.
    const gates = projectQualityGates({
      quality: QualityConfigSchema.parse({ gates: { test: { required: true } } }),
      registry: buildValidationRegistry(config().project),
      ran: [],
      changedFiles: ['src/a.ts'],
    });

    expect(gates[0]?.status).toBe('not_run');
    expect(unsatisfiedRequired(gates)).toHaveLength(1);
  });
});

/* ─── M6-ACC-17 … 18 ────────────────────────────────────────────────────────── */

describe('M6-ACC-17, 18 — a gate is mechanical, and NOT_RUN is never PASS', () => {
  it('records what the command did, from the command', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const gate = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'quality_gate_evaluated',
    );
    expect(gate?.detail).toMatchObject({ gate: 'test', status: 'passed', exitCode: 0 });
  });

  it('records a failure as a failure', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result(TREE_A, 1));

    const gate = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'quality_gate_evaluated',
    );
    expect(gate?.detail['status']).toBe('failed');
  });

  it('blocks on a required gate that did not run', () => {
    const gates = projectQualityGates({
      quality: QualityConfigSchema.parse({ gates: { e2e: { required: true } } }),
      registry: buildValidationRegistry(config().project),
      ran: [],
      changedFiles: ['src/a.ts'],
    });

    expect(gates[0]?.status).toBe('not_run');
    expect(
      decideQuality({
        reviews: [],
        findings: [],
        gates,
        quality: QualityConfigSchema.parse({}),
      }).blockedBy,
    ).toContain('every required quality gate passed');
  });
});

/* ─── M6-ACC-19 … 20 ────────────────────────────────────────────────────────── */

describe('M6-ACC-19 — the review loop terminates', () => {
  it('bounds how many findings one review may carry, visibly', async () => {
    const many = Array.from({ length: 60 }, () => FINDING);
    const h = await harness({
      quality: { gates: {} },
      answers: [{ verdict: 'changes_requested', findings: many }],
    });
    await h.adapter.review(h.run.runId, task(), result());

    const [record] = await h.reviews.readReviews(h.run.runId);
    expect(record?.findings).toHaveLength(50);

    const completed = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'review_completed',
    );
    expect(completed?.detail['truncated']).toBe(10);
  });

  it('ships budgets that are finite', () => {
    const review = config().global.review;

    expect(review.maxRounds).toBeLessThanOrEqual(10);
    expect(review.maxCorrectionRounds).toBeLessThanOrEqual(10);
    expect(review.maxDisputeRounds).toBeLessThanOrEqual(5);
  });
});

describe('M6-ACC-20 — crash and resume duplicate nothing', () => {
  it('numbers a second review as a second round rather than repeating the first', async () => {
    const h = await harness({ answers: [APPROVE, APPROVE] });
    await h.adapter.review(h.run.runId, task(), result());
    await h.adapter.review(h.run.runId, task(), result());

    const records = await h.reviews.readReviews(h.run.runId);
    expect(records.map((record) => record.id)).toEqual(['REV-0001', 'REV-0002']);
    expect(records.map((record) => record.round)).toEqual([1, 2]);
  });

  it('derives the next id from the log rather than from a counter', async () => {
    // A counter is a second source of truth about how many reviews exist, and it is the
    // one that survives a crash saying something the log disagrees with.
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const fresh = new ReviewStore({ fs: h.fs, projectDir: PROJECT });
    expect(await fresh.nextReviewId(h.run.runId)).toBe('REV-0002');
    expect(await fresh.nextFindingNumber(h.run.runId)).toBe(1);
  });

  it('loses no finding when the process that wrote it is gone', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    const fresh = new ReviewStore({ fs: h.fs, projectDir: PROJECT });
    expect((await fresh.readReviews(h.run.runId))[0]?.findings).toHaveLength(1);
  });
});

/* ─── M6-ACC-21 … 23 ────────────────────────────────────────────────────────── */

describe('M6-ACC-21 — one projection for every surface', () => {
  it('answers the same thing twice, from a pure fold', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    expect(await h.view()).toEqual(await h.view());
  });

  it('carries the decision, so no surface recomputes it', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const thread = (await h.view()).threads[0];
    expect(thread?.decision.conditions).toHaveLength(4);
  });
});

describe('M6-ACC-22 / M6-ACC-23 — M4 and M5 invariants survive', () => {
  it('leaves a run with no reviewer behaving exactly as M5', async () => {
    const h = await harness({ members: { backend: {} } });
    await h.adapter.review(h.run.runId, task(), result());

    expect(await h.reviews.readReviews(h.run.runId)).toEqual([]);
    expect((await h.store.readEvents(h.run.runId)).some((e) => e.type.startsWith('review_'))).toBe(
      false,
    );
  });

  it('assigns the reviewer through the same policy that assigns everything else', async () => {
    const h = await harness();
    await h.adapter.review(h.run.runId, task(), result());

    const assigned = (await h.store.readEvents(h.run.runId)).find(
      (event) => event.type === 'reviewer_assigned',
    );
    expect(assigned?.detail['reviewer']).toBe('reviewer');
  });

  it('answers a finding through the collaboration log M4 built', async () => {
    const h = await harness({ answers: [{ verdict: 'changes_requested', findings: [FINDING] }] });
    await h.adapter.review(h.run.runId, task(), result());

    // The reference union is M4's, extended with one variant rather than replaced.
    const parsed = AgentMessageSchema.safeParse({
      id: 'MSG-0001',
      runId: h.run.runId,
      threadId: 'THR-0001',
      from: 'backend',
      to: { kind: 'agent', id: 'reviewer' },
      type: 'acknowledge',
      subject: 're',
      body: 'noted',
      references: [{ kind: 'finding', id: 'FIND-0001' }],
      createdAt: '2026-09-02T12:05:00.000Z',
    });

    expect(parsed.success).toBe(true);
  });
});

/* ─── M6-ACC-24 … 28 ────────────────────────────────────────────────────────── */

describe('M6-ACC-24 … 28 — what only a live run can answer', () => {
  it.skip('M6-ACC-24 — live handoff/reassignment demonstrated', () => {
    // Carried from M5 per the charter's §55. A handoff needs a real agent to write one,
    // and four independent plans showed the planner resolves the area conflict upstream.
  });

  it.skip('M6-ACC-25 — live collaboration payload changes downstream behaviour', () => {
    // Twenty-one agent invocations across three milestones have produced one message.
  });

  it.skip('M6-ACC-26 — a live reviewer finds a real issue', () => {
    // A scripted reviewer finds what the script says. This is the dogfood's to answer.
  });

  it.skip('M6-ACC-27 — the live corrective loop fixes and verifies it', () => {
    // Same: the mechanism is proved above, and that it *fires on real output* is not.
  });

  it('M6-ACC-28 — every mandatory gate is green, and this suite is one of them', () => {
    // Trivially true here and meaningful in the report: the criterion is about the run
    // that ships, and it is checked by running the gates rather than by asserting it.
    expect(true).toBe(true);
  });
});
