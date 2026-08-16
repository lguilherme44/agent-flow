import { types as nodeUtilTypes } from 'node:util';
import type {
  UtilityModel,
  UtilityModelCapabilities,
  UtilityModelHealth,
  UtilityModelInput,
  UtilityModelResult,
  UtilityModelUsage,
} from '../../ports/utility-model.js';
import type { Clock } from '../../ports/clock.js';
import { estimateInputTokens, estimateTokens } from './token-estimator.js';

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
const EFFECTIVE_PROVIDER = 'openai-compatible';
const MAX_SAFE_TELEMETRY_TOKENS = 100_000_000;
const MAX_SAFE_TELEMETRY_DURATION_MS = 86_400_000;
const MAX_SAFE_RESPONSE_MODEL_LENGTH = 200;
const MAX_SNAPSHOT_NODES = 100_000;
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_CHARS = 1_000_000;
const UTILITY_INPUT_KEYS = new Set([
  'content',
  'systemInstruction',
  'desiredOutputSchema',
  'maxOutputTokens',
  'correlationId',
]);
const RESPONSE_PROTOTYPE = Response.prototype;
const RESPONSE_STATUS_GETTER = Object.getOwnPropertyDescriptor(RESPONSE_PROTOTYPE, 'status')?.get;
const RESPONSE_JSON_METHOD = Object.getOwnPropertyDescriptor(RESPONSE_PROTOTYPE, 'json')?.value as
  | ((this: Response) => Promise<unknown>)
  | undefined;

type SnapshotResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

interface UtilityModelInputSnapshot {
  readonly content: string;
  readonly systemInstruction?: string;
  readonly desiredOutputSchema?: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly correlationId?: string;
}

interface SnapshotBudget {
  nodes: number;
  chars: number;
}

function failedSnapshot<T>(): SnapshotResult<T> {
  return { ok: false };
}

function snapshotJsonValue(
  value: unknown,
  budget: SnapshotBudget = { nodes: 0, chars: 0 },
  depth = 0,
): SnapshotResult<unknown> {
  budget.nodes += 1;
  if (budget.nodes > MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) return failedSnapshot();

  if (value === null || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'string') {
    budget.chars += value.length;
    return budget.chars <= MAX_SNAPSHOT_CHARS ? { ok: true, value } : failedSnapshot();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : failedSnapshot();
  }
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) return failedSnapshot();

  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return failedSnapshot();
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_SNAPSHOT_NODES
      ) return failedSnapshot();

      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1) return failedSnapshot();
      const clone: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return failedSnapshot();
        const nested = snapshotJsonValue(descriptor.value, budget, depth + 1);
        if (!nested.ok) return failedSnapshot();
        clone.push(nested.value);
      }
      return { ok: true, value: Object.freeze(clone) };
    }

    if (prototype !== Object.prototype && prototype !== null) return failedSnapshot();
    const clone = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') return failedSnapshot();
      budget.chars += key.length;
      if (budget.chars > MAX_SNAPSHOT_CHARS) return failedSnapshot();
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return failedSnapshot();
      const nested = snapshotJsonValue(descriptor.value, budget, depth + 1);
      if (!nested.ok) return failedSnapshot();
      Object.defineProperty(clone, key, {
        value: nested.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return { ok: true, value: Object.freeze(clone) };
  } catch {
    return failedSnapshot();
  }
}

function snapshotUtilityInput(input: unknown): SnapshotResult<UtilityModelInputSnapshot> {
  if (!input || typeof input !== 'object' || nodeUtilTypes.isProxy(input)) return failedSnapshot();
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return failedSnapshot();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !UTILITY_INPUT_KEYS.has(key)) return failedSnapshot();
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return failedSnapshot();
    }

    const contentDescriptor = descriptors.content;
    if (!contentDescriptor || !('value' in contentDescriptor) || typeof contentDescriptor.value !== 'string') {
      return failedSnapshot();
    }
    const optionalValue = (key: string): unknown => {
      const descriptor = descriptors[key];
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    const systemInstruction = optionalValue('systemInstruction');
    const desiredOutputSchema = optionalValue('desiredOutputSchema');
    const maxOutputTokens = optionalValue('maxOutputTokens');
    const correlationId = optionalValue('correlationId');
    if (systemInstruction !== undefined && typeof systemInstruction !== 'string') return failedSnapshot();
    if (maxOutputTokens !== undefined && typeof maxOutputTokens !== 'number') return failedSnapshot();
    if (correlationId !== undefined && typeof correlationId !== 'string') return failedSnapshot();

    let safeSchema: Readonly<Record<string, unknown>> | undefined;
    if (desiredOutputSchema !== undefined) {
      const snapshot = snapshotJsonValue(desiredOutputSchema);
      if (!snapshot.ok || !snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)) {
        return failedSnapshot();
      }
      safeSchema = snapshot.value as Readonly<Record<string, unknown>>;
    }

    return {
      ok: true,
      value: Object.freeze({
        content: contentDescriptor.value,
        ...(systemInstruction === undefined ? {} : { systemInstruction }),
        ...(safeSchema === undefined ? {} : { desiredOutputSchema: safeSchema }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(correlationId === undefined ? {} : { correlationId }),
      }),
    };
  } catch {
    return failedSnapshot();
  }
}

function snapshotNativeResponse(value: unknown): SnapshotResult<{ readonly response: Response; readonly status: number }> {
  if (!value || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) return failedSnapshot();
  try {
    if (
      RESPONSE_STATUS_GETTER === undefined ||
      RESPONSE_JSON_METHOD === undefined ||
      Object.getPrototypeOf(value) !== RESPONSE_PROTOTYPE ||
      Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length !== 0
    ) return failedSnapshot();
    const status = RESPONSE_STATUS_GETTER.call(value);
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) return failedSnapshot();
    return { ok: true, value: Object.freeze({ response: value as Response, status }) };
  } catch {
    return failedSnapshot();
  }
}

function asSnapshotRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

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
    throw new Error('Invalid baseUrl: expected a valid http(s) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid baseUrl: protocol must be http: or https:');
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

    this.caps = Object.freeze({
      contextWindow: this.config.contextWindow,
      structuredOutput: this.config.structuredOutput,
      tools: false,
      streaming: false,
    });
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
      const response = snapshotNativeResponse(res);
      if (!response.ok) {
        return { status: 'unavailable', detail: 'Invalid health response' };
      }

      if (response.value.status < 200 || response.value.status > 299) {
        return {
          status: 'unavailable',
          detail: `Health check failed with HTTP ${response.value.status}`,
        };
      }

      if (RESPONSE_JSON_METHOD === undefined) {
        return { status: 'unavailable', detail: 'Invalid health response' };
      }
      const rawData = await RESPONSE_JSON_METHOD.call(response.value.response);
      const dataSnapshot = snapshotJsonValue(rawData);
      if (!dataSnapshot.ok) {
        return { status: 'unavailable', detail: 'Invalid health response' };
      }
      const data = asSnapshotRecord(dataSnapshot.value);
      const models = data?.data;

      if (Array.isArray(models)) {
        const modelId = this.config.model;
        const exists = models.some((candidate) => {
          const model = asSnapshotRecord(candidate);
          const id = model?.id;
          if (typeof id !== 'string') return false;
          return id === modelId || id.endsWith(`/${modelId}`) || id.includes(modelId);
        });

        if (!exists) {
          return {
            status: 'unavailable',
            detail: 'Configured model was not found in endpoint models list',
          };
        }

        return {
          status: 'available',
          detail: 'Configured model is available at endpoint',
        };
      }

      // Endpoint responded 200 OK without standard data array
      return {
        status: 'available',
        detail: 'Endpoint is reachable',
      };
    } catch {
      return {
        status: 'unavailable',
        detail: 'Health probe failed',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async run(input: UtilityModelInput): Promise<UtilityModelResult> {
    const inputSnapshot = snapshotUtilityInput(input);
    if (!inputSnapshot.ok) return this.invalidInput();
    const request = inputSnapshot.value;

    if (
      request.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
    ) {
      return this.invalidInput();
    }

    let systemInstruction: string;
    let expectsStructured: boolean;
    let estimatedTokens: number;
    let serializedBody: string;
    try {
      // 1. Prepare system instruction & /no_think normalization
      systemInstruction = request.systemInstruction?.trim() ?? '';

      if (this.config.injectNoThink) {
        const alreadyHasNoThink = /(?:^|\s)\/no_think(?:\s|$)/.test(systemInstruction);
        if (!alreadyHasNoThink) {
          systemInstruction = systemInstruction.length > 0 ? `/no_think\n${systemInstruction}` : '/no_think';
        }
      }

      expectsStructured = Boolean(request.desiredOutputSchema && this.caps.structuredOutput);
      if (expectsStructured && request.desiredOutputSchema) {
        const schemaPrompt = `\nYou must respond with a valid JSON object matching this schema:\n${JSON.stringify(request.desiredOutputSchema)}`;
        systemInstruction = systemInstruction.length > 0 ? `${systemInstruction}${schemaPrompt}` : schemaPrompt.trim();
      }

      // 2. Client-side conservative budget preflight check
      estimatedTokens = estimateInputTokens({
        content: request.content,
        systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined,
        // `systemInstruction` already contains the provider schema prompt above;
        // passing the schema here too would count context that is sent only once.
        injectNoThink: this.config.injectNoThink,
      });

      // 3. Assemble OpenAI wire messages from the validated snapshot only.
      const messages: Array<{ role: string; content: string }> = [];
      if (systemInstruction.length > 0) messages.push({ role: 'system', content: systemInstruction });
      messages.push({ role: 'user', content: request.content });

      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      };
      if (expectsStructured) body.response_format = { type: 'json_object' };
      serializedBody = JSON.stringify(body);
    } catch {
      return this.invalidInput();
    }

    if (estimatedTokens > this.config.targetInputTokens) {
      return Object.freeze({
        ok: false,
        errorCode: 'context_limit',
        message: `Estimated input tokens (${estimatedTokens}) exceeds target input budget (${this.config.targetInputTokens})`,
        usage: this.makeUsage(estimatedTokens),
      });
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
    const startTime = this.safeNow();

    try {
      const res = await this.config.fetch(this.chatCompletionsUrl, {
        method: 'POST',
        headers,
        body: serializedBody,
        signal: controller.signal,
      });
      const response = snapshotNativeResponse(res);
      if (!response.ok) {
        return this.invalidResponse(estimatedTokens, this.elapsedSince(startTime));
      }

      if (response.value.status < 200 || response.value.status > 299) {
        return this.normalizeHttpError(
          response.value.status,
          this.makeUsage(estimatedTokens, this.elapsedSince(startTime)),
        );
      }

      let rawData: unknown;
      try {
        if (RESPONSE_JSON_METHOD === undefined) {
          return this.invalidResponse(estimatedTokens, this.elapsedSince(startTime));
        }
        rawData = await RESPONSE_JSON_METHOD.call(response.value.response);
      } catch {
        return Object.freeze({
          ok: false,
          errorCode: 'invalid_response',
          message: 'Malformed JSON in HTTP 200 response from utility model',
          usage: this.makeUsage(estimatedTokens, this.elapsedSince(startTime)),
          provenance: this.makeProvenance(),
        });
      }

      const dataSnapshot = snapshotJsonValue(rawData);
      const data = dataSnapshot.ok ? asSnapshotRecord(dataSnapshot.value) : undefined;
      if (!data) return this.invalidResponse(estimatedTokens, this.elapsedSince(startTime));
      const choices = data.choices;
      const firstChoice = Array.isArray(choices) ? asSnapshotRecord(choices[0]) : undefined;
      const message = asSnapshotRecord(firstChoice?.message);
      const content = message?.content;
      const provenance = this.makeProvenance(data.model);
      const providerUsage = asSnapshotRecord(data.usage);
      if (typeof content !== 'string') {
        return Object.freeze({
          ok: false,
          errorCode: 'invalid_response',
          message: 'Malformed OpenAI response shape (missing choices[0].message.content)',
          usage: this.makeUsage(
            estimatedTokens,
            this.elapsedSince(startTime),
            undefined,
            providerUsage === undefined ? undefined : {
              prompt_tokens: providerUsage.prompt_tokens as number | undefined,
              completion_tokens: providerUsage.completion_tokens as number | undefined,
            },
          ),
          provenance,
        });
      }

      const usage = this.makeUsage(
        estimatedTokens,
        this.elapsedSince(startTime),
        content,
        providerUsage === undefined ? undefined : {
          prompt_tokens: providerUsage.prompt_tokens as number | undefined,
          completion_tokens: providerUsage.completion_tokens as number | undefined,
        },
      );

      if (expectsStructured) {
        try {
          const parsed = JSON.parse(content.trim());
          return Object.freeze({
            ok: true,
            text: content,
            structured: parsed,
            usage,
            provenance,
          });
        } catch {
          return Object.freeze({
            ok: false,
            errorCode: 'invalid_response',
            message: 'Failed to parse structured JSON output from utility model response',
            usage,
            provenance,
          });
        }
      }

      return Object.freeze({
        ok: true,
        text: content,
        usage,
        provenance,
      });
    } catch {
      const usage = this.makeUsage(estimatedTokens, this.elapsedSince(startTime));
      const provenance = this.makeProvenance();
      if (controller.signal.aborted) {
        return Object.freeze({
          ok: false,
          errorCode: 'timeout',
          message: 'Inference request timed out',
          usage,
          provenance,
        });
      }

      return Object.freeze({
        ok: false,
        errorCode: 'unavailable',
        message: 'Utility model endpoint unavailable',
        usage,
        provenance,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private normalizeHttpError(status: number, usage: UtilityModelUsage): UtilityModelResult {
    const provenance = this.makeProvenance();
    if (status === 401 || status === 403) {
      return Object.freeze({
        ok: false,
        errorCode: 'execution_failed',
        message: `Authentication failed (HTTP ${status})`,
        usage,
        provenance,
      });
    }

    if (status === 413) {
      return Object.freeze({
        ok: false,
        errorCode: 'context_limit',
        message: `Context limit exceeded (HTTP ${status})`,
        usage,
        provenance,
      });
    }

    if (status === 502 || status === 503 || status === 504) {
      return Object.freeze({
        ok: false,
        errorCode: 'unavailable',
        message: `Endpoint unavailable (HTTP ${status})`,
        usage,
        provenance,
      });
    }

    return Object.freeze({
      ok: false,
      errorCode: 'execution_failed',
      message: `Inference execution failed (HTTP ${status})`,
      usage,
      provenance,
    });
  }

  private invalidInput(): UtilityModelResult {
    return Object.freeze({
      ok: false,
      errorCode: 'invalid_response',
      message: 'Invalid utility model input',
    });
  }

  private invalidResponse(estimatedInputTokens: number, durationMs?: number): UtilityModelResult {
    return Object.freeze({
      ok: false,
      errorCode: 'invalid_response',
      message: 'Invalid utility model response',
      usage: this.makeUsage(estimatedInputTokens, durationMs),
      provenance: this.makeProvenance(),
    });
  }

  private makeUsage(
    estimatedInputTokens: number,
    durationMs?: number,
    outputText?: string,
    providerUsage?: { prompt_tokens?: number; completion_tokens?: number },
  ): UtilityModelUsage {
    const inputTokens = this.safeTokenCount(providerUsage?.prompt_tokens);
    const outputTokens = this.safeTokenCount(providerUsage?.completion_tokens);
    const safeEstimatedInput = this.safeTokenCount(estimatedInputTokens);
    const estimatedOutputTokens =
      outputText === undefined ? undefined : this.safeTokenCount(estimateTokens(outputText));

    return Object.freeze({
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(safeEstimatedInput === undefined ? {} : { estimatedInputTokens: safeEstimatedInput }),
      ...(estimatedOutputTokens === undefined ? {} : { estimatedOutputTokens }),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }

  private safeTokenCount(value: unknown): number | undefined {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAX_SAFE_TELEMETRY_TOKENS
    ) {
      return undefined;
    }
    return value;
  }

  private makeProvenance(responseModel?: unknown): Readonly<{ provider: string; model?: string }> {
    const model = this.safeResponseModel(responseModel);
    return Object.freeze({
      provider: EFFECTIVE_PROVIDER,
      ...(model === undefined ? {} : { model }),
    });
  }

  private safeResponseModel(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SAFE_RESPONSE_MODEL_LENGTH) return undefined;
    if (
      (this.config.apiKey !== undefined && this.config.apiKey.length > 0 && value.includes(this.config.apiKey)) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value)
    ) {
      return undefined;
    }
    return value;
  }

  private safeNow(): number | undefined {
    try {
      const value = this.config.clock ? this.config.clock.monotonicMs() : Date.now();
      return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private elapsedSince(startTime: number | undefined): number | undefined {
    if (startTime === undefined) return undefined;
    const endTime = this.safeNow();
    if (endTime === undefined) return undefined;
    const elapsed = endTime - startTime;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_SAFE_TELEMETRY_DURATION_MS) {
      return undefined;
    }
    return elapsed;
  }
}
