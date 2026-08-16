import { describe, expect, it } from 'vitest';
import {
  MAX_CONTEXT_TELEMETRY_INTEGER,
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

  it('projects a successful compression with a measured final context', () => {
    const projected = projectCompressionTelemetry({
      ok: true,
      status: 'compressed',
      artifact: {
        kind: 'hierarchical-context-compression',
        rawSources: [{ bytes: 120 }, { bytes: 40 }],
        skippedSources: ['note.txt'],
        omittedSourceRequests: 2,
        modelCalls: 1,
        finalContext: 'abcd',
        estimatedFinalTokens: 512,
      },
    });
    expect(projected).toBeDefined();
    expect(projected?.bypassReason).toBeUndefined();
    expect(projected?.rawBytes).toBe(160);
    expect(projected?.filesBefore).toBe(5);
    expect(projected?.filesAfter).toBe(2);
    expect(projected?.compressedBytes).toBe(4);
    expect(projected?.estimatedCompressedTokens).toBe(512);
    expect(projected?.utilityCalls).toBe(1);
  });

  it('fails closed when a compression reports counts but no model calls', () => {
    const projected = projectCompressionTelemetry({
      ok: true,
      status: 'compressed',
      artifact: {
        kind: 'hierarchical-context-compression',
        rawSources: [],
        skippedSources: [],
        omittedSourceRequests: 1,
      },
    });
    expect(projected).toBeUndefined();
  });

  it('fails closed when compression count aggregation overflows', () => {
    const projected = projectCompressionTelemetry({
      ok: true,
      status: 'compressed',
      artifact: {
        kind: 'hierarchical-context-compression',
        rawSources: [{ bytes: 1 }],
        skippedSources: ['s'],
        omittedSourceRequests: MAX_CONTEXT_TELEMETRY_INTEGER,
        modelCalls: 0,
      },
    });
    expect(projected).toBeUndefined();
  });

  it('projects a mechanical-only diff-triage bypass with invalid model output', () => {
    const projected = projectDiffTriageTelemetry({
      kind: 'diff-triage',
      status: 'mechanical_only',
      modelBypassReason: 'invalid_model_output',
      files: [{ path: 'a.ts' }],
      patch: { inspectedBytes: 900 },
      omittedFileCount: 1,
      invalidChangeCount: 0,
      modelCalls: 2,
    });
    expect(projected?.bypassReason).toBe('structured_output_failure');
    expect(projected?.rawBytes).toBe(900);
    expect(projected?.filesBefore).toBe(2);
    expect(projected?.filesAfter).toBe(1);
    expect(projected?.utilityFailures).toBe(1);
    expect(projected?.structuredOutputFailures).toBe(1);
  });

  it('fails closed in retrieval when a claimed packet is malformed', () => {
    const projected = projectRepositoryRetrievalTelemetry({
      ok: true,
      bypass: false,
      candidateCount: 2,
      packet: { relevantFiles: 'not-an-array' },
    });
    expect(projected).toBeUndefined();
  });

  it('projects structured-output-failure bypass with a failed call for log triage', () => {
    const projected = projectLogTriageTelemetry({
      kind: 'log-triage',
      status: 'mechanical_only',
      modelBypassReason: 'invalid_model_output',
      evidence: [],
      groups: [],
      omittedSourceCount: 0,
      invalidSourceCount: 0,
      modelCalls: 3,
    });
    expect(projected?.bypassReason).toBe('structured_output_failure');
    expect(projected?.utilityFailures).toBe(1);
    expect(projected?.structuredOutputFailures).toBe(1);
    expect(projected?.filesBefore).toBe(0);
    expect(projected?.utilityCalls).toBe(3);
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

  it('fails closed on non-plain-record inputs and hostile own-key discovery', () => {
    // `Date`, arrays, null and primitive inputs are not plain records; a proxy
    // whose ownKeys traps throw is rejected without invoking the trap payload.
    expect(normalizeContextTelemetryObservation(new Date())).toBeUndefined();
    expect(normalizeContextTelemetryObservation(null)).toBeUndefined();
    expect(normalizeContextTelemetryObservation([])).toBeUndefined();
    const throwingProxy = new Proxy({ stage: 'compression' }, {
      ownKeys: () => { throw new Error('Bearer secret'); },
    });
    expect(normalizeContextTelemetryObservation(throwingProxy)).toBeUndefined();
  });

  it('rejects an observation carrying more than the closed key vocabulary', () => {
    const wide: Record<string, unknown> = {
      stage: 'compression',
      source: 'hierarchical_compression',
      provenance: 'mechanical_projection',
    };
    for (let index = 0; index < 30; index += 1) wide[`extra${index}`] = index;
    expect(normalizeContextTelemetryObservation(wide)).toBeUndefined();
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

  it('rejects a wrong-kind artifact, missing integer fields and non-array evidence', () => {
    const notLogTriage = {
      kind: 'diff-triage',
      status: 'mechanical_only',
      evidence: [],
      groups: [],
      omittedSourceCount: 0,
      invalidSourceCount: 0,
      modelCalls: 0,
    };
    expect(projectLogTriageTelemetry(notLogTriage)).toBeUndefined();

    const missingInts = {
      kind: 'log-triage',
      status: 'mechanical_only',
      evidence: [],
      groups: [],
    };
    expect(projectLogTriageTelemetry(missingInts)).toBeUndefined();

    const evidenceWithBadBytes = {
      kind: 'log-triage',
      status: 'mechanical_only',
      evidence: [{ examinedBytes: -1 }],
      groups: [],
      omittedSourceCount: 0,
      invalidSourceCount: 0,
      modelCalls: 0,
    };
    expect(projectLogTriageTelemetry(evidenceWithBadBytes)).toBeUndefined();
    expect(projectLogTriageTelemetry({ ...missingInts, evidence: 'nope' })).toBeUndefined();
  });

  it('projects a structured-output-failure log bypass with a failed call', () => {
    const result = projectLogTriageTelemetry({
      kind: 'log-triage',
      status: 'mechanical_only',
      modelBypassReason: 'invalid_model_output',
      evidence: [{ examinedBytes: 4 }],
      groups: [],
      omittedSourceCount: 0,
      invalidSourceCount: 0,
      modelCalls: 2,
    });
    expect(result).toMatchObject({
      bypassReason: 'structured_output_failure',
      utilityCalls: 2,
      utilityFailures: 1,
      structuredOutputFailures: 1,
    });
  });

  it('ignores an unknown log bypass vocabulary and refuses overflow in byte sums', () => {
    const base = {
      kind: 'log-triage',
      status: 'mechanical_only',
      evidence: [{ examinedBytes: 1 }],
      groups: [],
      omittedSourceCount: 0,
      invalidSourceCount: 0,
      modelCalls: 0,
    };
    expect(projectLogTriageTelemetry({ ...base, modelBypassReason: 'password=secret' }))
      .toBeUndefined();

    const overflowing = {
      ...base,
      evidence: [{ examinedBytes: 999_999_999_999 }, { examinedBytes: 2 }],
    };
    expect(projectLogTriageTelemetry(overflowing)).toBeUndefined();

    const oversizedFiles = {
      ...base,
      omittedSourceCount: 999_999_999_999,
      invalidSourceCount: 2,
    };
    expect(projectLogTriageTelemetry(oversizedFiles)).toBeUndefined();
  });

  it('rejects compression artifacts of the wrong kind or without a valid model call count', () => {
    const wrongKind = {
      ok: true,
      status: 'compressed',
      artifact: {
        kind: 'log-triage',
        rawSources: [],
        skippedSources: [],
        finalContext: 'x',
        estimatedFinalTokens: 1,
        modelCalls: 1,
        omittedSourceRequests: 0,
      },
    };
    expect(projectCompressionTelemetry(wrongKind)).toBeUndefined();

    expect(
      projectCompressionTelemetry({
        ok: true,
        status: 'compressed',
        artifact: { kind: 'hierarchical-context-compression', rawSources: [] },
      }),
    ).toBeUndefined();

    expect(
      projectCompressionTelemetry({ ok: true, status: 'not-a-status', rawSources: [] }),
    ).toBeUndefined();
  });

  it('refuses oversized final context strings and non-integer source bytes', () => {
    const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
    expect(
      projectCompressionTelemetry({
        ok: true,
        status: 'compressed',
        artifact: {
          kind: 'hierarchical-context-compression',
          rawSources: [],
          skippedSources: [],
          finalContext: huge,
          estimatedFinalTokens: 1,
          modelCalls: 1,
          omittedSourceRequests: 0,
        },
      }),
    ).toBeUndefined();

    expect(
      projectCompressionTelemetry({
        ok: true,
        status: 'compressed',
        artifact: {
          kind: 'hierarchical-context-compression',
          rawSources: [{ bytes: 'big' }],
          skippedSources: [],
          finalContext: 'x',
          estimatedFinalTokens: 1,
          modelCalls: 1,
          omittedSourceRequests: 0,
        },
      }),
    ).toBeUndefined();

    expect(
      projectCompressionTelemetry({
        ok: true,
        status: 'compressed',
        artifact: {
          kind: 'hierarchical-context-compression',
          rawSources: [
            { bytes: 999_999_999_999 },
            { bytes: 2 },
          ],
          skippedSources: [],
          finalContext: 'x',
          estimatedFinalTokens: 1,
          modelCalls: 1,
          omittedSourceRequests: 0,
        },
      }),
    ).toBeUndefined();

    expect(
      projectCompressionTelemetry({
        ok: true,
        status: 'compressed',
        artifact: {
          kind: 'hierarchical-context-compression',
          rawSources: [],
          skippedSources: [],
          finalContext: 'x',
          modelCalls: 1,
          omittedSourceRequests: 1_000_000_000_000,
        },
      }),
    ).toBeUndefined();
  });

  it('maps a structured-output compression bypass with a failed call', () => {
    expect(
      projectCompressionTelemetry({
        ok: false,
        status: 'bypass',
        reason: 'invalid_model_output',
        rawSources: [],
        skippedSources: [],
        omittedSourceRequests: 0,
        modelCalls: 3,
      }),
    ).toMatchObject({
      bypassReason: 'structured_output_failure',
      utilityFailures: 1,
      structuredOutputFailures: 1,
    });
  });

  it('rejects retrieval inputs that are not coherent ok/bypass pairs', () => {
    expect(
      projectRepositoryRetrievalTelemetry({ ok: true, bypass: true, candidateCount: 3 }),
    ).toBeUndefined();
    expect(
      projectRepositoryRetrievalTelemetry({ ok: false, bypass: false, candidateCount: 3 }),
    ).toBeUndefined();
    expect(
      projectRepositoryRetrievalTelemetry({ ok: 'yes', candidateCount: 3 }),
    ).toBeUndefined();
    expect(
      projectRepositoryRetrievalTelemetry({ ok: true, bypass: false, errorCode: 'no_model' }),
    ).toBeUndefined();
  });

  it('maps each closed retrieval failure code to its bypass reason', () => {
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'empty_candidates',
      }),
    ).toMatchObject({ bypassReason: 'no_candidates', utilityCalls: 0 });
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'no_model',
      }),
    ).toMatchObject({ bypassReason: 'utility_model_missing', utilityCalls: 0 });
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'unavailable',
      }),
    ).toMatchObject({ bypassReason: 'utility_model_unavailable', utilityFailures: 1 });
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'invalid_response',
      }),
    ).toMatchObject({
      bypassReason: 'structured_output_failure',
      structuredOutputFailures: 1,
    });
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'context_limit',
      }),
    ).toMatchObject({ bypassReason: 'context_budget' });
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'timeout',
      }),
    ).toMatchObject({ bypassReason: 'model_failure' });
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'execution_failed',
      }),
    ).toMatchObject({ bypassReason: 'model_failure' });
    expect(
      projectRepositoryRetrievalTelemetry({
        ok: false,
        bypass: true,
        candidateCount: 3,
        errorCode: 'mystery',
      }),
    ).toBeUndefined();
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

  it('refuses the aggregate stage and non-boolean ok in utility projection', () => {
    expect(projectUtilityModelTelemetry('aggregate', { ok: true })).toBeUndefined();
    expect(projectUtilityModelTelemetry('primary_context', { ok: 'yes' })).toBeUndefined();
  });

  it('classifies every closed utility failure code without swallowing the caller text', () => {
    const call = (errorCode: string) =>
      projectUtilityModelTelemetry('retrieval', {
        ok: false,
        errorCode,
        message: 'password=secret',
      });
    expect(call('unavailable')).toMatchObject({ bypassReason: 'utility_model_unavailable' });
    expect(call('context_limit')).toMatchObject({ bypassReason: 'context_budget' });
    expect(call('timeout')).toMatchObject({ bypassReason: 'model_failure' });
    expect(call('execution_failed')).toMatchObject({ bypassReason: 'model_failure' });
    expect(call('invalid_response')).toMatchObject({ bypassReason: 'structured_output_failure' });
    expect(call('mystery')).toBeUndefined();
    for (const reason of ['unavailable', 'context_limit', 'timeout', 'execution_failed']) {
      const projected = call(reason);
      expect(projected).toBeDefined();
      expect(JSON.stringify(projected)).not.toContain('secret');
    }
  });

  it('rejects usage or provenance accessors rather than invoking them', () => {
    const withAccessor = Object.defineProperty(
      { ok: true },
      'usage',
      { enumerable: true, get: () => { throw new Error('Bearer secret'); } },
    );
    expect(projectUtilityModelTelemetry('retrieval', withAccessor)).toBeUndefined();
  });

  it('fails closed when the caller-owned allowlist itself carries an invalid model identity', () => {
    // The allowlist is a trust input: a credential or garbage entry inside it must
    // refuse the whole projection, never be quietly compared against.
    const result = projectUtilityModelTelemetry(
      'compression',
      {
        ok: true,
        provenance: { provider: 'openai-compatible', model: 'org/model-q4' },
      },
      { allowedEffectiveModels: ['sk-proj-secret_123'] },
    );
    expect(result).toBeUndefined();
  });

  it('rejects a provenance accessor and an unknown provider identity', () => {
    const withAccessor = Object.defineProperty(
      { ok: true, provenance: { provider: 'openai-compatible' } },
      'provenance',
      { enumerable: true, get: () => { throw new Error('Bearer secret'); } },
    );
    expect(projectUtilityModelTelemetry('retrieval', withAccessor)).toBeUndefined();

    const hostileProvider = {
      ok: true,
      provenance: { provider: 'anthropic', model: 'org/model-q4' },
    };
    const result = projectUtilityModelTelemetry('compression', hostileProvider);
    expect(result).not.toHaveProperty('effectiveProvider');
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
    // An observation carrying a field the schema forbids rejects the whole
    // aggregation rather than being silently dropped (§harden).
    expect(
      aggregateContextTelemetry([
        {
          stage: 'compression',
          source: 'hierarchical_compression',
          provenance: 'mechanical_projection',
          message: 'Bearer secret',
        },
      ]),
    ).toBeUndefined();
  });

  it('aggregates effective identity only when a single consistent value is observed', () => {
    const same = {
      stage: 'compression',
      source: 'utility_model',
      provenance: 'adapter_observation',
      effectiveProvider: 'openai-compatible',
      effectiveModel: 'org/moe-q4',
      utilityCalls: 1,
      utilityFailures: 0,
    } as const;
    const sameAgain = { ...same } as const;
    expect(aggregateContextTelemetry([same, sameAgain])).toMatchObject({
      effectiveProvider: 'openai-compatible',
      effectiveModel: 'org/moe-q4',
    });

    // Two different models in one series make the aggregate identity ambiguous.
    const other = { ...same, effectiveModel: 'org/other-model' } as const;
    expect(aggregateContextTelemetry([same, other])).not.toHaveProperty('effectiveModel');
  });

  it('refuses a summed metric once the accumulated value overflows a bounded aggregate', () => {
    const row = {
      stage: 'compression',
      source: 'hierarchical_compression',
      provenance: 'mechanical_projection',
    } as const;
    expect(
      aggregateContextTelemetry([
        { ...row, utilityLatencyMs: 86_400_000 },
        { ...row, utilityLatencyMs: 86_400_000 },
      ]),
    ).not.toHaveProperty('utilityLatencyMs');
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

  it('safely handles throwing getters and non-failure bypass reason in diff triage telemetry', () => {
    const throwingArtifact = {
      kind: 'diff-triage',
      get status() {
        throw new Error('Hostile getter');
      },
    };
    expect(projectDiffTriageTelemetry(throwingArtifact)).toBeUndefined();

    const nonFailureBypassArtifact = {
      kind: 'diff-triage',
      advisory: true,
      status: 'mechanical_only',
      modelBypassReason: 'no_files',
      evidenceId: 'evidence-1',
      diffRef: 'ref-1',
      base: '0000000000000000000000000000000000000000',
      head: '1111111111111111111111111111111111111111',
      files: [],
      modules: [],
      advisories: [],
      patch: {
        rawPatchCharacters: 0,
        rawPatchTruncated: false,
        rawPatchOmittedCharacters: 0,
        inspectedCharacters: 0,
        inspectedBytes: 0,
        inspectionTruncated: false,
      },
      omittedFileCount: 0,
      invalidChangeCount: 0,
      linesExamined: 0,
      modelCalls: 1,
      policy: {
        maxFiles: 256,
        maxPatchChars: 262144,
        maxPatchBytes: 524288,
        maxHunksPerFile: 32,
        maxLinesExamined: 20000,
        maxExcerptChars: 1024,
        maxExcerptBytes: 2048,
        maxModelInputChars: 24000,
        maxModelInputTokens: 16000,
        maxModelOutputChars: 8000,
        maxModelOutputTokens: 1024,
        maxModelCalls: 1,
        modelTimeoutMs: 5000,
      },
    };
    const obs = projectDiffTriageTelemetry(nonFailureBypassArtifact);
    expect(obs).toBeDefined();
    expect(obs?.utilityFailures).toBe(0);

    expect(projectDiffTriageTelemetry({ kind: 'other' })).toBeUndefined();
    expect(projectDiffTriageTelemetry({ kind: 'diff-triage', status: 'invalid_status' })).toBeUndefined();
    expect(
      projectDiffTriageTelemetry({
        ...nonFailureBypassArtifact,
        patch: { inspectedBytes: 'not_an_int' },
      }),
    ).toBeUndefined();
  });
});
