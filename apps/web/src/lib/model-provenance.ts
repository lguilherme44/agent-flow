export interface ModelProvenanceDisplay {
  readonly display: string;
  readonly isUnobservable: boolean;
  readonly isObserved: boolean;
  readonly isConfigured: boolean;
  readonly tooltip?: string | undefined;
}

/**
 * Normalizes model provenance display across all surfaces (Agents page, Run Detail, Inspector, etc.).
 *
 * Rules:
 * 1. AGY runner: backing model is unobservable by design -> "Unobservable"
 * 2. Effective model observed via telemetry/read-model: -> exact observed model name
 * 3. Configured model without runtime observation: -> configured model name
 * 4. No configuration and no observation: -> "Not observed" (or "runner default")
 */
export function resolveModelProvenance(params: {
  readonly runner?: string | undefined;
  readonly configuredModel?: string | undefined;
  readonly effectiveModel?: string | undefined;
}): ModelProvenanceDisplay {
  const runner = params.runner?.toLowerCase();

  if (runner === 'agy') {
    return {
      display: 'Unobservable',
      isUnobservable: true,
      isObserved: false,
      isConfigured: false,
      tooltip: 'The backing model of AGY CLI is managed internally by the CLI binary and is unobservable',
    };
  }

  if (params.effectiveModel && params.effectiveModel.trim()) {
    return {
      display: params.effectiveModel.trim(),
      isUnobservable: false,
      isObserved: true,
      isConfigured: false,
      tooltip: `Observed effective model: ${params.effectiveModel.trim()}`,
    };
  }

  if (params.configuredModel && params.configuredModel.trim()) {
    return {
      display: params.configuredModel.trim(),
      isUnobservable: false,
      isObserved: false,
      isConfigured: true,
      tooltip: `Configured model: ${params.configuredModel.trim()} (not yet observed at runtime)`,
    };
  }

  return {
    display: 'Not observed',
    isUnobservable: false,
    isObserved: false,
    isConfigured: false,
    tooltip: 'No model observation recorded',
  };
}
