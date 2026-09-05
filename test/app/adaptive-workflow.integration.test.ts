import { describe, it, expect } from 'vitest';
import { testGitCommand } from '../fakes/test-git-command.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { PlanningPipeline } from '../../src/app/planning-pipeline.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../../src/contracts/index.js';
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

const PROJECT_CONFIG = ProjectConfigSchema.parse({
  project: { name: 'portfolio-app', type: 'static-web' },
  commands: { test: 'npm test' },
});

function seedRealPrompts(fs: InMemoryFileSystem): void {
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
  }
}

describe('Adaptive Workflow Integration', () => {
  it('executes TRIVIAL pipeline with 1 model call and skips SDD / plan review', async () => {
    const fs = new InMemoryFileSystem();
    seedRealPrompts(fs);

    const clock = new FixedClock();
    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const runner = new FakeAgentRunner('claude');
    const processRunner = new FakeProcessRunner().always({ exitCode: 1 });
    const git = testGitCommand(processRunner);

    // TRIVIAL planner response (1 task)
    runner.pushJson({
      feature: 'Fix typo in README',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Fix typo in README.md',
          description: 'Fix the typo in line 4.',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          validation: ['test'],
          validationExpectation: 'pass',
          acceptanceCriteria: ['README typo is fixed'],
        },
      ],
    });

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
      processRunner,
      git,
      store,
      stageRunner,
      config: { global: globalConfig, project: PROJECT_CONFIG },
      capabilities: CAPABILITIES,
      providerOf: () => 'claude-code-cli',
      projectDir: PROJECT,
    });

    const run = await store.createRun('Fix typo in README');
    const result = await pipeline.run(run.runId, 'Fix typo in README');

    expect(result.stagesRun).toEqual(['planning']);
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.review).toBeUndefined();
    expect(runner.calls).toHaveLength(1);

    const updatedState = await store.loadRun(run.runId);
    expect(updatedState.workflow).toBe('trivial');
    expect(updatedState.status).toBe('waiting_for_approval');
  });

  it('executes SIMPLE pipeline with 2 model calls (short plan + plan review)', async () => {
    const fs = new InMemoryFileSystem();
    seedRealPrompts(fs);

    const clock = new FixedClock();
    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const runner = new FakeAgentRunner('claude');
    const processRunner = new FakeProcessRunner().always({ exitCode: 1 });
    const git = testGitCommand(processRunner);

    // SIMPLE planner response (2 tasks)
    runner.pushJson({
      feature: 'Add dark mode toggle',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Add dark theme CSS variables',
          description: 'Define dark mode colors.',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          validation: ['test'],
          validationExpectation: 'pass',
          acceptanceCriteria: ['Dark variables are defined in style.css'],
        },
        {
          id: 'TASK-002',
          title: 'Add theme toggle switch button',
          description: 'Implement dark/light toggle in header.',
          complexity: 'normal',
          risk: 'low',
          dependencies: ['TASK-001'],
          requirements: ['FR-001'],
          validation: ['test'],
          validationExpectation: 'pass',
          acceptanceCriteria: ['Toggle switches theme in localStorage'],
        },
      ],
    });

    // SIMPLE plan-review response
    runner.pushJson({
      verdict: 'PASS',
      summary: 'Plan is focused and addresses dark mode cleanly.',
      findings: [],
    });

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
      processRunner,
      git,
      store,
      stageRunner,
      config: { global: globalConfig, project: PROJECT_CONFIG },
      capabilities: CAPABILITIES,
      providerOf: () => 'claude-code-cli',
      projectDir: PROJECT,
    });

    const run = await store.createRun('Implement dark mode theme toggle');
    const result = await pipeline.run(run.runId, 'Implement dark mode theme toggle');

    expect(result.stagesRun).toEqual(['planning', 'plan-review']);
    expect(result.plan.tasks).toHaveLength(2);
    expect(result.review?.verdict).toBe('PASS');
    expect(runner.calls).toHaveLength(2);

    const updatedState = await store.loadRun(run.runId);
    expect(updatedState.workflow).toBe('simple');
    expect(updatedState.status).toBe('waiting_for_approval');
  });

  it('rejects SIMPLE plans that exceed the 3-task ceremony budget guardrail', async () => {
    const fs = new InMemoryFileSystem();
    seedRealPrompts(fs);

    const clock = new FixedClock();
    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const runner = new FakeAgentRunner('claude');
    const processRunner = new FakeProcessRunner().always({ exitCode: 1 });
    const git = testGitCommand(processRunner);

    // Over-orchestrated planner response (4 tasks for a simple theme request). The pipeline
    // hands a refused plan back to the planner once, so the planner has to insist for the
    // guardrail to be what the run finally fails on.
    const overOrchestrated = {
      feature: 'Add dark mode toggle',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Task 1',
          description: 'Task 1',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          validation: ['test'],
          validationExpectation: 'pass',
          acceptanceCriteria: ['Done'],
        },
        {
          id: 'TASK-002',
          title: 'Task 2',
          description: 'Task 2',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          validation: ['test'],
          validationExpectation: 'pass',
          acceptanceCriteria: ['Done'],
        },
        {
          id: 'TASK-003',
          title: 'Task 3',
          description: 'Task 3',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          validation: ['test'],
          validationExpectation: 'pass',
          acceptanceCriteria: ['Done'],
        },
        {
          id: 'TASK-004',
          title: 'Task 4',
          description: 'Task 4',
          complexity: 'trivial',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          validation: ['test'],
          validationExpectation: 'pass',
          acceptanceCriteria: ['Done'],
        },
      ],
    };
    runner.pushJson(overOrchestrated);
    runner.pushJson(overOrchestrated);

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
      processRunner,
      git,
      store,
      stageRunner,
      config: { global: globalConfig, project: PROJECT_CONFIG },
      capabilities: CAPABILITIES,
      providerOf: () => 'claude-code-cli',
      projectDir: PROJECT,
    });

    const run = await store.createRun('Implement dark mode theme toggle');
    await expect(pipeline.run(run.runId, 'Implement dark mode theme toggle')).rejects.toThrow(
      /SIMPLE workflow ceremony budget allows at most 3 tasks/,
    );
  });
});
