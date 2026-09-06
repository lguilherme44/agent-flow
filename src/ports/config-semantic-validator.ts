import type { ConfigPath } from './config-source-codec.js';

export type ConfigDiagnosticSeverity = 'error' | 'warning';

export interface ConfigDiagnostic {
  readonly severity: ConfigDiagnosticSeverity;
  readonly code: string;
  readonly path: ConfigPath;
  readonly message: string;
  readonly action?: string;
}

export interface ConfigSemanticValidationInput {
  readonly effectiveGlobal: Record<string, unknown>;
  readonly projectSource?: Record<string, unknown>;
}

export interface ConfigSemanticValidationResult {
  readonly effectiveGlobal: Record<string, unknown>;
  readonly projectSource?: Record<string, unknown>;
  readonly diagnostics: readonly ConfigDiagnostic[];
}

/** Schema and cross-reference validation, with no filesystem access. */
export interface ConfigSemanticValidator {
  validate(input: ConfigSemanticValidationInput): readonly ConfigDiagnostic[];
  /** Returns the Zod-materialized values used by runtime, including defaults. */
  normalize(input: ConfigSemanticValidationInput): ConfigSemanticValidationResult;
}
