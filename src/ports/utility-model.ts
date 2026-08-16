/**
 * Provider-neutral port for an optional utility model (M3-01).
 *
 * A UtilityModel is an auxiliary inference component used for advisory tasks
 * such as context compression, retrieval support, triage, and summarisation.
 * It is NOT a coding agent, NOT an AgentRunner, and NOT part of the primary
 * workflow authority chain.
 *
 * Design decisions:
 *
 * 1. SEPARATE FROM AgentRunInput / AgentRunner — UtilityModel does not carry
 *    write permissions, working-directory semantics, reasoning levels, or the
 *    runner-fallback vocabulary. It receives context supplied by the caller.
 *    The caller remains the authority; the model is a computation.
 *
 * 2. OPTIONALITY — The presence of a UtilityModel is never required for the
 *    Agent Flow workflow to operate. Callers must tolerate its absence or
 *    failure gracefully (bypassOnFailure policy lives in the caller, not here).
 *
 * 3. CONTEXT WINDOW SEMANTICS — M3-00 established that the advertised context
 *    window of a model is an upper capability bound, not a safe operational
 *    input budget. The port exposes `contextWindow` as an informational
 *    capability. The adapter/caller is responsible for applying its own
 *    operational input-token budget before sending a request.
 *
 * 4. PROVIDER NEUTRALITY — This file knows nothing about OpenAI, Qwen, Ollama,
 *    LM Studio, llama.cpp, or any vendor. Provider-specific behaviour (e.g.,
 *    the Qwen3 /no_think prefix) belongs in the concrete adapter (M3-02).
 *
 * 5. NO AUTHORITY BOUNDARY — A UtilityModel cannot edit files, execute shell
 *    commands, run Git operations, approve plans, alter planHash, or make
 *    network requests on the caller's behalf. Its output is advisory data only.
 *
 * 6. RAW EVIDENCE PRINCIPLE — Output produced by a UtilityModel is advisory.
 *    It must never replace raw source evidence for validation, approval,
 *    planHash binding, trusted evidence, final review, deterministic
 *    integration, or crash recovery.
 *
 * 7. TIMEOUT AND BYPASS SEPARATION — run() reports the result of inference.
 *    What the caller does after a failure (bypass, retry, degrade gracefully)
 *    is caller policy and does not belong in this port.
 *
 * 8. STREAMING AND TOOL CALLING — Represented as capabilities for future use.
 *    Neither is implemented or required in MVP3. A model with streaming: false
 *    and tools: false is fully functional.
 */

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * What a UtilityModel can do, as declared by its adapter.
 *
 * All fields describe provider capability, not caller requirements. A caller
 * must not refuse to use a model solely because it lacks an optional capability
 * (e.g., tools: false) unless that caller's workflow genuinely requires it.
 *
 * contextWindow:
 *   The nominal maximum context the model can accept in tokens. This is the
 *   advertised upper bound. M3-00 found that the safe operational input budget
 *   for a given deployment may be substantially lower — e.g., a model that
 *   advertises 64 000 tokens may truncate silently around 47 500. Adapters and
 *   callers must apply their own `targetInputTokens` budget before inference.
 *
 * structuredOutput:
 *   Whether the model can reliably produce structured (JSON) responses when
 *   instructed. MVP3 depends on this for retrieval-support and triage tasks.
 *
 * tools:
 *   Whether the model supports tool/function calling. Not required for MVP3.
 *
 * streaming:
 *   Whether the model supports streaming responses. Not implemented in MVP3.
 */
export interface UtilityModelCapabilities {
  readonly contextWindow: number;
  readonly structuredOutput: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
}

// ─── Health ───────────────────────────────────────────────────────────────────

/**
 * Availability state of a UtilityModel as reported by healthCheck().
 *
 * `available`:
 *   The model endpoint responded to a lightweight probe successfully.
 *
 * `unavailable`:
 *   The endpoint could not be reached, or responded with a non-recoverable
 *   error. M3-00 found offline detection is fast (< 2 s), so healthCheck()
 *   implementations should not require inference for this.
 *
 * `detail` is a human-readable diagnostic string for logging purposes only. It
 * must not carry secrets and must not be used for control-flow decisions.
 */
export interface UtilityModelHealth {
  readonly status: 'available' | 'unavailable';
  readonly detail?: string;
}

// ─── Input ────────────────────────────────────────────────────────────────────

/**
 * What the caller supplies to a UtilityModel invocation.
 *
 * The model receives CONTEXT, not authority. Fields that would grant the model
 * operational power — shell commands, filesystem paths for the model to act on,
 * Git refs, SSH targets, arbitrary URLs to fetch — are deliberately excluded.
 *
 * content:
 *   The primary context text supplied to the model. The caller is responsible
 *   for ensuring content fits within the adapter's configured operational input
 *   budget (targetInputTokens), which may be lower than contextWindow.
 *
 * systemInstruction:
 *   Optional system-level instruction shaping the model's behaviour. Adapters
 *   may augment this (e.g., by prepending a provider-specific directive) before
 *   the request is sent, but must not expose that augmentation in this type.
 *
 * desiredOutputSchema:
 *   A JSON Schema object expressing the structure the caller expects in the
 *   model's response. Presence implies the caller intends to parse the result
 *   as structured data. This is a provider-neutral intent declaration; the
 *   adapter translates it to whatever the provider requires (e.g.,
 *   response_format in the OpenAI wire format — see M3-02).
 *
 * maxOutputTokens:
 *   Soft upper bound on the response length the caller is willing to consume.
 *   The adapter maps this to the appropriate provider parameter. Optional;
 *   adapters apply their own default when absent.
 *
 * correlationId:
 *   Opaque string for tracing and logging. Never interpreted by the model port
 *   or the adapter for control-flow purposes.
 */
export interface UtilityModelInput {
  readonly content: string;
  readonly systemInstruction?: string;
  readonly desiredOutputSchema?: Record<string, unknown>;
  readonly maxOutputTokens?: number;
  readonly correlationId?: string;
}

// ─── Result ───────────────────────────────────────────────────────────────────

/**
 * Usage metadata for a successful inference call.
 *
 * All fields are optional: not every provider exposes token counts, and the
 * port must not mandate precision the adapter cannot guarantee. Do not compare
 * usage fields across providers for billing — consult provider dashboards.
 */
export interface UtilityModelUsage {
  /** Provider-reported input count, when finite, integral, non-negative, and bounded. */
  readonly inputTokens?: number;
  /** Provider-reported output count, when finite, integral, non-negative, and bounded. */
  readonly outputTokens?: number;
  /** Adapter estimate for the request actually assembled on the wire. */
  readonly estimatedInputTokens?: number;
  /** Adapter estimate for the response text actually observed. */
  readonly estimatedOutputTokens?: number;
  /** Locally observed invocation latency. Missing means it could not be measured safely. */
  readonly durationMs?: number;
}

/**
 * Effective execution provenance established by an adapter.
 *
 * This is deliberately separate from `UtilityModel.id`: configured identifiers,
 * endpoints, and requested model names are intent, not proof of what served a
 * request. Adapters may expose only closed, secret-safe provider vocabulary and
 * response-established model identity. Missing fields must remain missing.
 */
export interface UtilityModelProvenance {
  readonly provider: string;
  readonly model?: string;
}

export interface UtilityModelSuccess {
  readonly ok: true;
  /** Raw text output. Always present when ok is true. */
  readonly text: string;
  /**
   * Populated when the caller supplied desiredOutputSchema and the adapter
   * successfully parsed the response into a structured value. The type is
   * unknown because the schema is caller-defined; callers must validate.
   */
  readonly structured?: unknown;
  /** Advisory telemetry — optional and provider-neutral. */
  readonly usage?: UtilityModelUsage;
  /** Safe effective execution identity, never configured intent. */
  readonly provenance?: UtilityModelProvenance;
}

export interface UtilityModelFailure {
  readonly ok: false;
  readonly errorCode: UtilityModelErrorCode;
  /**
   * Human-readable diagnosis. Never used for control-flow; kept for logging
   * and operator review only.
   */
  readonly message: string;
  /** Safe metrics observed before the failure; missing is not zero. */
  readonly usage?: UtilityModelUsage;
  /** Safe effective execution identity established before the failure. */
  readonly provenance?: UtilityModelProvenance;
}

export type UtilityModelResult = UtilityModelSuccess | UtilityModelFailure;

// ─── Error vocabulary ─────────────────────────────────────────────────────────

/**
 * Normalised failure codes for UtilityModel invocations.
 *
 * Adapters translate provider-specific errors into these codes; the caller
 * branches on the code and never on the message string.
 *
 * unavailable:
 *   The endpoint could not be reached or the model is not loaded. This is the
 *   most common failure for optional local deployments. Callers applying
 *   bypassOnFailure should treat this code as the primary trigger.
 *
 * timeout:
 *   The request exceeded the configured time budget. M3-00 measured latency of
 *   ~4 s for 1 k tokens and ~27 s for 30 k tokens with the Qwen3 endpoint.
 *   Adapter timeout configuration (e.g., 120 s) is an adapter concern (M3-02).
 *
 * invalid_response:
 *   The model responded but the response could not be parsed or validated. For
 *   structured-output requests, this includes JSON parse failure after any
 *   repair attempts the adapter performs.
 *
 * context_limit:
 *   The supplied content exceeded the adapter's configured operational input
 *   budget. The adapter is responsible for detecting this before sending, so
 *   the caller can truncate or split. M3-00 showed silent truncation around
 *   47 500 tokens on an endpoint advertising 64 000 — adapters must use a
 *   conservative budget.
 *
 * execution_failed:
 *   A catch-all for failures that do not map to the above. Adapters should
 *   prefer the more specific codes; this exists for genuinely unexpected errors.
 */
export const UTILITY_MODEL_ERROR_CODES = [
  'unavailable',
  'timeout',
  'invalid_response',
  'context_limit',
  'execution_failed',
] as const;

export type UtilityModelErrorCode = (typeof UTILITY_MODEL_ERROR_CODES)[number];

// ─── Port ─────────────────────────────────────────────────────────────────────

/**
 * The UtilityModel port.
 *
 * Implementations are adapters (e.g., the OpenAI-compatible HTTP adapter in
 * M3-02). The FakeUtilityModel in test/fakes/ is the test double.
 *
 * Structural guarantees enforced by architecture tests (test/architecture.test.ts):
 * - This file does not import Git, process-runner, or worktree modules.
 * - This file does not import AgentRunInput or AgentRunner.
 * - src/core/adaptive-workflow.ts does not import this port.
 * - The primary workflow does not require a UtilityModel to be present.
 */
export interface UtilityModel {
  /**
   * A stable, human-readable identifier for this model implementation.
   * Used in logs and diagnostics. Never controls workflow routing.
   */
  readonly id: string;

  /**
   * Returns the static capability profile of this model.
   *
   * Synchronous — capabilities are known at construction time and must not
   * require a network call to retrieve. Callers may cache this value freely.
   */
  capabilities(): UtilityModelCapabilities;

  /**
   * Probes whether the model is currently reachable.
   *
   * Implementations should complete quickly (< 5 s) using a lightweight check,
   * not a full inference call. The result describes availability only and must
   * not include secrets or internal stack traces.
   *
   * A UtilityModel returning unavailable must not block the Agent Flow
   * workflow. The caller applies its own bypass policy.
   */
  healthCheck(): Promise<UtilityModelHealth>;

  /**
   * Submits content to the model and returns the result.
   *
   * The caller is responsible for:
   * - Ensuring input.content fits within the adapter's operational input
   *   budget (which may be lower than capabilities().contextWindow).
   * - Applying timeout policy externally if needed (bypassOnFailure lives in
   *   the caller, not in run()).
   * - Treating the result as advisory data, never as trusted evidence.
   *
   * run() always returns a UtilityModelResult. Model, infrastructure, and
   * runtime DTO-validation failures are wrapped in UtilityModelFailure with an
   * appropriate errorCode and a closed, secret-safe diagnostic. It must not
   * reject because an untrusted input/schema/response accessor or proxy throws.
   */
  run(input: UtilityModelInput): Promise<UtilityModelResult>;
}
