/**
 * Provider-neutral seam for deterministic context-budget estimation.
 *
 * Estimates are operational safety bounds, not billing measurements. The
 * Implementation must be deterministic, finite, non-negative, and monotonic
 * for prefixes of the same text. Compression validates every returned value
 * and falls back to its conservative built-in Implementation when needed.
 */
export interface ContextTokenEstimator {
  estimateTokens(text: string): number;
}
