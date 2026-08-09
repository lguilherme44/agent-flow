import { REASONING_ORDER, type ReasoningLevel } from '../contracts/common.schema.js';

const rank = (level: ReasoningLevel): number => REASONING_ORDER.indexOf(level);

export function compareReasoning(a: ReasoningLevel, b: ReasoningLevel): number {
  return rank(a) - rank(b);
}

export function highestSupported(
  supported: readonly ReasoningLevel[],
): ReasoningLevel | undefined {
  return [...supported].sort(compareReasoning).at(-1);
}

export interface ClampResult {
  readonly reasoning: ReasoningLevel;
  readonly clamped: boolean;
}

/**
 * Fits a requested reasoning level to what a runner actually offers (R-15).
 *
 * Preference order: the exact level, then the closest level *below* it, and only
 * if nothing lower exists, the runner's minimum. Going up spends more of the
 * user's quota than they asked for, so it is a last resort taken only because
 * the alternative is refusing to run.
 *
 * Either adjustment sets `clamped`, which travels into `result.json` and shows
 * up as a degradation. A quiet downgrade would leave someone wondering why the
 * output got worse after a fallback fired.
 */
export function clampReasoning(
  requested: ReasoningLevel,
  supported: readonly ReasoningLevel[],
): ClampResult {
  if (supported.includes(requested)) return { reasoning: requested, clamped: false };

  if (supported.length === 0) {
    throw new Error('runner declares no supported reasoning levels');
  }

  const ordered = [...supported].sort(compareReasoning);
  const below = ordered.filter((level) => compareReasoning(level, requested) < 0).at(-1);
  const chosen = below ?? (ordered[0] as ReasoningLevel);

  return { reasoning: chosen, clamped: true };
}
