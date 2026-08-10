import { describe, it, expect } from 'vitest';
import { createRunnerFactory } from '../../src/app/runner-factory.js';
import { resolveRole, resolveFallback } from '../../src/core/role.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import type { FallbackEvent } from '../../src/adapters/runners/fallback-runner.js';
import type { RunnerRegistry } from '../../src/adapters/runners/registry.js';
import type { AgentRunInput } from '../../src/ports/index.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { recordFallback } from '../../src/app/fallback-audit.js';

/**
 * V-02 regression.
 *
 * Was a defect: `FallbackRunner` was constructed only by its own tests. The
 * runtime asked the registry for a runner by id and got a bare adapter, so a
 * configured fallback did nothing — while `doctor` still counted it when
 * deciding whether a role had a route. Doctor and runtime disagreed, and doctor
 * was the optimistic one.
 */

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
} as const;

const NARROW_CAPS = { ...CAPS, supportedReasoningLevels: ['low', 'medium', 'high'] } as const;

function config(overrides: Record<string, unknown> = {}) {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'codex', effort: 'low' },
        normal: { runner: 'codex', model: 'gpt-5.6-terra', effort: 'medium' },
        complex: { runner: 'codex', effort: 'high' },
      },
      verification: { runner: 'codex', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'very_high' },
    },
    ...overrides,
  });
}

const withFallback = (roles: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  config({ fallback: { enabled: true, roles, ...extra } });

function registryOf(runners: Record<string, FakeAgentRunner>, caps = CAPS): RunnerRegistry {
  return {
    ids: () => Object.keys(runners),
    get: (id) => {
      const runner = runners[id];
      if (!runner) throw new Error(`no runner ${id}`);
      return runner;
    },
    has: (id) => id in runners,
    capabilities: () => Object.fromEntries(Object.keys(runners).map((id) => [id, caps])),
    providerOf: (id) => (id === 'claude' ? 'claude-code-cli' : 'codex-cli'),
    health: async () => ({}),
    validateRoles: () => undefined,
  };
}

const input: AgentRunInput = {
  prompt: 'do the thing',
  reasoning: 'medium',
  workingDirectory: '/repo',
  permissions: 'write',
  timeoutSeconds: 900,
};

describe('a configured fallback actually fires', () => {
  it('routes a quota failure to the replacement runner', async () => {
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const cfg = withFallback({ 'executor.normal': { runner: 'claude', effort: 'high' } });
    const factory = createRunnerFactory({ registry: registryOf({ claude, codex }), config: cfg });

    codex.pushFailure('quota_exceeded');
    claude.pushText('done');

    const runner = factory(resolveRole('executor.normal', cfg, { claude: CAPS, codex: CAPS }));
    const result = await runner.run(input);

    expect(result.ok).toBe(true);
    expect(claude.calls).toHaveLength(1);
  });

  it('returns a plain adapter when the role has no fallback', async () => {
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const cfg = config();
    const factory = createRunnerFactory({ registry: registryOf({ claude, codex }), config: cfg });
    const runner = factory(resolveRole('executor.normal', cfg, { claude: CAPS, codex: CAPS }));

    expect(runner).toBe(codex);
  });

  it('still refuses to route a quality failure (§55)', async () => {
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const cfg = withFallback({ 'executor.normal': { runner: 'claude', effort: 'high' } });
    const factory = createRunnerFactory({ registry: registryOf({ claude, codex }), config: cfg });

    codex.pushFailure('invalid_output');

    const runner = factory(resolveRole('executor.normal', cfg, { claude: CAPS, codex: CAPS }));
    const result = await runner.run(input);

    expect(result.ok).toBe(false);
    expect(claude.calls).toHaveLength(0);
  });
});

describe('the replacement runs on its own configuration', () => {
  it('does not carry the primary model across to another runner', async () => {
    // The concrete trap: executor.normal is configured with gpt-5.6-terra on
    // codex. Handing that model name to Claude Code would fail as an unknown
    // model, and the failure would look like the fallback itself being broken.
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const cfg = withFallback({
      'executor.normal': { runner: 'claude', model: 'opus', effort: 'very_high' },
    });
    const factory = createRunnerFactory({ registry: registryOf({ claude, codex }), config: cfg });

    codex.pushFailure('quota_exceeded');
    claude.pushText('done');

    const runner = factory(resolveRole('executor.normal', cfg, { claude: CAPS, codex: CAPS }));
    await runner.run({ ...input, model: 'gpt-5.6-terra' });

    expect(claude.lastCall?.model).toBe('opus');
  });

  it('drops the model entirely when the fallback declares none', async () => {
    // An absent model means "whatever this CLI is configured for", which is
    // right. The primary's model name would be wrong.
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const cfg = withFallback({ 'executor.normal': { runner: 'claude', effort: 'high' } });
    const factory = createRunnerFactory({ registry: registryOf({ claude, codex }), config: cfg });

    codex.pushFailure('quota_exceeded');
    claude.pushText('done');

    const runner = factory(resolveRole('executor.normal', cfg, { claude: CAPS, codex: CAPS }));
    await runner.run({ ...input, model: 'gpt-5.6-terra' });

    expect(claude.lastCall?.model).toBeUndefined();
  });

  it('uses the fallback effort and timeout, not the primary ones', async () => {
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const cfg = withFallback({
      'executor.normal': { runner: 'claude', effort: 'very_high', timeoutSeconds: 120 },
    });
    const factory = createRunnerFactory({ registry: registryOf({ claude, codex }), config: cfg });

    codex.pushFailure('auth_required');
    claude.pushText('done');

    const runner = factory(resolveRole('executor.normal', cfg, { claude: CAPS, codex: CAPS }));
    await runner.run(input);

    expect(claude.lastCall?.reasoning).toBe('very_high');
    expect(claude.lastCall?.timeoutSeconds).toBe(120);
  });
});

describe('the substitution is recorded', () => {
  it('reports which role ran where, and on what', async () => {
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);
    const events: FallbackEvent[] = [];

    const cfg = withFallback({ 'executor.normal': { runner: 'claude', effort: 'high' } });
    const factory = createRunnerFactory({
      registry: registryOf({ claude, codex }),
      config: cfg,
      onFallback: (event) => {
        events.push(event);
      },
    });

    codex.pushFailure('quota_exceeded');
    claude.pushText('done');

    await factory(resolveRole('executor.normal', cfg, { claude: CAPS, codex: CAPS })).run(input);

    expect(events).toHaveLength(1);
    expect(events[0]?.config.role).toBe('executor.normal');
    expect(events[0]?.to).toBe('claude');
    expect(events[0]?.errorCode).toBe('quota_exceeded');
  });
});

describe('resolveFallback', () => {
  const caps = { claude: CAPS, codex: CAPS };

  it('is undefined when fallback is disabled entirely', () => {
    const cfg = config({
      fallback: { enabled: false, roles: { 'executor.normal': { runner: 'claude', effort: 'high' } } },
    });
    expect(resolveFallback('executor.normal', cfg, caps)).toBeUndefined();
  });

  it('is undefined when the role has no fallback configured', () => {
    expect(resolveFallback('executor.normal', config(), caps)).toBeUndefined();
  });

  it('is undefined when the fallback runner is disabled', () => {
    const cfg = withFallback({ 'executor.normal': { runner: 'claude', effort: 'high' } });
    const disabled = GlobalConfigSchema.parse({
      ...cfg,
      runners: { claude: { type: 'claude-code-cli', enabled: false }, codex: { type: 'codex-cli' } },
    });
    expect(resolveFallback('executor.normal', disabled, caps)).toBeUndefined();
  });

  it('refuses a fallback that cannot honour a read-only stage', () => {
    // Falling back must not quietly drop a guarantee: a read-only stage stays
    // read-only even when the primary runner is down.
    const cfg = withFallback({ sdd: { runner: 'claude', effort: 'high' } });
    const noReadOnly = { claude: { ...CAPS, supportsReadOnly: false }, codex: CAPS };

    expect(resolveFallback('sdd', cfg, noReadOnly, { readOnly: true })).toBeUndefined();
    expect(resolveFallback('sdd', cfg, noReadOnly, { readOnly: false })).toBeDefined();
  });

  it('clamps the fallback effort to what its runner supports', () => {
    const cfg = withFallback({ 'executor.normal': { runner: 'claude', effort: 'very_high' } });
    const resolved = resolveFallback('executor.normal', cfg, { claude: NARROW_CAPS, codex: CAPS });

    expect(resolved?.reasoning).toBe('high');
    expect(resolved?.reasoningClamped).toBe(true);
  });
});

describe('every fallback is recorded (AF-R02 regression)', () => {
  // Three separate mistakes lived in the inline hook this replaces, and each
  // was enough on its own to lose the record: the promise was discarded with
  // `void`, the run id was captured once when the context was built, and any
  // failure was swallowed by the same `void`.
  //
  // A fallback is exactly the event a run must be able to explain afterwards —
  // it finished on a provider nobody configured for it.

  async function auditWorld() {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    const store = new StateStore({ fs, clock, projectDir: '/repo' });
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const cfg = withFallback({ 'executor.normal': { runner: 'claude', effort: 'high' } });
    const factory = createRunnerFactory({
      registry: registryOf({ claude, codex }),
      config: cfg,
      onFallback: recordFallback(store),
    });

    return { fs, store, claude, codex, cfg, factory };
  }

  it('persists the degradation before the run continues', async () => {
    // The awaited write is the point: recordDegradation is a read-modify-write
    // on state.json, so a pending promise lost the entry to the next write.
    const w = await auditWorld();
    const run = await w.store.createRun('f');

    w.codex.pushFailure('quota_exceeded');
    w.claude.pushText('done');

    await w.factory(resolveRole('executor.normal', w.cfg, { claude: CAPS, codex: CAPS })).run(input);

    const state = await w.store.loadRun(run.runId);
    expect(state.degradations.map((d) => d.kind)).toContain('runner_unavailable_with_fallback');
  });

  it('names the role, the substitute and the effort it ran at', async () => {
    const w = await auditWorld();
    const run = await w.store.createRun('f');

    w.codex.pushFailure('auth_required');
    w.claude.pushText('done');

    await w.factory(resolveRole('executor.normal', w.cfg, { claude: CAPS, codex: CAPS })).run(input);

    const degradation = (await w.store.loadRun(run.runId)).degradations[0];
    expect(degradation?.reason).toContain('codex');
    expect(degradation?.impact).toContain('executor.normal');
    expect(degradation?.impact).toContain('claude');
  });

  it('logs an event alongside the degradation', async () => {
    const w = await auditWorld();
    const run = await w.store.createRun('f');

    w.codex.pushFailure('quota_exceeded');
    w.claude.pushText('done');

    await w.factory(resolveRole('executor.normal', w.cfg, { claude: CAPS, codex: CAPS })).run(input);

    const events = await w.store.readEvents(run.runId);
    const used = events.find((event) => event.type === 'fallback_used');

    expect(used?.detail['from']).toBe('codex');
    expect(used?.detail['to']).toBe('claude');
  });

  it('records against the run that is in flight, not the one that existed at wiring time', async () => {
    // The run id used to be captured when the context was built. A fallback
    // during a later run recorded against the wrong id — or against ''.
    const w = await auditWorld();
    await w.store.createRun('first');
    const second = await w.store.createRun('second');

    w.codex.pushFailure('quota_exceeded');
    w.claude.pushText('done');

    await w.factory(resolveRole('executor.normal', w.cfg, { claude: CAPS, codex: CAPS })).run(input);

    expect((await w.store.loadRun(second.runId)).degradations).toHaveLength(1);
  });

  it('does nothing when no run is active, rather than throwing into the void', async () => {
    const w = await auditWorld();

    w.codex.pushFailure('quota_exceeded');
    w.claude.pushText('done');

    const result = await w
      .factory(resolveRole('executor.normal', w.cfg, { claude: CAPS, codex: CAPS }))
      .run(input);

    // The work still succeeds; the audit simply has nowhere to go.
    expect(result.ok).toBe(true);
  });

  it('does not pile up identical entries when a role falls back repeatedly', async () => {
    const w = await auditWorld();
    const run = await w.store.createRun('f');
    const runner = w.factory(resolveRole('executor.normal', w.cfg, { claude: CAPS, codex: CAPS }));

    for (let i = 0; i < 3; i += 1) {
      w.codex.pushFailure('quota_exceeded');
      w.claude.pushText('done');
      await runner.run(input);
    }

    expect((await w.store.loadRun(run.runId)).degradations).toHaveLength(1);
  });
});
