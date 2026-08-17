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
import {
  FailedAttemptSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
  TaskAttemptResultSchema,
  TaskSchema,
} from '../../src/contracts/index.js';
import { attemptLogName, runPaths } from '../../src/app/paths.js';
import { createRunnerFactory } from '../../src/app/runner-factory.js';
import { FakeHost } from '../fakes/fake-host.js';
import { testGitCommand } from '../fakes/test-git-command.js';
import { GitWorkspaces } from '../../src/adapters/git/git-workspaces.js';
import type { ProcessResult } from '../../src/ports/index.js';

const PROJECT = '/repo';
const PROMPTS = '/pkg/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
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
      project: ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm test' },
        validationCommands: { recurrence: 'npm test -- recurrence' },
      }),
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

    await executor.execute(task({ validation: ['recurrence'] }), run.runId, 'SDD');

    // The id resolved to the command the *project* configured, not to anything
    // the plan carried (V-01 regression).
    expect(proc.calls).toHaveLength(1);
    expect(proc.lastCall?.args[1]).toBe('npm test -- recurrence');
  });

  it('sends a task to review when its validation fails', async () => {
    // Never to another model (§55): a failing check is information about the
    // work, and routing around it would replace a visible problem with a quiet
    // one.
    const proc = new FakeProcessRunner().always({ exitCode: 1, stdout: 'expected 1 to be 2' });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(task({ validation: ['test'] }), run.runId, 'SDD');

    expect(result.status).toBe('review_required');
    expect(result.validation.passed).toBe(false);
  });

  it('does not take the agent word for it', async () => {
    // The agent claims validation passed; the command says otherwise.
    const proc = new FakeProcessRunner().always({ exitCode: 1 });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(task({ validation: ['test'] }), run.runId, 'SDD');
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

    await executor.execute(task({ validation: ['test'] }), run.runId, 'SDD');
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

describe('recorded provenance is what actually ran (V-06 regression)', () => {
  // Was a defect: `reasoning: 'medium'` was hardcoded at three points and the
  // model was never recorded at all, so `result.json` described the request
  // rather than the execution. Anything reading those files — telemetry, a
  // future dashboard, a person debugging — would have been quietly wrong.

  it('records the effort the role actually resolved to', async () => {
    // executor.complex is configured at `high`; the old code wrote `medium`.
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    const result = await executor.execute(
      task({ complexity: 'complex', risk: 'high' }),
      run.runId,
      'SDD',
    );

    expect(runner.lastCall?.reasoning).toBe('high');
    expect(result.reasoning).toBe('high');
  });

  it('records the effort for a trivial task too', async () => {
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    const result = await executor.execute(
      task({ complexity: 'trivial', risk: 'low' }),
      run.runId,
      'SDD',
    );
    expect(result.reasoning).toBe('low');
  });

  it('records a clamp when the runner could not reach the configured level', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const narrow = { ...CAPS, supportedReasoningLevels: ['low', 'medium'] } as const;
    const runner = new FakeAgentRunner('claude', narrow);

    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: globalConfig,
        capabilities: { claude: narrow },
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        getRunner: () => runner,
        projectDir: PROJECT,
      }),
      processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
      config: { global: globalConfig },
      projectDir: PROJECT,
    });

    runner.pushText(COMPLETED);
    const result = await executor.execute(
      task({ complexity: 'complex', risk: 'high' }),
      run.runId,
      'SDD',
    );

    expect(result.reasoning).toBe('medium');
    expect(result.reasoningClamped).toBe(true);
  });

  /**
   * I-22 and C-03 (AR-01) — the configuration that used to cost a task attempt.
   *
   * The evidence run's TASK-002: `effort: medium` against a model offering `low` and
   * `high`. The runner was invoked at the unsupported level, the invocation failed, and the
   * task spent one of its two attempts finding out something the system already knew. With
   * the pair's capabilities resolved before invocation, there is nothing to spend it on.
   */
  it('spends no attempt discovering an effort the model does not support', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const runner = new FakeAgentRunner('claude', CAPS);

    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    // The pair, not the CLI: `agy-like` answers narrowly for one model and widely for the
    // rest, which is precisely the shape AD-30 made expressible.
    const perModel = {
      claude: (model?: string) =>
        model === 'narrow-model'
          ? { ...CAPS, supportedReasoningLevels: ['low', 'high'] as const }
          : CAPS,
    };

    const withNarrowModel = GlobalConfigSchema.parse({
      ...globalConfig,
      roles: {
        ...globalConfig.roles,
        executors: {
          ...globalConfig.roles.executors,
          normal: { runner: 'claude', model: 'narrow-model', effort: 'medium' },
        },
      },
    });

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: withNarrowModel,
        capabilities: perModel,
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        getRunner: () => runner,
        projectDir: PROJECT,
      }),
      processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
      config: { global: withNarrowModel },
      projectDir: PROJECT,
    });

    runner.pushText(COMPLETED);
    const result = await executor.execute(task(), run.runId, 'SDD');

    // Exactly one invocation, at the supported level. Not two, and never at `medium`.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.reasoning).toBe('low');
    expect(runner.calls[0]?.model).toBe('narrow-model');

    // The work itself succeeded, so the attempt was spent on work — which is the whole
    // of AD-37's distinction.
    expect(result.status).toBe('completed');
    expect(result.reasoning).toBe('low');
    expect(result.reasoningClamped).toBe(true);
    expect(result.model).toBe('narrow-model');
  });

  it('records the model when the role configures one', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const runner = new FakeAgentRunner('claude', CAPS);

    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    const withModel = GlobalConfigSchema.parse({
      ...globalConfig,
      roles: {
        ...globalConfig.roles,
        executors: {
          ...globalConfig.roles.executors,
          normal: { runner: 'claude', model: 'sonnet', effort: 'medium' },
        },
      },
    });

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: withModel,
        capabilities: { claude: CAPS },
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        getRunner: () => runner,
        projectDir: PROJECT,
      }),
      processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
      config: { global: withModel },
      projectDir: PROJECT,
    });

    runner.pushText(COMPLETED);
    const result = await executor.execute(task(), run.runId, 'SDD');

    expect(result.model).toBe('sonnet');
  });

  it('records the substitution when a fallback ran the work', async () => {
    // The case the request could never describe: the role asked for one runner
    // and a different one did the job.
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    const withFallback = GlobalConfigSchema.parse({
      ...globalConfig,
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
      fallback: {
        enabled: true,
        roles: { 'executor.normal': { runner: 'codex', effort: 'high' } },
      },
    });

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: withFallback,
        capabilities: { claude: CAPS, codex: CAPS },
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        getRunner: createRunnerFactory({
          registry: {
            ids: () => ['claude', 'codex'],
            get: (id) => (id === 'claude' ? claude : codex),
            has: () => true,
            capabilities: () => ({ claude: CAPS, codex: CAPS }),
            providerOf: (id) => (id === 'claude' ? 'claude-code-cli' : 'codex-cli'),
            health: async () => ({}),
            validateRoles: () => undefined,
          },
          config: withFallback,
        }),
        projectDir: PROJECT,
      }),
      processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
      config: { global: withFallback },
      projectDir: PROJECT,
    });

    claude.pushFailure('quota_exceeded');
    codex.pushText(COMPLETED);

    const result = await executor.execute(task(), run.runId, 'SDD');

    expect(result.runner).toBe('codex');
    expect(result.reasoning).toBe('high');
    expect(result.fallback).toEqual({ from: 'claude', errorCode: 'quota_exceeded' });
  });
});

describe('test-first tasks are judged by what they expected (V-04 regression)', () => {
  // The contradiction the tool itself caught in a real run: a task written to
  // produce failing tests carried a validation command that could not pass at
  // that moment, and the executor marked it review_required.

  it('completes a RED task when its tests fail', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 1, stdout: 'not ok 1 - tags default' });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(
      task({ validation: ['test'], validationExpectation: 'fail' }),
      run.runId,
      'SDD',
    );

    expect(result.status).toBe('completed');
    // The command result is still recorded honestly: it did not pass.
    expect(result.validation.passed).toBe(false);
    expect(result.validation.expectation).toBe('fail');
  });

  it('sends a RED task that went green to review', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(
      task({ validation: ['test'], validationExpectation: 'fail' }),
      run.runId,
      'SDD',
    );

    expect(result.status).toBe('review_required');
    expect(result.notes.join(' ')).toMatch(/asserts nothing|already exists/i);
  });

  it('still reviews an ordinary task whose validation failed', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 1 });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(
      task({ validation: ['test'] }),
      run.runId,
      'SDD',
    );

    expect(result.status).toBe('review_required');
  });

  it('runs nothing at all when the task expects none', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 1 });
    const { executor, runner, run } = await harness({ processRunner: proc });
    runner.pushText(COMPLETED);

    const result = await executor.execute(
      task({ validation: ['test'], validationExpectation: 'none' }),
      run.runId,
      'SDD',
    );

    expect(proc.calls).toHaveLength(0);
    expect(result.status).toBe('completed');
  });

  it('defaults to expecting a pass, so existing plans behave as before', async () => {
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    const result = await executor.execute(task({ validation: ['test'] }), run.runId, 'SDD');
    expect(result.validation.expectation).toBe('pass');
  });
});

// Regression suite — was `[DEFECT] AF-R04` in test/reanalysis.repro.test.ts.
// A failed task recorded `runner: "unknown"` at `reasoning: "medium"`. Neither
// was true, and `medium` is the more dangerous of the two: it is a real level a
// run can have, so a task routed at `high` that failed was indistinguishable
// from one that genuinely ran low.
describe('a failed task records where the work was actually routed', () => {
  it('names the runner that failed, not a placeholder', async () => {
    const { executor, runner, run } = await harness();
    runner.pushFailure('quota_exceeded');

    const result = await executor.execute(task(), run.runId, 'SDD');

    expect(result.status).toBe('failed');
    expect(result.runner).toBe('claude');
    expect(result.errorCode).toBe('quota_exceeded');
  });

  it('keeps the effort the role was configured at', async () => {
    // executor.complex is `high`. The old placeholder would have said `medium`
    // — a plausible answer, and the wrong one.
    const { executor, runner, run } = await harness();
    runner.pushFailure('runner_unavailable');

    const result = await executor.execute(
      task({ complexity: 'complex', risk: 'high' }),
      run.runId,
      'SDD',
    );

    expect(result.status).toBe('failed');
    expect(result.reasoning).toBe('high');
  });

  it('records a failure the same way a success does', async () => {
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);
    const ok = await executor.execute(task(), run.runId, 'SDD');

    const second = await harness();
    second.runner.pushFailure('quota_exceeded');
    const failed = await second.executor.execute(task(), second.run.runId, 'SDD');

    // Same runner, same effort — only the status differs. The provenance of a
    // run should not depend on whether it worked.
    expect(failed.runner).toBe(ok.runner);
    expect(failed.reasoning).toBe(ok.reasoning);
  });
});

describe('where a task runs (M2-04 §4.2)', () => {
  // Three places touch a directory, and in worktree mode all three must be the
  // task's own checkout. The third is the one that is easy to miss: `AGENTS.md`
  // used to be read from the mutable project directory, so a task would observe
  // whatever the user happened to have saved in their editor while agents were
  // running rather than the `AGENTS.md` of its own base.

  const WORKSPACE = '/workspace/TASK-001/attempt-1';

  function workspace() {
    return {
      path: WORKSPACE,
      attempt: 1,
      isolation: {
        base: 'a'.repeat(40),
        branch: 'agent-flow/AF-2026-001-0f3a91c4bd27e615/TASK-001/attempt-1',
        relativePath: 'repo-x/AF-2026-001-0f3a91c4bd27e615/TASK-001/attempt-1',
      },
    };
  }

  it('runs the agent in the workspace', async () => {
    const world = await harness();
    world.fs.seed(`${WORKSPACE}/AGENTS.md`, '# Workspace rules\n');

    await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

    expect(world.runner.calls.at(-1)?.workingDirectory).toBe(WORKSPACE);
  });

  it('runs the validation commands in the workspace', async () => {
    const processRunner = new FakeProcessRunner().always({ exitCode: 0 });
    const world = await harness({ processRunner });
    world.fs.seed(`${WORKSPACE}/AGENTS.md`, '# Workspace rules\n');

    // A task with a validation id, so commands actually run.
    await world.executor.execute(
      task({ validation: ['test'] }),
      world.run.runId,
      'SDD',
      workspace(),
    );

    const validation = processRunner.calls.filter((call) => call.command === '/bin/sh');
    expect(validation.length).toBeGreaterThan(0);
    for (const call of validation) expect(call.cwd).toBe(WORKSPACE);
  });

  it('reads AGENTS.md from the workspace, not from the project', async () => {
    const world = await harness();
    world.fs.seed(`${PROJECT}/AGENTS.md`, '# The user just edited this\n');
    world.fs.seed(`${WORKSPACE}/AGENTS.md`, '# The rules of this task\u2019s base\n');

    await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

    const prompt = world.runner.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain('The rules of this task');
    expect(prompt).not.toContain('The user just edited this');
  });

  it('keeps every one of them in the project directory without a workspace', async () => {
    // Sequential mode, unchanged (§25).
    const processRunner = new FakeProcessRunner().always({ exitCode: 0 });
    const world = await harness({ processRunner });
    world.fs.seed(`${PROJECT}/AGENTS.md`, '# Project rules\n');

    await world.executor.execute(task({ validation: ['test'] }), world.run.runId, 'SDD');

    expect(world.runner.calls.at(-1)?.workingDirectory).toBe(PROJECT);
    for (const call of processRunner.calls.filter((entry) => entry.command === '/bin/sh')) {
      expect(call.cwd).toBe(PROJECT);
    }
    expect(world.runner.calls.at(-1)?.prompt ?? '').toContain('Project rules');
  });
});

describe('worktree mode records an attempt, not a result (M2-05 §10.1)', () => {
  // The one place the two artifacts are told apart in practice. `result.json`
  // means "this is what the task came to"; in worktree mode that is decided at
  // integration, so the executor writes evidence of one execution instead —
  // `attempt-<n>.json`, with a receipt when validation was satisfied.

  const BASE = 'a'.repeat(40);
  const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const MARKER = 'ffee0011223344556677889900aabbccddeeff00';
  const KEY = 'AF-2026-001-0f3a91c4bd27e615';
  const WORKSPACE = '/home/.agent-flow/worktrees/repo-0f3a91c4bd27/AF-2026-001-0f3a91c4bd27e615/TASK-001/attempt-1';

  function subcommandOf(args: readonly string[]): string {
    let index = 0;
    while (args[index] === '-c') index += 2;
    return args[index] ?? '';
  }

  function workspace(attempt = 1) {
    return {
      path: WORKSPACE,
      attempt,
      isolation: {
        base: BASE,
        branch: `agent-flow/${KEY}/TASK-001/attempt-${String(attempt)}`,
        relativePath: `repo-0f3a91c4bd27/${KEY}/TASK-001/attempt-${String(attempt)}`,
      },
    };
  }

  async function isolated(
    options: {
      readonly validation?: Partial<ProcessResult>;
      /** Fails one Git subcommand of the §11.2 sequence, by name. */
      readonly failing?: string;
    } = {},
  ) {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const runner = new FakeAgentRunner('claude', CAPS);
    const host = new FakeHost();

    const processRunner = new FakeProcessRunner().always((spawn) => {
      if (spawn.command !== 'git') return options.validation ?? { exitCode: 0 };
      const subcommand = subcommandOf(spawn.args);
      if (subcommand === options.failing) {
        return { exitCode: 128, stderr: `fatal: something went wrong in ${WORKSPACE}` };
      }
      if (subcommand === 'write-tree') return { stdout: `${TREE}\n` };
      if (subcommand === 'commit-tree') return { stdout: `${MARKER}\n` };
      return {};
    });

    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f', () => ({
      isolationMode: 'worktree',
      planningBase: BASE,
      gitRunKey: KEY,
    }));

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: globalConfig,
        capabilities: { claude: CAPS },
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        getRunner: () => runner,
        projectDir: PROJECT,
      }),
      processRunner,
      config: {
        global: globalConfig,
        project: ProjectConfigSchema.parse({
          project: { name: 'x', type: 'node' },
          commands: { test: 'npm test' },
        }),
      },
      projectDir: PROJECT,
      workspaces: new GitWorkspaces({
        git: testGitCommand(processRunner),
        fs,
        worktreeRoot: '/home/.agent-flow/worktrees',
      }),
      host,
    });

    return { fs, store, run, runner, processRunner, executor };
  }

  const attemptOf = async (fs: InMemoryFileSystem, runId: string, attempt = 1) =>
    TaskAttemptResultSchema.parse(
      JSON.parse(await fs.readFile(runPaths(PROJECT, runId).taskAttempt('TASK-001', attempt))),
    );

  it('writes attempt-1.json with a receipt and no result.json', async () => {
    const world = await isolated();
    world.runner.pushText(COMPLETED);

    const result = await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

    // The task still ends where `judgeValidation` put it — the executor's
    // decision is unchanged, only what it persists is different.
    expect(result.status).toBe('completed');

    const persisted = await attemptOf(world.fs, world.run.runId);
    expect(persisted.validationJudgement).toBe('satisfied');
    expect(persisted.receipt?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(persisted.receipt?.validatedTree).toBe(TREE);
    expect(persisted.base).toBe(BASE);
    expect(persisted.workspace.startsWith('/')).toBe(false);

    // §10.3: `result.json` is written only after integration, and integration
    // does not exist yet. A file here saying `"status": "completed"` for work
    // that has not reached the integration branch is a lie recovery believes.
    expect(await world.fs.exists(runPaths(PROJECT, world.run.runId).taskResult('TASK-001'))).toBe(
      false,
    );
  });

  it('records the provenance of what actually ran', async () => {
    const world = await isolated();
    world.runner.pushText(COMPLETED);

    await world.executor.execute(
      task({ complexity: 'complex', risk: 'high', validation: ['test'] }),
      world.run.runId,
      'SDD',
      workspace(),
    );

    const persisted = await attemptOf(world.fs, world.run.runId);
    expect(persisted.runner).toBe('claude');
    expect(persisted.reasoning).toBe('high');
    expect(persisted.agentReport.status).toBe('COMPLETED');
    expect(persisted.filesChanged).toEqual(['src/recurrence.ts']);
    // The *ids* the plan named, which `TaskResult` does not keep — it holds the
    // resolved commands, and an id is what a person recognises.
    expect(persisted.validation.ids).toEqual(['test']);
  });

  it('announces the attempt and its marker (Appendix B)', async () => {
    const world = await isolated();
    world.runner.pushText(COMPLETED);

    await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

    const events = await world.store.readEvents(world.run.runId);
    const validated = events.find((event) => event.type === 'task_attempt_validated');
    const marker = events.find((event) => event.type === 'task_attempt_marker_created');

    expect(validated?.detail).toMatchObject({ task: 'TASK-001', attempt: 1, judgement: 'satisfied' });
    expect(marker?.detail).toMatchObject({ task: 'TASK-001', attempt: 1, marker: MARKER, tree: TREE });
    // No absolute path in either payload (§7.2, §21.3).
    expect(JSON.stringify([validated, marker])).not.toContain(WORKSPACE);
  });

  it('gives an unsatisfied attempt no receipt, no marker and no Git at all', async () => {
    const world = await isolated({ validation: { exitCode: 1 } });
    world.runner.pushText(COMPLETED);

    const result = await world.executor.execute(
      task({ validation: ['test'] }),
      world.run.runId,
      'SDD',
      workspace(),
    );

    // RED/GREEN is untouched: `judgeValidation` said review_required and that is
    // what the task is.
    expect(result.status).toBe('review_required');

    const persisted = await attemptOf(world.fs, world.run.runId);
    expect(persisted.validationJudgement).toBe('unsatisfied');
    expect(persisted.receipt).toBeUndefined();
    expect(world.processRunner.calls.filter((call) => call.command === 'git')).toEqual([]);
  });

  it('completes a RED task and gives it a receipt, because its expectation was met', async () => {
    // `validationExpectation: 'fail'` with a failing command is a satisfied
    // attempt. Reading "the command exited non-zero" as unsatisfied would be the
    // V-04 defect one layer down.
    const world = await isolated({ validation: { exitCode: 1 } });
    world.runner.pushText(COMPLETED);

    const result = await world.executor.execute(
      task({ validation: ['test'], validationExpectation: 'fail' }),
      world.run.runId,
      'SDD',
      workspace(),
    );

    expect(result.status).toBe('completed');

    const persisted = await attemptOf(world.fs, world.run.runId);
    expect(persisted.validationJudgement).toBe('satisfied');
    expect(persisted.validation.passed).toBe(false);
    expect(persisted.validation.expectation).toBe('fail');
    expect(persisted.receipt?.validatedTree).toBe(TREE);
  });

  it('records a BLOCKED agent as not_reached', async () => {
    const world = await isolated();
    world.runner.pushText('## RESULT\nSTATUS: BLOCKED\nNOTES:\n- missing decision\n');

    const result = await world.executor.execute(
      task({ validation: ['test'] }),
      world.run.runId,
      'SDD',
      workspace(),
    );

    expect(result.status).toBe('blocked');

    const persisted = await attemptOf(world.fs, world.run.runId);
    expect(persisted.validationJudgement).toBe('not_reached');
    expect(persisted.agentReport.status).toBe('BLOCKED');
    expect(persisted.receipt).toBeUndefined();
    expect(persisted.errorCode).toBe('blocked');
  });

  it('writes no evidence for an attempt the agent never reported on', async () => {
    // §17.3 windows 1 and 2: with no artifact there is no evidence, and the
    // milestone does not infer evidence. Inventing an `agentReport` so there
    // would be something to write is exactly the inference it forbids.
    const world = await isolated();
    world.runner.pushFailure('quota_exceeded');

    const result = await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('quota_exceeded');
    expect(
      await world.fs.exists(runPaths(PROJECT, world.run.runId).taskAttempt('TASK-001', 1)),
    ).toBe(false);
  });

  it('refuses to call a task done when its evidence could not be captured', async () => {
    // Not a re-judgement: `judgeValidation` already said the expectation was
    // met, and nothing re-evaluates it. But without an artifact there is no
    // receipt, without a receipt there is no marker, and without a marker
    // nothing can ever be integrated — so `completed` would be a claim about a
    // future that cannot happen.
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const runner = new FakeAgentRunner('claude', CAPS);

    const processRunner = new FakeProcessRunner().always((spawn) => {
      if (spawn.command !== 'git') return { exitCode: 0 };
      return subcommandOf(spawn.args) === 'write-tree'
        ? { exitCode: 128, stderr: `fatal: cannot read ${WORKSPACE}` }
        : {};
    });

    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f', () => ({
      isolationMode: 'worktree',
      planningBase: BASE,
      gitRunKey: KEY,
    }));

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: globalConfig,
        capabilities: { claude: CAPS },
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        getRunner: () => runner,
        projectDir: PROJECT,
      }),
      processRunner,
      config: { global: globalConfig },
      projectDir: PROJECT,
      workspaces: new GitWorkspaces({
        git: testGitCommand(processRunner),
        fs,
        worktreeRoot: '/home/.agent-flow/worktrees',
      }),
      host: new FakeHost(),
    });

    runner.pushText(COMPLETED);
    const result = await executor.execute(task(), run.runId, 'SDD', workspace());

    expect(result.status).toBe('failed');
    // And it does *not* borrow the runner's error vocabulary to say so. The
    // runner produced its report; Git could not record it. `execution_failed`
    // here would tell `doctor`, the health model and the CLI's hint that the
    // agent's process went wrong, and send a person to read the wrong log.
    expect(result.errorCode).toBeUndefined();
    // The code that is true travels in the note instead.
    expect(result.notes.join(' ')).toContain('validated_tree_uncapturable');
    // And the sentence a person reads names no directory on this machine.
    expect(result.notes.join(' ')).not.toContain(WORKSPACE);
  });

  it('keeps one log per attempt, so a retry does not erase the first', async () => {
    const world = await isolated();
    world.runner.pushText(COMPLETED);

    await world.executor.execute(task(), world.run.runId, 'SDD', workspace(2));

    expect(
      await world.fs.exists(
        runPaths(PROJECT, world.run.runId).log(attemptLogName('TASK-001', 2)),
      ),
    ).toBe(true);
  });

  it('leaves a sequential run writing result.json and asking Git nothing (§25.1)', async () => {
    const world = await isolated();
    world.runner.pushText(COMPLETED);

    await world.executor.execute(task({ validation: ['test'] }), world.run.runId, 'SDD');

    expect(await world.fs.exists(runPaths(PROJECT, world.run.runId).taskResult('TASK-001'))).toBe(
      true,
    );
    expect(
      await world.fs.exists(runPaths(PROJECT, world.run.runId).taskAttempt('TASK-001', 1)),
    ).toBe(false);
    expect(world.processRunner.calls.filter((call) => call.command === 'git')).toEqual([]);
  });

  /**
   * A satisfied validation whose evidence could not be captured.
   *
   * This is the combination worth being careful about, because two plausible
   * repairs are both wrong. Reporting the task `completed` claims a future that
   * cannot happen — no artifact, no receipt, no marker, nothing to integrate.
   * Recording the attempt as `unsatisfied` to make the receipt-iff-satisfied
   * `.refine` fit writes a false statement about what the validation commands
   * found, into the one file §17.1 tells recovery to trust first.
   *
   * What the code does instead: the judgement stands wherever it was written,
   * the task does not claim completion, and the note carries the module's own
   * failure code — which names the step that failed rather than borrowing a
   * vocabulary that means something else.
   */
  describe('a satisfied attempt whose evidence could not be captured', () => {
    const attemptPathOf = (runId: string) => runPaths(PROJECT, runId).taskAttempt('TASK-001', 1);

    for (const [step, failing, code] of [
      ['stageAll', 'add', 'validated_tree_uncapturable'],
      ['writeTree', 'write-tree', 'validated_tree_uncapturable'],
      ['commitTree', 'commit-tree', 'attempt_marker_unpublishable'],
      ['updateRef', 'update-ref', 'attempt_marker_unpublishable'],
    ] as const) {
      it(`does not report the task completed when ${step} fails`, async () => {
        const world = await isolated({ failing });
        world.runner.pushText(COMPLETED);

        const result = await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

        expect(result.status).not.toBe('completed');
        expect(result.status).toBe('failed');
        // Not the runner's vocabulary. The runner produced its report; Git could
        // not record it, and `RunnerErrorCodeSchema` would name the wrong
        // subsystem to `doctor`, to the health model and to the CLI's hint.
        expect(result.errorCode).toBeUndefined();
        expect(result.notes.join(' ')).toContain(code);
        expect(result.notes.join(' ')).not.toContain(WORKSPACE);
      });
    }

    for (const [step, failing] of [
      ['commitTree', 'commit-tree'],
      ['updateRef', 'update-ref'],
    ] as const) {
      it(`leaves the persisted judgement satisfied when ${step} fails`, async () => {
        const world = await isolated({ failing });
        world.runner.pushText(COMPLETED);

        await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

        const raw = await world.fs.readFile(attemptPathOf(world.run.runId));
        const persisted = TaskAttemptResultSchema.parse(JSON.parse(raw));

        expect(persisted.validationJudgement).toBe('satisfied');
        expect(persisted.receipt?.validatedTree).toBe(TREE);
        // Written once. A rewrite here would mint a second nonce for an attempt
        // that already has one, and the marker recovery rebuilds is a function
        // of the file — two files, two markers, and no way to tell which was
        // the one validation ran against.
        expect(world.fs.writes.filter((path) => path === attemptPathOf(world.run.runId))).toHaveLength(
          1,
        );
      });
    }

    for (const [step, failing] of [
      ['stageAll', 'add'],
      ['writeTree', 'write-tree'],
    ] as const) {
      it(`writes no artifact at all when ${step} fails`, async () => {
        const world = await isolated({ failing });
        world.runner.pushText(COMPLETED);

        await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

        // Neither a forged one nor a downgraded one. §17.3 windows 1 and 2 read
        // "no artifact" as *the attempt's work was never observed*, which is the
        // truth here — the tree it would have been about was never captured.
        expect(await world.fs.exists(attemptPathOf(world.run.runId))).toBe(false);
        expect(await world.fs.exists(runPaths(PROJECT, world.run.runId).taskResult('TASK-001'))).toBe(
          false,
        );
      });
    }

    it('does not report the task completed when the artifact cannot be written', async () => {
      const world = await isolated();
      world.fs.failWrite = (_operation, path) =>
        path.includes('attempt-1.json') ? new Error('ENOSPC: no space left on device') : undefined;
      world.runner.pushText(COMPLETED);

      const result = await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

      expect(result.status).toBe('failed');
      expect(result.errorCode).toBeUndefined();
      expect(result.notes.join(' ')).toContain('attempt_artifact_unwritable');
      expect(await world.fs.exists(attemptPathOf(world.run.runId))).toBe(false);
      // And no marker was built from an artifact that does not exist.
      expect(
        world.processRunner.calls.map((call) => subcommandOf(call.args)),
      ).not.toContain('commit-tree');
    });

    it('announces the attempt only when the evidence was actually recorded', async () => {
      // Appendix B's events describe what happened, so an event for an attempt
      // whose artifact was never written would be the same forgery one layer up
      // — a run history claiming evidence that recovery will not find.
      const world = await isolated({ failing: 'write-tree' });
      world.runner.pushText(COMPLETED);

      await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

      const events = await world.store.readEvents(world.run.runId);
      expect(events.map((event) => event.type)).not.toContain('task_attempt_validated');
      expect(events.map((event) => event.type)).not.toContain('task_attempt_marker_created');
    });

    it('announces no marker when the marker was not published', async () => {
      const world = await isolated({ failing: 'update-ref' });
      world.runner.pushText(COMPLETED);

      await world.executor.execute(task(), world.run.runId, 'SDD', workspace());

      const events = await world.store.readEvents(world.run.runId);
      expect(events.map((event) => event.type)).not.toContain('task_attempt_marker_created');
    });
  });
});

/**
 * AD-34 and C-05 (AR-02) — a failed attempt leaves an artifact of its own.
 *
 * `task-executor` deliberately wrote nothing when the stage threw, and the reasoning was
 * sound: the agent produced no report, and inventing one would be evidence of a report
 * nobody made. But the conclusion overshot. The evidence of the *failure* exists — code,
 * provenance, raw output, duration — and discarding it meant the only attempts with no
 * persisted record were exactly the two somebody needed to diagnose.
 *
 * The separate file name is what preserves §17.3's window semantics: "no `attempt-<n>.json`"
 * still means the attempt's work was never observed.
 */
describe('a failed attempt is recorded, under its own name (AD-34)', () => {
  const DENIAL = [
    'tool request: Bash(npm test)',
    'soft-denying tool confirmation "Bash"',
    'permission check failed',
  ].join('\n');

  async function failedInWorktree(raw: string) {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const runner = new FakeAgentRunner('claude', CAPS);

    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: globalConfig,
        capabilities: { claude: CAPS },
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        getRunner: () => runner,
        projectDir: PROJECT,
      }),
      processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
      config: { global: globalConfig },
      projectDir: PROJECT,
    });

    runner.push({ ok: false, errorCode: 'execution_failed', raw, durationMs: 3 });

    const workspace = {
      path: '/wt/AF-2026-001/TASK-001/attempt-2',
      attempt: 2,
      isolation: {
        base: 'a'.repeat(40),
        branch: 'agent-flow/AF-2026-001-0123456789abcdef/TASK-001/attempt-2',
        relativePath: 'repo-abc/AF-2026-001-0123456789abcdef/TASK-001/attempt-2',
      },
    };

    const result = await executor.execute(task(), run.runId, 'SDD', workspace);
    const path = runPaths(PROJECT, run.runId).failedAttempt('TASK-001', 2);
    const written = (await fs.exists(path)) ? await fs.readFile(path) : undefined;

    return { fs, store, run, result, written, path };
  }

  it('writes attempt-<n>.failed.json', async () => {
    const { written } = await failedInWorktree(DENIAL);
    expect(written).toBeDefined();
  });

  it('validates against the schema the milestone declared', async () => {
    const { written } = await failedInWorktree(DENIAL);
    expect(() => FailedAttemptSchema.parse(JSON.parse(written ?? '{}'))).not.toThrow();
  });

  it('carries the classification, the provenance and the redacted excerpt', async () => {
    const { written } = await failedInWorktree(DENIAL);
    const artifact = FailedAttemptSchema.parse(JSON.parse(written ?? '{}'));

    expect(artifact.failureClass).toBe('runner_permission_required');
    expect(artifact.runnerErrorCode).toBe('execution_failed');
    expect(artifact.runner).toBe('claude');
    expect(artifact.attempt).toBe(2);
    expect(artifact.branch).toContain('TASK-001/attempt-2');
    expect(artifact.rawExcerpt).toContain('soft-denying');
  });

  it('records whether the failure spent an attempt, per the taxonomy (AD-37, I-22)', async () => {
    // The decision, persisted rather than recomputed: a reader asking "why was retry still
    // allowed" gets an answer from the artifact instead of re-deriving it from a table
    // that may since have changed.
    const denied = await failedInWorktree(DENIAL);
    expect(FailedAttemptSchema.parse(JSON.parse(denied.written ?? '{}')).consumedAttempt).toBe(
      false,
    );

    const generic = await failedInWorktree('the process exited unexpectedly');
    expect(FailedAttemptSchema.parse(JSON.parse(generic.written ?? '{}')).consumedAttempt).toBe(
      true,
    );
  });

  it('contains no agentReport, which is what §17.3 rests on', async () => {
    const { written } = await failedInWorktree(DENIAL);
    expect(JSON.parse(written ?? '{}')).not.toHaveProperty('agentReport');
  });

  it('does not write attempt-<n>.json, so the window semantics survive', async () => {
    const { fs, run } = await failedInWorktree(DENIAL);
    expect(await fs.exists(runPaths(PROJECT, run.runId).taskAttempt('TASK-001', 2))).toBe(false);
  });

  it('persists no absolute path (§21.3, I-21)', async () => {
    const { written } = await failedInWorktree(
      `failed inside /wt/AF-2026-001/TASK-001/attempt-2/src/x.ts\n${DENIAL}`,
    );

    expect(written).not.toContain('/wt/AF-2026-001');
  });

  it('still returns a failed TaskResult, unchanged', async () => {
    // The artifact is additive. Nothing about the task's outcome moves in this milestone.
    const { result } = await failedInWorktree(DENIAL);
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('execution_failed');
  });

  it('names the failure class on the result, so a reader never sees only a code', async () => {
    const { result } = await failedInWorktree(DENIAL);
    expect(result.failureClass).toBe('runner_permission_required');
  });
});
