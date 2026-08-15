/**
 * Conservative token estimation for utility model input budget enforcement (M3-02).
 *
 * M3-00 empirical finding: endpoints can silently truncate or overflow before
 * the advertised contextWindow (e.g. silent truncation around ~47.5k on a 64k model).
 *
 * This estimator provides a deterministic, conservative approximation of token count
 * for client-side preflight budget checks. It accounts for:
 * 1. Primary content text
 * 2. System instructions
 * 3. Structured output schema definition and prompt overhead
 * 4. Provider-specific directives (e.g. /no_think)
 * 5. OpenAI wire message framing envelope overhead (~4 tokens per message + 3 primer tokens)
 *
 * Safety margin:
 * - Uses a conservative ratio of ~3.0 characters per token for general text (vs nominal 3.5-4.0)
 * - Combines character-length and word-count heuristics: max(ceil(chars / 3.0), ceil(words * 1.3))
 * - Explicitly adds framing overhead per message role
 */

/**
 * Conservative token estimation for a single text segment.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  const charBased = Math.ceil(text.length / 3.0);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const wordBased = Math.ceil(words * 1.3);

  return Math.max(charBased, wordBased);
}

export interface EstimateInputTokensOptions {
  readonly content: string;
  readonly systemInstruction?: string;
  readonly desiredOutputSchema?: Record<string, unknown>;
  readonly injectNoThink?: boolean;
}

/** Per-message overhead in ChatML / OpenAI wire format (<|im_start|>role\n...<|im_end|>\n) */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;
/** Primer overhead for assistant response start (<|im_start|>assistant\n) */
const PRIMER_OVERHEAD_TOKENS = 3;

/**
 * Estimates total input tokens for an OpenAI-compatible /chat/completions payload.
 *
 * Guarantees a deterministic, conservative upper bound on the prompt tokens.
 */
export function estimateInputTokens(options: EstimateInputTokensOptions): number {
  let totalTokens = PRIMER_OVERHEAD_TOKENS;

  // 1. User message (content)
  totalTokens += PER_MESSAGE_OVERHEAD_TOKENS;
  totalTokens += estimateTokens(options.content);

  // 2. System message (system instruction + /no_think + schema instructions)
  const hasSystemInstruction = Boolean(options.systemInstruction && options.systemInstruction.trim().length > 0);
  const hasNoThink = Boolean(options.injectNoThink);
  const hasSchema = Boolean(options.desiredOutputSchema && Object.keys(options.desiredOutputSchema).length > 0);

  if (hasSystemInstruction || hasNoThink || hasSchema) {
    totalTokens += PER_MESSAGE_OVERHEAD_TOKENS;

    let systemText = options.systemInstruction ?? '';

    if (hasNoThink) {
      const alreadyHasNoThink = /(?:^|\s)\/no_think(?:\s|$)/.test(systemText);
      if (!alreadyHasNoThink) {
        systemText = systemText.length > 0 ? `/no_think\n${systemText}` : '/no_think';
      }
    }

    if (hasSchema && options.desiredOutputSchema) {
      const schemaPrompt = `\nYou must respond with a valid JSON object matching this schema:\n${JSON.stringify(options.desiredOutputSchema)}`;
      systemText += schemaPrompt;
    }

    totalTokens += estimateTokens(systemText);
  }

  return totalTokens;
}
