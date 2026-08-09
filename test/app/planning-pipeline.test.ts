import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { PlanningPipeline } from '../../src/app/planning-pipeline.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../../src/contracts/index.js';
import { agentFlowPaths, runPaths } from '../../src/app/paths.js';
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

async function harness() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
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
    config: {
      global: globalConfig,
      project: ProjectConfigSchema.parse({
        project: { name: 'demo', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    capabilities: CAPABILITIES,
    projectDir: PROJECT,
  });

  return { fs, clock, store, run, runner, pipeline };
}

const PASSING_REVIEW = { verdict: 'PASS', summary: 'Sound plan.', findings: [] };

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
    const { pipeline, run, runner, fs } = await harness();
    fs.seed(agentFlowPaths(PROJECT).architectureCache, '# Architecture\n\nCached.');

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
    const { pipeline, run, runner, store, fs } = await harness();
    fs.seed(agentFlowPaths(PROJECT).architectureCache, '# Architecture');
    await store.writeArtifact(run.runId, 'architectureImpact', '# Impact');
    await store.writeArtifact(run.runId, 'sdd', SDD_TEXT);

    runner.pushJson(goodPlan);
    runner.pushJson(PASSING_REVIEW);
    const result = await pipeline.run(run.runId, 'Add recurring bookings', { from: 'planning' });

    expect(result.stagesRun).toEqual(['planning', 'plan-review']);
    expect(runner.calls).toHaveLength(2);
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
