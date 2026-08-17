import {
  CONTEXT_TELEMETRY_BYPASS_REASONS,
  CONTEXT_TELEMETRY_STAGES,
  ContextTelemetryEffectiveModelSchema,
  ContextTelemetryObservationSchema,
  MAX_CONTEXT_TELEMETRY_INTEGER,
  MAX_CONTEXT_TELEMETRY_LATENCY_MS,
  MAX_CONTEXT_TELEMETRY_OBSERVATIONS,
  type ContextTelemetryBypassReason,
  type ContextTelemetryObservation,
  type ContextTelemetryStage,
} from '../contracts/context-telemetry.schema.js';

export { MAX_CONTEXT_TELEMETRY_INTEGER };

/**
 * Pure, best-effort projections for operational context estimates.
 *
 * These values never steer workflow state and are not billing records. Every
 * projection reads only bounded mechanical fields from its input. Human/model
 * prose, paths, evidence ids, URLs, headers and failure messages are ignored.
 */

const MAX_ARTIFACT_ITEMS = 256;
const MAX_MEASURED_STRING_CHARACTERS = 4 * 1024 * 1024;

const OBSERVATION_KEYS = new Set([
  'stage',
  'source',
  'provenance',
  'estimatedInputTokens',
  'estimatedOutputTokens',
  'estimatedCompressedTokens',
  'estimatedPrimaryContextTokens',
  'estimatedAvoidedTokens',
  'rawBytes',
  'compressedBytes',
  'candidatesBefore',
  'candidatesAfter',
  'filesBefore',
  'filesAfter',
  'utilityCalls',
  'utilityFailures',
  'structuredOutputFailures',
  'utilityLatencyMs',
  'bypassReason',
  'effectiveProvider',
  'effectiveModel',
]);

const SUMMABLE_KEYS = [
  'estimatedInputTokens',
  'estimatedOutputTokens',
  'estimatedCompressedTokens',
  'estimatedPrimaryContextTokens',
  'rawBytes',
  'compressedBytes',
  'candidatesBefore',
  'candidatesAfter',
  'filesBefore',
  'filesAfter',
  'utilityCalls',
  'utilityFailures',
  'structuredOutputFailures',
  'utilityLatencyMs',
] as const;

type SummableKey = (typeof SUMMABLE_KEYS)[number];
type DataSnapshot = Readonly<Record<string, unknown>>;

interface DataValue {
  readonly present: boolean;
  readonly value?: unknown;
}

export interface ContextTelemetryProjectionTrust {
  /** Caller-owned configured/approved model identities; absent means model identity is unavailable. */
  readonly allowedEffectiveModels?: readonly string[];
}

export function deriveEstimatedAvoidedTokens(
  estimatedInputTokens: number | undefined,
  estimatedPrimaryOrCompressedTokens: number | undefined,
): number | undefined {
  if (
    !isIntegerMetric(estimatedInputTokens) ||
    !isIntegerMetric(estimatedPrimaryOrCompressedTokens)
  ) {
    return undefined;
  }
  return Math.max(0, estimatedInputTokens - estimatedPrimaryOrCompressedTokens);
}

/** Safely validates a caller-supplied observation without invoking accessors. */
export function normalizeContextTelemetryObservation(
  input: unknown,
): ContextTelemetryObservation | undefined {
  try {
    if (!isPlainRecord(input)) return undefined;
    const keys = Reflect.ownKeys(input);
    if (keys.length > OBSERVATION_KEYS.size) return undefined;

    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string' || !OBSERVATION_KEYS.has(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      snapshot[key] = descriptor.value;
    }

    const parsed = ContextTelemetryObservationSchema.safeParse(snapshot);
    if (!parsed.success) return undefined;
    return Object.freeze({ ...parsed.data });
  } catch {
    return undefined;
  }
}

export function projectRepositoryRetrievalTelemetry(
  input: unknown,
  trust?: ContextTelemetryProjectionTrust,
): ContextTelemetryObservation | undefined {
  try {
    const allowedEffectiveModels = snapshotAllowedEffectiveModels(trust);
    const snapshot = snapshotFields(input, [
      'ok',
      'bypass',
      'candidateCount',
      'packet',
      'errorCode',
      'usage',
      'provenance',
    ]);
    const candidateCount = integer(snapshot.candidateCount);
    if (candidateCount === undefined || typeof snapshot.ok !== 'boolean') return undefined;

    const observation: Record<string, unknown> = base(
      'retrieval',
      'repository_retrieval',
      'mechanical_projection',
    );
    observation.candidatesBefore = candidateCount;

    if (snapshot.ok === true && snapshot.bypass === false) {
      const packet = snapshotFields(snapshot.packet, ['relevantFiles']);
      const selected = snapshotArray(packet.relevantFiles);
      observation.candidatesAfter = selected.length;
      observation.filesAfter = selected.length;
      observation.utilityCalls = 1;
      observation.utilityFailures = 0;
      observation.structuredOutputFailures = 0;
    } else if (snapshot.ok === false && snapshot.bypass === true) {
      const outcome = retrievalFailure(snapshot.errorCode);
      if (!outcome) return undefined;
      observation.bypassReason = outcome.reason;
      observation.candidatesAfter = 0;
      observation.filesAfter = 0;
      observation.utilityCalls = outcome.calls;
      observation.utilityFailures = outcome.failures;
      observation.structuredOutputFailures = outcome.structuredFailures;
    } else {
      return undefined;
    }

    if (snapshot.usage !== undefined) {
      const usage = snapshotFields(snapshot.usage, [
        'estimatedInputTokens',
        'estimatedOutputTokens',
        'durationMs',
      ]);
      addIntegerIfObserved(observation, 'estimatedInputTokens', usage.estimatedInputTokens);
      addIntegerIfObserved(observation, 'estimatedOutputTokens', usage.estimatedOutputTokens);
      if (usage.durationMs !== undefined) {
        const latency = integer(usage.durationMs);
        if (latency !== undefined && latency <= MAX_CONTEXT_TELEMETRY_LATENCY_MS) {
          observation.utilityLatencyMs = latency;
        } else {
          throw new Error('invalid telemetry latency');
        }
      }
    }

    if (snapshot.provenance !== undefined) {
      const provenance = snapshotFields(snapshot.provenance, ['provider', 'model']);
      if (safeProviderIdentity(provenance.provider)) {
        observation.effectiveProvider = provenance.provider;
        if (
          safeModelIdentity(provenance.model) &&
          allowedEffectiveModels.has(provenance.model)
        ) {
          observation.effectiveModel = provenance.model;
        }
      }
    }

    return normalizeContextTelemetryObservation(observation);
  } catch {
    return undefined;
  }
}

export function projectCompressionTelemetry(
  input: unknown,
): ContextTelemetryObservation | undefined {
  try {
    const outer = snapshotFields(input, [
      'ok',
      'status',
      'artifact',
      'reason',
      'rawSources',
      'skippedSources',
      'omittedSourceRequests',
      'modelCalls',
    ]);
    const success = outer.ok === true && outer.status === 'compressed';
    const bypass = outer.ok === false && outer.status === 'bypass';
    if (!success && !bypass) return undefined;

    const body = success
      ? snapshotFields(outer.artifact, [
          'kind',
          'rawSources',
          'skippedSources',
          'finalContext',
          'estimatedFinalTokens',
          'modelCalls',
          'omittedSourceRequests',
        ])
      : outer;
    if (success && body.kind !== 'hierarchical-context-compression') return undefined;

    const rawSources = snapshotArray(body.rawSources);
    const skippedSources = snapshotArray(body.skippedSources);
    const omitted = integer(body.omittedSourceRequests);
    const modelCalls = integer(body.modelCalls);
    if (omitted === undefined || modelCalls === undefined) return undefined;

    let rawBytes = 0;
    for (const source of rawSources) {
      const sourceSnapshot = snapshotFields(source, ['bytes']);
      const bytes = integer(sourceSnapshot.bytes);
      if (bytes === undefined) return undefined;
      const next = safeAdd(rawBytes, bytes);
      if (next === undefined) return undefined;
      rawBytes = next;
    }
    const filesBefore = safeAdd(rawSources.length, skippedSources.length, omitted);
    if (filesBefore === undefined) return undefined;

    const observation: Record<string, unknown> = base(
      'compression',
      'hierarchical_compression',
      'mechanical_projection',
    );
    observation.rawBytes = rawBytes;
    observation.filesBefore = filesBefore;
    observation.filesAfter = rawSources.length;
    observation.utilityCalls = modelCalls;
    observation.utilityFailures = 0;
    observation.structuredOutputFailures = 0;

    if (success) {
      if (
        typeof body.finalContext !== 'string' ||
        body.finalContext.length > MAX_MEASURED_STRING_CHARACTERS
      ) {
        return undefined;
      }
      const estimatedFinalTokens = integer(body.estimatedFinalTokens);
      if (estimatedFinalTokens === undefined) return undefined;
      observation.estimatedCompressedTokens = estimatedFinalTokens;
      observation.compressedBytes = new TextEncoder().encode(body.finalContext).byteLength;
    } else {
      const reason = compressionBypass(body.reason);
      if (!reason) return undefined;
      observation.bypassReason = reason;
      observation.utilityFailures = modelFailureCount(reason, modelCalls);
      observation.structuredOutputFailures =
        reason === 'structured_output_failure' && modelCalls > 0 ? 1 : 0;
    }

    return normalizeContextTelemetryObservation(observation);
  } catch {
    return undefined;
  }
}

export function projectLogTriageTelemetry(input: unknown): ContextTelemetryObservation | undefined {
  try {
    const artifact = snapshotFields(input, [
      'kind',
      'status',
      'modelBypassReason',
      'evidence',
      'groups',
      'omittedSourceCount',
      'invalidSourceCount',
      'modelCalls',
    ]);
    if (
      artifact.kind !== 'log-triage' ||
      (artifact.status !== 'mechanical_only' && artifact.status !== 'model_enriched')
    ) {
      return undefined;
    }
    const evidence = snapshotArray(artifact.evidence);
    snapshotArray(artifact.groups);
    const omitted = integer(artifact.omittedSourceCount);
    const invalid = integer(artifact.invalidSourceCount);
    const modelCalls = integer(artifact.modelCalls);
    if (omitted === undefined || invalid === undefined || modelCalls === undefined) return undefined;

    let examinedBytes = 0;
    for (const item of evidence) {
      const itemSnapshot = snapshotFields(item, ['examinedBytes']);
      const bytes = integer(itemSnapshot.examinedBytes);
      if (bytes === undefined) return undefined;
      const next = safeAdd(examinedBytes, bytes);
      if (next === undefined) return undefined;
      examinedBytes = next;
    }
    const filesBefore = safeAdd(evidence.length, omitted, invalid);
    if (filesBefore === undefined) return undefined;

    const observation: Record<string, unknown> = base(
      'log_triage',
      'log_triage',
      'mechanical_projection',
    );
    observation.rawBytes = examinedBytes;
    observation.filesBefore = filesBefore;
    observation.filesAfter = evidence.length;
    observation.utilityCalls = modelCalls;
    observation.utilityFailures = 0;
    observation.structuredOutputFailures = 0;

    if (artifact.status === 'mechanical_only' && artifact.modelBypassReason !== undefined) {
      const reason = triageBypass(artifact.modelBypassReason);
      if (!reason) return undefined;
      observation.bypassReason = reason;
      observation.utilityFailures = modelFailureCount(reason, modelCalls);
      observation.structuredOutputFailures =
        reason === 'structured_output_failure' && modelCalls > 0 ? 1 : 0;
    }
    return normalizeContextTelemetryObservation(observation);
  } catch {
    return undefined;
  }
}

export function projectDiffTriageTelemetry(input: unknown): ContextTelemetryObservation | undefined {
  try {
    const artifact = snapshotFields(input, [
      'kind',
      'status',
      'modelBypassReason',
      'files',
      'patch',
      'omittedFileCount',
      'invalidChangeCount',
      'modelCalls',
    ]);
    if (
      artifact.kind !== 'diff-triage' ||
      (artifact.status !== 'mechanical_only' && artifact.status !== 'model_enriched')
    ) {
      return undefined;
    }
    const files = snapshotArray(artifact.files);
    const patch = snapshotFields(artifact.patch, ['inspectedBytes']);
    const inspectedBytes = integer(patch.inspectedBytes);
    const omitted = integer(artifact.omittedFileCount);
    const invalid = integer(artifact.invalidChangeCount);
    const modelCalls = integer(artifact.modelCalls);
    if (
      inspectedBytes === undefined ||
      omitted === undefined ||
      invalid === undefined ||
      modelCalls === undefined
    ) {
      return undefined;
    }
    const filesBefore = safeAdd(files.length, omitted, invalid);
    if (filesBefore === undefined) return undefined;

    const observation: Record<string, unknown> = base(
      'diff_triage',
      'diff_triage',
      'mechanical_projection',
    );
    observation.rawBytes = inspectedBytes;
    observation.filesBefore = filesBefore;
    observation.filesAfter = files.length;
    observation.utilityCalls = modelCalls;
    observation.utilityFailures = 0;
    observation.structuredOutputFailures = 0;

    if (artifact.status === 'mechanical_only' && artifact.modelBypassReason !== undefined) {
      const reason = triageBypass(artifact.modelBypassReason);
      if (!reason) return undefined;
      observation.bypassReason = reason;
      observation.utilityFailures = modelFailureCount(reason, modelCalls);
      observation.structuredOutputFailures =
        reason === 'structured_output_failure' && modelCalls > 0 ? 1 : 0;
    }
    return normalizeContextTelemetryObservation(observation);
  } catch {
    return undefined;
  }
}

/** Projects only adapter-observed safe usage/provenance, never text/message output. */
export function projectUtilityModelTelemetry(
  stage: ContextTelemetryStage,
  input: unknown,
  trust?: ContextTelemetryProjectionTrust,
): ContextTelemetryObservation | undefined {
  try {
    if (!CONTEXT_TELEMETRY_STAGES.includes(stage) || stage === 'aggregate') return undefined;
    const allowedEffectiveModels = snapshotAllowedEffectiveModels(trust);
    const result = snapshotFields(input, ['ok', 'usage', 'provenance', 'errorCode']);
    if (typeof result.ok !== 'boolean') return undefined;
    const observation: Record<string, unknown> = base(
      stage,
      'utility_model',
      'adapter_observation',
    );
    observation.utilityCalls = 1;
    observation.utilityFailures = result.ok ? 0 : 1;
    observation.structuredOutputFailures = 0;

    if (result.usage !== undefined) {
      const usage = snapshotFields(result.usage, [
        'estimatedInputTokens',
        'estimatedOutputTokens',
        'durationMs',
      ]);
      addIntegerIfObserved(observation, 'estimatedInputTokens', usage.estimatedInputTokens);
      addIntegerIfObserved(observation, 'estimatedOutputTokens', usage.estimatedOutputTokens);
      if (usage.durationMs !== undefined) observation.utilityLatencyMs = usage.durationMs;
    }
    if (result.provenance !== undefined) {
      const provenance = snapshotFields(result.provenance, ['provider', 'model']);
      if (safeProviderIdentity(provenance.provider)) {
        observation.effectiveProvider = provenance.provider;
        if (
          safeModelIdentity(provenance.model) &&
          allowedEffectiveModels.has(provenance.model)
        ) {
          observation.effectiveModel = provenance.model;
        }
      }
    }
    if (!result.ok) {
      if (result.errorCode === 'invalid_response') {
        observation.bypassReason = 'structured_output_failure';
        observation.structuredOutputFailures = 1;
      } else if (result.errorCode === 'unavailable') {
        observation.bypassReason = 'utility_model_unavailable';
      } else if (result.errorCode === 'context_limit') {
        observation.bypassReason = 'context_budget';
      } else if (result.errorCode === 'timeout' || result.errorCode === 'execution_failed') {
        observation.bypassReason = 'model_failure';
      } else {
        return undefined;
      }
    }
    return normalizeContextTelemetryObservation(observation);
  } catch {
    return undefined;
  }
}

/** Creates one deterministic non-authoritative read-model aggregate. */
export function aggregateContextTelemetry(
  inputs: unknown,
): ContextTelemetryObservation | undefined {
  try {
    const observations = snapshotArray(inputs, MAX_CONTEXT_TELEMETRY_OBSERVATIONS);
    const normalized: ContextTelemetryObservation[] = [];
    for (const input of observations) {
      const observation = normalizeContextTelemetryObservation(input);
      if (!observation) return undefined;
      if (observation.stage === 'aggregate') return undefined;
      normalized.push(observation);
    }

    const aggregate: Record<string, unknown> = base('aggregate', 'aggregate', 'aggregate');
    for (const key of SUMMABLE_KEYS) {
      const total = sumObserved(normalized, key);
      if (total !== undefined) aggregate[key] = total;
    }

    const inputTokens = numberValue(aggregate.estimatedInputTokens);
    const comparison =
      numberValue(aggregate.estimatedPrimaryContextTokens) ??
      numberValue(aggregate.estimatedCompressedTokens);
    const avoided = deriveEstimatedAvoidedTokens(inputTokens, comparison);
    if (avoided !== undefined) aggregate.estimatedAvoidedTokens = avoided;

    const provider = uniqueObservedIdentity(normalized, 'effectiveProvider');
    const model = uniqueObservedIdentity(normalized, 'effectiveModel');
    if (provider !== undefined) {
      aggregate.effectiveProvider = provider;
      if (model !== undefined) aggregate.effectiveModel = model;
    }

    return normalizeContextTelemetryObservation(aggregate);
  } catch {
    return undefined;
  }
}

function snapshotFields(input: unknown, fields: readonly string[]): DataSnapshot {
  if (!isPlainRecord(input)) throw new Error('invalid telemetry input');
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) {
    const data = ownData(input, field);
    if (data.present) snapshot[field] = data.value;
  }
  return Object.freeze(snapshot);
}

function ownData(input: object, key: string): DataValue {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return { present: false };
  if (!('value' in descriptor)) throw new Error('accessor rejected');
  return { present: true, value: descriptor.value };
}

function snapshotArray(input: unknown, max = MAX_ARTIFACT_ITEMS): readonly unknown[] {
  if (!Array.isArray(input)) throw new Error('array required');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor)) throw new Error('invalid array');
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw new Error('array bound');

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor)) throw new Error('sparse or accessor array');
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function isPlainRecord(input: unknown): input is object {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function base(stage: string, source: string, provenance: string): Record<string, unknown> {
  return { stage, source, provenance };
}

function integer(input: unknown): number | undefined {
  return isIntegerMetric(input) ? input : undefined;
}

function isIntegerMetric(input: unknown): input is number {
  return (
    typeof input === 'number' &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    input <= MAX_CONTEXT_TELEMETRY_INTEGER
  );
}

function safeAdd(...values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!isIntegerMetric(value)) return undefined;
    total += value;
    if (!Number.isSafeInteger(total) || total > MAX_CONTEXT_TELEMETRY_INTEGER) return undefined;
  }
  return total;
}

function safeProviderIdentity(input: unknown): input is string {
  return input === 'openai-compatible';
}

function safeModelIdentity(input: unknown): input is string {
  return ContextTelemetryEffectiveModelSchema.safeParse(input).success;
}

function snapshotAllowedEffectiveModels(
  trust: ContextTelemetryProjectionTrust | undefined,
): ReadonlySet<string> {
  if (trust === undefined) return new Set();
  const snapshot = snapshotFields(trust, ['allowedEffectiveModels']);
  if (snapshot.allowedEffectiveModels === undefined) return new Set();
  const candidates = snapshotArray(snapshot.allowedEffectiveModels, 32);
  const allowed = new Set<string>();
  for (const candidate of candidates) {
    if (!safeModelIdentity(candidate)) throw new Error('invalid effective model authority');
    allowed.add(candidate);
  }
  return allowed;
}

function addIntegerIfObserved(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value === undefined) return;
  const metric = integer(value);
  if (metric === undefined) throw new Error('invalid telemetry metric');
  output[key] = metric;
}

function retrievalFailure(errorCode: unknown):
  | {
      readonly reason: ContextTelemetryBypassReason;
      readonly calls: number;
      readonly failures: number;
      readonly structuredFailures: number;
    }
  | undefined {
  switch (errorCode) {
    case 'no_model':
      return { reason: 'utility_model_missing', calls: 0, failures: 0, structuredFailures: 0 };
    case 'empty_candidates':
      return { reason: 'no_candidates', calls: 0, failures: 0, structuredFailures: 0 };
    case 'validation_failed':
      return { reason: 'validation_failed', calls: 1, failures: 0, structuredFailures: 1 };
    case 'unavailable':
      return { reason: 'utility_model_unavailable', calls: 1, failures: 1, structuredFailures: 0 };
    case 'invalid_response':
      return { reason: 'structured_output_failure', calls: 1, failures: 1, structuredFailures: 1 };
    case 'context_limit':
      return { reason: 'context_budget', calls: 1, failures: 1, structuredFailures: 0 };
    case 'timeout':
    case 'execution_failed':
      return { reason: 'model_failure', calls: 1, failures: 1, structuredFailures: 0 };
    default:
      return undefined;
  }
}

function compressionBypass(input: unknown): ContextTelemetryBypassReason | undefined {
  const mapping: Readonly<Record<string, ContextTelemetryBypassReason>> = {
    utility_model_missing: 'utility_model_missing',
    utility_model_unavailable: 'utility_model_unavailable',
    invalid_capabilities: 'invalid_capabilities',
    invalid_health: 'invalid_health',
    invalid_input: 'invalid_input',
    no_content: 'no_content',
    context_budget_too_small: 'context_budget_too_small',
    model_call_limit: 'model_call_limit',
    model_failure: 'model_failure',
    invalid_model_output: 'structured_output_failure',
    oversized_model_output: 'output_budget',
    recursion_limit: 'recursion_limit',
    final_context_budget: 'final_context_budget',
    internal_error: 'internal_error',
  };
  return typeof input === 'string' ? mapping[input] : undefined;
}

function triageBypass(input: unknown): ContextTelemetryBypassReason | undefined {
  const mapping: Readonly<Record<string, ContextTelemetryBypassReason>> = {
    utility_model_missing: 'utility_model_missing',
    utility_model_unavailable: 'utility_model_unavailable',
    structured_output_unsupported: 'structured_output_unsupported',
    invalid_capabilities: 'invalid_capabilities',
    invalid_health: 'invalid_health',
    no_groups: 'no_groups',
    no_files: 'no_files',
    context_budget: 'context_budget',
    model_call_limit: 'model_call_limit',
    model_failure: 'model_failure',
    invalid_model_output: 'structured_output_failure',
    oversized_model_output: 'output_budget',
  };
  return typeof input === 'string' ? mapping[input] : undefined;
}

function modelFailureCount(reason: ContextTelemetryBypassReason, calls: number): number {
  if (calls === 0) return 0;
  return [
    'utility_model_unavailable',
    'model_failure',
    'structured_output_failure',
    'output_budget',
  ].includes(reason)
    ? 1
    : 0;
}

function sumObserved(
  observations: readonly ContextTelemetryObservation[],
  key: SummableKey,
): number | undefined {
  let observed = false;
  let total = 0;
  for (const observation of observations) {
    const value = observation[key];
    if (value === undefined) continue;
    observed = true;
    total += value;
    const max = key === 'utilityLatencyMs' ? 86_400_000 : MAX_CONTEXT_TELEMETRY_INTEGER;
    if (!Number.isFinite(total) || total > max) return undefined;
  }
  return observed ? total : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function uniqueObservedIdentity(
  observations: readonly ContextTelemetryObservation[],
  key: 'effectiveProvider' | 'effectiveModel',
): string | undefined {
  let observed: string | undefined;
  for (const observation of observations) {
    const value = observation[key];
    if (value === undefined) continue;
    if (observed !== undefined && observed !== value) return undefined;
    observed = value;
  }
  return observed;
}

/**
 * Deterministic outcome aggregate computed per-observation.
 *
 * Delivery is only counted when a retrieval observation carries no bypassReason
 * (ok=true, advisory reached the prompt). Bypassed observations are counted by
 * the presence of bypassReason, not from aggregate utility call counters.
 *
 * This avoids the overlapping-counter problem: an observation with both
 * utilityFailures=1 and bypassReason set is ONE bypass, not two failures.
 */
export interface ContextOutcomes {
  readonly observations: number;
  readonly utilityCalls: number;
  readonly deliveredAdvisories: number;
  readonly bypassedObservations: number;
  readonly bypassReasons: ReadonlyArray<{
    readonly reason: ContextTelemetryBypassReason;
    readonly count: number;
  }>;
}

/**
 * Aggregates observation-level outcome facts from a bounded observation list.
 *
 * Rules (§4–§7):
 * - Delivery = observations where bypassReason is absent (advisory was delivered)
 * - Bypass = observations where bypassReason is present (one bypass per observation)
 * - utilityCalls = sum of utilityCalls across ALL observations: each observation
 *   contributes its own call count exactly once, which keeps this consistent with
 *   `aggregate.utilityCalls`. A bypass never erases the calls that produced it —
 *   `validation_failed` DID invoke the model; `no_candidates` never did.
 * - bypassReasons = histogram of bypassReason values, preserving duplicates
 * - Zero-call bypasses (utility_model_missing, no_candidates) add zero to utilityCalls
 */
export function aggregateContextOutcomes(
  observations: readonly ContextTelemetryObservation[],
): ContextOutcomes {
  const reasonCounts = new Map<ContextTelemetryBypassReason, number>();
  let delivered = 0;
  let bypassed = 0;
  let utilityCalls = 0;
  let counted = 0;

  for (const obs of observations) {
    if (obs.stage === 'aggregate') continue;
    counted += 1;

    if (obs.bypassReason !== undefined) {
      bypassed += 1;
      reasonCounts.set(obs.bypassReason, (reasonCounts.get(obs.bypassReason) ?? 0) + 1);
    } else {
      delivered += 1;
    }

    if (obs.utilityCalls !== undefined && isIntegerMetric(obs.utilityCalls)) {
      utilityCalls += obs.utilityCalls;
    }
  }

  // Sort by count descending for stable display ordering.
  const bypassReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  return Object.freeze({
    observations: counted,
    utilityCalls,
    deliveredAdvisories: delivered,
    bypassedObservations: bypassed,
    bypassReasons: Object.freeze(bypassReasons),
  });
}

// Compile-time exhaustiveness guard: every runtime bypass must be schema-closed.
void CONTEXT_TELEMETRY_BYPASS_REASONS;
