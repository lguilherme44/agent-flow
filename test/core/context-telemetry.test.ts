import { describe, expect, it } from 'vitest';
import {
  aggregateContextTelemetry,
  deriveEstimatedAvoidedTokens,
  normalizeContextTelemetryObservation,
  projectCompressionTelemetry,
  projectDiffTriageTelemetry,
  projectLogTriageTelemetry,
  projectRepositoryRetrievalTelemetry,
  projectUtilityModelTelemetry,
} from '../../src/core/context-telemetry.js';

describe('context telemetry derivation', () => {
  it('derives avoided tokens only from two observed estimates', () => {
    expect(deriveEstimatedAvoidedTokens(100, 40)).toBe(60);
    expect(deriveEstimatedAvoidedTokens(10, 20)).toBe(0);
    expect(deriveEstimatedAvoidedTokens(undefined, 20)).toBeUndefined();
    expect(deriveEstimatedAvoidedTokens(20, undefined)).toBeUndefined();
    expect(deriveEstimatedAvoidedTokens(Number.MAX_SAFE_INTEGER, 0)).toBeUndefined();
  });

  it('normalizes a data-only observation deterministically and deep freezes it', () => {
    const result = normalizeContextTelemetryObservation({
      stage: 'compression',
      source: 'hierarchical_compression',
      provenance: 'mechanical_projection',
      estimatedInputTokens: 100,
      estimatedCompressedTokens: 40,
      estimatedAvoidedTokens: 60,
      utilityCalls: 0,
    });

    expect(result).toEqual({
      stage: 'compression',
      source: 'hierarchical_compression',
      provenance: 'mechanical_projection',
      estimatedInputTokens: 100,
      estimatedCompressedTokens: 40,
      estimatedAvoidedTokens: 60,
      utilityCalls: 0,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns unavailable for accessors, inherited properties, proxies and unknown keys', () => {
    const secret = 'AWS_SECRET_ACCESS_KEY=never-surface';
    const accessor = Object.defineProperty(
      {
        source: 'hierarchical_compression',
        provenance: 'mechanical_projection',
      },
      'stage',
      { enumerable: true, get: () => { throw new Error(secret); } },
    );
    const inherited = Object.create({ stage: 'compression' }) as Record<string, unknown>;
    Object.assign(inherited, {
      source: 'hierarchical_compression',
      provenance: 'mechanical_projection',
    });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error(secret); } });

    expect(normalizeContextTelemetryObservation(accessor)).toBeUndefined();
    expect(normalizeContextTelemetryObservation(inherited)).toBeUndefined();
    expect(normalizeContextTelemetryObservation(proxy)).toBeUndefined();
    expect(
      normalizeContextTelemetryObservation({
        stage: 'compression',
        source: 'hierarchical_compression',
        provenance: 'mechanical_projection',
        message: secret,
      }),
    ).toBeUndefined();
  });
});

describe('artifact projections', () => {
  it('projects repository retrieval counts without copying packet prose or paths', () => {
    const result = projectRepositoryRetrievalTelemetry({
      ok: true,
      bypass: false,
      candidateCount: 9,
      packet: {
        objective: 'password=secret',
        relevantFiles: [
          { path: '/secret/path', reason: 'Bearer token' },
          { path: 'src/b.ts', reason: 'API_KEY=secret' },
        ],
      },
    });

    expect(result).toEqual({
      stage: 'retrieval',
      source: 'repository_retrieval',
      provenance: 'mechanical_projection',
      candidatesBefore: 9,
      candidatesAfter: 2,
      filesAfter: 2,
      utilityCalls: 1,
      utilityFailures: 0,
      structuredOutputFailures: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|path|Bearer|API_KEY/i);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('maps retrieval failure codes to a closed bypass reason without reading reason text', () => {
    const hostile = Object.defineProperty(
      {
        ok: false,
        bypass: true,
        errorCode: 'validation_failed',
        candidateCount: 4,
      },
      'reason',
      { enumerable: true, get: () => { throw new Error('password=secret'); } },
    );
    expect(projectRepositoryRetrievalTelemetry(hostile)).toEqual({
      stage: 'retrieval',
      source: 'repository_retrieval',
      provenance: 'mechanical_projection',
      bypassReason: 'validation_failed',
      candidatesBefore: 4,
      candidatesAfter: 0,
      filesAfter: 0,
      utilityCalls: 1,
      utilityFailures: 0,
      structuredOutputFailures: 1,
    });
  });

  it('projects compression volumes and counts without retaining raw/final content', () => {
    const result = projectCompressionTelemetry({
      ok: true,
      status: 'compressed',
      artifact: {
        kind: 'hierarchical-context-compression',
        rawSources: [
          { bytes: 7, content: 'password=secret' },
          { bytes: 5, content: 'Bearer secret' },
        ],
        skippedSources: [{ reason: 'not_regular_file', path: '/secret' }],
        finalContext: 'compressed secret must not be retained',
        estimatedFinalTokens: 3,
        modelCalls: 2,
        omittedSourceRequests: 1,
      },
    });
    expect(result).toEqual({
      stage: 'compression',
      source: 'hierarchical_compression',
      provenance: 'mechanical_projection',
      estimatedCompressedTokens: 3,
      rawBytes: 12,
      compressedBytes: 38,
      filesBefore: 4,
      filesAfter: 2,
      utilityCalls: 2,
      utilityFailures: 0,
      structuredOutputFailures: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|Bearer|path|content/i);
  });

  it('projects only closed compression bypass vocabulary', () => {
    expect(
      projectCompressionTelemetry({
        ok: false,
        status: 'bypass',
        reason: 'model_failure',
        rawSources: [],
        skippedSources: [],
        omittedSourceRequests: 0,
        modelCalls: 1,
      }),
    ).toMatchObject({
      bypassReason: 'model_failure',
      utilityCalls: 1,
      utilityFailures: 1,
    });
    expect(
      projectCompressionTelemetry({
        ok: false,
        status: 'bypass',
        reason: 'password=secret',
        rawSources: [],
        skippedSources: [],
        omittedSourceRequests: 0,
        modelCalls: 0,
      }),
    ).toBeUndefined();
  });

  it('projects log triage mechanical counts and model failure class only', () => {
    const result = projectLogTriageTelemetry({
      kind: 'log-triage',
      status: 'mechanical_only',
      modelBypassReason: 'invalid_model_output',
      evidence: [
        { examinedBytes: 8, evidenceId: 'password=secret' },
        { examinedBytes: 13, commandId: 'Bearer secret' },
      ],
      groups: [{ excerpt: 'API_KEY=secret' }],
      omittedSourceCount: 2,
      invalidSourceCount: 1,
      modelCalls: 1,
    });
    expect(result).toEqual({
      stage: 'log_triage',
      source: 'log_triage',
      provenance: 'mechanical_projection',
      bypassReason: 'structured_output_failure',
      rawBytes: 21,
      filesBefore: 5,
      filesAfter: 2,
      utilityCalls: 1,
      utilityFailures: 1,
      structuredOutputFailures: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|Bearer|excerpt/i);
  });

  it('keeps valid multi-group log telemetry because groups are not files', () => {
    expect(
      projectLogTriageTelemetry({
        kind: 'log-triage',
        status: 'model_enriched',
        evidence: [{ examinedBytes: 8 }],
        groups: [{ excerpt: 'one' }, { excerpt: 'two' }],
        omittedSourceCount: 0,
        invalidSourceCount: 0,
        modelCalls: 1,
      }),
    ).toMatchObject({
      filesBefore: 1,
      filesAfter: 1,
    });
  });

  it('projects diff triage counts and patch volumes without paths or summaries', () => {
    const result = projectDiffTriageTelemetry({
      kind: 'diff-triage',
      status: 'model_enriched',
      files: [{ path: '/private/secret' }, { path: 'AWS_TOKEN=secret' }],
      omittedFileCount: 2,
      invalidChangeCount: 1,
      advisories: [{ summary: 'password=secret' }],
      patch: { rawPatchCharacters: 100, inspectedBytes: 80 },
      modelCalls: 1,
    });
    expect(result).toEqual({
      stage: 'diff_triage',
      source: 'diff_triage',
      provenance: 'mechanical_projection',
      rawBytes: 80,
      filesBefore: 5,
      filesAfter: 2,
      utilityCalls: 1,
      utilityFailures: 0,
      structuredOutputFailures: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|password|summary/i);
  });

  it('fails closed on oversized or accessor-bearing artifact arrays', () => {
    const oversized = Array.from({ length: 257 }, () => ({ examinedBytes: 1 }));
    const accessor = [Object.defineProperty({}, 'examinedBytes', {
      enumerable: true,
      get: () => { throw new Error('password=secret'); },
    })];
    const base = {
      kind: 'log-triage',
      status: 'mechanical_only',
      groups: [],
      omittedSourceCount: 0,
      invalidSourceCount: 0,
      modelCalls: 0,
    };
    expect(projectLogTriageTelemetry({ ...base, evidence: oversized })).toBeUndefined();
    expect(projectLogTriageTelemetry({ ...base, evidence: accessor })).toBeUndefined();
  });
});

describe('UtilityModel telemetry projection', () => {
  it('projects safe observed usage/provenance without response text or message', () => {
    const result = projectUtilityModelTelemetry(
      'compression',
      {
        ok: true,
        text: 'Bearer secret',
        usage: {
          estimatedInputTokens: 80,
          estimatedOutputTokens: 20,
          durationMs: 12.5,
        },
        provenance: { provider: 'openai-compatible', model: 'org/model-q4' },
      },
      { allowedEffectiveModels: ['org/model-q4'] },
    );
    expect(result).toEqual({
      stage: 'compression',
      source: 'utility_model',
      provenance: 'adapter_observation',
      estimatedInputTokens: 80,
      estimatedOutputTokens: 20,
      utilityCalls: 1,
      utilityFailures: 0,
      structuredOutputFailures: 0,
      utilityLatencyMs: 12.5,
      effectiveProvider: 'openai-compatible',
      effectiveModel: 'org/model-q4',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('omits secret-shaped effective provenance', () => {
    for (const model of [
      'sk-proj-secret_123',
      'ghp_1234567890abcdefghijklmnopqrstuv',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-secret',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    ]) {
      const result = projectUtilityModelTelemetry('compression', {
        ok: true,
        usage: { estimatedInputTokens: 1 },
        provenance: {
          provider: 'openai-compatible',
          model,
        },
      });
      expect(result).toHaveProperty('effectiveProvider', 'openai-compatible');
      expect(result).not.toHaveProperty('effectiveModel');
      expect(JSON.stringify(result)).not.toContain(model);
    }
  });

  it('emits model identity only through an explicit caller-owned allowlist', () => {
    const input = {
      ok: true,
      provenance: {
        provider: 'openai-compatible',
        model: 'org/served-model',
      },
    };
    expect(projectUtilityModelTelemetry('compression', input)).not.toHaveProperty(
      'effectiveModel',
    );
    expect(
      projectUtilityModelTelemetry('compression', input, {
        allowedEffectiveModels: ['org/another-model'],
      }),
    ).not.toHaveProperty('effectiveModel');
    expect(
      projectUtilityModelTelemetry('compression', input, {
        allowedEffectiveModels: ['org/served-model'],
      }),
    ).toHaveProperty('effectiveModel', 'org/served-model');
  });

  it('classifies an invalid response without copying hostile failure text', () => {
    const result = projectUtilityModelTelemetry('retrieval', {
      ok: false,
      errorCode: 'invalid_response',
      message: 'AWS_SECRET_ACCESS_KEY=secret',
      usage: { estimatedInputTokens: 5 },
      provenance: { provider: 'openai-compatible' },
    });
    expect(result).toMatchObject({
      utilityCalls: 1,
      utilityFailures: 1,
      structuredOutputFailures: 1,
      bypassReason: 'structured_output_failure',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('context telemetry aggregation', () => {
  it('sums only observed metrics, derives avoided tokens and stays deterministic/frozen', () => {
    const first = {
      stage: 'compression',
      source: 'hierarchical_compression',
      provenance: 'mechanical_projection',
      estimatedInputTokens: 100,
      estimatedCompressedTokens: 40,
      estimatedAvoidedTokens: 60,
      rawBytes: 1000,
      utilityCalls: 1,
    } as const;
    const second = {
      stage: 'primary_context',
      source: 'primary_runner',
      provenance: 'runtime_observation',
      estimatedPrimaryContextTokens: 30,
      utilityCalls: 0,
    } as const;
    const result = aggregateContextTelemetry([first, second]);

    expect(result).toEqual({
      stage: 'aggregate',
      source: 'aggregate',
      provenance: 'aggregate',
      estimatedInputTokens: 100,
      estimatedCompressedTokens: 40,
      estimatedPrimaryContextTokens: 30,
      estimatedAvoidedTokens: 70,
      rawBytes: 1000,
      utilityCalls: 1,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(aggregateContextTelemetry([first, second])).toEqual(result);
  });

  it('omits unobserved fields and refuses overflow rather than wrapping or clamping', () => {
    expect(aggregateContextTelemetry([])).toEqual({
      stage: 'aggregate',
      source: 'aggregate',
      provenance: 'aggregate',
    });
    expect(
      aggregateContextTelemetry([
        {
          stage: 'compression',
          source: 'hierarchical_compression',
          provenance: 'mechanical_projection',
          rawBytes: 999_999_999_999,
        },
        {
          stage: 'diff_triage',
          source: 'diff_triage',
          provenance: 'mechanical_projection',
          rawBytes: 2,
        },
      ]),
    ).not.toHaveProperty('rawBytes');
  });

  it('returns unavailable for a hostile or oversized observation collection', () => {
    const proxy = new Proxy([], {
      getOwnPropertyDescriptor: () => { throw new Error('Bearer secret'); },
    });
    expect(aggregateContextTelemetry(proxy)).toBeUndefined();
    expect(
      aggregateContextTelemetry(Array.from({ length: 257 }, () => ({
        stage: 'compression',
        source: 'hierarchical_compression',
        provenance: 'mechanical_projection',
      }))),
    ).toBeUndefined();
  });

  it('refuses to aggregate a prior aggregate and double-count metrics', () => {
    expect(
      aggregateContextTelemetry([
        {
          stage: 'aggregate',
          source: 'aggregate',
          provenance: 'aggregate',
          rawBytes: 10,
        },
      ]),
    ).toBeUndefined();
  });
});
