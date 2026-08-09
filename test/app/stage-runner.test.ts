import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { StageRunner, StageFailure } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import { runPaths } from '../../src/app/paths.js';
import type { StageDefinition } from '../../src/app/stage-runner.js';

const PROJECT = '/repo';
const PROMPTS = '/pkg/prompts';

const config = GlobalConfigSchema.parse({
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

const SDD_STAGE: StageDefinition = {
  name: 'sdd',
  role: 'sdd',
  prompt: 'sdd',
  artifact: 'sdd',
};

async function harness(options: { runner?: FakeAgentRunner; prompt?: string } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = options.runner ?? new FakeAgentRunner('claude');

  fs.seed(
    `${PROMPTS}/sdd.md`,
    options.prompt ??
      '---\nrole: sdd\npermissions: read-only\nrequiredVars: [featureRequest]\n---\nWrite an SDD for {{featureRequest}}.\n',
  );

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('recurring-bookings');

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config,
    capabilities: CAPABILITIES,
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: () => runner,
    projectDir: PROJECT,
  });

  return { fs, clock, store, run, runner, stageRunner };
}

describe('running a stage', () => {
  it('renders the prompt and invokes the resolved runner', async () => {
    const { stageRunner, run, runner } = await harness();
    runner.pushText('# Software Design Document');

    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'recurring bookings' });

    expect(runner.lastCall?.prompt).toContain('recurring bookings');
    expect(runner.lastCall?.reasoning).toBe('high');
    expect(runner.lastCall?.workingDirectory).toBe(PROJECT);
  });

  it('applies the permissions the prompt declares (§35)', async () => {
    const { stageRunner, run, runner } = await harness();
    runner.pushText('ok');

    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });
    expect(runner.lastCall?.permissions).toBe('read-only');
  });

  it('persists the artifact inside the run directory (R-01)', async () => {
    const { stageRunner, run, fs, runner } = await harness();
    runner.pushText('# SDD body');

    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    expect(await fs.readFile(runPaths(PROJECT, run.runId).sdd)).toBe('# SDD body');
  });

  it('writes a per-stage log', async () => {
    const { stageRunner, run, fs } = await harness();
    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    const log = await fs.readFile(runPaths(PROJECT, run.runId).log('sdd'));
    expect(log).toContain('sdd');
  });

  it('records telemetry without any monetary figure (§57)', async () => {
    // Operational telemetry only. Presenting a cost would imply agent-flow
    // knows what the user is billed, which it does not.
    const { stageRunner, run, store } = await harness();
    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    const events = await store.readEvents(run.runId);
    const completed = events.find((event) => event.type === 'stage_completed');

    expect(completed?.detail['runner']).toBe('claude');
    expect(completed?.detail['role']).toBe('sdd');
    expect(JSON.stringify(completed)).not.toMatch(/cost|usd|price/i);
  });

  it('records start and completion as events', async () => {
    const { stageRunner, run, store } = await harness();
    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    const types = (await store.readEvents(run.runId)).map((event) => event.type);
    expect(types).toContain('stage_started');
    expect(types).toContain('stage_completed');
  });

  it('advances the run stage on success', async () => {
    const { stageRunner, run, store } = await harness();
    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });
    expect((await store.loadRun(run.runId)).stage).toBe('sdd');
  });
});

describe('missing variables cost nothing', () => {
  it('fails before invoking the runner', async () => {
    // The prompt loader raises; the point here is that no call was made.
    const { stageRunner, run, runner } = await harness();

    await expect(stageRunner.run(SDD_STAGE, run.runId, {})).rejects.toThrow(/featureRequest/);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('structured output and the repair loop', () => {
  const schema = z.object({ feature: z.string(), tasks: z.array(z.string()) });
  const stage: StageDefinition = {
    name: 'planning',
    role: 'planner',
    prompt: 'sdd',
    artifact: 'plan',
    outputSchema: schema,
  };

  it('passes a JSON Schema when the stage declares one', async () => {
    const { stageRunner, run, runner } = await harness();
    runner.pushJson({ feature: 'f', tasks: [] });

    await stageRunner.run(stage, run.runId, { featureRequest: 'x' });
    expect(runner.lastCall?.outputSchema).toBeDefined();
  });

  it('returns the validated object', async () => {
    const { stageRunner, run, runner } = await harness();
    runner.pushJson({ feature: 'recurring', tasks: ['a'] });

    const result = await stageRunner.run(stage, run.runId, { featureRequest: 'x' });
    expect(result.data).toEqual({ feature: 'recurring', tasks: ['a'] });
  });

  it('re-prompts once with the validation errors, then succeeds', async () => {
    // Runners without runtime-enforced schemas will produce near-misses. One
    // targeted retry is much cheaper than failing the whole stage.
    const { stageRunner, run, runner } = await harness();
    runner.pushJson({ feature: 'recurring' }); // tasks missing
    runner.pushJson({ feature: 'recurring', tasks: [] });

    const result = await stageRunner.run(stage, run.runId, { featureRequest: 'x' });

    expect(runner.calls).toHaveLength(2);
    expect(result.data).toEqual({ feature: 'recurring', tasks: [] });
    // The retry must say what was wrong, otherwise it is just a coin flip.
    expect(runner.calls[1]?.prompt).toContain('tasks');
  });

  it('gives up after two repair attempts', async () => {
    const { stageRunner, run, runner } = await harness();
    runner.always({ ok: true, text: '{"feature":"x"}', json: { feature: 'x' }, durationMs: 1 });

    await expect(stageRunner.run(stage, run.runId, { featureRequest: 'x' })).rejects.toThrowError(
      StageFailure,
    );
    expect(runner.calls.length).toBeLessThanOrEqual(3);
  });

  it('reports invalid_output and never asks for a fallback (§55)', async () => {
    // A schema mismatch is a contract problem. Retrying on another provider
    // would bury it instead of surfacing it.
    const { stageRunner, run, runner } = await harness();
    runner.always({ ok: true, text: 'not json at all', durationMs: 1 });

    try {
      await stageRunner.run(stage, run.runId, { featureRequest: 'x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StageFailure);
      expect((error as StageFailure).errorCode).toBe('invalid_output');
      expect((error as StageFailure).fallbackEligible).toBe(false);
    }
  });
});

describe('runner failures', () => {
  it('surfaces a quota failure as fallback-eligible', async () => {
    // Infrastructure, not quality — this one a fallback may act on.
    const { stageRunner, run, runner } = await harness();
    runner.pushFailure('quota_exceeded', 'usage limit reached');

    try {
      await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as StageFailure).errorCode).toBe('quota_exceeded');
      expect((error as StageFailure).fallbackEligible).toBe(true);
    }
  });

  it('does not retry a failed invocation', async () => {
    // The repair loop is for malformed output, not for infrastructure. Retrying
    // a quota error immediately would just burn the same wall.
    const { stageRunner, run, runner } = await harness();
    runner.pushFailure('quota_exceeded');

    await expect(stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' })).rejects.toThrow();
    expect(runner.calls).toHaveLength(1);
  });

  it('records the failure as an event', async () => {
    const { stageRunner, run, store, runner } = await harness();
    runner.pushFailure('execution_failed', 'boom');

    await expect(stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' })).rejects.toThrow();

    const types = (await store.readEvents(run.runId)).map((event) => event.type);
    expect(types).toContain('stage_failed');
  });

  it('leaves earlier artifacts untouched when a stage fails', async () => {
    const { stageRunner, run, runner, store } = await harness();
    runner.pushText('# good SDD');
    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    runner.pushFailure('execution_failed');
    await expect(stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' })).rejects.toThrow();

    expect(await store.readArtifact(run.runId, 'sdd')).toBe('# good SDD');
  });
});

describe('reasoning clamping is recorded as a degradation (R-16)', () => {
  it('notes the clamp on the run rather than only in the log', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    fs.seed(`${PROMPTS}/sdd.md`, '---\nrole: sdd\nrequiredVars: [featureRequest]\n---\n{{featureRequest}}\n');

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');
    const runner = new FakeAgentRunner('claude');

    const stageRunner = new StageRunner({
      fs,
      clock,
      store,
      config,
      // Runner tops out below what finalReviewer asks for.
      capabilities: {
        claude: { ...CAPABILITIES.claude, supportedReasoningLevels: ['low', 'medium', 'high'] },
      },
      promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
      getRunner: () => runner,
      projectDir: PROJECT,
    });

    await stageRunner.run(
      { name: 'final-review', role: 'finalReviewer', prompt: 'sdd' },
      run.runId,
      { featureRequest: 'x' },
    );

    const state = await store.loadRun(run.runId);
    expect(state.degradations.map((d) => d.kind)).toContain('reasoning_clamped');
  });
});
