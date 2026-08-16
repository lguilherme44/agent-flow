import { describe, expect, it } from 'vitest';
import {
  ContextTelemetryReader,
  MAX_CONTEXT_TELEMETRY_EVENT_SCAN,
  contextTelemetryFromEvents,
} from '../../src/server/context-telemetry-reader.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';

const RUN_ID = 'AF-2026-001';
const EVENTS_PATH = `/repo/.agent-flow/runs/${RUN_ID}/events.jsonl`;

function observation(input = 100, primary = 40) {
  return {
    stage: 'primary_context',
    source: 'primary_runner',
    provenance: 'runtime_observation',
    estimatedInputTokens: input,
    estimatedPrimaryContextTokens: primary,
    estimatedAvoidedTokens: Math.max(0, input - primary),
  } as const;
}

function event(value: unknown = observation()) {
  return {
    at: '2026-08-09T20:00:00.000Z',
    type: 'context_telemetry_observed',
    detail: { observation: value },
  };
}

describe('ContextTelemetryReader', () => {
  it('skips malformed, legacy, and secret-bearing audit lines while deriving a closed view', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(
      EVENTS_PATH,
      [
        '{broken',
        JSON.stringify({ at: 'legacy', type: 'context_telemetry_observed', detail: {} }),
        JSON.stringify(event({ ...observation(), header: 'Bearer secret' })),
        JSON.stringify(event()),
      ].join('\n'),
    );

    const view = await new ContextTelemetryReader({ fs, projectDir: '/repo' }).read(RUN_ID);

    expect(view).toMatchObject({
      basis: 'estimated_operational_not_billing',
      scope: { eventsScanned: 4, observations: 1, truncated: false },
      observations: [observation()],
      aggregate: {
        stage: 'aggregate',
        source: 'aggregate',
        provenance: 'aggregate',
        estimatedInputTokens: 100,
        estimatedPrimaryContextTokens: 40,
        estimatedAvoidedTokens: 60,
      },
    });
    expect(JSON.stringify(view)).not.toMatch(/Bearer|secret|header/i);
  });

  it('counts duplicate observations as distinct facts but never crosses run scope', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(EVENTS_PATH, `${JSON.stringify(event())}\n${JSON.stringify(event())}\n`);
    fs.seed(
      '/repo/.agent-flow/runs/AF-2026-002/events.jsonl',
      `${JSON.stringify(event(observation(999, 1)))}\n`,
    );

    const view = await new ContextTelemetryReader({ fs, projectDir: '/repo' }).read(RUN_ID);

    expect(view?.scope.observations).toBe(2);
    expect(view?.aggregate?.estimatedInputTokens).toBe(200);
    expect(view?.aggregate?.estimatedPrimaryContextTokens).toBe(80);
  });

  it('reports the deterministic event cap instead of silently describing a partial log', async () => {
    const fs = new InMemoryFileSystem();
    const lines = Array.from(
      { length: MAX_CONTEXT_TELEMETRY_EVENT_SCAN + 1 },
      () => JSON.stringify(event(observation(1, 1))),
    );
    fs.seed(EVENTS_PATH, lines.join('\n'));

    const view = await new ContextTelemetryReader({ fs, projectDir: '/repo' }).read(RUN_ID);

    expect(view?.scope).toEqual({
      eventsScanned: MAX_CONTEXT_TELEMETRY_EVENT_SCAN,
      eventLimit: MAX_CONTEXT_TELEMETRY_EVENT_SCAN,
      observations: MAX_CONTEXT_TELEMETRY_EVENT_SCAN,
      truncated: true,
    });
    expect(view?.aggregate?.estimatedInputTokens).toBe(MAX_CONTEXT_TELEMETRY_EVENT_SCAN);
  });

  it('reports truncation even when the bounded prefix contains no context observation', () => {
    const legacy = Array.from(
      { length: MAX_CONTEXT_TELEMETRY_EVENT_SCAN + 1 },
      () => ({ at: '2026-08-09T20:00:00.000Z', type: 'task_started', detail: {} }),
    );

    const view = contextTelemetryFromEvents(legacy);

    expect(view?.scope).toMatchObject({ observations: 0, truncated: true });
    expect(view?.observations).toEqual([]);
    expect(view?.aggregate).toBeUndefined();
  });

  it('skips an oversized event line without preventing a later bounded observation', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(
      EVENTS_PATH,
      `${JSON.stringify({ giant: 'x'.repeat(70_000) })}\n${JSON.stringify(event())}\n`,
    );

    const view = await new ContextTelemetryReader({ fs, projectDir: '/repo' }).read(RUN_ID);

    expect(view?.scope).toMatchObject({ eventsScanned: 2, observations: 1, truncated: false });
    expect(view?.aggregate?.estimatedInputTokens).toBe(100);
  });

  it('preserves observed zero, omits unobserved fields, and refuses unsafe sums', () => {
    const zero = contextTelemetryFromEvents([
      event({
        stage: 'retrieval',
        source: 'repository_retrieval',
        provenance: 'mechanical_projection',
        candidatesBefore: 0,
        utilityCalls: 0,
      }),
    ]);
    const overflow = contextTelemetryFromEvents([
      event(observation(600_000_000_000, 1)),
      event(observation(600_000_000_000, 1)),
    ]);

    expect(zero?.aggregate?.utilityCalls).toBe(0);
    expect(zero?.aggregate?.estimatedInputTokens).toBeUndefined();
    expect(overflow?.aggregate?.estimatedInputTokens).toBeUndefined();
    expect(overflow?.aggregate?.estimatedPrimaryContextTokens).toBe(2);
  });

  it('returns absence rather than zeros and skips hostile event DTOs without traps escaping', () => {
    let getterCalls = 0;
    const accessor = { ...event() };
    Object.defineProperty(accessor, 'detail', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { observation: observation() };
      },
    });
    const proxy = new Proxy(event(), {
      getOwnPropertyDescriptor() {
        throw new Error('hostile secret');
      },
    });

    const view = contextTelemetryFromEvents([accessor, proxy, { type: 'legacy' }, event()]);
    expect(view?.scope.observations).toBe(1);
    expect(view?.aggregate?.estimatedInputTokens).toBe(100);
    expect(getterCalls).toBe(0);
  });
});
