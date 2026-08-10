import type {
  ReasoningLevel,
  RunnerErrorCode,
} from '../contracts/common.schema.js';

/**
 * What a stage asks a runner to do.
 *
 * Deliberately free of provider vocabulary: no flags, no CLI names, no physical
 * model identifiers beyond an opaque string the adapter passes through. Adding a
 * runner must never require changing this shape.
 */
export interface AgentRunInput {
  readonly prompt: string;
  readonly systemPrompt?: string;

  /**
   * Opaque to the core (AD-13). When absent the adapter omits the flag entirely
   * and the CLI falls back to whatever the user configured for it.
   */
  readonly model?: string;
  readonly reasoning: ReasoningLevel;

  readonly workingDirectory: string;

  /**
   * Containment is the runner's job, not ours (AD-14). `read-only` must map to
   * a real sandbox or permission mode — agent-flow spawns a child process and
   * cannot intercept what that process decides to run.
   */
  readonly permissions: 'read-only' | 'write';

  /**
   * JSON Schema for enforced structured output. Runners reporting
   * `structuredOutputStrategy: 'native'` hand this to their CLI; the rest fall
   * back to prompting and a repair loop.
   */
  readonly outputSchema?: Record<string, unknown>;

  readonly timeoutSeconds: number;

  /** Extra directories the agent may read, beyond the working directory. */
  readonly additionalReadPaths?: readonly string[];
}

/**
 * What actually ran, when it differs from what was asked for.
 *
 * Set by a decorator that redirected the work — today, the fallback runner. The
 * caller resolved a role and knows what it *requested*; only the layer that
 * substituted knows what was *executed*, and a result file recording the former
 * as though it were the latter is a lie an audit trail cannot survive.
 */
export interface RunProvenance {
  readonly runner: string;
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  readonly reasoningClamped: boolean;
  /** The runner this replaced, and why. */
  readonly substitutedFor: { readonly runner: string; readonly errorCode: RunnerErrorCode };
}

export interface AgentRunSuccess {
  readonly ok: true;
  /** Raw text output, always present even when `json` is populated. */
  readonly text: string;
  /** Populated when an output schema was requested and parsing succeeded. */
  readonly json?: unknown;
  readonly durationMs: number;
  /** Absent when the run happened on the runner that was asked. */
  readonly provenance?: RunProvenance;
}

export interface AgentRunFailure {
  readonly ok: false;
  /**
   * Normalised code (§22.1). The core branches on this and never on message
   * text — translating CLI-specific wording is the adapter's responsibility.
   */
  readonly errorCode: RunnerErrorCode;
  /** Original message, kept for diagnosis. Never used for control flow. */
  readonly raw: string;
  readonly durationMs: number;
}

export type AgentRunResult = AgentRunSuccess | AgentRunFailure;

/**
 * What a runner can actually do (§43.1).
 *
 * Missing capabilities are a configuration error caught at load time, never a
 * reason to fall back at runtime (R-05): fallback is reserved for infrastructure
 * failures, and silently rerouting because of a capability gap would hide a
 * mistake in the user's config.
 */
export interface RunnerCapabilities {
  readonly supportedReasoningLevels: readonly ReasoningLevel[];
  readonly supportsReadOnly: boolean;
  readonly supportsNonInteractive: boolean;
  readonly supportsWorkingDirectory: boolean;
  /**
   * `native` means the CLI enforces the schema itself. `prompted` means we ask
   * for JSON and validate afterwards, with a bounded repair loop.
   */
  readonly structuredOutputStrategy: 'native' | 'prompted';
}

export interface RunnerHealth {
  readonly installed: boolean;
  /**
   * Separate from `installed` on purpose: a package can be present while its
   * binary is missing. That is not hypothetical — it is how the Codex CLI is
   * currently broken on the machine this was developed on.
   */
  readonly executable: boolean;
  readonly auth: 'configured' | 'not_configured' | 'available' | 'unknown';
  readonly version?: string;
  readonly detail?: string;
}

export interface AgentRunner {
  readonly id: string;
  capabilities(): RunnerCapabilities;
  healthCheck(): Promise<RunnerHealth>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
