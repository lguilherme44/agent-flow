import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  RunnerCapabilities,
  RunnerHealth,
} from '../../ports/agent-runner.js';
import type { FallbackTrigger, RunnerErrorCode } from '../../contracts/index.js';
import { FALLBACK_TRIGGERS } from '../../contracts/index.js';
import type { ResolvedAgentConfig } from '../../core/role.js';

/** Recorded when a fallback fires, so `result.json` can explain what happened. */
export interface FallbackEvent {
  readonly from: string;
  readonly to: string;
  readonly errorCode: RunnerErrorCode;
  readonly reasoningClamped: boolean;
  /** The configuration the replacement actually ran with. */
  readonly config: ResolvedAgentConfig;
}

export interface FallbackRunnerOptions {
  readonly primary: AgentRunner;
  readonly secondary: AgentRunner;
  /**
   * The fallback role's own resolved configuration — its model, effort and
   * timeout, not the primary's.
   *
   * This is the difference between a fallback and a retry pointed elsewhere.
   * Reusing the primary's input would send its model name to a runner that has
   * never heard of it: `gpt-5.6-sol` handed to Claude Code fails as an unknown
   * model, and the failure would look like the fallback itself being broken.
   */
  readonly secondaryConfig: ResolvedAgentConfig;
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
   * Roles are resolved against these, before any run. The fallback's own
   * capabilities were already checked when its configuration was resolved, so a
   * fallback that cannot satisfy the stage never reaches this class.
   */
  capabilities(model?: string): RunnerCapabilities {
    // Forwarded, not reinterpreted. The model belongs to the *primary's* resolution —
    // a fallback entry carries its own model and was resolved against its own
    // capabilities before this decorator was built (see `resolveFallback`), so
    // answering with the secondary's would describe a run that has not been decided on.
    return this.options.primary.capabilities(model);
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
    const { secondary, secondaryConfig, primary, onFallback } = this.options;

    await onFallback?.({
      from: primary.id,
      to: secondary.id,
      errorCode,
      reasoningClamped: secondaryConfig.reasoningClamped,
      config: secondaryConfig,
    });

    // The replacement runs on its own terms: its model, its effort, its
    // timeout. Only the work itself — the prompt, the permissions, the working
    // directory — carries over.
    const result = await secondary.run({
      ...input,
      reasoning: secondaryConfig.reasoning,
      timeoutSeconds: secondaryConfig.timeoutSeconds,
      // Deleted rather than left in place: an absent model means "use whatever
      // this CLI is configured for", which is right, while the primary's model
      // name would be wrong.
      ...(secondaryConfig.model === undefined
        ? { model: undefined }
        : { model: secondaryConfig.model }),
    });

    // The caller resolved a role and knows what it asked for; only this layer
    // knows what ran. Attaching it here is what lets the result record the
    // truth rather than the intention.
    //
    // Attached on failure too. A substitution that also failed is still a
    // substitution: without this, a run where both providers were down recorded
    // the primary as the runner and the fallback left no trace at all.
    return {
      ...result,
      provenance: {
        runner: secondary.id,
        ...(secondaryConfig.model === undefined ? {} : { model: secondaryConfig.model }),
        reasoning: secondaryConfig.reasoning,
        reasoningClamped: secondaryConfig.reasoningClamped,
        substitutedFor: { runner: primary.id, errorCode },
      },
    };
  }
}
