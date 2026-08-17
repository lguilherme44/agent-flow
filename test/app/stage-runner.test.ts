import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { StageRunner, StageFailure, type StageAdvisor } from '../../src/app/stage-runner.js';
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
    nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
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

/**
 * C-03 and I-20 (AR-01) — the evidence run's TASK-002 attempt 1, reproduced.
 *
 * A role configured `effort: medium` against a model offering only `low` and `high`. The
 * clamp machinery already existed and had never fired, because `capabilities()` took no
 * argument and answered with the *CLI's* levels. Feeding it the pair's levels is the whole
 * change; what this milestone owes on top is that the clamp is never silent, and that no
 * runner is ever handed the unsupported level.
 */
describe('a model that does not offer the configured effort clamps, loudly (C-03, I-20)', () => {
  const NARROW_MODEL = 'narrow-model';
  const WIDE_MODEL = 'wide-model';

  /** Capabilities that genuinely depend on the model, as an adapter with knowledge is. */
  const perModel = {
    claude: (model?: string) =>
      model === NARROW_MODEL
        ? { ...CAPABILITIES.claude, supportedReasoningLevels: ['low', 'high'] as const }
        : CAPABILITIES.claude,
  };

  const configWithModel = (model: string) =>
    GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: {
        architect: { runner: 'claude', effort: 'high' },
        // The role under test: `medium`, against whichever model the case supplies.
        sdd: { runner: 'claude', effort: 'medium', model },
        planner: { runner: 'claude', effort: 'high' },
        planReviewer: { runner: 'claude', effort: 'high' },
        executors: {
          trivial: { runner: 'claude', effort: 'low' },
          normal: { runner: 'claude', effort: 'medium' },
          complex: { runner: 'claude', effort: 'high' },
        },
        verification: { runner: 'claude', effort: 'medium' },
        finalReviewer: { runner: 'claude', effort: 'high' },
      },
    });

  async function clampHarness(model: string) {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    fs.seed(
      `${PROMPTS}/sdd.md`,
      '---\nrole: sdd\npermissions: read-only\nrequiredVars: [featureRequest]\n---\n{{featureRequest}}\n',
    );

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');
    const runner = new FakeAgentRunner('claude');
    runner.pushText('# SDD');

    const stageRunner = new StageRunner({
      fs,
      clock,
      store,
      config: configWithModel(model),
      capabilities: perModel,
      promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
      getRunner: () => runner,
      projectDir: PROJECT,
    });

    const result = await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });
    return { store, run, runner, result };
  }

  it('hands the adapter the effective level, never the requested one (I-20)', async () => {
    // The invariant, asserted where it can actually be broken: at the port. Everything
    // else in this describe is evidence *about* the decision; this is the decision.
    const { runner } = await clampHarness(NARROW_MODEL);

    expect(runner.calls).toHaveLength(1);
    expect(runner.lastCall?.reasoning).toBe('low');
  });

  it('passes the model through unchanged, as the opaque string it is (AD-13, AD-30)', async () => {
    // The constraint that keeps provider knowledge out of the core: the effective effort
    // and the model id are decided by different mechanisms, and the core must not
    // "reconcile" them. A model id that encodes an effort is the adapter's business.
    const { runner } = await clampHarness(NARROW_MODEL);

    expect(runner.lastCall?.model).toBe(NARROW_MODEL);
  });

  it('chooses the greatest supported level that does not exceed the request', async () => {
    const { result } = await clampHarness(NARROW_MODEL);

    expect(result.execution.reasoning).toBe('low');
    expect(result.execution.reasoningClamped).toBe(true);
  });

  it('records a reasoning_clamped degradation carrying every fact C-03 requires', async () => {
    const { store, run } = await clampHarness(NARROW_MODEL);

    const state = await store.loadRun(run.runId);
    const clamp = state.degradations.find((d) => d.kind === 'reasoning_clamped');
    expect(clamp).toBeDefined();

    // requested, effective, supported set, runner, model, reason — in the words a person
    // reads. "Something was degraded" is the sentence this channel exists to forbid.
    const said = `${clamp?.reason ?? ''} ${clamp?.impact ?? ''}`;
    expect(said).toContain('medium');
    expect(said).toContain('low');
    expect(said).toContain('high');
    expect(said).toContain('claude');
    expect(said).toContain(NARROW_MODEL);
  });

  it('publishes the same facts structurally, so a reader never parses prose', async () => {
    // §8 keeps `RunEvent.detail` an open record precisely so evidence can be enriched
    // without a migration. The degradation is for people; this is for the read model.
    const { store, run } = await clampHarness(NARROW_MODEL);

    const events = await store.readEvents(run.runId);
    const started = events.find((event) => event.type === 'stage_started');

    expect(started?.detail).toMatchObject({
      runner: 'claude',
      model: NARROW_MODEL,
      reasoning: 'low',
      reasoningRequested: 'medium',
      reasoningClamped: true,
    });
    expect(started?.detail?.['reasoningSupported']).toEqual(['low', 'high']);
  });

  it('lets the run proceed rather than refusing it (AD-31)', async () => {
    const { result, store, run } = await clampHarness(NARROW_MODEL);

    expect(result.text).toContain('# SDD');
    expect(await store.readArtifact(run.runId, 'sdd')).toContain('# SDD');
  });

  it('does not clamp the same effort when the model does offer it', async () => {
    // The control. Without it, a test suite that clamps everything would pass.
    const { runner, store, run, result } = await clampHarness(WIDE_MODEL);

    expect(runner.lastCall?.reasoning).toBe('medium');
    expect(result.execution.reasoningClamped).toBe(false);

    const state = await store.loadRun(run.runId);
    expect(state.degradations.map((d) => d.kind)).not.toContain('reasoning_clamped');
  });

  it('records no clamp evidence on the event when nothing was clamped', async () => {
    const { store, run } = await clampHarness(WIDE_MODEL);

    const events = await store.readEvents(run.runId);
    const started = events.find((event) => event.type === 'stage_started');

    expect(started?.detail).toMatchObject({ reasoningClamped: false, reasoning: 'medium' });
  });
});

// AF-R04, second pass. The runner-failure path carries its provenance; the
// repair-exhausted path did not. A fallback that answered three times with
// output the schema rejected produced a StageFailure with nothing attached, and
// the caller fell back to describing the runner it had *asked* for — naming the
// primary for work the substitute did.
describe('exhausted repairs still say who produced the output', () => {
  const schema = z.object({ feature: z.string() });
  const stage: StageDefinition = {
    name: 'planning',
    role: 'planner',
    prompt: 'sdd',
    outputSchema: schema,
  };

  const fromFallback = (text: string) => ({
    ok: true as const,
    text,
    durationMs: 1,
    provenance: {
      runner: 'codex',
      reasoning: 'high' as const,
      reasoningClamped: false,
      substitutedFor: { runner: 'claude', errorCode: 'quota_exceeded' as const },
    },
  });

  it('attaches the execution of the last attempt', async () => {
    const { stageRunner, run, runner } = await harness();
    // Every attempt answers, and every answer is rejected by the schema.
    runner.always(fromFallback('not json at all'));

    const error = await stageRunner
      .run(stage, run.runId, { featureRequest: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StageFailure);
    expect((error as StageFailure).errorCode).toBe('invalid_output');
    expect((error as StageFailure).execution?.runner).toBe('codex');
    expect((error as StageFailure).execution?.fallback?.from).toBe('claude');
  });

  it('reports the resolved role when nothing ever answered differently', async () => {
    const { stageRunner, run, runner } = await harness();
    runner.always({ ok: true, text: 'still not json', durationMs: 1 });

    const error = await stageRunner
      .run(stage, run.runId, { featureRequest: 'x' })
      .catch((caught: unknown) => caught);

    expect((error as StageFailure).execution?.runner).toBe('claude');
    expect((error as StageFailure).execution?.fallback).toBeUndefined();
  });
});

describe('advisory context (M3-08)', () => {
  const ADVISORY_STAGE: StageDefinition = {
    name: 'sdd',
    role: 'sdd',
    prompt: 'sdd',
    artifact: 'sdd',
  };

  async function advisorHarness(advisor: StageAdvisor) {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const runner = new FakeAgentRunner('claude');
    fs.seed(
      `${PROMPTS}/sdd.md`,
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
      advisor,
    });
    return { fs, clock, store, run, runner, stageRunner };
  }

  it('appends the advisory block to the prompt the primary runner receives', async () => {
    const { stageRunner, run, runner } = await advisorHarness({
      advise: async ({ renderedPrompt, objective }) =>
        `[ADVISORY]\nObjective: ${objective}\nBase was: ${renderedPrompt.includes('recurring-bookings') ? 'ok' : 'missing'}`,
    });
    runner.pushText('fine');
    await stageRunner.run(
      { ...ADVISORY_STAGE, name: 'sdd' },
      run.runId,
      { featureRequest: 'x' },
    );
    expect(runner.lastCall?.prompt).toContain('[ADVISORY]');
    expect(runner.lastCall?.prompt).toContain('Objective: sdd');
  });

  it('leaves the prompt untouched when the advisor returns undefined', async () => {
    const { stageRunner, run, runner } = await advisorHarness({
      advise: async () => undefined,
    });
    runner.pushText('fine');
    await stageRunner.run({ ...ADVISORY_STAGE, name: 'sdd' }, run.runId, {
      featureRequest: 'x',
    });
    expect(runner.lastCall?.prompt).not.toContain('[ADVISORY]');
    expect(runner.lastCall?.prompt).toContain('Write an SDD for x.');
  });

  it('treats a throwing advisor as absent: the stage still runs', async () => {
    const { stageRunner, run, runner } = await advisorHarness({
      advise: async () => {
        throw new Error('utility model offline');
      },
    });
    runner.pushText('fine');
    const result = await stageRunner.run(
      { ...ADVISORY_STAGE, name: 'sdd' },
      run.runId,
      { featureRequest: 'x' },
    );
    expect(result.text).toBe('fine');
    expect(runner.lastCall?.prompt).not.toContain('[ADVISORY]');
  });

  it('adds advisory context once, not again on a repaired re-prompt', async () => {
    const { stageRunner, run, runner } = await advisorHarness({
      advise: async () => '[ADVISORY]\nblock',
    });
    const schema = z.object({ feature: z.string(), tasks: z.array(z.string()) });
    runner.pushJson({ feature: 'f' }); // tasks missing → repair
    runner.pushJson({ feature: 'f', tasks: [] });
    await stageRunner.run(
      {
        name: 'planning',
        role: 'planner',
        prompt: 'sdd',
        artifact: 'plan',
        outputSchema: schema,
      },
      run.runId,
      { featureRequest: 'x' },
    );
    expect(runner.calls).toHaveLength(2);
    // The advisory block appears exactly once in each call, and the repair is
    // appended after it — never duplicated per attempt.
    for (const call of runner.calls) {
      expect((call.prompt.match(/\[ADVISORY\]/g) ?? []).length).toBe(1);
    }
  });
});
