import { describe, expect, it } from 'vitest';
import { ContextTelemetryRecorder } from '../../src/app/context-telemetry-recorder.js';
import { StateStore } from '../../src/app/state-store.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';

const OBSERVATION = {
  stage: 'primary_context',
  source: 'primary_runner',
  provenance: 'runtime_observation',
  estimatedInputTokens: 100,
  estimatedPrimaryContextTokens: 40,
  estimatedAvoidedTokens: 60,
} as const;

describe('ContextTelemetryRecorder', () => {
  it('persists a schema-validated observation only in the existing audit trail', async () => {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/repo' });
    const run = await store.createRun('context telemetry');

    new ContextTelemetryRecorder(store).record(run.runId, OBSERVATION);
    await Promise.resolve();

    const observed = (await store.readEvents(run.runId)).filter(
      (event) => event.type === 'context_telemetry_observed',
    );
    expect(observed).toEqual([
      {
        at: '2026-08-09T20:00:00.000Z',
        type: 'context_telemetry_observed',
        detail: { observation: OBSERVATION },
      },
    ]);
    expect(Object.keys(fs.snapshot()).filter((path) => path.includes('telemetry'))).toEqual([]);
  });

  it('is fail-open when the audit append rejects', async () => {
    const failure = new Error('disk path /secret/token=do-not-return');
    const recorder = new ContextTelemetryRecorder({
      appendEvent: async () => {
        throw failure;
      },
    });

    expect(() => recorder.record('AF-2026-001', OBSERVATION)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('omits invalid or secret-bearing observations without invoking persistence', async () => {
    const persisted: unknown[] = [];
    const recorder = new ContextTelemetryRecorder({
      appendEvent: async (...args: unknown[]) => {
        persisted.push(args);
      },
    });

    recorder.record('AF-2026-001', { ...OBSERVATION, apiKey: 'sk-live-secret' });
    recorder.record('AF-2026-001', { ...OBSERVATION, estimatedInputTokens: -1 });
    await Promise.resolve();

    expect(persisted).toEqual([]);
  });

  it('does not execute inherited properties, accessors, or hostile proxy traps', async () => {
    let getterCalls = 0;
    const inherited = Object.create({ apiKey: 'sk-inherited-secret' }) as Record<string, unknown>;
    Object.assign(inherited, OBSERVATION);
    Object.defineProperty(inherited, 'estimatedOutputTokens', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 99;
      },
    });
    const hostile = new Proxy(OBSERVATION, {
      ownKeys() {
        throw new Error('proxy secret');
      },
    });
    const persisted: unknown[] = [];
    const recorder = new ContextTelemetryRecorder({
      appendEvent: async (...args: unknown[]) => {
        persisted.push(args);
      },
    });

    expect(() => recorder.record('AF-2026-001', inherited)).not.toThrow();
    expect(() => recorder.record('AF-2026-001', hostile)).not.toThrow();
    await Promise.resolve();

    expect(getterCalls).toBe(0);
    expect(persisted).toEqual([]);
  });
});
