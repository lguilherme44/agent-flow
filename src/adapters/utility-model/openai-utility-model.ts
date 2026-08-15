import type {
  UtilityModel,
  UtilityModelCapabilities,
  UtilityModelHealth,
  UtilityModelInput,
  UtilityModelResult,
  UtilityModelUsage,
} from '../../ports/utility-model.js';
import type { Clock } from '../../ports/clock.js';
import { estimateInputTokens } from './token-estimator.js';

/**
 * Configuration for the OpenAI-compatible UtilityModel adapter (M3-02).
 */
export interface OpenAiCompatibleUtilityModelConfig {
  /**
   * Human-readable identifier for this model instance.
   * Default: 'openai-compatible-utility-model'
   */
  readonly id?: string;

  /**
   * Base URL of the OpenAI-compatible service (e.g. 'http://localhost:1234' or 'http://localhost:1234/v1').
   * Trailing slashes and '/v1' suffixes are normalized automatically.
   */
  readonly baseUrl: string;

  /**
   * Model identifier to pass in /chat/completions requests.
   */
  readonly model: string;

  /**
   * Optional API key. Sent in `Authorization: Bearer <apiKey>` header.
   * Never logged, leaked, or exposed in diagnostics.
   */
  readonly apiKey?: string;

  /**
   * Advertised context window capacity in tokens.
   * Default: 64,000 (M3-00 finding)
   */
  readonly contextWindow?: number;

  /**
   * Safe operational input budget in tokens, enforced before inference.
   * Must be positive and <= contextWindow.
   * Default: 40,000 (M3-00 conservative safe target)
   */
  readonly targetInputTokens?: number;

  /**
   * Default maximum output tokens per inference call.
   * Can be overridden per call via UtilityModelInput.maxOutputTokens.
   * Default: 4,000 (M3-00 operational default)
   */
  readonly maxOutputTokens?: number;

  /**
   * Inference request timeout in seconds.
   * Default: 120 (M3-00 safe inference default)
   */
  readonly timeoutSeconds?: number;

  /**
   * Health check timeout in seconds.
   * Default: 5 (ensures fast offline detection < 2s)
   */
  readonly healthTimeoutSeconds?: number;

  /**
   * Whether to inject the `/no_think` directive into the system instruction for Qwen3 models.
   * Default: false (must be explicitly enabled for Qwen models).
   */
  readonly injectNoThink?: boolean;

  /**
   * Whether this endpoint supports structured JSON output.
   * Default: true
   */
  readonly structuredOutput?: boolean;

  /**
   * Optional injectable fetch function for deterministic unit testing.
   * Default: globalThis.fetch
   */
  readonly fetch?: typeof fetch;

  /**
   * Optional clock for duration measurement.
   */
  readonly clock?: Clock;
}

const DEFAULT_CONTEXT_WINDOW = 64_000;
const DEFAULT_TARGET_INPUT_TOKENS = 40_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_HEALTH_TIMEOUT_SECONDS = 5;
const DEFAULT_INJECT_NO_THINK = false;
const DEFAULT_STRUCTURED_OUTPUT = true;

/**
 * Normalizes an OpenAI-compatible base URL into exact endpoint URLs.
 *
 * Supported formats:
 * - 'http://localhost:1234' -> '/v1/chat/completions', '/v1/models'
 * - 'http://localhost:1234/' -> '/v1/chat/completions', '/v1/models'
 * - 'http://localhost:1234/v1' -> '/chat/completions', '/models'
 * - 'http://localhost:1234/v1/' -> '/chat/completions', '/models'
 * - 'http://host:port/custom/v1' -> '/chat/completions', '/models'
 */
function normalizeEndpointUrls(rawBaseUrl: string): { chatCompletionsUrl: string; modelsUrl: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`Invalid baseUrl: "${rawBaseUrl}" is not a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid baseUrl: protocol must be http: or https:, got "${parsed.protocol}"`);
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const originAndPath = `${parsed.protocol}//${parsed.host}${pathname}`;

  if (pathname.endsWith('/v1')) {
    return {
      chatCompletionsUrl: `${originAndPath}/chat/completions`,
      modelsUrl: `${originAndPath}/models`,
    };
  } else if (pathname === '' || pathname === '/') {
    return {
      chatCompletionsUrl: `${parsed.protocol}//${parsed.host}/v1/chat/completions`,
      modelsUrl: `${parsed.protocol}//${parsed.host}/v1/models`,
    };
  } else {
    return {
      chatCompletionsUrl: `${originAndPath}/chat/completions`,
      modelsUrl: `${originAndPath}/models`,
    };
  }
}

/**
 * OpenAI-compatible HTTP adapter for UtilityModel (M3-02).
 *
 * Implements the provider-neutral UtilityModel port using standard OpenAI wire format.
 * Incorporates all empirical constraints discovered in M3-00:
 * - Client-side budget enforcement against targetInputTokens before HTTP dispatch (0 network calls on overflow)
 * - Safe inference timeout with AbortController cancellation
 * - Fast lightweight health probe against /v1/models without inference
 * - Qwen3 /no_think system instruction normalization with deduplication
 * - Strict structured JSON output parsing with <think> pollution protection
 * - Provider-neutral error normalization (unavailable, timeout, invalid_response, context_limit, execution_failed)
 * - Complete secret redaction (no API keys in logs, messages, or telemetry)
 * - Strict authority boundary (advisory output only, no runner/Git/shell access)
 */
export class OpenAiCompatibleUtilityModel implements UtilityModel {
  readonly id: string;
  private readonly config: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly contextWindow: number;
    readonly targetInputTokens: number;
    readonly maxOutputTokens: number;
    readonly timeoutSeconds: number;
    readonly healthTimeoutSeconds: number;
    readonly injectNoThink: boolean;
    readonly structuredOutput: boolean;
    readonly fetch: typeof fetch;
    readonly clock?: Clock;
  };

  private readonly chatCompletionsUrl: string;
  private readonly modelsUrl: string;
  private readonly caps: UtilityModelCapabilities;

  constructor(config: OpenAiCompatibleUtilityModelConfig) {
    if (!config || typeof config !== 'object') {
      throw new Error('OpenAiCompatibleUtilityModel requires a valid config object');
    }

    if (!config.model || typeof config.model !== 'string' || config.model.trim().length === 0) {
      throw new Error('OpenAiCompatibleUtilityModel requires a non-empty model identifier');
    }

    const { chatCompletionsUrl, modelsUrl } = normalizeEndpointUrls(config.baseUrl);
    this.chatCompletionsUrl = chatCompletionsUrl;
    this.modelsUrl = modelsUrl;

    const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      throw new Error(`Invalid contextWindow: must be a positive integer, got ${contextWindow}`);
    }

    const targetInputTokens = config.targetInputTokens ?? DEFAULT_TARGET_INPUT_TOKENS;
    if (!Number.isInteger(targetInputTokens) || targetInputTokens <= 0) {
      throw new Error(`Invalid targetInputTokens: must be a positive integer, got ${targetInputTokens}`);
    }

    if (targetInputTokens > contextWindow) {
      throw new Error(
        `targetInputTokens (${targetInputTokens}) cannot exceed contextWindow (${contextWindow})`,
      );
    }

    const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new Error(`Invalid maxOutputTokens: must be a positive integer, got ${maxOutputTokens}`);
    }

    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error(`Invalid timeoutSeconds: must be a positive number, got ${timeoutSeconds}`);
    }

    const healthTimeoutSeconds = config.healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT_SECONDS;
    if (!Number.isFinite(healthTimeoutSeconds) || healthTimeoutSeconds <= 0) {
      throw new Error(`Invalid healthTimeoutSeconds: must be a positive number, got ${healthTimeoutSeconds}`);
    }

    const injectNoThink = config.injectNoThink ?? DEFAULT_INJECT_NO_THINK;
    const structuredOutput = config.structuredOutput ?? DEFAULT_STRUCTURED_OUTPUT;

    this.id = config.id ?? `openai-compatible:${config.model}`;
    this.config = {
      baseUrl: config.baseUrl,
      model: config.model.trim(),
      apiKey: config.apiKey,
      contextWindow,
      targetInputTokens,
      maxOutputTokens,
      timeoutSeconds,
      healthTimeoutSeconds,
      injectNoThink,
      structuredOutput,
      fetch: config.fetch ?? globalThis.fetch,
      clock: config.clock,
    };

    this.caps = {
      contextWindow: this.config.contextWindow,
      structuredOutput: this.config.structuredOutput,
      tools: false,
      streaming: false,
    };
  }

  capabilities(): UtilityModelCapabilities {
    return this.caps;
  }

  async healthCheck(): Promise<UtilityModelHealth> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.healthTimeoutSeconds * 1000);

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (this.config.apiKey) {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      }

      const res = await this.config.fetch(this.modelsUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        return {
          status: 'unavailable',
          detail: `Health check failed with HTTP ${res.status}`,
        };
      }

      const data = (await res.json()) as { data?: Array<{ id?: string }> };

      if (Array.isArray(data?.data)) {
        const modelId = this.config.model;
        const exists = data.data.some((m) => {
          if (!m || typeof m.id !== 'string') return false;
          return m.id === modelId || m.id.endsWith(`/${modelId}`) || m.id.includes(modelId);
        });

        if (!exists) {
          return {
            status: 'unavailable',
            detail: `Configured model "${modelId}" was not found in endpoint models list`,
          };
        }

        return {
          status: 'available',
          detail: `Model "${modelId}" is available at endpoint`,
        };
      }

      // Endpoint responded 200 OK without standard data array
      return {
        status: 'available',
        detail: 'Endpoint is reachable',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'unavailable',
        detail: this.sanitizeMessage(`Health probe failed: ${msg}`),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async run(input: UtilityModelInput): Promise<UtilityModelResult> {
    if (!input || typeof input !== 'object' || typeof input.content !== 'string') {
      throw new TypeError('UtilityModelInput.content must be a string');
    }

    if (input.maxOutputTokens !== undefined) {
      if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0 || !Number.isFinite(input.maxOutputTokens)) {
        return {
          ok: false,
          errorCode: 'invalid_response',
          message: `Invalid maxOutputTokens: must be a positive integer, got ${input.maxOutputTokens}`,
        };
      }
    }

    // 1. Prepare system instruction & /no_think normalization
    let systemInstruction = input.systemInstruction?.trim() ?? '';

    if (this.config.injectNoThink) {
      const alreadyHasNoThink = /(?:^|\s)\/no_think(?:\s|$)/.test(systemInstruction);
      if (!alreadyHasNoThink) {
        systemInstruction = systemInstruction.length > 0 ? `/no_think\n${systemInstruction}` : '/no_think';
      }
    }

    const expectsStructured = Boolean(input.desiredOutputSchema && this.caps.structuredOutput);
    if (expectsStructured && input.desiredOutputSchema) {
      const schemaPrompt = `\nYou must respond with a valid JSON object matching this schema:\n${JSON.stringify(input.desiredOutputSchema)}`;
      systemInstruction = systemInstruction.length > 0 ? `${systemInstruction}${schemaPrompt}` : schemaPrompt.trim();
    }

    // 2. Client-side conservative budget preflight check
    const estimatedTokens = estimateInputTokens({
      content: input.content,
      systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined,
      desiredOutputSchema: input.desiredOutputSchema,
      injectNoThink: this.config.injectNoThink,
    });

    if (estimatedTokens > this.config.targetInputTokens) {
      return {
        ok: false,
        errorCode: 'context_limit',
        message: `Estimated input tokens (${estimatedTokens}) exceeds target input budget (${this.config.targetInputTokens})`,
      };
    }

    // 3. Assemble OpenAI wire messages
    const messages: Array<{ role: string; content: string }> = [];
    if (systemInstruction.length > 0) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: input.content });

    const effectiveMaxOutputTokens = input.maxOutputTokens ?? this.config.maxOutputTokens;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: effectiveMaxOutputTokens,
    };

    if (expectsStructured) {
      body.response_format = { type: 'json_object' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);
    const startTime = this.now();

    try {
      const res = await this.config.fetch(this.chatCompletionsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const durationMs = this.now() - startTime;

      if (!res.ok) {
        return this.normalizeHttpError(res.status, res.statusText);
      }

      let data: {
        choices?: Array<{
          message?: {
            content?: unknown;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
        };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        return {
          ok: false,
          errorCode: 'invalid_response',
          message: 'Malformed JSON in HTTP 200 response from utility model',
        };
      }

      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        return {
          ok: false,
          errorCode: 'invalid_response',
          message: 'Malformed OpenAI response shape (missing choices[0].message.content)',
        };
      }

      const usage: UtilityModelUsage = {
        inputTokens: typeof data?.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : undefined,
        outputTokens: typeof data?.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : undefined,
        durationMs,
      };

      if (expectsStructured) {
        try {
          const parsed = JSON.parse(content.trim());
          return {
            ok: true,
            text: content,
            structured: parsed,
            usage,
          };
        } catch {
          return {
            ok: false,
            errorCode: 'invalid_response',
            message: 'Failed to parse structured JSON output from utility model response',
          };
        }
      }

      return {
        ok: true,
        text: content,
        usage,
      };
    } catch (err: unknown) {
      const durationMs = this.now() - startTime;
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        return {
          ok: false,
          errorCode: 'timeout',
          message: `Inference request timed out after ${this.config.timeoutSeconds}s (${durationMs}ms elapsed)`,
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorCode: 'unavailable',
        message: this.sanitizeMessage(`Endpoint unreachable: ${msg}`),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private normalizeHttpError(status: number, statusText: string): UtilityModelResult {
    if (status === 401 || status === 403) {
      return {
        ok: false,
        errorCode: 'execution_failed',
        message: `Authentication failed (HTTP ${status})`,
      };
    }

    if (status === 413) {
      return {
        ok: false,
        errorCode: 'context_limit',
        message: `Context limit exceeded (HTTP ${status})`,
      };
    }

    if (status === 502 || status === 503 || status === 504) {
      return {
        ok: false,
        errorCode: 'unavailable',
        message: `Endpoint unavailable (HTTP ${status}: ${statusText || 'Service Unavailable'})`,
      };
    }

    return {
      ok: false,
      errorCode: 'execution_failed',
      message: `HTTP ${status}: ${statusText || 'Inference execution failed'}`,
    };
  }

  private sanitizeMessage(msg: string): string {
    let sanitized = msg;
    if (this.config.apiKey) {
      sanitized = sanitized.split(this.config.apiKey).join('[REDACTED]');
    }
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, 'Bearer [REDACTED]');
    return sanitized;
  }

  private now(): number {
    return this.config.clock ? this.config.clock.monotonicMs() : Date.now();
  }
}
