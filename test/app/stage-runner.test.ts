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

async function harness(options: { runner?: FakeAgentRunner; prompt?: string; recordPrompts?: boolean } = {}) {
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
    config: options.recordPrompts === true
      ? { ...config, execution: { ...config.execution, recordPrompts: true } }
      : config,
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

  it('keeps the prompt out of the log unless the operator asked for it (§95)', async () => {
    // A prompt is a copy of whatever the stage was given — repository content, a plan, a
    // failure packet. Recording one by default would leave that lying in the run directory.
    const quiet = await harness();
    quiet.runner.pushText('ok');
    await quiet.stageRunner.run(SDD_STAGE, quiet.run.runId, { featureRequest: 'recurring bookings' });
    expect(await quiet.fs.readFile(runPaths(PROJECT, quiet.run.runId).log('sdd'))).not.toContain('recurring bookings');

    const recording = await harness({ recordPrompts: true });
    recording.runner.pushText('ok');
    await recording.stageRunner.run(SDD_STAGE, recording.run.runId, { featureRequest: 'recurring bookings' });
    const log = await recording.fs.readFile(runPaths(PROJECT, recording.run.runId).log('sdd'));
    // The input the agent acted on, which no other record holds.
    expect(log).toContain('--- prompt (redacted) ---');
    expect(log).toContain('recurring bookings');
  });

  it('writes a per-stage log', async () => {
    const { stageRunner, run, fs } = await harness();
    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    const log = await fs.readFile(runPaths(PROJECT, run.runId).log('sdd'));
    expect(log).toContain('sdd');
  });

  /**
   * A stage that worked used to log two lines (§95, PRI-21).
   *
   * The failure path has written the runner's whole output since somebody had to open a
   * vendor's log directory to find out what an agent said. The success path wrote
   * `repair=1 ok durationMs=…` for what a live run measured as six minutes of model work —
   * and once `execution.recordPrompts` shipped, the log held the question and not the
   * answer, which is the same asymmetry pointing the other way.
   */
  it('says where a successful answer went when the stage has an artifact', async () => {
    const { stageRunner, run, fs, runner } = await harness();
    runner.pushText('# SDD body');

    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });
    const log = await fs.readFile(runPaths(PROJECT, run.runId).log('sdd'));

    // A pointer rather than a copy: the answer is already on disk under a name, and two
    // copies of one document is how a reader ends up comparing them.
    expect(log).toContain('answer written to artifact "sdd"');
    expect(log).not.toContain('--- runner output (redacted) ---');
  });

  it('writes the answer itself when no artifact would hold it', async () => {
    const { stageRunner, run, fs, runner } = await harness();
    runner.pushText('the whole answer, kept nowhere else');

    await stageRunner.run(
      { name: 'sdd', role: 'sdd', prompt: 'sdd', logName: 'sdd' },
      run.runId,
      { featureRequest: 'x' },
    );
    const log = await fs.readFile(runPaths(PROJECT, run.runId).log('sdd'));

    expect(log).toContain('--- runner output (redacted) ---');
    expect(log).toContain('the whole answer, kept nowhere else');
  });

  it('invents no monetary figure when the runner reported none (§57, PRI-19)', async () => {
    // §57's prohibition, narrowed rather than dropped. What it forbids absolutely is a
    // price *this codebase computes* — a table of per-token rates would make agent-flow
    // accountable for a number it has no basis for. What PRI-19 allows is a price the
    // provider itself returned, and this fake returns none, so nothing may appear.
    const { stageRunner, run, store } = await harness();
    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    const events = await store.readEvents(run.runId);
    const completed = events.find((event) => event.type === 'stage_completed');

    expect(completed?.detail['runner']).toBe('claude');
    expect(completed?.detail['role']).toBe('sdd');
    expect(completed?.detail['usage']).toBeUndefined();
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

/**
 * C-05 and I-21 (AR-02) — the failure stops being a code with nothing attached.
 *
 * `AgentRunFailure.raw` is documented as "kept for diagnosis" and was dropped at exactly
 * the two points that persist anything: the log wrote only the error code, and the event
 * omitted it entirely. The true cause of the evidence run's worst failure —
 * `soft-denying tool confirmation "Bash"` — existed in memory and was thrown away, so a
 * person opened the vendor's own log directory instead.
 *
 * Raw output is **evidence, never control flow**. Everything that branches still branches
 * on `RunnerErrorCode`; the classifier reads the text once, to name what happened.
 */
describe('a failed stage persists what actually happened (C-05, I-21)', () => {
  const DENIAL = [
    '[agy] tool request: Bash(grep -rn "x" src/)',
    '[agy] soft-denying tool confirmation "Bash"',
    '[agy] permission check failed',
  ].join('\n');

  async function failWith(raw: string, errorCode: 'execution_failed' | 'timeout' = 'execution_failed') {
    const harnessed = await harness();
    harnessed.runner.push({ ok: false, errorCode, raw, durationMs: 5 });

    const error = await harnessed.stageRunner
      .run(SDD_STAGE, harnessed.run.runId, { featureRequest: 'x' })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    return { ...harnessed, error };
  }

  it('classifies the denial rather than reporting execution_failed', async () => {
    const { error } = await failWith(DENIAL);

    expect(error).toBeInstanceOf(StageFailure);
    expect((error as StageFailure).failureClass).toBe('runner_permission_required');
    expect((error as StageFailure).deniedCommand).toBe('Bash');
  });

  it('keeps branching on the runner code, never on the text', async () => {
    // The classification is a *name*, not a decision. `errorCode` is still what the
    // caller's control flow reads, and it is unchanged.
    const { error } = await failWith(DENIAL);
    expect((error as StageFailure).errorCode).toBe('execution_failed');
  });

  it('carries the class and a redacted excerpt on stage_failed', async () => {
    const { store, run } = await failWith(DENIAL);

    const events = await store.readEvents(run.runId);
    const failed = events.find((event) => event.type === 'stage_failed');

    expect(failed?.detail).toMatchObject({
      errorCode: 'execution_failed',
      failureClass: 'runner_permission_required',
      deniedCommand: 'Bash',
      runner: 'claude',
    });
    expect(String(failed?.detail?.['rawExcerpt'])).toContain('soft-denying');
  });

  it('writes the full raw into the stage log', async () => {
    const { fs, run } = await failWith(DENIAL);

    const log = await fs.readFile(runPaths(PROJECT, run.runId).log('sdd'));
    expect(log).toContain('soft-denying tool confirmation');
    expect(log).toContain('permission check failed');
  });

  it('redacts before persisting, in the log and in the event', async () => {
    // I-21: no persisted artifact, event or response carries unredacted runner output.
    // A runner's output routinely names the absolute directory it ran in and, when a
    // build tool echoes its environment, rather more than that.
    const leaky = [
      `failed while reading ${PROJECT}/src/secret-place/config.ts`,
      'export API_KEY=sk-live-4f2b9c81aa77de31',
      'Authorization: Bearer ghp_ZZZZYYYYXXXXWWWWVVVV1111',
    ].join('\n');

    const { fs, store, run } = await failWith(leaky);

    const log = await fs.readFile(runPaths(PROJECT, run.runId).log('sdd'));
    const events = await store.readEvents(run.runId);
    const failed = events.find((event) => event.type === 'stage_failed');
    const persisted = `${log}\n${JSON.stringify(failed?.detail ?? {})}`;

    expect(persisted).not.toContain('sk-live-4f2b9c81aa77de31');
    expect(persisted).not.toContain('ghp_ZZZZYYYYXXXXWWWWVVVV1111');
    expect(persisted).not.toContain(`${PROJECT}/src/secret-place`);
    // And it still says something: redaction is lossy, not silencing.
    expect(persisted).toContain('failed while reading');
  });

  it('bounds the excerpt and marks the cut', async () => {
    // §6.5: a budget is never applied silently.
    const huge = `first line\n${'x'.repeat(8000)}`;
    const { store, run } = await failWith(huge);

    const events = await store.readEvents(run.runId);
    const excerpt = String(
      events.find((event) => event.type === 'stage_failed')?.detail?.['rawExcerpt'] ?? '',
    );

    expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(2048);
    expect(excerpt).toContain('first line');
    expect(excerpt).toMatch(/truncated/);
  });

  it('does not invent a class for a failure whose text says nothing', async () => {
    const { error, store, run } = await failWith('the process exited unexpectedly');

    expect((error as StageFailure).failureClass).toBe('runner_execution_failed');
    expect((error as StageFailure).deniedCommand).toBeUndefined();

    const events = await store.readEvents(run.runId);
    expect(events.find((event) => event.type === 'stage_failed')?.detail).toMatchObject({
      failureClass: 'runner_execution_failed',
    });
  });

  it('classifies a timeout from its code alone', async () => {
    const { error } = await failWith('deadline exceeded', 'timeout');
    expect((error as StageFailure).failureClass).toBe('runner_timeout');
  });
});

/**
 * AR-09 — what the prompt was made of, per stage.
 *
 * A one-`grep` call in the evidence environment reported ≈49 000 input tokens before Agent
 * Flow contributed anything of its own, and recovery adds a Failure Context Packet on top
 * of that. The measurement is the deliverable: "the prompt got big" is not something
 * anybody can act on, and "AGENTS.md is 80% of it" is.
 */
describe('the prompt is measured, by source (AR-09)', () => {
  it('records a composition event with every contributing source', async () => {
    const { stageRunner, run, store, runner } = await harness();
    runner.pushText('# SDD');

    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    const measured = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );

    expect(measured?.detail).toMatchObject({ stage: 'sdd', overCeiling: false });
    expect(Number(measured?.detail?.['totalBytes'])).toBeGreaterThan(0);
  });

  it('attributes the measurement to the attempt it belongs to (AR-09)', async () => {
    // **Without this the number is unusable.** AR-09's acceptance asks for a recovered
    // task's cost "against a first-attempt baseline", and a baseline is a comparison
    // between two attempts of one task. An event that names only the stage cannot be joined
    // to either of them: `implementation` runs once per task per attempt, so every one of
    // them writes an event with the identical `stage` field.
    const { stageRunner, run, store, runner } = await harness();
    runner.pushText('# SDD');

    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' }, {
      task: 'TASK-001',
      attempt: 2,
    });

    const measured = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );

    expect(measured?.detail).toMatchObject({ task: 'TASK-001', attempt: 2 });
  });

  it('omits the attribution for a stage that has no task', async () => {
    // Absent rather than a placeholder. A pipeline stage genuinely belongs to no task, and
    // `task: ''` would join to nothing while looking like it should.
    const { stageRunner, run, store, runner } = await harness();
    runner.pushText('# SDD');

    await stageRunner.run(SDD_STAGE, run.runId, { featureRequest: 'x' });

    const measured = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );

    expect(measured?.detail?.['task']).toBeUndefined();
    expect(measured?.detail?.['attempt']).toBeUndefined();
  });

  it('attributes AGENTS.md separately from our own prompt', async () => {
    // Four sources, four owners. A single total cannot tell anybody which one to shrink.
    const { stageRunner, run, store, runner } = await harness();
    runner.pushText('# SDD');

    await stageRunner.run(SDD_STAGE, run.runId, {
      featureRequest: 'x',
      agentsMd: 'y'.repeat(4000),
    });

    const measured = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = measured?.detail?.['parts'] as { source: string; bytes: number; share: number }[];

    const agents = parts.find((part) => part.source === 'agentsMd');
    expect(agents?.bytes).toBe(4000);
    // Largest first, so the thing worth shrinking is the thing read first.
    expect(parts[0]?.source).toBe('agentsMd');
  });

  it('warns when a trivial task receives more context than the ceiling', async () => {
    const { stageRunner, run, store, runner } = await harness();
    runner.pushText('# SDD');

    await stageRunner.run(
      SDD_STAGE,
      run.runId,
      { featureRequest: 'x', agentsMd: 'y'.repeat(30 * 1024) },
      { complexity: 'trivial' },
    );

    const measured = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );

    expect(measured?.detail?.['overCeiling']).toBe(true);
    expect(String(measured?.detail?.['ceilingDetail'])).toContain('agentsMd');
  });

  it('does not warn for an unclassified pipeline stage', async () => {
    // The ceiling belongs to `trivial` alone. Discovery legitimately receives a lot, and
    // warning there would train the reader to ignore the warning that matters.
    const { stageRunner, run, store, runner } = await harness();
    runner.pushText('# SDD');

    await stageRunner.run(SDD_STAGE, run.runId, {
      featureRequest: 'x',
      agentsMd: 'y'.repeat(30 * 1024),
    });

    const measured = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );

    expect(measured?.detail?.['overCeiling']).toBe(false);
  });
});
