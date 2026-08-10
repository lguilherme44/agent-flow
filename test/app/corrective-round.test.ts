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

  return { fs, clock, store, runners, stageRunner, run, round };
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
