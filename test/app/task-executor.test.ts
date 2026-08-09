import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { TaskExecutor, parseResultBlock } from '../../src/app/task-executor.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { GlobalConfigSchema, ProjectConfigSchema, TaskSchema } from '../../src/contracts/index.js';
import { runPaths } from '../../src/app/paths.js';

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

const task = (overrides: Record<string, unknown> = {}) =>
  TaskSchema.parse({
    id: 'TASK-001',
    title: 'Add recurrence types',
    description: 'Domain types for recurrence.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['Types compile.'],
    validation: [],
    ...overrides,
  });

const COMPLETED = `Done.

## RESULT

STATUS: COMPLETED

FILES CHANGED:
- src/recurrence.ts

VALIDATION:
- npm test: passed

DEVIATIONS:
- none

NOTES:
- none
`;

async function harness(options: { processRunner?: FakeProcessRunner } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);
  const processRunner = options.processRunner ?? new FakeProcessRunner().always({ exitCode: 0 });

  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('f');

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config: globalConfig,
    capabilities: { claude: CAPS },
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: () => runner,
    projectDir: PROJECT,
  });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner,
    processRunner,
    config: {
      global: globalConfig,
      project: ProjectConfigSchema.parse({ project: { name: 'x', type: 'node' } }),
    },
    projectDir: PROJECT,
  });

  return { fs, store, run, runner, processRunner, executor };
}

describe('parseResultBlock', () => {
  it('reads a well-formed report', () => {
    const report = parseResultBlock(COMPLETED);
    expect(report.status).toBe('COMPLETED');
    expect(report.filesChanged).toEqual(['src/recurrence.ts']);
    expect(report.deviations).toEqual([]);
  });

  it('recognises BLOCKED', () => {
    const report = parseResultBlock('## RESULT\n\nSTATUS: BLOCKED\n\nNOTES:\n- Need a decision.\n');
    expect(report.status).toBe('BLOCKED');
    expect(report.notes).toEqual(['Need a decision.']);
  });

  it('treats a missing block as completed rather than discarding the work', () => {
    // The block is a convention. A response that did the work but formatted
    // the summary badly should not be thrown away.
    expect(parseResultBlock('I changed some files.').status).toBe('COMPLETED');
  });

  it('finds BLOCKED even without the surrounding block', () => {
    // The one thing read strictly: missing this would record a task that
    // stopped for a missing decision as done.
    expect(parseResultBlock('STATUS: BLOCKED — need a decision').status).toBe('BLOCKED');
  });

  it('drops "none" placeholders', () => {
    const report = parseResultBlock('## RESULT\nSTATUS: COMPLETED\nDEVIATIONS:\n- none\n');
    expect(report.deviations).toEqual([]);
  });

  it('collects several changed files', () => {
    const report = parseResultBlock(
      '## RESULT\nSTATUS: COMPLETED\nFILES CHANGED:\n- a.ts\n- b.ts\n\nNOTES:\n- none\n',
    );
    expect(report.filesChanged).toEqual(['a.ts', 'b.ts']);
  });
});

describe('executing a task', () => {
  it('runs with write permission, unlike planning', async () => {
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    await executor.execute(task(), run.runId, 'SDD');
    expect(runner.lastCall?.permissions).toBe('write');
  });

  it('gives the agent the task and the approved SDD', async () => {
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    await executor.execute(task(), run.runId, '# SDD\n\nFR-001: something');

    expect(runner.lastCall?.prompt).toContain('TASK-001');
    expect(runner.lastCall?.prompt).toContain('FR-001');
  });

  it('routes by classification (§15)', async () => {
    // executor.complex is configured at `high` effort; trivial at `low`.
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    await executor.execute(task({ complexity: 'complex', risk: 'high' }), run.runId, 'SDD');
    expect(runner.lastCall?.reasoning).toBe('high');
  });

  it('persists a result file for the task (§21)', async () => {
    const { executor, runner, run, fs } = await harness();
    runner.pushText(COMPLETED);

    await executor.execute(task(), run.runId, 'SDD');

    const path = runPaths(PROJECT, run.runId).taskResult('TASK-001');
    const result = JSON.parse(await fs.readFile(path)) as Record<string, unknown>;

    expect(result['task']).toBe('TASK-001');
    expect(result['status']).toBe('completed');
    // What actually ran, not what was configured — they differ under fallback.
    expect(result['runner']).toBe('claude');
  });
});

describe('validation is run by agent-flow, not reported by the agent (§42)', () => {
  it('executes the task validation commands itself', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    await executor.execute(task({ validation: ['npm test -- recurrence'] }), run.runId, 'SDD');

    expect(proc.calls).toHaveLength(1);
    expect(proc.lastCall?.args[1]).toContain('npm test -- recurrence');
  });

  it('sends a task to review when its validation fails', async () => {
    // Never to another model (§55): a failing check is information about the
    // work, and routing around it would replace a visible problem with a quiet
    // one.
    const proc = new FakeProcessRunner().always({ exitCode: 1, stdout: 'expected 1 to be 2' });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(task({ validation: ['npm test'] }), run.runId, 'SDD');

    expect(result.status).toBe('review_required');
    expect(result.validation.passed).toBe(false);
  });

  it('does not take the agent word for it', async () => {
    // The agent claims validation passed; the command says otherwise.
    const proc = new FakeProcessRunner().always({ exitCode: 1 });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(task({ validation: ['npm test'] }), run.runId, 'SDD');
    expect(result.status).not.toBe('completed');
  });

  it('completes a task that declares no validation', async () => {
    const proc = new FakeProcessRunner();
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(task({ validation: [] }), run.runId, 'SDD');

    expect(result.status).toBe('completed');
    expect(proc.calls).toHaveLength(0);
  });
});

describe('BLOCKED', () => {
  it('records the task as blocked and keeps the explanation', async () => {
    const { executor, runner, run } = await harness();
    runner.pushText(
      '## RESULT\n\nSTATUS: BLOCKED\n\nNOTES:\n- The SDD does not say which module owns this.\n',
    );

    const result = await executor.execute(task(), run.runId, 'SDD');

    expect(result.status).toBe('blocked');
    expect(result.errorCode).toBe('blocked');
    expect(result.notes.join(' ')).toContain('does not say');
  });

  it('does not run validation for a blocked task', async () => {
    const proc = new FakeProcessRunner();
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText('## RESULT\nSTATUS: BLOCKED\nNOTES:\n- missing decision\n');

    await executor.execute(task({ validation: ['npm test'] }), run.runId, 'SDD');
    expect(proc.calls).toHaveLength(0);
  });
});

describe('runner failures', () => {
  it('records a failed task with its normalised code', async () => {
    const { executor, runner, run } = await harness();
    runner.pushFailure('quota_exceeded');

    const result = await executor.execute(task(), run.runId, 'SDD');

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('quota_exceeded');
  });
});

describe('events', () => {
  it('logs the task starting and finishing', async () => {
    const { executor, runner, run, store } = await harness();
    runner.pushText(COMPLETED);

    await executor.execute(task(), run.runId, 'SDD');

    const types = (await store.readEvents(run.runId)).map((event) => event.type);
    expect(types).toContain('task_started');
    expect(types).toContain('task_finished');
  });
});
