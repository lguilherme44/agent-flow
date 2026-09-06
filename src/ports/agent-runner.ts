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
  /**
   * Ends this invocation before its timeout, and its whole process tree with it (PRI-14).
   *
   * Threaded from the operator's `cancel` all the way down, because a cancel that stopped
   * at the scheduler would stop dispatching and leave the agent running — spending quota,
   * writing files, with nothing left watching it. `agent-flow cancel` promises the
   * processes are terminated, and this is the only path by which that can be true.
   *
   * An adapter that ignores it is not wrong so much as unfinished: it degrades to "the
   * run stops dispatching", which is pause.
   */
  readonly signal?: AbortSignal;
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

/**
 * What one invocation actually spent, as the runner itself reported it (PRI-19).
 *
 * **Every field optional, and the optionality is the contract.** An orchestrator whose
 * whole job is spending model calls could not answer "what did this run cost" or "which
 * model wrote this" — not because the numbers were unavailable, but because the adapters
 * parsed the envelope and threw them away. Claude Code returns `modelUsage`, `usage` and
 * `total_cost_usd` on every response; the only mention of `usage` in four adapters was a
 * regex looking for the words "usage limit".
 *
 * Not every CLI reports the same set, and an adapter that invents a number is worse than
 * one that says nothing (AD-30, applied to accounting). A reader must therefore treat an
 * absent field as *unmeasured* and never as zero — a run whose cost is unknown and a run
 * that cost nothing are different runs.
 *
 * `model` is the field that matters most and the one nothing else can supply. The
 * execution record carries a model only when the configuration pinned one, and AD-13 says
 * not to pin: so on the honest default, every run was unattributable. The runner's own
 * account of which model answered closes that without a table of model names anywhere
 * above the adapter boundary.
 */
export interface AgentRunUsage {
  /** The model that actually answered, as the provider names it. Opaque to the core. */
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * Tokens served from the provider's prompt cache.
   *
   * Worth its own field rather than folded into `inputTokens`: one measured call read
   * 31,810 cached tokens against 2 fresh ones, which is the difference between a run that
   * cost cents and one that cost dollars.
   */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** What the provider says it charged, in USD. Absent where the CLI does not say. */
  readonly costUsd?: number;
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
  /** What this call spent, when the runner reported it (PRI-19). */
  readonly usage?: AgentRunUsage;
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
  /**
   * Absent when the run happened on the runner that was asked.
   *
   * Present on failures as well as successes: a substitution that also failed
   * is still a substitution, and a run where every provider was down should be
   * able to say so rather than blaming the one that was tried first.
   */
  readonly provenance?: RunProvenance;
  /**
   * What this call spent, when the runner reported it (PRI-19).
   *
   * Present on failures as well as successes, for a blunt reason: a call that failed after
   * the model answered was still paid for. Accounting that only counts successes
   * under-reports exactly the runs an operator is trying to understand.
   */
  readonly usage?: AgentRunUsage;
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
  /**
   * Tool classes the runner can exercise without an interactive confirmation (AD-32).
   *
   * **Distinct from `supportsNonInteractive`, and the two were conflated.** That flag
   * says the process will not block on a prompt. It does not say the agent can run the
   * tools the work requires — one runner in the evidence run was non-interactive and
   * still failed: it tried `grep`, local policy demanded a confirmation, nobody could
   * answer, and the run recorded a generic execution failure.
   *
   * Unknown stays `false`, and `false` does not block execution: it produces a
   * `permission_not_ready` warning from `doctor` and a preflight finding, never a
   * silent pass. A grant is *declared*, never inferred from a run that happened to
   * succeed.
   */
  readonly nonInteractiveToolGrants: {
    readonly fileEdit: boolean;
    readonly commandExecution: boolean;
    /** Commands known to be denied in this environment, when discoverable. */
    readonly deniedCommands?: readonly string[];
  };
}

/**
 * How a caller may be *given* a runner's capabilities (AD-30).
 *
 * Two forms, both accepted. A plain record is what a runner with no model-specific
 * knowledge has to say, and it is what every caller wrote before this milestone; a
 * resolver is what a runner whose answer depends on the model provides. Declared in the
 * port rather than in the core because it is a property of the *contract* — the core
 * merely reads it, through one accessor, so no consumer has to know which it received.
 */
export type RunnerCapabilityResolver = (model?: string) => RunnerCapabilities;

export type RunnerCapabilityEntry = RunnerCapabilities | RunnerCapabilityResolver;

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
  /**
   * What this runner can do — optionally, on a specific model (AD-30).
   *
   * The core passes the configured model as an **opaque string** and never
   * interprets it; an adapter with model-specific knowledge answers with it, and one
   * without ignores the argument and returns what it always returned. Behaviour is
   * therefore unchanged for every existing runner, and adding the parameter is
   * source-compatible with every adapter.
   *
   * The old signature was *structurally incapable* of expressing the difference that
   * cost the evidence run a task attempt: one adapter declares
   * `['low','medium','high']`, which is true of its CLI and false of the model that
   * CLI was pointed at. No argument reached `capabilities()`, so the mismatch was
   * undetectable before invocation.
   *
   * **A capability table keyed by model name may never live in the core.** That is
   * provider knowledge, it belongs to the adapter that owns the provider (AD-13), and
   * putting it above the adapter boundary would make one vendor a core concern.
   */
  capabilities(model?: string): RunnerCapabilities;
  healthCheck(): Promise<RunnerHealth>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  /**
   * The models this runner can be pointed at, asked of the provider (AD-13).
   *
   * Optional, and absent is a real answer: not every CLI can enumerate its models, and a
   * table of model names kept in the core would be provider knowledge above the adapter
   * boundary — the exact thing AD-13 forbids — with the added defect that model names
   * rot. `agy models` and an OpenAI-compatible `GET /models` both answer this for real;
   * a runner that cannot is expected to say nothing rather than to guess.
   *
   * Never a closed list for an editor to enforce. What it feeds is a suggestion: a model
   * released this morning must remain typeable this morning.
   */
  listModels?(): Promise<readonly string[]>;
}
