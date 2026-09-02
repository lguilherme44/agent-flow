import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { runCorrectiveRound } from '../../src/app/corrective-round.js';
import { checkApproval, planHash, approveRun } from '../../src/app/approval.js';
import { buildValidationRegistry } from '../../src/core/validation-registry.js';
import {
  GlobalConfigSchema,
  PlanSchema,
  ProjectConfigSchema,
  ReviewResultSchema,
  type Plan,
  type ReviewFinding,
  type ReviewResult,
} from '../../src/contracts/index.js';

/**
 * AF-H01 — the corrective loop, end to end, without `--force`.
 *
 * The live run that exposed this went: Final Review FAIL → `review --fix` →
 * corrective tasks appended → plan hash changes → approval correctly reopened →
 * `agent-flow approve` refused, because the only plan review on disk described
 * the plan *before* the fixes. The documented way forward was `approve --force`,
 * which records a degradation saying the review gate did not hold.
 *
 * A workflow whose ordinary corrective path requires waiving its own gate has no
 * gate. The fix is not to relax the check — the check is right — but to give the
 * corrected plan a review of its own, through the same service the planning
 * pipeline uses.
 */

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

const PROMPTS = '/pkg/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');
const SDD = readFileSync(join(import.meta.dirname, 'fixtures-sdd.md'), 'utf8');

const PLAN: Plan = PlanSchema.parse({
  feature: 'weekly-recurrence',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Implement generation',
      description: 'Generate occurrences.',
      complexity: 'normal',
      risk: 'medium',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Occurrences are generated.'],
      validation: ['test'],
    },
  ],
});

const FINAL_REVIEW: ReviewResult = ReviewResultSchema.parse({
  verdict: 'FAIL',
  independence: 'cross-provider',
  reviewer: { runner: 'claude', reasoning: 'very_high' },
  findings: [
    {
      severity: 'high',
      type: 'missing_test',
      description: 'Nothing covers the last week of a month.',
      suggestedAction: 'Add a test for the boundary.',
    },
  ],
});

function config() {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'codex', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'codex', effort: 'low' },
        normal: { runner: 'codex', effort: 'medium' },
        complex: { runner: 'codex', effort: 'high' },
      },
      verification: { runner: 'codex', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'very_high' },
    },
  });
}

async function world() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const global = config();
  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const runners = {
    claude: new FakeAgentRunner('claude', CAPS),
    codex: new FakeAgentRunner('codex', CAPS),
  };

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config: global,
    capabilities: { claude: CAPS, codex: CAPS },
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: (resolved) => runners[resolved.runner as 'claude' | 'codex'],
    projectDir: '/repo',
  });

  const project = ProjectConfigSchema.parse({
    project: { name: 'demo', type: 'node' },
    commands: { test: 'npm test' },
  });

  const run = await store.createRun('weekly recurrence');
  // A planning stage that actually happened, so the corrective round can find
  // out who wrote the tasks it is about to extend.
  await store.appendEvent(run.runId, 'stage_completed', {
    stage: 'planning',
    role: 'planner',
    runner: 'codex',
    reasoning: 'high',
    reasoningClamped: false,
    attempts: 1,
    startedAt: clock.now(),
    finishedAt: clock.now(),
  });
  await store.writeArtifact(run.runId, 'plan', `${JSON.stringify(PLAN, null, 2)}\n`);

  const round = (overrides: Partial<Parameters<typeof runCorrectiveRound>[0]> = {}) =>
    runCorrectiveRound({
      store,
      stageRunner,
      providerOf: (id: string) => (id === 'claude' ? 'claude-code-cli' : 'codex-cli'),
      runId: run.runId,
      plan: PLAN,
      finalReview: FINAL_REVIEW,
      origin: 'final-review',
      sdd: SDD,
      architectureImpact: '# Impact\n\nTouches the store.',
      validation: buildValidationRegistry(project),
      ...overrides,
    });

  return { fs, clock, store, runners, stageRunner, run, round, project };
}

describe('the corrective loop closes without --force', () => {
  it('gives the corrected plan a review bound to its own hash', async () => {
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'The fix is scoped.', findings: [] });

    const result = await w.round();

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;

    expect(result.added.map((task) => task.id)).toEqual(['FIX-001']);
    expect(result.review.planHash).toBe(planHash(result.plan));
    expect(result.review.planHash).not.toBe(planHash(PLAN));
  });

  it('lets the ordinary approve command through', async () => {
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', findings: [] });

    const result = await w.round();
    if (result.outcome !== 'applied') throw new Error('expected the round to apply');

    const state = await w.store.loadRun(w.run.runId);
    const check = checkApproval(state, result.plan, result.review);

    expect(state.status).toBe('waiting_for_approval');
    expect(check.allowed).toBe(true);
    expect(check.refusal).toBeUndefined();
  });

  it('does not force anything, so nothing is recorded as forced', async () => {
    // The whole point. A corrective round that needed --force left every run
    // carrying a `forced_approval` degradation saying its gate did not hold.
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', findings: [] });

    const result = await w.round();
    if (result.outcome !== 'applied') throw new Error('expected the round to apply');

    await approveRun(w.store, w.run.runId, result.plan);

    const state = await w.store.loadRun(w.run.runId);
    expect(state.degradations.map((d) => d.kind)).not.toContain('forced_approval');
    expect(state.approvedPlanHash).toBe(planHash(result.plan));
  });

  it('reopens the gate before the review runs, not after', async () => {
    // Ordering, not decoration: a crash between writing the plan and reviewing
    // it must not leave a run approved for a document nobody approved.
    const w = await world();
    await approveRun(w.store, w.run.runId, PLAN);

    w.runners.claude.push(async () => {
      const midway = await w.store.loadRun(w.run.runId);
      expect(midway.approved).toBe(false);
      expect(midway.approvedPlanHash).toBeUndefined();
      return { ok: true, text: JSON.stringify({ verdict: 'PASS', findings: [] }), durationMs: 1 };
    });

    await w.round();
  });

  it('rejects the run when the corrected plan fails its review', async () => {
    const w = await world();
    w.runners.claude.pushJson({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'high',
          type: 'scope',
          description: 'The fix rewrites more than the finding asked for.',
          suggestedAction: 'Narrow it.',
        },
      ],
    });

    const result = await w.round();
    if (result.outcome !== 'applied') throw new Error('expected the round to apply');

    const state = await w.store.loadRun(w.run.runId);
    expect(state.status).toBe('plan_rejected');
    expect(checkApproval(state, result.plan, result.review).refusal?.kind).toBe('review_failed');
  });

  it('writes nothing when no finding is severe enough', async () => {
    const w = await world();
    const low = ReviewResultSchema.parse({
      ...FINAL_REVIEW,
      findings: [{ ...FINAL_REVIEW.findings[0], severity: 'low' }],
    });

    const result = await w.round({ finalReview: low });

    expect(result.outcome).toBe('nothing_actionable');
    // No review was spent, and the plan on disk is untouched.
    expect(w.runners.claude.calls).toHaveLength(0);
    expect(await w.store.readArtifact(w.run.runId, 'plan')).toContain('TASK-001');
  });
});

describe('the corrected plan is judged on who really wrote it', () => {
  it('is not independent of the reviewer whose findings became the tasks', async () => {
    // The FIX tasks are a transcription of the final reviewer's conclusions.
    // A plan review by that same provider is a fresh context, not an
    // independent one, and the artifact must not claim otherwise.
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', findings: [] });

    const result = await w.round();
    if (result.outcome !== 'applied') throw new Error('expected the round to apply');

    // planner=codex, final reviewer=claude, plan reviewer=claude.
    expect(result.review.independence).toBe('same-provider-fresh-context');

    const state = await w.store.loadRun(w.run.runId);
    expect(state.degradations.map((d) => d.kind)).toContain('single_provider');
  });

  it('is independent when neither author shares the reviewer’s provider', async () => {
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', findings: [] });

    const result = await w.round({
      finalReview: ReviewResultSchema.parse({
        ...FINAL_REVIEW,
        reviewer: { runner: 'codex', reasoning: 'high' },
      }),
    });
    if (result.outcome !== 'applied') throw new Error('expected the round to apply');

    expect(result.review.independence).toBe('cross-provider');
  });
});

describe('a corrective plan passes the same mechanical checks', () => {
  it('refuses to write a plan that would not survive them', async () => {
    const w = await world();

    // A finding that cites a requirement the SDD never declared. The generator
    // would happily transcribe it; the plan must not reach a reviewer.
    const result = await w.round({
      finalReview: ReviewResultSchema.parse({
        ...FINAL_REVIEW,
        findings: [{ ...FINAL_REVIEW.findings[0], requirement: 'FR-099' }],
      }),
    });

    expect(result.outcome).toBe('invalid_plan');
    if (result.outcome !== 'invalid_plan') return;
    expect(result.problems.join(' ')).toContain('FR-099');

    // Nothing was written and no review was spent.
    expect(w.runners.claude.calls).toHaveLength(0);
    expect(await w.store.readArtifact(w.run.runId, 'plan')).not.toContain('FIX-001');
  });
});

/**
 * AD-46, C-18 and I-25 (AR-05b) — what an approval already authorised.
 *
 * `runCorrectiveRound` cleared `approved` unconditionally, and the reason was sound: a
 * human approved a set of tasks and a corrective round is a different set. AD-46's claim
 * is that "different set" is *measurable* — a fix touching only files this run already
 * changed, citing only requirements the SDD already declares, adding no contract and no
 * validation id is the same agreement executed correctly.
 *
 * Eleven of the evidence run's sixteen manual operations came after approval, and none of
 * them was a decision. This is the one that removes the last of them.
 */
describe('a corrective round inside the envelope keeps its approval (AD-46, C-18)', () => {
  /** Everything the round needs to be judged inside: the SDD's own ids, the plan's files. */
  const insideEnvelope = (touched: string[], validationIds: readonly string[]) => ({
    context: {
      touchedFiles: touched,
      declaredRequirements: ['FR-001', 'FR-002', 'FR-003', 'NFR-001', 'NFR-002'],
      declaredValidationIds: validationIds,
      contractPaths: ['src/contracts/'],
    },
    budget: { correctiveRoundsUsed: 0, maxCorrectiveRounds: 2 },
  });

  async function approved() {
    const w = await world();
    await approveRun(w.store, w.run.runId, PLAN);
    expect((await w.store.loadRun(w.run.runId)).approved).toBe(true);
    return w;
  }

  it('does not clear approval when every task is inside', async () => {
    const w = await approved();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    // The finding names no file, so `applyFixes` declares none — a task that claims
    // nothing cannot be outside a set it makes no claim about.
    const outcome = await w.round({ envelope: insideEnvelope(['src/recurrence.ts'], buildValidationRegistry(w.project).ids) });

    expect(outcome.outcome).toBe('applied');
    expect((await w.store.loadRun(w.run.runId)).approved).toBe(true);
  });

  it('clears approval when a task reaches a file this run never touched', async () => {
    const w = await approved();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    const outcome = await w.round({
      finalReview: ReviewResultSchema.parse({
        ...FINAL_REVIEW,
        findings: [{ ...FINAL_REVIEW.findings[0], file: 'src/never-touched.ts' }],
      }),
      envelope: insideEnvelope(['src/recurrence.ts'], buildValidationRegistry(w.project).ids),
    });

    expect(outcome.outcome).toBe('applied');
    expect((await w.store.loadRun(w.run.runId)).approved).toBe(false);
  });

  it('records the evaluation per task, whichever way it went', async () => {
    // C-18 asks for the reason a task *passed*, not only the reason one failed. A record
    // of refusals alone cannot answer "why did this not ask me".
    const w = await approved();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    await w.round({ envelope: insideEnvelope(['src/recurrence.ts'], buildValidationRegistry(w.project).ids) });

    const evaluated = (await w.store.readEvents(w.run.runId)).find(
      (event) => event.type === 'corrective_envelope_evaluated',
    );

    expect(evaluated?.detail).toMatchObject({ evaluated: true, mayProceed: true });
    const tasks = evaluated?.detail?.['tasks'] as { id: string; reason: string }[];
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('clears approval when the corrective budget is spent', async () => {
    // Condition 5, and it applies to the round rather than to a task: an envelope full of
    // inside-tasks does not buy another round.
    const w = await approved();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    await w.round({
      envelope: {
        ...insideEnvelope(['src/recurrence.ts'], buildValidationRegistry(w.project).ids),
        budget: { correctiveRoundsUsed: 2, maxCorrectiveRounds: 2 },
      },
    });

    expect((await w.store.loadRun(w.run.runId)).approved).toBe(false);
  });

  it('still stops on a reviewer that rejects the corrected plan', async () => {
    // The envelope answers "is this the same agreement". It does not answer "is this plan
    // any good", and a reviewer's objection is semantic — I-25 does not overrule it.
    const w = await approved();
    w.runners.claude.pushJson({
      verdict: 'FAIL',
      summary: 'The fix misses the case.',
      findings: [
        { severity: 'high', type: 'correctness', description: 'Still wrong.', suggestedAction: 'Redo.' },
      ],
    });

    await w.round({ envelope: insideEnvelope(['src/recurrence.ts'], buildValidationRegistry(w.project).ids) });

    expect((await w.store.loadRun(w.run.runId)).status).toBe('plan_rejected');
  });

  it('reopens approval when no envelope is supplied at all', async () => {
    // The default has to be the cautious one: a caller that cannot compute the envelope
    // must not be given the benefit of it. This is every caller predating AR-05b.
    const w = await approved();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    await w.round();

    expect((await w.store.loadRun(w.run.runId)).approved).toBe(false);
  });
});

/**
 * The link a finding's lifecycle runs on.
 *
 * `projectFindings` derives `fixed` from `corrective_task_created` paired with the task
 * completing, and read that event from the day M6 was written while nothing emitted it.
 * Every test that exercised the projection supplied the event itself, so the suite was
 * green and no finding in a real run could ever leave `open`.
 */
describe('a corrective task records which finding asked for it', () => {
  /**
   * Built rather than parsed, and that is the point.
   *
   * `ReviewResultSchema` describes a *proposed* finding, which has no id — Agent Flow
   * assigns those (§16), so parsing here would strip the very field the link is made of.
   * Production never round-trips these: `correctiveSelection` hands the generator
   * `ReviewFinding`s straight off the projection. A fixture that parsed would be testing a
   * state the product never reaches.
   */
  const reviewWith = (id: string): ReviewResult => {
    const findings: ReviewFinding[] = [
      {
        id: id as ReviewFinding['id'],
        severity: 'high',
        type: 'correctness',
        description: 'The assertion cannot fail: the substring survives escaped.',
        suggestedAction: 'Assert on the attribute, not on the whole output.',
        file: 'test/orders.test.js',
        evidence: [],
      },
    ];

    return {
      verdict: 'FAIL',
      independence: 'cross-provider',
      reviewer: { runner: 'reviewer', reasoning: 'high' },
      findings,
      adjudications: [],
      residualRisks: [],
    };
  };

  it('appends the event the finding projection reads', async () => {
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    const result = await w.round({ finalReview: reviewWith('FIND-0001') });
    expect(result.outcome).toBe('applied');

    const created = (await w.store.readEvents(w.run.runId)).filter(
      (event) => event.type === 'corrective_task_created',
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.detail).toMatchObject({ finding: 'FIND-0001' });
  });

  it('labels the task with the review that raised it, not with the batch', async () => {
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    const result = await w.round({
      finalReview: reviewWith('FIND-0002'),
      origin: 'final-review',
      originFor: new Map([['FIND-0002', 'code-review' as const]]),
    });

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(result.added[0]?.correctiveFor?.stage).toBe('code-review');
  });

  it('still labels a run-level finding as the run-level review', async () => {
    const w = await world();
    w.runners.claude.pushJson({ verdict: 'PASS', summary: 'Scoped.', findings: [] });

    // No id, which is what a run-level review produces — and so no entry in the map.
    const result = await w.round({ originFor: new Map([['FIND-0002', 'code-review' as const]]) });

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(result.added[0]?.correctiveFor?.stage).toBe('final-review');
    expect(result.added[0]?.correctiveFor?.finding).toBeUndefined();
  });
});
