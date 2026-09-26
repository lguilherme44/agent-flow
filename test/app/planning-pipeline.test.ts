import { describe, it, expect } from 'vitest';
import { testGitCommand } from '../fakes/test-git-command.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import {
  PlanningPipeline,
  PlanningRefusal,
  type PlanningGate,
} from '../../src/app/planning-pipeline.js';
import { StageFailure, StageRunner } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../../src/contracts/index.js';
import { agentFlowPaths, runPaths } from '../../src/app/paths.js';
import { computeFingerprint, writeFingerprint } from '../../src/app/discovery-cache.js';
import type { ExecutorCommands } from '../../src/core/command-grants.js';
import { stringify as toYaml } from 'yaml';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = '/repo';
const PROMPTS = '/pkg/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const globalConfig = GlobalConfigSchema.parse({
  runners: { claude: { type: 'claude-code-cli' } },
  roles: {
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
    finalReviewer: { runner: 'claude', effort: 'very_high' },
  },
});

const CAPABILITIES = {
  claude: {
    supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
    supportsReadOnly: true,
    supportsNonInteractive: true,
    supportsWorkingDirectory: true,
    structuredOutputStrategy: 'native',
    nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
  },
} as const;

/** The real shipped prompts, so the pipeline is exercised against what ships. */
function seedRealPrompts(fs: InMemoryFileSystem): void {
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
  }
}

const SDD_TEXT = `# Software Design Document

## Context
x
## Problem
x
## Current Behavior
x
## Desired Behavior
x
## Functional Requirements
- FR-001: Generate recurring bookings.
- FR-002: Cancel one occurrence.
## Non-Functional Requirements
- NFR-001: Generation completes within 200ms.
## Architecture
x
## Components Affected
x
## Database Changes
x
## API Changes
x
## Frontend Changes
None. No user interface is involved.
## Domain Changes
x
## Contracts and Interfaces
x
## Security
x
## Observability
x
## Migration Strategy
x
## Testing Strategy
x
## Edge Cases
x
## Risks
x
## Alternatives Considered
x
## Acceptance Criteria
- A weekly rule produces the expected occurrences.
`;

const goodPlan = {
  feature: 'recurring-bookings',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types for recurrence rules.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile and are exported.'],
      validation: [],
    },
    {
      id: 'TASK-002',
      title: 'Add cancellation',
      description: 'Cancel a single occurrence.',
      complexity: 'normal',
      risk: 'medium',
      dependencies: ['TASK-001'],
      requirements: ['FR-002'],
      acceptanceCriteria: ['Cancelling one occurrence leaves the series intact.'],
      validation: [],
    },
  ],
};

async function harness(
  options: {
    processRunner?: FakeProcessRunner;
    planningBaseGate?: PlanningGate;
    executorCommands?: ExecutorCommands;
  } = {},
) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const processRunner = options.processRunner ?? new FakeProcessRunner().always({ exitCode: 1 });
  const runner = new FakeAgentRunner('claude');

  seedRealPrompts(fs);

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('recurring-bookings');

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config: globalConfig,
    capabilities: CAPABILITIES,
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: () => runner,
    projectDir: PROJECT,
  });

  const pipeline = new PlanningPipeline({
    fs,
    clock,
    store,
    stageRunner,
    processRunner,
    git: testGitCommand(processRunner),
    config: { global: globalConfig, project: PROJECT_CONFIG },
    capabilities: CAPABILITIES,
    providerOf: (id: string) => (id === 'claude' ? 'claude-code-cli' : 'codex-cli'),
    projectDir: PROJECT,
    ...(options.planningBaseGate === undefined
      ? {}
      : { planningBaseGate: options.planningBaseGate }),
    ...(options.executorCommands === undefined ? {} : { executorCommands: options.executorCommands }),
  });

  return { fs, clock, store, run, runner, pipeline, processRunner };
}

const PROJECT_CONFIG = ProjectConfigSchema.parse({
  project: { name: 'demo', type: 'node' },
  commands: { test: 'npm test' },
});

const PASSING_REVIEW = { verdict: 'PASS', summary: 'Sound plan.', findings: [] };

/**
 * Seeds a cached map together with a fingerprint that matches the current
 * repository. Writing only the file leaves a cache that cannot be trusted, and
 * the pipeline correctly refuses it — see the orphaned-cache test below.
 */
async function seedValidCache(
  fs: InMemoryFileSystem,
  processRunner: FakeProcessRunner,
  content: string,
): Promise<void> {
  fs.seed(agentFlowPaths(PROJECT).architectureCache, content);
  await writeFingerprint(
    fs,
    PROJECT,
    await computeFingerprint({
      fs,
      git: testGitCommand(processRunner),
      projectDir: PROJECT,
      // Must match what the pipeline renders, or the fingerprints differ and
      // the cache is correctly treated as stale.
      projectConfig: toYaml(PROJECT_CONFIG).trim(),
    }),
  );
}

/** Queues one good response per stage, in pipeline order. */
function scriptHappyPath(runner: FakeAgentRunner): void {
  runner.pushText('# Architecture\n\nA Node service.');
  runner.pushText('# Architecture Impact\n\nTouches the booking module.');
  runner.pushText(SDD_TEXT);
  runner.pushJson(goodPlan);
  runner.pushJson(PASSING_REVIEW);
}

describe('happy path', () => {
  it('runs the four stages and returns a validated plan', async () => {
    const { pipeline, run, runner } = await harness();
    scriptHappyPath(runner);

    const result = await pipeline.run(run.runId, 'Add recurring bookings');

    expect(result.stagesRun).toEqual([
      'discovery',
      'architecture-impact',
      'sdd',
      'planning',
      'plan-review',
    ]);
    expect(result.plan.tasks).toHaveLength(2);
  });

  it('persists every artifact inside the run, and discovery outside it', async () => {
    const { pipeline, run, runner, fs } = await harness();
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'Add recurring bookings');

    const paths = runPaths(PROJECT, run.runId);
    expect(await fs.exists(paths.request)).toBe(true);
    expect(await fs.exists(paths.architectureImpact)).toBe(true);
    expect(await fs.exists(paths.sdd)).toBe(true);
    expect(await fs.exists(paths.plan)).toBe(true);

    // Feature-agnostic, so it is shared rather than trapped in one run (R-07).
    expect(await fs.exists(agentFlowPaths(PROJECT).architectureCache)).toBe(true);
  });

  it('passes the feature request into every feature-specific stage', async () => {
    const { pipeline, run, runner } = await harness();
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'Add recurring bookings');

    // Discovery is deliberately excluded: it must stay feature-agnostic.
    expect(runner.calls[0]?.prompt).not.toContain('Add recurring bookings');
    expect(runner.calls[1]?.prompt).toContain('Add recurring bookings');
    expect(runner.calls[2]?.prompt).toContain('Add recurring bookings');
  });

  it('feeds each stage the output of the previous one', async () => {
    const { pipeline, run, runner } = await harness();
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'Add recurring bookings');

    expect(runner.calls[1]?.prompt).toContain('A Node service.');
    expect(runner.calls[2]?.prompt).toContain('Touches the booking module.');
    expect(runner.calls[3]?.prompt).toContain('FR-001');
  });

  it('runs read-only throughout (§35)', async () => {
    // Nothing in planning may modify the repository.
    const { pipeline, run, runner } = await harness();
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'Add recurring bookings');

    for (const call of runner.calls) expect(call.permissions).toBe('read-only');
  });

  it('offers the project validation commands to the planner', async () => {
    const { pipeline, run, runner } = await harness();
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'Add recurring bookings');
    expect(runner.calls[3]?.prompt).toContain('npm test');
  });
});

describe('discovery cache (R-07)', () => {
  it('skips discovery when a cached map exists', async () => {
    // One expensive call saved per feature.
    const { pipeline, run, runner, fs, processRunner } = await harness();
    await seedValidCache(fs, processRunner, '# Architecture\n\nCached.');

    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);

    const result = await pipeline.run(run.runId, 'Add recurring bookings');

    expect(result.stagesRun).not.toContain('discovery');
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls[0]?.prompt).toContain('Cached.');
  });

  it('re-runs discovery when the cache is disabled', async () => {
    const { pipeline, run, runner, fs } = await harness();
    fs.seed(agentFlowPaths(PROJECT).architectureCache, '# Old');
    scriptHappyPath(runner);

    const result = await pipeline.run(run.runId, 'Add recurring bookings', { noCache: true });

    expect(result.stagesRun).toContain('discovery');
    expect(await fs.readFile(agentFlowPaths(PROJECT).architectureCache)).toContain('A Node service.');
  });
});

/**
 * A grounded request: an orchestrating model has already investigated, and says so.
 *
 * Measured 23/09/2026 on two runs: discovery (the feature-agnostic map) took 5–23 min and
 * the facts that changed the plans came from `architecture-impact` reading code — the
 * uncalled pricing helper, the search index consuming the same pricing. With the
 * investigation already in the request, the map is redundant; the claims are what need
 * checking. A cached map is still free, so it is still used.
 */
describe('a grounded request', () => {
  it('skips a fresh discovery and asks the impact to confirm the request in the code', async () => {
    const { pipeline, run, runner, store } = await harness();
    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);

    const result = await pipeline.run(run.runId, 'Add recurring bookings', { grounded: true });

    expect(result.stagesRun).toEqual(['architecture-impact', 'sdd', 'planning', 'plan-review']);
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls[0]?.prompt).toContain('Discovery did not run');
    expect(runner.calls[0]?.prompt).toContain('callers');

    const events = await store.readEvents(run.runId);
    expect(events.find((e) => e.type === 'stage_skipped')?.detail).toMatchObject({
      stage: 'discovery',
      reason: 'grounded_request',
    });
    expect((await store.loadRun(run.runId)).grounded).toBe(true);
  });

  it('still uses a valid cached map, which costs nothing', async () => {
    const { pipeline, run, runner, fs, processRunner, store } = await harness();
    await seedValidCache(fs, processRunner, '# Architecture\n\nCached.');
    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);

    await pipeline.run(run.runId, 'Add recurring bookings', { grounded: true });

    expect(runner.calls[0]?.prompt).toContain('Cached.');
    const events = await store.readEvents(run.runId);
    expect(events.some((e) => e.type === 'stage_skipped')).toBe(false);
  });

  it('stays grounded when the run is planned again without saying so', async () => {
    // `revise` and a resume call the pipeline with the options of *that* call. A run that
    // forgot it was grounded would buy the 20-minute map on its second plan.
    const { pipeline, run, runner } = await harness();
    runner.pushText('# Impact').pushText(SDD_TEXT).pushJson(goodPlan).pushJson(PASSING_REVIEW);
    await pipeline.run(run.runId, 'Add recurring bookings', { grounded: true });

    runner.pushText('# Impact again').pushText(SDD_TEXT).pushJson(goodPlan).pushJson(PASSING_REVIEW);
    const again = await pipeline.run(run.runId, 'Add recurring bookings', { from: 'architecture-impact' });

    expect(again.stagesRun).not.toContain('discovery');
    expect(runner.calls).toHaveLength(8);
  });
});

describe('checkpointing (R-08)', () => {
  it('keeps completed artifacts when a later stage fails', async () => {
    // Four expensive calls; losing the first three to a failure in the fourth
    // is the specific waste checkpointing exists to prevent.
    const { pipeline, run, runner, store } = await harness();
    runner.pushText('# Architecture');
    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.pushFailure('quota_exceeded');

    await expect(pipeline.run(run.runId, 'Add recurring bookings')).rejects.toThrow();

    expect(await store.readArtifact(run.runId, 'sdd')).toContain('FR-001');
    expect(await store.readArtifact(run.runId, 'architectureImpact')).toBe('# Impact');
  });

  it('resumes from a stage without redoing the earlier ones', async () => {
    const { pipeline, run, runner, store, fs, processRunner } = await harness();
    await seedValidCache(fs, processRunner, '# Architecture');
    await store.writeArtifact(run.runId, 'architectureImpact', '# Impact');
    await store.writeArtifact(run.runId, 'sdd', SDD_TEXT);

    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);
    const result = await pipeline.run(run.runId, 'Add recurring bookings', { from: 'planning' });

    expect(result.stagesRun).toEqual(['planning', 'plan-review']);
    expect(runner.calls).toHaveLength(2);
  });

  it('keeps a stale map when resuming past discovery, and says it is stale', async () => {
    // Measured on AF-2026-001 (a Python service, 23/09/2026): `revise --from sdd` re-ran a
    // 10-minute discovery because AGENTS.md and the project config had been edited. The
    // impact and SDD stages honour `--from`; discovery did not, so asking to resume from
    // the SDD still paid for the most expensive stage. The operator asked to resume past
    // it: the map is kept, and its staleness is recorded rather than acted on.
    const { pipeline, run, runner, store, fs } = await harness();
    fs.seed(agentFlowPaths(PROJECT).architectureCache, '# Architecture\n\nA Node service.');
    // No fingerprint at all — the strictest "stale" there is.
    await store.writeArtifact(run.runId, 'architectureImpact', '# Impact');

    runner.pushText(SDD_TEXT);
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);
    const result = await pipeline.run(run.runId, 'Add recurring bookings', { from: 'sdd' });

    expect(result.stagesRun).toEqual(['sdd', 'planning', 'plan-review']);
    const reused = (await store.readEvents(run.runId)).find(
      (e) => e.type === 'stage_reused' && e.detail['stage'] === 'discovery',
    );
    expect(reused?.detail['reason']).toBe('resumed_from_later_stage');
    expect(reused?.detail['stale']).toBe(true);
  });

  it('still runs discovery when resuming past it with no map to keep', async () => {
    const { pipeline, run, runner, store } = await harness();
    await store.writeArtifact(run.runId, 'architectureImpact', '# Impact');

    runner.pushText('# Architecture\n\nA Node service.');
    runner.pushText(SDD_TEXT);
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);
    const result = await pipeline.run(run.runId, 'Add recurring bookings', { from: 'sdd' });

    expect(result.stagesRun[0]).toBe('discovery');
  });

  it('reports progress per stage', async () => {
    const { pipeline, run, runner } = await harness();
    scriptHappyPath(runner);

    const seen: string[] = [];
    await pipeline.run(run.runId, 'Add recurring bookings', {
      onProgress: (stage, status) => seen.push(`${stage}:${status}`),
    });

    expect(seen).toContain('discovery:started');
    expect(seen).toContain('planning:completed');
  });
});

describe('plan validation', () => {
  it('rejects a plan that leaves a requirement uncovered (§41)', async () => {
    const { pipeline, run, runner } = await harness();
    runner.pushText('# Architecture');
    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.pushJson({ feature: 'f', tasks: [goodPlan.tasks[0]] }); // FR-002 orphaned
    runner.always({ ok: true, text: JSON.stringify({ feature: 'f', tasks: [goodPlan.tasks[0]] }), json: { feature: 'f', tasks: [goodPlan.tasks[0]] }, durationMs: 1 });

    await expect(pipeline.run(run.runId, 'x')).rejects.toThrow(/FR-002/);
  });

  it('rejects a plan whose dependencies form a cycle', async () => {
    const cyclic = {
      feature: 'f',
      tasks: [
        { ...goodPlan.tasks[0], dependencies: ['TASK-002'] },
        { ...goodPlan.tasks[1], dependencies: ['TASK-001'] },
      ],
    };

    const { pipeline, run, runner } = await harness();
    runner.pushText('# Architecture');
    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.always({ ok: true, text: JSON.stringify(cyclic), json: cyclic, durationMs: 1 });

    await expect(pipeline.run(run.runId, 'x')).rejects.toThrow(/cycle/i);
  });

  /**
   * Two independent tasks declaring one file — the refusal five of the seven planning
   * failures on a real machine were, and the one the prompt promised would be "asked again".
   */
  const contending = {
    feature: 'recurring-bookings',
    tasks: goodPlan.tasks.map((task) => ({
      ...task,
      dependencies: [],
      files: { likely: ['src/shared.ts'] },
    })),
  };

  it('hands a refused plan back to the planner once, with the checks’ own words attached', async () => {
    const { pipeline, run, runner, store } = await harness();
    runner.pushText('# Architecture');
    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.pushJson(contending);
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);

    const progress: string[] = [];
    const result = await pipeline.run(run.runId, 'Add recurring bookings', {
      onProgress: (stage, status) => progress.push(`${stage}:${status}`),
    });

    // The second answer is the plan the run proceeds with.
    expect(result.plan.tasks.map((task) => task.dependencies)).toEqual([[], ['TASK-001']]);
    expect(result.stagesRun).toContain('plan-review');

    // The planner was asked twice, and the second time it was told exactly what was wrong,
    // beneath the request it was given the first time.
    const planner = runner.calls.map((call) => call.prompt).filter((prompt) => prompt.includes('Add recurring bookings'));
    const repair = planner.find((prompt) => prompt.includes('refused by the mechanical checks'));
    expect(repair).toBeDefined();
    expect(repair).toContain('both declare src/shared.ts');
    expect(repair).toContain('change nothing else');

    // Recorded: one refusal, one repair, and a progress line a person can tell from a start.
    const events = await store.readEvents(run.runId);
    expect(events.filter((e) => e.type === 'stage_failed' && e.detail['stage'] === 'planning')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'planning_repair_requested')).toHaveLength(1);
    expect(events.find((e) => e.type === 'planning_repair_requested')?.detail).toMatchObject({ repair: 1, maxRepairs: 1 });
    expect(progress.filter((line) => line === 'planning:started')).toHaveLength(1);
    expect(progress).toContain('planning:repairing');
    expect(progress).toContain('planning:completed');
  });

  it('asks a person after exactly one repair, and says which attempt was refused', async () => {
    const { pipeline, run, runner, store } = await harness();
    runner.pushText('# Architecture');
    runner.pushText('# Impact');
    runner.pushText(SDD_TEXT);
    runner.always({ ok: true, text: JSON.stringify(contending), json: contending, durationMs: 1 });

    const raised = await pipeline.run(run.runId, 'x').catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(StageFailure);
    expect((raised as StageFailure).failureClass).toBe('plan_rejected_by_checks');
    expect((raised as Error).message).toMatch(/contend for it/);

    const refusals = (await store.readEvents(run.runId)).filter(
      (e) => e.type === 'stage_failed' && e.detail['stage'] === 'planning',
    );
    expect(refusals).toHaveLength(2);
    expect(refusals[0]?.detail['repair']).toBeUndefined();
    expect(refusals[1]?.detail).toMatchObject({ repair: 1 });
    // The planner answered twice and no more: the bound holds.
    expect(runner.calls.filter((call) => call.prompt.includes('Rules the plan must satisfy'))).toHaveLength(2);
  });

  /** A plan asking the executor for a device run: `npm run e2e:android` is neither declared nor granted. */
  const citing = {
    ...goodPlan,
    tasks: [
      { ...goodPlan.tasks[0], description: 'Domain types, confirmed with `npm run e2e:android`.' },
      goodPlan.tasks[1],
    ],
  };
  const moved = {
    ...goodPlan,
    operatorVerifications: [{ check: 'Run `npm run e2e:android` on a device.', reason: 'The executor has no device.' }],
  };
  const bounded: ExecutorCommands = { known: true, any: false, prefixes: ['npm test'] };

  it('holds the planner to what the executor can run, and accepts the measurement moved out (FR-009)', async () => {
    const { pipeline, run, runner, store } = await harness({ executorCommands: bounded });
    runner.pushText('# Architecture').pushText('# Impact').pushText(SDD_TEXT);
    runner.pushJson(citing).pushJson(moved).pushJson(PASSING_REVIEW);

    const result = await pipeline.run(run.runId, 'Add recurring bookings');

    expect(result.plan.operatorVerifications).toHaveLength(1);
    const repair = (await store.readEvents(run.runId)).find((e) => e.type === 'planning_repair_requested');
    const problems = (repair?.detail['problems'] as string[]).join(' ');
    expect(problems).toContain('task TASK-001');
    expect(problems).toContain('in its description');
    expect(problems).toContain('`npm run e2e:android`');
    expect(problems).toContain('operatorVerifications');
  });

  it('claims nothing about the executor when the wiring did not say what it can run', async () => {
    // Positive control for the test above: the refusal came from the executor's command set.
    const { pipeline, run, runner, store } = await harness();
    runner.pushText('# Architecture').pushText('# Impact').pushText(SDD_TEXT);
    runner.pushJson(citing).pushJson(PASSING_REVIEW);

    await pipeline.run(run.runId, 'Add recurring bookings');

    expect((await store.readEvents(run.runId)).some((e) => e.type === 'planning_repair_requested')).toBe(false);
  });

  it('refuses requiredEvidence the task does not validate with, even with the executor unknown (FR-024)', async () => {
    const evidenced = {
      ...goodPlan,
      tasks: [{ ...goodPlan.tasks[0], validation: ['test'], requiredEvidence: ['test-deck'] }, goodPlan.tasks[1]],
    };
    const { pipeline, run, runner } = await harness();
    runner.pushText('# Architecture').pushText('# Impact').pushText(SDD_TEXT);
    runner.always({ ok: true, text: JSON.stringify(evidenced), json: evidenced, durationMs: 1 });

    await expect(pipeline.run(run.runId, 'x')).rejects.toThrow(/nothing would run it/);
  });

  it('tells the planner how an undeclared validation id is declared (FR-023)', async () => {
    const undeclared = { ...goodPlan, tasks: [{ ...goodPlan.tasks[0], validation: ['e2e'] }, goodPlan.tasks[1]] };
    const { pipeline, run, runner } = await harness();
    runner.pushText('# Architecture').pushText('# Impact').pushText(SDD_TEXT);
    runner.always({ ok: true, text: JSON.stringify(undeclared), json: undeclared, durationMs: 1 });

    const raised = await pipeline.run(run.runId, 'x').catch((error: unknown) => error);

    expect((raised as Error).message).toContain('validationCommands');
    expect((raised as Error).message).toContain('"<id>: <command>"');
    expect((raised as Error).message).toContain('available: test');
  });
});

describe('what the planner and the plan reviewer are told the executor can run (FR-018, FR-019)', () => {
  const planningPrompt = (runner: FakeAgentRunner): string =>
    runner.calls.find((call) => call.prompt.includes('ROLE: PLANNING_AGENT'))?.prompt ?? '';
  const reviewPrompt = (runner: FakeAgentRunner): string =>
    runner.calls.find((call) => call.prompt.includes('ROLE: PLAN_REVIEW_AGENT'))?.prompt ?? '';

  it('hands both the executor commands the composition root computed', async () => {
    const executorCommands: ExecutorCommands = {
      known: true,
      any: false,
      prefixes: ['npm test', 'npx vitest'],
    };
    const { pipeline, run, runner } = await harness({ executorCommands });
    scriptHappyPath(runner);

    await pipeline.run(run.runId, 'Add recurring bookings');

    for (const prompt of [planningPrompt(runner), reviewPrompt(runner)]) {
      expect(prompt).toContain('- `npm test`');
      expect(prompt).toContain('- `npx vitest`');
    }
    expect(planningPrompt(runner)).toContain('operatorVerifications');
    expect(reviewPrompt(runner)).toContain('- test (runs: npm test)');
    expect(reviewPrompt(runner)).toContain('a gate the SDD requires that no task lists');
  });

  it('says the executor may run anything, and names no refusal, when every route may', async () => {
    const { pipeline, run, runner } = await harness({
      executorCommands: { known: true, any: true, prefixes: [] },
    });
    scriptHappyPath(runner);

    await pipeline.run(run.runId, 'Add recurring bookings');

    expect(planningPrompt(runner)).toContain('may run any command');
    // The citation check does not run under an any-grant (FR-009), so the prompt must not
    // threaten a refusal the checks will never make.
    expect(planningPrompt(runner)).not.toContain('is rejected.');
    expect(reviewPrompt(runner)).toContain('may run any command');
  });
});

describe('SDD structural validation', () => {
  it('re-prompts when a required section is missing', async () => {
    // The SDD is the contract; a missing section is a blind spot downstream.
    const incomplete = '# SDD\n\n## Context\nx\n## Problem\nx\n';

    const { pipeline, run, runner } = await harness();
    runner.pushText('# Architecture');
    runner.pushText('# Impact');
    runner.pushText(incomplete);
    runner.pushText(SDD_TEXT);
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);

    const result = await pipeline.run(run.runId, 'x');

    expect(result.plan.tasks).toHaveLength(2);
    // The retry must name what was missing rather than just asking again.
    expect(runner.calls[3]?.prompt).toMatch(/Acceptance Criteria|missing required section/i);
  });
});

describe('AGENTS.md', () => {
  it('forwards project instructions when present (§37)', async () => {
    const { pipeline, run, runner, fs } = await harness();
    fs.seed(`${PROJECT}/AGENTS.md`, '# Rules\n\nControllers stay thin.');
    scriptHappyPath(runner);

    await pipeline.run(run.runId, 'x');
    expect(runner.calls[0]?.prompt).toContain('Controllers stay thin.');
  });

  it('says so explicitly when there is none', async () => {
    // Better than an empty section, which reads as an instruction to ignore.
    const { pipeline, run, runner } = await harness();
    scriptHappyPath(runner);

    await pipeline.run(run.runId, 'x');
    expect(runner.calls[0]?.prompt).toContain('No AGENTS.md');
  });
});

describe('the discovery cache is invalidated when the repository changes (V-07 regression)', () => {
  // Was a defect: the cache decision was `exists()`. Nothing about HEAD, the
  // working tree, AGENTS.md or the project config participated, so a repository
  // could be rewritten and every later feature would still be planned against a
  // map of what it used to be. That failure is silent and expensive — the SDD
  // and the plan look reasonable and describe a codebase that is gone.

  /** Drives `git rev-parse` / `git status` for the fingerprint. */
  const gitReturning = (head: string, status = '') =>
    new FakeProcessRunner().always((spawn) =>
      spawn.args.includes('rev-parse') ? { exitCode: 0, stdout: head } : { exitCode: 0, stdout: status },
    );

  it('reuses the cache when nothing relevant changed', async () => {
    const { pipeline, run, runner, fs } = await harness({ processRunner: gitReturning('abc123') });
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'first feature');

    const callsAfterFirst = runner.calls.length;
    expect(await fs.exists(agentFlowPaths(PROJECT).architectureCache)).toBe(true);

    // Second feature, same repository state: discovery must not run again.
    runner.pushText('# Impact').pushText(SDD_TEXT).pushJson(goodPlan).pushJson(PASSING_REVIEW);
    const second = await pipeline.run(run.runId, 'second feature');

    expect(second.stagesRun).not.toContain('discovery');
    expect(runner.calls.length - callsAfterFirst).toBe(4);
  });

  it('re-runs discovery when HEAD moved', async () => {
    const proc = gitReturning('abc123');
    const { pipeline, run, runner } = await harness({ processRunner: proc });
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'first feature');

    // A commit landed.
    proc.always((spawn) =>
      spawn.args.includes('rev-parse') ? { exitCode: 0, stdout: 'def456' } : { exitCode: 0, stdout: '' },
    );

    scriptHappyPath(runner);
    const second = await pipeline.run(run.runId, 'second feature');

    expect(second.stagesRun).toContain('discovery');
  });

  it('reuses the map when files were modified but nothing was committed', async () => {
    // **The opposite of what this asserted, and deliberately.** A modified tracked file
    // used to re-run the most expensive stage in the product, which meant an active working
    // tree almost never got the amortisation this cache exists for. Discovery now opens
    // with an index parsed from the tree at the moment it runs, so what changed on disk
    // reaches the stage without the cached prose being thrown away to deliver it.
    const proc = gitReturning('abc123');
    const { pipeline, run, runner } = await harness({ processRunner: proc });
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'first feature');

    proc.always((spawn) =>
      spawn.args.includes('rev-parse')
        ? { exitCode: 0, stdout: 'abc123' }
        : { exitCode: 0, stdout: ' M src/notes.js' },
    );

    scriptHappyPath(runner);
    expect((await pipeline.run(run.runId, 'second')).stagesRun).not.toContain('discovery');
  });

  it('re-runs discovery when AGENTS.md changed', async () => {
    // The standing rules shape what discovery reports, so a map built before
    // them is answering a different question.
    const { pipeline, run, runner, fs } = await harness({ processRunner: gitReturning('abc123') });
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'first feature');

    fs.seed(`${PROJECT}/AGENTS.md`, '# Rules\n\nControllers stay thin.');

    scriptHappyPath(runner);
    expect((await pipeline.run(run.runId, 'second')).stagesRun).toContain('discovery');
  });

  it('records what invalidated the cache', async () => {
    const proc = gitReturning('abc123');
    const { pipeline, run, runner, store } = await harness({ processRunner: proc });
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'first feature');

    proc.always((spawn) =>
      spawn.args.includes('rev-parse') ? { exitCode: 0, stdout: 'zzz' } : { exitCode: 0, stdout: '' },
    );

    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'second');

    const events = await store.readEvents(run.runId);
    const invalidated = events.find((e) => e.type === 'discovery_cache_invalidated');

    expect(invalidated).toBeDefined();
    expect(String(invalidated?.detail['changed'])).toContain('commit');
  });

  it('still honours --no-cache regardless of the fingerprint', async () => {
    const { pipeline, run, runner } = await harness({ processRunner: gitReturning('abc123') });
    scriptHappyPath(runner);
    await pipeline.run(run.runId, 'first feature');

    scriptHappyPath(runner);
    const second = await pipeline.run(run.runId, 'second', { noCache: true });

    expect(second.stagesRun).toContain('discovery');
  });
});

describe('a cache with no fingerprint is not trusted', () => {
  it('re-runs discovery when the map exists but its fingerprint does not', async () => {
    // Surfaced by the fix itself: two older tests seeded the cache file alone
    // and started failing. That is the right behaviour — a map with nothing
    // recording what it describes cannot be validated, so it is treated the
    // same as having no cache at all rather than being used on faith.
    const { pipeline, run, runner, fs } = await harness();
    fs.seed(agentFlowPaths(PROJECT).architectureCache, '# Architecture\n\nUnverifiable.');

    scriptHappyPath(runner);
    const result = await pipeline.run(run.runId, 'a feature');

    expect(result.stagesRun).toContain('discovery');
  });
});

describe('a repository gate refuses in the repository’s vocabulary (§6.2, Appendix A)', () => {
  /** A pipeline whose gate refuses at a chosen moment, and lets every other pass. */
  async function withGate(refuseAt: string) {
    const asked: string[] = [];
    const built = await harness({
      planningBaseGate: async (_runId, moment) => {
        asked.push(moment);
        return moment === refuseAt
          ? {
              code: 'working_tree_dirty',
              detail: 'the working tree has uncommitted changes: src/a.ts',
              action: 'Commit or stash them, then run this again.',
            }
          : null;
      },
    });

    return { ...built, asked };
  }

  it('raises the canonical refusal code, not a runner error code', async () => {
    // The dogfood defect this test exists for. `assertReady` used to throw
    // `StageFailure('planning', 'invalid_output')`, so a dirty working tree
    // reached the user as "the runner produced output that never satisfied the
    // contract" — a sentence about a model, printed when no model had run.
    const { pipeline, run, runner } = await withGate('planning start');
    scriptHappyPath(runner);

    await expect(pipeline.run(run.runId, 'a feature')).rejects.toThrow(PlanningRefusal);

    const raised = await pipeline.run(run.runId, 'a feature').catch((error: unknown) => error);
    expect(raised).toBeInstanceOf(PlanningRefusal);
    expect((raised as PlanningRefusal).code).toBe('working_tree_dirty');
    // Appendix A's code is what a person looks up in `docs/troubleshooting.md`,
    // so the message carries it rather than paraphrasing it away.
    expect((raised as PlanningRefusal).message).toContain('uncommitted changes');
    expect((raised as PlanningRefusal).action).toMatch(/Commit or stash/);
  });

  it('is not a StageFailure, so nothing offers to retry it elsewhere', async () => {
    // The property that made the old shape actively harmful: `StageFailure`
    // carries `fallbackEligible`, and the renderer explains stage failures in
    // terms of runners and fallbacks. A refusal is met, never routed around
    // (§6.4), so it must not be able to enter that path at all.
    const { pipeline, run, runner } = await withGate('planning start');
    scriptHappyPath(runner);

    const raised = await pipeline.run(run.runId, 'a feature').catch((error: unknown) => error);
    expect(raised).not.toBeInstanceOf(StageFailure);
  });

  it('spends no agent invocation when it refuses at the start', async () => {
    // A refusal costs nothing (§6.4). The gate runs before discovery, so a
    // repository that is not ready never reaches a runner.
    const { pipeline, run, runner } = await withGate('planning start');
    scriptHappyPath(runner);

    await pipeline.run(run.runId, 'a feature').catch(() => undefined);

    expect(runner.calls).toHaveLength(0);
  });

  it('marks run as failed and records planning_refused audit event when refused late', async () => {
    const { pipeline, run, runner, store } = await withGate('architecture-impact');
    scriptHappyPath(runner);

    await expect(pipeline.run(run.runId, 'a feature')).rejects.toThrow(PlanningRefusal);

    const updated = await store.loadRun(run.runId);
    expect(updated.status).toBe('failed');

    const events = await store.readEvents(run.runId);
    const refusalEvent = events.find((e) => e.type === 'planning_refused');
    expect(refusalEvent).toBeDefined();
    expect(refusalEvent?.detail['code']).toBe('working_tree_dirty');
    expect(refusalEvent?.detail['action']).toMatch(/Commit or stash/);
  });

  it('marks run as failed and preserves stage_failed event on runner failure', async () => {
    const { pipeline, run, runner, store } = await withGate('never');
    // Runner fails with quota_exceeded
    runner.pushFailure('quota_exceeded');

    await expect(pipeline.run(run.runId, 'a feature')).rejects.toThrow(StageFailure);

    const updated = await store.loadRun(run.runId);
    expect(updated.status).toBe('failed');

    const events = await store.readEvents(run.runId);
    expect(events.some((e) => e.type === 'stage_failed')).toBe(true);
    expect(events.some((e) => e.type === 'planning_refused')).toBe(false);
  });

  it('lets a satisfied gate through, and asks it at every moment it declares', async () => {
    const { pipeline, run, runner, asked } = await withGate('never');
    scriptHappyPath(runner);

    const result = await pipeline.run(run.runId, 'a feature');

    expect(result.plan.tasks.length).toBeGreaterThan(0);
    expect(asked, 'the gate was never consulted').not.toHaveLength(0);
    expect(asked).toContain('planning start');
  });
});

describe('Adaptive Workflow Pipeline Execution', () => {
  it('executes TRIVIAL workflow in 1 direct model call without SDD or review', async () => {
    const { pipeline, run, runner, store } = await harness();
    runner.pushJson({
      feature: 'Fix typo in documentation',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Fix typo in README',
          description: 'Fix typo',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          validation: [],
          validationExpectation: 'pass',
          acceptanceCriteria: ['Typo fixed'],
        },
      ],
    });

    const result = await pipeline.run(run.runId, 'Fix typo in README documentation');

    expect(result.stagesRun).toEqual(['planning']);
    expect(result.plan.tasks).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);

    const updated = await store.loadRun(run.runId);
    expect(updated.workflow).toBe('trivial');
    expect(updated.status).toBe('waiting_for_approval');
  });

  /**
   * One provider is a choice, not a defect (23/09/2026). HIGH-RISK used to refuse a
   * single-provider setup outright, so a repository whose request mentioned auth, payment or
   * a migration could not be planned at all without a second provider installed. The loss is
   * real but it is information: the review records `same-provider-fresh-context` and every
   * surface that renders a review says so. It is never a gate.
   */
  it('plans a HIGH-RISK workflow on a single provider, and records the review as same-provider', async () => {
    const { pipeline, run, runner, store } = await harness();
    scriptHappyPath(runner);

    const result = await pipeline.run(run.runId, 'Add user authentication with JWT token');

    expect(result.stagesRun).toEqual([
      'discovery',
      'architecture-impact',
      'sdd',
      'planning',
      'plan-review',
    ]);
    expect(result.review?.independence).toBe('same-provider-fresh-context');

    const updated = await store.loadRun(run.runId);
    expect(updated.workflow).toBe('high-risk');
    expect(updated.status).toBe('waiting_for_approval');

    const events = await store.readEvents(run.runId);
    expect(events.some((e) => e.type === 'planning_refused')).toBe(false);
  });

  it('detects sensitive repository paths (auth, db/migrations, payment) and escalates to HIGH-RISK', async () => {
    const { pipeline, run, runner, fs, store } = await harness();
    fs.seed(`${PROJECT}/src/auth/token.ts`, 'export const token = "xyz";');
    fs.seed(`${PROJECT}/db/migrations/001_init.sql`, 'CREATE TABLE users();');
    scriptHappyPath(runner);

    await pipeline.run(run.runId, 'Update user login session handling');

    const updated = await store.loadRun(run.runId);
    expect(updated.workflow).toBe('high-risk');
  });
});

/**
 * FR-014. Where the class came from, recorded by the entry point that knows.
 *
 * `explicitOverride = options.workflow ?? state.workflow` made every re-plan and every
 * `--from` resume record "Explicit workflow override set by operator" when no operator had
 * touched the class.
 */
describe('the origin of the workflow class (FR-014)', () => {
  const ONE_TASK_PLAN = { ...goodPlan, tasks: goodPlan.tasks.slice(0, 1) };

  async function classified(store: StateStore, runId: string): Promise<Record<string, unknown>> {
    const events = (await store.readEvents(runId)).filter((e) => e.type === 'workflow_classified');
    expect(events).toHaveLength(1);
    return events[0]?.detail ?? {};
  }

  it('records an operator override with what the request alone detects', async () => {
    const { pipeline, run, runner, store } = await harness();
    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);

    const result = await pipeline.run(run.runId, 'Add customer feedback form', { workflow: 'simple' });

    const detail = await classified(store, run.runId);
    expect(detail).toMatchObject({ workflow: 'simple', origin: 'operator', requested: 'simple', detected: 'standard' });
    expect(detail['evidence']).toEqual([]);
    // The keys every earlier reader relied on are still there.
    expect(Object.keys(detail)).toEqual(expect.arrayContaining(['workflow', 'rationale', 'budget', 'highRiskSignals']));
    expect(detail['rationale']).toContain('set by operator');

    // The same classification reaches the caller, so `feature` can render it.
    expect(result.classification).toMatchObject({ workflow: 'simple', origin: 'operator', detected: 'standard' });
  });

  it('records a class read back from the run as carried, and never says an operator set it', async () => {
    const { pipeline, run, runner, store } = await harness();
    await store.updateRun(run.runId, (s) => ({ ...s, workflow: 'trivial' }));
    runner.pushJson(ONE_TASK_PLAN);

    const result = await pipeline.run(run.runId, 'Add customer feedback form');

    const detail = await classified(store, run.runId);
    expect(detail).toMatchObject({ workflow: 'trivial', origin: 'carried', requested: 'trivial', detected: 'standard' });
    expect(String(detail['rationale'])).not.toMatch(/operator/i);
    expect(result.classification?.origin).toBe('carried');
  });

  it('records a class a caller says it carried as carried', async () => {
    const { pipeline, run, runner, store } = await harness();
    runner.pushJson(ONE_TASK_PLAN);

    await pipeline.run(run.runId, 'Add customer feedback form', { workflow: 'trivial', workflowOrigin: 'carried' });

    const detail = await classified(store, run.runId);
    expect(detail).toMatchObject({ origin: 'carried', requested: 'trivial' });
    expect(String(detail['rationale'])).not.toMatch(/operator/i);
  });

  it('records a class nothing overrode as detected, with the excerpt that decided it and no requested', async () => {
    // Positive control for the two above: with neither an option nor a persisted class, the
    // origin is the classifier's and there is no `requested` key at all.
    const { pipeline, run, runner, store } = await harness();
    scriptHappyPath(runner);

    await pipeline.run(run.runId, 'Add user authentication with JWT token');

    const detail = await classified(store, run.runId);
    expect(detail).toMatchObject({ workflow: 'high-risk', origin: 'detected', detected: 'high-risk' });
    expect(detail).not.toHaveProperty('requested');
    expect(detail['evidence']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: 'token', excerpt: 'Add user authentication with JWT token', source: 'text' }),
      ]),
    );
  });
});

/**
 * Discovery, ahead of the feature that would otherwise fund it.
 *
 * The map is feature-agnostic and cached, which is why paying for it inside the first
 * request was always an accident of ordering rather than a design. On a large repository
 * it is also the stage most likely not to fit its budget — and a discovery that runs out
 * of time takes the whole planning run with it, at its first stage, before anything that
 * could be reused exists.
 */
describe('warming the repository map', () => {
  it('builds the map and says it ran', async () => {
    const { pipeline, run, runner, fs } = await harness();
    runner.pushText('# Architecture\n\nA Node service.');

    const warm = await pipeline.warm(run.runId);

    expect(warm.ran).toBe(true);
    expect(await fs.readFile(agentFlowPaths(PROJECT).architectureCache)).toContain('A Node service.');
  });

  it('leaves a cache a later run actually reuses', async () => {
    // The point of warming. Without the fingerprint written beside the file the map is
    // correctly refused as untrustworthy, and the warm-up would have bought nothing.
    const { pipeline, run, runner, store } = await harness();
    runner.pushText('# Architecture\n\nA Node service.');
    await pipeline.warm(run.runId);

    const second = await store.createRun('a later feature');

    expect((await pipeline.warm(second.runId)).ran).toBe(false);
  });

  it('re-runs once the repository moves under the warmed map', async () => {
    // The positive control for the test above, and for the defect it guards: a cache
    // reused on existence alone keeps planning against a codebase that is gone. AGENTS.md
    // is one of the four fingerprint inputs, so writing it has to invalidate the map.
    const { pipeline, run, runner, store, fs: files } = await harness();
    runner.pushText('# Architecture\n\nA Node service.');
    await pipeline.warm(run.runId);

    files.seed(`${PROJECT}/AGENTS.md`, '# Project Instructions\n\nPrefer the code index.\n');
    runner.pushText('# Architecture\n\nA Node service, mapped again.');
    const second = await store.createRun('a later feature');

    expect((await pipeline.warm(second.runId)).ran).toBe(true);
  });

  it('spends nothing when the map is already current', async () => {
    const { pipeline, run, runner, fs, processRunner } = await harness();
    await seedValidCache(fs, processRunner, '# Architecture\n\nAlready known.');

    const warm = await pipeline.warm(run.runId);

    expect(warm.ran).toBe(false);
    // Nothing was queued on the runner, so a call would have thrown. Asserted anyway:
    // "it did not run" is the claim, and an empty queue is how it is proven.
    expect(runner.calls.length).toBe(0);
  });

  it('reports an elapsed time rather than inventing one', async () => {
    const { pipeline, run, runner } = await harness();
    runner.pushText('# Architecture\n\nA Node service.');

    const warm = await pipeline.warm(run.runId);

    expect(warm.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(warm.elapsedMs)).toBe(true);
  });
});
