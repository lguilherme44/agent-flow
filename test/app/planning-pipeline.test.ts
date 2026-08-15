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
  options: { processRunner?: FakeProcessRunner; planningBaseGate?: PlanningGate } = {},
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

  it('re-runs discovery when tracked files were modified', async () => {
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
    expect((await pipeline.run(run.runId, 'second')).stagesRun).toContain('discovery');
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

  it('rejects HIGH-RISK workflow when cross-provider independence cannot be satisfied', async () => {
    const { store } = await harness();
    const fs = new InMemoryFileSystem();
    seedRealPrompts(fs);
    const clock = new FixedClock();
    const runner = new FakeAgentRunner('claude');
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
      processRunner: new FakeProcessRunner(),
      git: testGitCommand(new FakeProcessRunner()),
      config: { global: globalConfig, project: PROJECT_CONFIG },
      capabilities: CAPABILITIES,
      providerOf: () => 'anthropic', // Both planner and planReviewer resolve to anthropic
      projectDir: PROJECT,
    });

    const run = await store.createRun('Add user authentication with JWT token');
    await expect(pipeline.run(run.runId, 'Add user authentication with JWT token')).rejects.toThrow(
      PlanningRefusal,
    );

    const raised = await pipeline
      .run(run.runId, 'Add user authentication with JWT token')
      .catch((err: unknown) => err);
    expect(raised).toBeInstanceOf(PlanningRefusal);
    expect((raised as PlanningRefusal).code).toBe('cross_provider_required');
    expect(runner.calls).toHaveLength(0); // Fails safely with 0 model calls
  });
});
