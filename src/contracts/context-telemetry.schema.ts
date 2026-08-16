import { z } from 'zod';

/** Stable discriminator for the append-only context observation audit event. */
export const CONTEXT_TELEMETRY_EVENT_TYPE = 'context_telemetry_observed' as const;

/**
 * Operational context telemetry only. These observations are estimates and
 * must never be interpreted as provider billing or workflow authority.
 */
export const CONTEXT_TELEMETRY_STAGES = [
  'retrieval',
  'compression',
  'log_triage',
  'diff_triage',
  'primary_context',
  'aggregate',
] as const;

export const CONTEXT_TELEMETRY_SOURCES = [
  'repository_retrieval',
  'hierarchical_compression',
  'log_triage',
  'diff_triage',
  'utility_model',
  'primary_runner',
  'aggregate',
] as const;

export const CONTEXT_TELEMETRY_PROVENANCE = [
  'mechanical_projection',
  'adapter_observation',
  'runtime_observation',
  'aggregate',
] as const;

export const CONTEXT_TELEMETRY_BYPASS_REASONS = [
  'utility_model_missing',
  'utility_model_unavailable',
  'structured_output_unsupported',
  'invalid_capabilities',
  'invalid_health',
  'invalid_input',
  'no_content',
  'no_candidates',
  'no_groups',
  'no_files',
  'context_budget',
  'context_budget_too_small',
  'model_call_limit',
  'model_failure',
  'structured_output_failure',
  'output_budget',
  'recursion_limit',
  'final_context_budget',
  'validation_failed',
  'internal_error',
] as const;

export const CONTEXT_TELEMETRY_EFFECTIVE_PROVIDERS = ['openai-compatible'] as const;

export const ContextTelemetryStageSchema = z.enum(CONTEXT_TELEMETRY_STAGES);
export const ContextTelemetrySourceSchema = z.enum(CONTEXT_TELEMETRY_SOURCES);
export const ContextTelemetryProvenanceSchema = z.enum(CONTEXT_TELEMETRY_PROVENANCE);
export const ContextTelemetryBypassReasonSchema = z.enum(CONTEXT_TELEMETRY_BYPASS_REASONS);
export const ContextTelemetryEffectiveProviderSchema = z.enum(
  CONTEXT_TELEMETRY_EFFECTIVE_PROVIDERS,
);

export type ContextTelemetryStage = (typeof CONTEXT_TELEMETRY_STAGES)[number];
export type ContextTelemetrySource = (typeof CONTEXT_TELEMETRY_SOURCES)[number];
export type ContextTelemetryProvenance = (typeof CONTEXT_TELEMETRY_PROVENANCE)[number];
export type ContextTelemetryBypassReason = (typeof CONTEXT_TELEMETRY_BYPASS_REASONS)[number];
export type ContextTelemetryEffectiveProvider =
  (typeof CONTEXT_TELEMETRY_EFFECTIVE_PROVIDERS)[number];

/** Hard operational bounds; exceeding them means the metric is unavailable. */
export const MAX_CONTEXT_TELEMETRY_INTEGER = 1_000_000_000_000;
export const MAX_CONTEXT_TELEMETRY_LATENCY_MS = 86_400_000;
export const MAX_CONTEXT_TELEMETRY_OBSERVATIONS = 256;

const IntegerMetricSchema = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .max(MAX_CONTEXT_TELEMETRY_INTEGER);

const LatencyMetricSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(MAX_CONTEXT_TELEMETRY_LATENCY_MS);

/**
 * Response-established provider/model identity. This grammar deliberately
 * excludes whitespace, query strings, fragments and credential punctuation.
 */
function resemblesCredential(identity: string): boolean {
  return (
    /(?:^|[._/-])(?:sk|pk)[_-](?:live|test|proj|secret)(?:$|[A-Za-z0-9._/-])/i.test(
      identity,
    ) ||
    /(?:^|[._/-])(?:secret|token|password|credential|api[_-]?key)(?:$|[._/-])/i.test(
      identity,
    ) ||
    /^gh[pousr]_[A-Za-z0-9]{20,}$/i.test(identity) ||
    /^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(identity) ||
    /^xox[baprs]-/i.test(identity) ||
    /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(identity) ||
    /^ya29\./i.test(identity)
  );
}

export const ContextTelemetryEffectiveModelSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/)
  .refine((identity) => !resemblesCredential(identity), 'model identity resembles credential material');

const VALID_OBSERVATION_TRIPLES = new Set([
  'retrieval|repository_retrieval|mechanical_projection',
  'compression|hierarchical_compression|mechanical_projection',
  'log_triage|log_triage|mechanical_projection',
  'diff_triage|diff_triage|mechanical_projection',
  'retrieval|utility_model|adapter_observation',
  'compression|utility_model|adapter_observation',
  'log_triage|utility_model|adapter_observation',
  'diff_triage|utility_model|adapter_observation',
  'primary_context|primary_runner|runtime_observation',
  'aggregate|aggregate|aggregate',
]);

const BYPASS_REASONS_BY_SOURCE: Readonly<Record<string, ReadonlySet<string>>> = {
  repository_retrieval: new Set([
    'utility_model_missing',
    'utility_model_unavailable',
    'no_candidates',
    'context_budget',
    'model_failure',
    'structured_output_failure',
    'validation_failed',
  ]),
  hierarchical_compression: new Set([
    'utility_model_missing',
    'utility_model_unavailable',
    'invalid_capabilities',
    'invalid_health',
    'invalid_input',
    'no_content',
    'context_budget_too_small',
    'model_call_limit',
    'model_failure',
    'structured_output_failure',
    'output_budget',
    'recursion_limit',
    'final_context_budget',
    'internal_error',
  ]),
  log_triage: new Set([
    'utility_model_missing',
    'utility_model_unavailable',
    'structured_output_unsupported',
    'invalid_capabilities',
    'invalid_health',
    'no_groups',
    'context_budget',
    'model_call_limit',
    'model_failure',
    'structured_output_failure',
    'output_budget',
  ]),
  diff_triage: new Set([
    'utility_model_missing',
    'utility_model_unavailable',
    'structured_output_unsupported',
    'invalid_capabilities',
    'invalid_health',
    'no_files',
    'context_budget',
    'model_call_limit',
    'model_failure',
    'structured_output_failure',
    'output_budget',
  ]),
  utility_model: new Set([
    'utility_model_unavailable',
    'context_budget',
    'model_failure',
    'structured_output_failure',
  ]),
};

export const ContextTelemetryObservationSchema = z
  .object({
    stage: ContextTelemetryStageSchema,
    source: ContextTelemetrySourceSchema,
    provenance: ContextTelemetryProvenanceSchema,
    estimatedInputTokens: IntegerMetricSchema.optional(),
    estimatedOutputTokens: IntegerMetricSchema.optional(),
    estimatedCompressedTokens: IntegerMetricSchema.optional(),
    /** Not populated by pre-M3-08 projections. */
    estimatedPrimaryContextTokens: IntegerMetricSchema.optional(),
    estimatedAvoidedTokens: IntegerMetricSchema.optional(),
    rawBytes: IntegerMetricSchema.optional(),
    compressedBytes: IntegerMetricSchema.optional(),
    candidatesBefore: IntegerMetricSchema.optional(),
    candidatesAfter: IntegerMetricSchema.optional(),
    filesBefore: IntegerMetricSchema.optional(),
    filesAfter: IntegerMetricSchema.optional(),
    utilityCalls: IntegerMetricSchema.optional(),
    utilityFailures: IntegerMetricSchema.optional(),
    structuredOutputFailures: IntegerMetricSchema.optional(),
    utilityLatencyMs: LatencyMetricSchema.optional(),
    bypassReason: ContextTelemetryBypassReasonSchema.optional(),
    effectiveProvider: ContextTelemetryEffectiveProviderSchema.optional(),
    effectiveModel: ContextTelemetryEffectiveModelSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    const comparison =
      observation.estimatedPrimaryContextTokens ?? observation.estimatedCompressedTokens;
    const canDerive = observation.estimatedInputTokens !== undefined && comparison !== undefined;
    if (observation.estimatedAvoidedTokens !== undefined && !canDerive) {
      context.addIssue({
        code: 'custom',
        path: ['estimatedAvoidedTokens'],
        message: 'avoided tokens require both input and primary-or-compressed estimates',
      });
    }
    if (canDerive) {
      const expected = Math.max(0, observation.estimatedInputTokens! - comparison!);
      if (observation.estimatedAvoidedTokens !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['estimatedAvoidedTokens'],
          message: 'avoided tokens must be present and mechanically derived from observed estimates',
        });
      }
    }

    if (
      observation.candidatesBefore !== undefined &&
      observation.candidatesAfter !== undefined &&
      observation.candidatesAfter > observation.candidatesBefore
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidatesAfter'],
        message: 'after count cannot exceed before count',
      });
    }
    if (
      observation.filesBefore !== undefined &&
      observation.filesAfter !== undefined &&
      observation.filesAfter > observation.filesBefore
    ) {
      context.addIssue({
        code: 'custom',
        path: ['filesAfter'],
        message: 'after count cannot exceed before count',
      });
    }
    if (
      observation.utilityCalls !== undefined &&
      observation.utilityFailures !== undefined &&
      observation.utilityFailures > observation.utilityCalls
    ) {
      context.addIssue({
        code: 'custom',
        path: ['utilityFailures'],
        message: 'failure count cannot exceed call count',
      });
    }
    if (
      observation.utilityCalls !== undefined &&
      observation.structuredOutputFailures !== undefined &&
      observation.structuredOutputFailures > observation.utilityCalls
    ) {
      context.addIssue({
        code: 'custom',
        path: ['structuredOutputFailures'],
        message: 'structured-output failure count cannot exceed call count',
      });
    }

    const triple = `${observation.stage}|${observation.source}|${observation.provenance}`;
    if (!VALID_OBSERVATION_TRIPLES.has(triple)) {
      context.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'stage, source and provenance must form a recognized observation boundary',
      });
    }

    if (observation.bypassReason !== undefined) {
      const allowed = BYPASS_REASONS_BY_SOURCE[observation.source];
      if (!allowed?.has(observation.bypassReason)) {
        context.addIssue({
          code: 'custom',
          path: ['bypassReason'],
          message: 'bypass reason does not belong to this observation source',
        });
      }
      if (
        observation.source === 'utility_model' &&
        (observation.utilityCalls === undefined ||
          observation.utilityCalls === 0 ||
          observation.utilityFailures === undefined ||
          observation.utilityFailures === 0)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['bypassReason'],
          message: 'a UtilityModel failure observation requires an observed failed call',
        });
      }
    }

    const mayCarryEffectiveIdentity =
      observation.source === 'utility_model' ||
      observation.source === 'aggregate' ||
      observation.source === 'repository_retrieval';
    if (
      !mayCarryEffectiveIdentity &&
      (observation.effectiveProvider !== undefined || observation.effectiveModel !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveProvider'],
        message: 'effective identity requires adapter-observed or aggregated provenance',
      });
    }
    if (observation.effectiveModel !== undefined && observation.effectiveProvider === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveModel'],
        message: 'effective model requires its effective provider',
      });
    }
  });

export type ContextTelemetryObservation = z.infer<typeof ContextTelemetryObservationSchema>;

export const ContextTelemetrySeriesSchema = z
  .object({
    observations: z.array(ContextTelemetryObservationSchema).max(MAX_CONTEXT_TELEMETRY_OBSERVATIONS),
  })
  .strict();

export type ContextTelemetrySeries = z.infer<typeof ContextTelemetrySeriesSchema>;
