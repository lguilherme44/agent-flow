import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { FallbackRunner } from '../../src/adapters/runners/fallback-runner.js';
import { collectTelemetry } from '../../src/app/telemetry.js';
import { summariseTelemetry } from '../../src/core/telemetry.js';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  TaskSchema,
  type Task,
} from '../../src/contracts/index.js';

/**
 * AF-H05 — telemetry as a projection, not as a third file.
 *
 * `TelemetryEntry` sat in the contracts with no producer at all. The obvious fix
 * — write a telemetry log next to the state and the event log — would have
 * created a third thing that can disagree with the two that must win. So nothing
 * is stored: every entry is derived from the events the stage runner already
 * appends and the result files the executor already writes, which is what makes
 * it impossible for telemetry to be quietly wrong about a run.
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

const IMPLEMENTED = `Done.

## RESULT

STATUS: COMPLETED

FILES CHANGED:
- src/recurrence.js
`;

const TASK: Task = TaskSchema.parse({
  id: 'TASK-001',
  title: 'Implement generation',
  description: 'Generate occurrences.',
  complexity: 'normal',
  risk: 'medium',
  requirements: ['FR-001'],
  acceptanceCriteria: ['It works.'],
  validation: ['test'],
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

  const processRunner = new FakeProcessRunner().always({ exitCode: 0 });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner,
    processRunner,
    config: { global, project },
    projectDir: '/repo',
  });

  return { fs, clock, store, runners, stageRunner, executor, global };
}

describe('telemetry is derived from what the run already recorded', () => {
  it('reports one entry per stage, with the effort it ran at', async () => {
    const w = await world();
    const run = await w.store.createRun('f');

    w.runners.claude.pushText('# Architecture');
    w.clock.advance(4_000);

    await w.stageRunner.run(
      { name: 'discovery', role: 'architect', prompt: 'discovery' },
      run.runId,
      { projectDir: '/repo', projectConfig: 'none', agentsMd: 'none' },
    );

    const entries = await collectTelemetry(w.store, await w.store.loadRun(run.runId));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      runId: run.runId,
      kind: 'stage',
      stage: 'discovery',
      role: 'architect',
      runner: 'claude',
      reasoning: 'high',
      status: 'completed',
      attempts: 1,
    });
  });

  it('measures how long a stage took', async () => {
    const w = await world();
    const run = await w.store.createRun('f');

    // The clock moves while the runner "works".
    w.runners.claude.push(() => {
      w.clock.advance(7_000);
      return { ok: true, text: '# Architecture', durationMs: 7_000 };
    });

    await w.stageRunner.run(
      { name: 'discovery', role: 'architect', prompt: 'discovery' },
      run.runId,
      { projectDir: '/repo', projectConfig: 'none', agentsMd: 'none' },
    );

    const entries = await collectTelemetry(w.store, await w.store.loadRun(run.runId));
    expect(entries[0]?.durationMs).toBe(7_000);
  });

  it('names the runner that actually ran, not the one configured', async () => {
    // The invariant: actual execution provenance beats configured intent. The
    // event log used to record the resolved runner, so a stage that fell back
    // was filed under the runner that was down.
    const w = await world();
    const run = await w.store.createRun('f');

    const primary = new FakeAgentRunner('claude', CAPS).pushFailure('quota_exceeded');
    const secondary = new FakeAgentRunner('codex', CAPS).pushText('# Architecture');

    const stageRunner = new StageRunner({
      fs: w.fs,
      clock: w.clock,
      store: w.store,
      config: w.global,
      capabilities: { claude: CAPS, codex: CAPS },
      promptLoader: new PromptLoader({ fs: w.fs, promptsDir: PROMPTS }),
      getRunner: () =>
        new FallbackRunner({
          primary,
          secondary,
          secondaryConfig: {
            role: 'architect',
            runner: 'codex',
            reasoning: 'high',
            reasoningClamped: false,
            requestedReasoning: 'high',
            supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
            timeoutSeconds: 900,
            structuredOutputStrategy: 'native',
          },
          onFallback: () => undefined,
        }),
      projectDir: '/repo',
    });

    await stageRunner.run({ name: 'discovery', role: 'architect', prompt: 'discovery' }, run.runId, {
      projectDir: '/repo',
      projectConfig: 'none',
      agentsMd: 'none',
    });

    const entries = await collectTelemetry(w.store, await w.store.loadRun(run.runId));

    expect(entries[0]?.runner).toBe('codex');
    expect(entries[0]?.fallback).toEqual({ from: 'claude', errorCode: 'quota_exceeded' });
    expect(summariseTelemetry(entries).fallbacks).toBe(1);
  });

  it('keeps a failed stage, with the code it failed on', async () => {
    const w = await world();
    const run = await w.store.createRun('f');

    w.runners.claude.pushFailure('timeout');

    await expect(
      w.stageRunner.run({ name: 'discovery', role: 'architect', prompt: 'discovery' }, run.runId, {
        projectDir: '/repo',
        projectConfig: 'none',
        agentsMd: 'none',
      }),
    ).rejects.toThrow();

    const entries = await collectTelemetry(w.store, await w.store.loadRun(run.runId));

    expect(entries[0]).toMatchObject({ status: 'failed', errorCode: 'timeout', runner: 'claude' });
    expect(summariseTelemetry(entries).failures).toBe(1);
  });

  it('reports a task once, from its result rather than from its stage', async () => {
    // The implementation stage runs per task. Counting both the stage event and
    // the task result would double every implementation call in every aggregate.
    const w = await world();
    const run = await w.store.createRun('f');

    w.runners.codex.pushText(IMPLEMENTED);
    await w.executor.execute(TASK, run.runId, SDD);

    await w.store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
    }));

    const entries = await collectTelemetry(w.store, await w.store.loadRun(run.runId));
    const tasks = entries.filter((entry) => entry.kind === 'task');

    expect(entries.filter((entry) => entry.stage === 'implementation')).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: 'TASK-001',
      role: 'executor.normal',
      runner: 'codex',
      status: 'completed',
    });
  });

  it('counts retries from the run, because a retried task overwrites its result', async () => {
    const w = await world();
    const run = await w.store.createRun('f');

    w.runners.codex.pushText(IMPLEMENTED);
    await w.executor.execute(TASK, run.runId, SDD);

    await w.store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 3, infrastructureFailures: 0 }],
    }));

    const entries = await collectTelemetry(w.store, await w.store.loadRun(run.runId));

    expect(summariseTelemetry(entries).retries).toBe(2);
  });

  it('is reproducible: reading twice gives the same answer', async () => {
    // The property that makes a projection safe. Nothing is stored, so nothing
    // can drift from the state and the events it is read out of.
    const w = await world();
    const run = await w.store.createRun('f');

    w.runners.claude.pushText('# Architecture');
    await w.stageRunner.run({ name: 'discovery', role: 'architect', prompt: 'discovery' }, run.runId, {
      projectDir: '/repo',
      projectConfig: 'none',
      agentsMd: 'none',
    });

    const state = await w.store.loadRun(run.runId);
    expect(await collectTelemetry(w.store, state)).toEqual(await collectTelemetry(w.store, state));
  });

  it('is empty for a run that has done nothing', async () => {
    const w = await world();
    const run = await w.store.createRun('f');

    expect(await collectTelemetry(w.store, await w.store.loadRun(run.runId))).toEqual([]);
  });
});
