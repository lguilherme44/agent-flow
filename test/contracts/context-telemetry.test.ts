import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TELEMETRY_BYPASS_REASONS,
  CONTEXT_TELEMETRY_PROVENANCE,
  CONTEXT_TELEMETRY_SOURCES,
  CONTEXT_TELEMETRY_STAGES,
  ContextTelemetryObservationSchema,
  ContextTelemetrySeriesSchema,
} from '../../src/contracts/context-telemetry.schema.js';

const BASE = {
  stage: 'compression',
  source: 'hierarchical_compression',
  provenance: 'mechanical_projection',
} as const;

describe('ContextTelemetry contract', () => {
  it('uses closed stage, source, provenance and bypass vocabularies', () => {
    expect(CONTEXT_TELEMETRY_STAGES).toEqual([
      'retrieval',
      'compression',
      'log_triage',
      'diff_triage',
      'primary_context',
      'aggregate',
    ]);
    expect(CONTEXT_TELEMETRY_SOURCES).toEqual([
      'repository_retrieval',
      'hierarchical_compression',
      'log_triage',
      'diff_triage',
      'utility_model',
      'primary_runner',
      'aggregate',
    ]);
    expect(CONTEXT_TELEMETRY_PROVENANCE).toEqual([
      'mechanical_projection',
      'adapter_observation',
      'runtime_observation',
      'aggregate',
    ]);
    expect(CONTEXT_TELEMETRY_BYPASS_REASONS).toContain('structured_output_failure');
  });

  it('preserves absent metrics as unavailable and explicit zero as observed zero', () => {
    const absent = ContextTelemetryObservationSchema.parse(BASE);
    const zero = ContextTelemetryObservationSchema.parse({
      ...BASE,
      estimatedInputTokens: 0,
      utilityCalls: 0,
      utilityLatencyMs: 0,
    });

    expect(absent).not.toHaveProperty('estimatedInputTokens');
    expect(absent).not.toHaveProperty('utilityCalls');
    expect(zero.estimatedInputTokens).toBe(0);
    expect(zero.utilityCalls).toBe(0);
    expect(zero.utilityLatencyMs).toBe(0);
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe integer metric %s',
    (value) => {
      expect(
        ContextTelemetryObservationSchema.safeParse({ ...BASE, estimatedInputTokens: value }).success,
      ).toBe(false);
    },
  );

  it.each([NaN, Infinity, -0.01, 86_400_000.01])('rejects unsafe latency %s', (value) => {
    expect(
      ContextTelemetryObservationSchema.safeParse({ ...BASE, utilityLatencyMs: value }).success,
    ).toBe(false);
  });

  it('allows finite fractional latency inside the operational bound', () => {
    expect(
      ContextTelemetryObservationSchema.parse({ ...BASE, utilityLatencyMs: 12.75 })
        .utilityLatencyMs,
    ).toBe(12.75);
  });

  it('rejects unknown fields and free-form fields that could carry secrets', () => {
    for (const field of ['message', 'reason', 'content', 'path', 'url', 'headers', 'credential']) {
      expect(
        ContextTelemetryObservationSchema.safeParse({
          ...BASE,
          [field]: 'AWS_SECRET_ACCESS_KEY=do-not-store',
        }).success,
      ).toBe(false);
    }
  });

  it('requires an exact derived avoided-token estimate and both operands', () => {
    const valid = {
      ...BASE,
      estimatedInputTokens: 100,
      estimatedCompressedTokens: 40,
      estimatedAvoidedTokens: 60,
    };
    expect(ContextTelemetryObservationSchema.safeParse(valid).success).toBe(true);
    expect(
      ContextTelemetryObservationSchema.safeParse({ ...valid, estimatedAvoidedTokens: 59 }).success,
    ).toBe(false);
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        estimatedInputTokens: 100,
        estimatedAvoidedTokens: 60,
      }).success,
    ).toBe(false);
  });

  it('floors avoided tokens at zero', () => {
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        estimatedInputTokens: 10,
        estimatedPrimaryContextTokens: 20,
        estimatedAvoidedTokens: 0,
      }).success,
    ).toBe(true);
  });

  it('accepts only secret-safe effective provider/model identifiers', () => {
    expect(
      ContextTelemetryObservationSchema.safeParse({
        stage: 'compression',
        source: 'utility_model',
        provenance: 'adapter_observation',
        effectiveProvider: 'openai-compatible',
        effectiveModel: 'org/served-model-Q4_K_M',
      }).success,
    ).toBe(true);
    for (const value of [
      'https://host/v1',
      'Bearer secret',
      'model?api_key=secret',
      'line\nbreak',
      'x'.repeat(201),
    ]) {
      expect(
        ContextTelemetryObservationSchema.safeParse({
          stage: 'compression',
          source: 'utility_model',
          provenance: 'adapter_observation',
          effectiveProvider: 'openai-compatible',
          effectiveModel: value,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects secret-shaped provenance even when it matches identifier punctuation', () => {
    for (const effectiveModel of [
      'sk-proj-secret_123',
      'ghp_1234567890abcdefghijklmnopqrstuv',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-secret',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    ]) {
      expect(
        ContextTelemetryObservationSchema.safeParse({
          stage: 'compression',
          source: 'utility_model',
          provenance: 'adapter_observation',
          effectiveProvider: 'openai-compatible',
          effectiveModel,
        }).success,
      ).toBe(false);
    }
  });

  it('requires coherent stage/source/provenance triples and monotonic counts', () => {
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        source: 'primary_runner',
      }).success,
    ).toBe(false);
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        filesBefore: 1,
        filesAfter: 2,
      }).success,
    ).toBe(false);
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        utilityCalls: 0,
        utilityFailures: 1,
      }).success,
    ).toBe(false);
  });

  it('constrains bypass and effective identity to coherent observation boundaries', () => {
    expect(
      ContextTelemetryObservationSchema.safeParse({
        stage: 'aggregate',
        source: 'aggregate',
        provenance: 'aggregate',
        bypassReason: 'model_failure',
      }).success,
    ).toBe(false);
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        bypassReason: 'no_candidates',
      }).success,
    ).toBe(false);
    expect(
      ContextTelemetryObservationSchema.safeParse({
        stage: 'compression',
        source: 'utility_model',
        provenance: 'adapter_observation',
        utilityCalls: 1,
        utilityFailures: 0,
        bypassReason: 'model_failure',
      }).success,
    ).toBe(false);
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        effectiveProvider: 'openai-compatible',
      }).success,
    ).toBe(false);
    expect(
      ContextTelemetryObservationSchema.safeParse({
        stage: 'compression',
        source: 'utility_model',
        provenance: 'adapter_observation',
        effectiveModel: 'served-model',
      }).success,
    ).toBe(false);
  });

  it('requires the derived avoided metric whenever both operands are observed', () => {
    expect(
      ContextTelemetryObservationSchema.safeParse({
        ...BASE,
        estimatedInputTokens: 100,
        estimatedCompressedTokens: 40,
      }).success,
    ).toBe(false);
  });

  it('caps a series and rejects unknown envelope fields', () => {
    const observations = Array.from({ length: 257 }, () => BASE);
    expect(ContextTelemetrySeriesSchema.safeParse({ observations }).success).toBe(false);
    expect(
      ContextTelemetrySeriesSchema.safeParse({ observations: [BASE], billingUsd: 0.01 }).success,
    ).toBe(false);
  });
});
