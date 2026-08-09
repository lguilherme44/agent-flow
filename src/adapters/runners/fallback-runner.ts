import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  RunnerCapabilities,
  RunnerHealth,
} from '../../ports/agent-runner.js';
import type { FallbackTrigger, ReasoningLevel, RunnerErrorCode } from '../../contracts/index.js';
import { FALLBACK_TRIGGERS } from '../../contracts/index.js';
import { clampReasoning } from '../../core/reasoning.js';

/** Recorded when a fallback fires, so `result.json` can explain what happened. */
export interface FallbackEvent {
  readonly from: string;
  readonly to: string;
  readonly errorCode: RunnerErrorCode;
  readonly reasoningClamped: boolean;
}

export interface FallbackRunnerOptions {
  readonly primary: AgentRunner;
  readonly secondary: AgentRunner;
  /**
   * Which failures may be routed around. Constrained to infrastructure causes
   * by the type: `FallbackTrigger` cannot express `execution_failed`.
   */
  readonly triggers?: readonly FallbackTrigger[];
  /**
   * Skips the primary entirely when health checks already showed it is down
   * (AD-16). Spending a doomed invocation per task to rediscover that is pure
   * waste when the answer is already known.
   */
  readonly primaryUnhealthy?: boolean;
  readonly onFallback?: (event: FallbackEvent) => void | Promise<void>;
}

/**
 * Routes to a second runner when the first fails for infrastructure reasons.
 *
 * Fallback is infrastructure, never a correction strategy (§55). Quota, auth and
 * availability are things the user cannot fix mid-run and that say nothing about
 * the work itself. A malformed response or a failed validation is the opposite:
 * it is information about quality, and retrying it on another model would
 * replace a visible problem with a quiet one.
 *
 * The constraint is enforced by the type — `triggers` accepts `FallbackTrigger`,
 * which has exactly three members — rather than by a runtime check someone could
 * later relax.
 *
 * Written as a decorator so the core never learns that fallback exists: the
 * stage asks a runner to run and gets a result.
 */
export class FallbackRunner implements AgentRunner {
  readonly id: string;
  private readonly triggers: ReadonlySet<RunnerErrorCode>;

  constructor(private readonly options: FallbackRunnerOptions) {
    this.id = options.primary.id;
    this.triggers = new Set(options.triggers ?? FALLBACK_TRIGGERS);
  }

  /**
   * The primary's capabilities.
   *
   * Roles are resolved against these, and resolution happens before any run. A
   * fallback that cannot honour the requested reasoning level clamps at the
   * moment it is used, which is recorded — rather than quietly narrowing what
   * the whole configuration looks capable of.
   */
  capabilities(): RunnerCapabilities {
    return this.options.primary.capabilities();
  }

  async healthCheck(): Promise<RunnerHealth> {
    return this.options.primary.healthCheck();
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.options.primaryUnhealthy === true) {
      return this.runSecondary(input, 'runner_unavailable');
    }

    const result = await this.options.primary.run(input);
    if (result.ok || !this.triggers.has(result.errorCode)) return result;

    return this.runSecondary(input, result.errorCode);
  }

  private async runSecondary(
    input: AgentRunInput,
    errorCode: RunnerErrorCode,
  ): Promise<AgentRunResult> {
    const { secondary, primary, onFallback } = this.options;

    // The replacement may not reach as high as the role asked for. Clamping
    // beats failing, but it is recorded either way — a run that quietly
    // dropped a level should be able to explain itself afterwards (R-15).
    const supported = secondary.capabilities().supportedReasoningLevels;
    const { reasoning, clamped } = clampReasoning(input.reasoning, supported);

    await onFallback?.({
      from: primary.id,
      to: secondary.id,
      errorCode,
      reasoningClamped: clamped,
    });

    return secondary.run({ ...input, reasoning: reasoning as ReasoningLevel });
  }
}
