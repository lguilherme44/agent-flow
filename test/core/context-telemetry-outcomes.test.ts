import { describe, expect, it } from 'vitest';
import { aggregateContextOutcomes } from '../../src/core/context-telemetry.js';
import type { ContextTelemetryObservation } from '../../src/contracts/index.js';

function retrieval(opts: {
  ok?: boolean;
  bypass?: string;
  utilityCalls?: number;
  utilityFailures?: number;
}): ContextTelemetryObservation {
  const base: Record<string, unknown> = {
    stage: 'retrieval',
    source: 'repository_retrieval',
    provenance: 'mechanical_projection',
    candidatesBefore: 3,
  };
  if (opts.ok === true) {
    base.candidatesAfter = 2;
    base.filesAfter = 2;
    base.utilityCalls = opts.utilityCalls ?? 1;
    base.utilityFailures = opts.utilityFailures ?? 0;
  } else if (opts.bypass) {
    base.bypassReason = opts.bypass;
    // Faithful to `retrievalFailure`: a validation_failed bypass DID invoke the
    // model (calls=1), while no_candidates / utility_model_missing never did.
    base.utilityCalls =
      opts.bypass === 'no_candidates' || opts.bypass === 'utility_model_missing' ? 0 : 1;
  }
  return base as unknown as ContextTelemetryObservation;
}

describe('aggregateContextOutcomes', () => {
  it('dogfood: 18 observations - 7 delivered, 11 validation_failed bypassed', () => {
    const observations: ContextTelemetryObservation[] = [
      ...Array.from({ length: 7 }, () => retrieval({ ok: true })),
      ...Array.from({ length: 11 }, () => retrieval({ ok: false, bypass: 'validation_failed' })),
    ];
    const outcomes = aggregateContextOutcomes(observations);
    expect(outcomes.observations).toBe(18);
    expect(outcomes.bypassedObservations).toBe(11);
    expect(outcomes.deliveredAdvisories).toBe(7);
    expect(outcomes.utilityCalls).toBe(18);
    expect(outcomes.bypassReasons).toEqual([{ reason: 'validation_failed', count: 11 }]);
  });

  it('mixed: 3 distinct bypass reasons = 3 bypassed, not 4', () => {
    const observations: ContextTelemetryObservation[] = [
      retrieval({ ok: false, bypass: 'model_failure' }),
      retrieval({ ok: false, bypass: 'utility_model_missing' }),
      retrieval({ ok: false, bypass: 'validation_failed' }),
    ];
    const outcomes = aggregateContextOutcomes(observations);
    expect(outcomes.observations).toBe(3);
    expect(outcomes.bypassedObservations).toBe(3);
    expect(outcomes.deliveredAdvisories).toBe(0);
    expect(outcomes.utilityCalls).toBe(2);
    expect(outcomes.bypassReasons).toHaveLength(3);
    expect(outcomes.bypassReasons.find((r) => r.reason === 'model_failure')?.count).toBe(1);
    expect(outcomes.bypassReasons.find((r) => r.reason === 'utility_model_missing')?.count).toBe(1);
    expect(outcomes.bypassReasons.find((r) => r.reason === 'validation_failed')?.count).toBe(1);
  });

  it('non-call bypasses do not corrupt utility call denominator', () => {
    const observations: ContextTelemetryObservation[] = [
      retrieval({ ok: true }),
      retrieval({ ok: false, bypass: 'utility_model_missing' }),
      retrieval({ ok: false, bypass: 'no_candidates' }),
    ];
    const outcomes = aggregateContextOutcomes(observations);
    expect(outcomes.observations).toBe(3);
    expect(outcomes.utilityCalls).toBe(1);
    expect(outcomes.deliveredAdvisories).toBe(1);
    expect(outcomes.bypassedObservations).toBe(2);
  });

  it('one observation with overlapping counters counts as one bypass', () => {
    const obs = {
      stage: 'retrieval',
      source: 'repository_retrieval',
      provenance: 'mechanical_projection',
      candidatesBefore: 5,
      utilityCalls: 1,
      utilityFailures: 1,
      bypassReason: 'validation_failed',
    } as unknown as ContextTelemetryObservation;
    const outcomes = aggregateContextOutcomes([obs]);
    expect(outcomes.observations).toBe(1);
    expect(outcomes.bypassedObservations).toBe(1);
    expect(outcomes.deliveredAdvisories).toBe(0);
    expect(outcomes.utilityCalls).toBe(1);
    expect(outcomes.bypassReasons).toEqual([{ reason: 'validation_failed', count: 1 }]);
  });

  it('aggregate-stage observations are never counted as outcomes', () => {
    const aggregate = {
      stage: 'aggregate',
      source: 'aggregate',
      provenance: 'aggregate',
      utilityCalls: 999,
      bypassReason: 'validation_failed',
    } as unknown as ContextTelemetryObservation;
    const outcomes = aggregateContextOutcomes([retrieval({ ok: true }), aggregate]);
    expect(outcomes.observations).toBe(1);
    expect(outcomes.deliveredAdvisories).toBe(1);
    expect(outcomes.bypassedObservations).toBe(0);
    expect(outcomes.utilityCalls).toBe(1);
  });

  it('empty observations produce zero counts', () => {
    const outcomes = aggregateContextOutcomes([]);
    expect(outcomes.observations).toBe(0);
    expect(outcomes.bypassedObservations).toBe(0);
    expect(outcomes.deliveredAdvisories).toBe(0);
    expect(outcomes.utilityCalls).toBe(0);
    expect(outcomes.bypassReasons).toEqual([]);
  });

  it('same bypass reason on multiple observations counts each independently', () => {
    const observations = Array.from({ length: 5 }, () =>
      retrieval({ ok: false, bypass: 'validation_failed' }),
    );
    const outcomes = aggregateContextOutcomes(observations);
    expect(outcomes.bypassReasons).toEqual([{ reason: 'validation_failed', count: 5 }]);
    expect(outcomes.bypassedObservations).toBe(5);
  });
});
