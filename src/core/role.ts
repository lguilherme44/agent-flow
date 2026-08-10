import {
  GlobalConfigSchema,
  roleConfigOf,
  type GlobalConfig,
  type ReasoningLevel,
  type WorkflowRole,
} from '../contracts/index.js';
import type { RunnerCapabilities } from '../ports/agent-runner.js';
import { clampReasoning } from './reasoning.js';

export { GlobalConfigSchema };
export type { GlobalConfig, WorkflowRole };

/**
 * Capabilities keyed by runner id. Passed in rather than looked up, so this
 * module stays pure: it reasons about what runners can do without knowing that
 * any particular runner exists.
 */
export type RunnerCapabilitiesMap = Readonly<Record<string, RunnerCapabilities>>;

export type RoleResolutionErrorKind =
  | 'unknown_runner'
  | 'runner_disabled'
  | 'missing_capability';

export class RoleResolutionError extends Error {
  /**
   * Always false. Kept explicit because the tempting shortcut — "the runner
   * can't do this, try the fallback" — is exactly what §55 forbids. Fallback
   * covers infrastructure failures; a capability gap is a configuration
   * mistake, and rerouting around it would hide the user's error.
   */
  readonly fallbackEligible = false;

  constructor(
    readonly kind: RoleResolutionErrorKind,
    readonly role: WorkflowRole,
    message: string,
  ) {
    super(message);
    this.name = 'RoleResolutionError';
  }
}

/** What a stage needs from its runner, declared in the prompt front-matter (AD-12). */
export interface RoleRequirements {
  /** Read-only stages (§35): discovery, architecture, SDD, planning, reviews. */
  readonly readOnly?: boolean;
  /** True only when a prompted-and-validated fallback is unacceptable. */
  readonly nativeStructuredOutput?: boolean;
}

export interface ResolvedAgentConfig {
  readonly role: WorkflowRole;
  readonly runner: string;
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  readonly reasoningClamped: boolean;
  readonly timeoutSeconds: number;
  readonly structuredOutputStrategy: 'native' | 'prompted';
}

/**
 * Turns a logical role into the concrete configuration a runner will execute.
 *
 * Everything that can be known statically is checked here, before any process
 * is spawned: unknown runner, disabled runner, missing capability. Discovering
 * a broken configuration halfway through a run would waste the quota already
 * spent on earlier stages.
 */
export function resolveRole(
  role: WorkflowRole,
  config: GlobalConfig,
  capabilities: RunnerCapabilitiesMap,
  requirements: RoleRequirements = {},
): ResolvedAgentConfig {
  const roleConfig = roleConfigOf(config.roles, role);
  const runnerId = roleConfig.runner;

  const runnerConfig = config.runners[runnerId];
  const runnerCapabilities = capabilities[runnerId];

  if (!runnerConfig || !runnerCapabilities) {
    const known = Object.keys(config.runners).join(', ') || '(none)';
    throw new RoleResolutionError(
      'unknown_runner',
      role,
      `Role "${role}" is configured to use runner "${runnerId}", which is not registered.\n` +
        `  Known runners: ${known}`,
    );
  }

  if (!runnerConfig.enabled) {
    throw new RoleResolutionError(
      'runner_disabled',
      role,
      `Role "${role}" uses runner "${runnerId}", which is disabled in configuration.\n` +
        `  Enable it under runners.${runnerId}.enabled, or point the role at another runner.`,
    );
  }

  if (!runnerCapabilities.supportsNonInteractive) {
    throw new RoleResolutionError(
      'missing_capability',
      role,
      `Runner "${runnerId}" cannot run non-interactively, which every role requires.`,
    );
  }

  if (!runnerCapabilities.supportsWorkingDirectory) {
    throw new RoleResolutionError(
      'missing_capability',
      role,
      `Runner "${runnerId}" cannot target a working directory, which every role requires.`,
    );
  }

  if (requirements.readOnly && !runnerCapabilities.supportsReadOnly) {
    throw new RoleResolutionError(
      'missing_capability',
      role,
      `Role "${role}" must run read-only, but runner "${runnerId}" offers no read-only mode.`,
    );
  }

  if (
    requirements.nativeStructuredOutput &&
    runnerCapabilities.structuredOutputStrategy !== 'native'
  ) {
    throw new RoleResolutionError(
      'missing_capability',
      role,
      `Role "${role}" requires runtime-enforced structured output, but runner "${runnerId}" ` +
        `can only be prompted for it.`,
    );
  }

  const { reasoning, clamped } = clampReasoning(
    roleConfig.effort,
    runnerCapabilities.supportedReasoningLevels,
  );

  return {
    role,
    runner: runnerId,
    ...(roleConfig.model === undefined ? {} : { model: roleConfig.model }),
    reasoning,
    reasoningClamped: clamped,
    timeoutSeconds: roleConfig.timeoutSeconds,
    structuredOutputStrategy: runnerCapabilities.structuredOutputStrategy,
  };
}

/**
 * The configuration a role falls back to, when one is declared and usable.
 *
 * Resolved as a role in its own right rather than as "the same request, sent
 * elsewhere". A fallback entry carries its own runner, model, effort and
 * timeout, and reusing the primary's would send a model name to a runner that
 * has never heard of it.
 *
 * Returns undefined when fallback is disabled, unconfigured for this role, or
 * pointing somewhere unusable. That is not an error: it means there is nothing
 * to fall back to, and the primary failure surfaces as it would have anyway.
 */
export function resolveFallback(
  role: WorkflowRole,
  config: GlobalConfig,
  capabilities: RunnerCapabilitiesMap,
  requirements: RoleRequirements = {},
): ResolvedAgentConfig | undefined {
  if (!config.fallback.enabled) return undefined;

  const fallbackConfig = config.fallback.roles[role];
  if (fallbackConfig === undefined) return undefined;

  const runnerConfig = config.runners[fallbackConfig.runner];
  const runnerCapabilities = capabilities[fallbackConfig.runner];
  if (runnerConfig?.enabled !== true || runnerCapabilities === undefined) return undefined;

  // A fallback that cannot satisfy the stage is no fallback. Using it anyway
  // would quietly break the guarantee the requirement expresses — a read-only
  // stage has to stay read-only even when the primary runner is down.
  if (!runnerCapabilities.supportsNonInteractive) return undefined;
  if (!runnerCapabilities.supportsWorkingDirectory) return undefined;
  if (requirements.readOnly === true && !runnerCapabilities.supportsReadOnly) return undefined;
  if (
    requirements.nativeStructuredOutput === true &&
    runnerCapabilities.structuredOutputStrategy !== 'native'
  ) {
    return undefined;
  }

  const { reasoning, clamped } = clampReasoning(
    fallbackConfig.effort,
    runnerCapabilities.supportedReasoningLevels,
  );

  return {
    role,
    runner: fallbackConfig.runner,
    ...(fallbackConfig.model === undefined ? {} : { model: fallbackConfig.model }),
    reasoning,
    reasoningClamped: clamped,
    timeoutSeconds: fallbackConfig.timeoutSeconds,
    structuredOutputStrategy: runnerCapabilities.structuredOutputStrategy,
  };
}
