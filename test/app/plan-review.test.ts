import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { PlanningPipeline } from '../../src/app/planning-pipeline.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { GlobalConfigSchema, ReviewResultSchema } from '../../src/contracts/index.js';
import { reviewIndependence } from '../../src/app/stages/plan-review.js';
import { runPaths } from '../../src/app/paths.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = '/repo';
const PROMPTS = '/pkg/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
} as const;

function config(reviewerRunner: string, plannerRunner = 'claude') {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: plannerRunner, effort: 'high' },
      planReviewer: { runner: reviewerRunner, effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: reviewerRunner, effort: 'very_high' },
    },
  });
}

const SDD_TEXT = readFileSync(join(import.meta.dirname, 'fixtures-sdd.md'), 'utf8');

const goodPlan = {
  feature: 'f',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Do it',
      description: 'Implements FR-001.',
      complexity: 'normal',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['It works.'],
      validation: [],
    },
  ],
};

async function harness(reviewerRunner: string) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const global = config(reviewerRunner);
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('f');

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
    projectDir: PROJECT,
  });

  const pipeline = new PlanningPipeline({
    fs,
    clock,
    store,
    stageRunner,
    config: { global },
    capabilities: { claude: CAPS, codex: CAPS },
    projectDir: PROJECT,
  });

  // Everything up to planning is pre-seeded; these tests are about the review.
  fs.seed(`${PROJECT}/.agent-flow/cache/architecture.md`, '# Architecture');
  await store.writeArtifact(run.runId, 'architectureImpact', '# Impact');
  await store.writeArtifact(run.runId, 'sdd', SDD_TEXT);

  return { fs, store, run, runners, pipeline };
}

describe('reviewIndependence', () => {
  it('is cross-provider when the planner and reviewer differ', () => {
    expect(reviewIndependence(config('codex', 'claude'))).toBe('cross-provider');
  });

  it('is same-provider when they are the same runner', () => {
    // §56 permits this, but it is not the same thing and must not be reported
    // as though it were.
    expect(reviewIndependence(config('claude', 'claude'))).toBe('same-provider-fresh-context');
  });
});

describe('cross-provider review', () => {
  it('sends the review to a different runner from the planner', async () => {
    const { pipeline, run, runners } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.pushJson({ verdict: 'PASS', findings: [] });

    await pipeline.run(run.runId, 'f', { from: 'planning' });

    expect(runners.claude.calls).toHaveLength(1);
    expect(runners.codex.calls).toHaveLength(1);
  });

  it('records the independence on the artifact itself (R-16)', async () => {
    const { pipeline, run, runners, fs } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.pushJson({ verdict: 'PASS', findings: [] });

    await pipeline.run(run.runId, 'f', { from: 'planning' });

    const review = ReviewResultSchema.parse(
      JSON.parse(await fs.readFile(runPaths(PROJECT, run.runId).planReview)),
    );
    expect(review.independence).toBe('cross-provider');
    expect(review.reviewer.runner).toBe('codex');
  });

  it('does not record a degradation when independence is real', async () => {
    const { pipeline, run, runners, store } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.pushJson({ verdict: 'PASS', findings: [] });

    await pipeline.run(run.runId, 'f', { from: 'planning' });

    const state = await store.loadRun(run.runId);
    expect(state.degradations.map((d) => d.kind)).not.toContain('single_provider');
  });

  it('gives the reviewer only the artifacts, never the planner conversation (§27)', async () => {
    // The reviewer's value is that it did not participate in producing the
    // plan. Passing the earlier context would destroy exactly that.
    const { pipeline, run, runners } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.pushJson({ verdict: 'PASS', findings: [] });

    await pipeline.run(run.runId, 'f', { from: 'planning' });

    const prompt = runners.codex.lastCall?.prompt ?? '';
    expect(prompt).toContain('FR-001');
    expect(prompt).toContain('TASK-001');
    expect(prompt).not.toContain('PLANNING_AGENT');
  });
});

describe('degraded review', () => {
  it('records a degradation when the reviewer shares the planner runner', async () => {
    // The whole risk of tolerating one provider: reviews stop being independent
    // and nothing says so unless it is written down (RK-12).
    const { pipeline, run, runners, store } = await harness('claude');
    runners.claude.pushJson(goodPlan).pushJson({ verdict: 'PASS', findings: [] });

    await pipeline.run(run.runId, 'f', { from: 'planning' });

    const state = await store.loadRun(run.runId);
    const degradation = state.degradations.find((d) => d.kind === 'single_provider');

    expect(degradation).toBeDefined();
    expect(degradation?.impact).toMatch(/repeated rather than caught/i);
  });

  it('marks the artifact as same-provider', async () => {
    const { pipeline, run, runners, fs } = await harness('claude');
    runners.claude.pushJson(goodPlan).pushJson({ verdict: 'PASS', findings: [] });

    await pipeline.run(run.runId, 'f', { from: 'planning' });

    const review = ReviewResultSchema.parse(
      JSON.parse(await fs.readFile(runPaths(PROJECT, run.runId).planReview)),
    );
    expect(review.independence).toBe('same-provider-fresh-context');
  });
});

describe('verdicts', () => {
  it('moves the run to waiting_for_approval on PASS', async () => {
    const { pipeline, run, runners, store } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.pushJson({ verdict: 'PASS', findings: [] });

    await pipeline.run(run.runId, 'f', { from: 'planning' });
    expect((await store.loadRun(run.runId)).status).toBe('waiting_for_approval');
  });

  it('moves the run to plan_rejected on FAIL', async () => {
    const { pipeline, run, runners, store } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.pushJson({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'high',
          type: 'missing_test',
          description: 'No test covers the cancellation path.',
          suggestedAction: 'Add a task for it.',
        },
      ],
    });

    const result = await pipeline.run(run.runId, 'f', { from: 'planning' });

    expect(result.review?.verdict).toBe('FAIL');
    expect((await store.loadRun(run.runId)).status).toBe('plan_rejected');
  });

  it('rejects a FAIL with no findings', async () => {
    // "It is wrong" without saying why is not reviewable feedback.
    const { pipeline, run, runners } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.always({
      ok: true,
      text: '{"verdict":"FAIL","findings":[]}',
      json: { verdict: 'FAIL', findings: [] },
      durationMs: 1,
    });

    await expect(pipeline.run(run.runId, 'f', { from: 'planning' })).rejects.toThrow();
  });

  it('allows PASS with findings worth mentioning', async () => {
    const { pipeline, run, runners } = await harness('codex');
    runners.claude.pushJson(goodPlan);
    runners.codex.pushJson({
      verdict: 'PASS',
      summary: 'Sound, with one nit.',
      findings: [
        {
          severity: 'low',
          type: 'wrong_order',
          description: 'TASK-001 could come later.',
          suggestedAction: 'Consider reordering.',
        },
      ],
    });

    const result = await pipeline.run(run.runId, 'f', { from: 'planning' });
    expect(result.review?.verdict).toBe('PASS');
    expect(result.review?.findings).toHaveLength(1);
  });
});

describe('skipping review', () => {
  it('stops after planning when asked', async () => {
    const { pipeline, run, runners, store } = await harness('codex');
    runners.claude.pushJson(goodPlan);

    const result = await pipeline.run(run.runId, 'f', { from: 'planning', skipReview: true });

    expect(result.stagesRun).toEqual(['planning']);
    expect(result.review).toBeUndefined();
    expect((await store.loadRun(run.runId)).status).toBe('waiting_for_approval');
  });
});
