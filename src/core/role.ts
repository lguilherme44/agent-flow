import {
  GlobalConfigSchema,
  roleConfigOf,
  roleConfigForStage,
  type FailureClass,
  type GlobalConfig,
  type ReasoningLevel,
  type WorkflowRole,
} from '../contracts/index.js';
import type {
  RunnerCapabilities,
  RunnerCapabilityEntry,
  RunnerCapabilityResolver,
} from '../ports/agent-runner.js';
import { clampReasoning } from './reasoning.js';

export type { RunnerCapabilityEntry, RunnerCapabilityResolver };

export { GlobalConfigSchema };
export type { GlobalConfig, WorkflowRole };

/**
 * Capabilities keyed by runner id. Passed in rather than looked up, so this
 * module stays pure: it reasons about what runners can do without knowing that
 * any particular runner exists.
 *
 * Since AD-30 an entry may be a **resolver** rather than a plain record, because a
 * runner's capabilities can depend on the model the role configured. The map is
 * still keyed by runner id and the model is still opaque here: this module hands the
 * string through to the resolver and never inspects it.
 *
 * Both forms are accepted on purpose. Every existing caller passes plain records —
 * `registry.capabilities()` builds one, and ~20 test files write one inline — and a
 * runner with no model-specific knowledge has nothing to gain from a function. Use
 * {@link capabilitiesOf} rather than indexing, so no caller has to know which it got.
 */
export type RunnerCapabilitiesMap = Readonly<Record<string, RunnerCapabilityEntry>>;

/**
 * The capabilities of one runner, on one model.
 *
 * The single reader of a {@link RunnerCapabilitiesMap} entry. Everything downstream
 * — resolution, the preflight AR-01 will add, `doctor` — asks through here, so
 * "record or resolver" is answered once instead of at every call site.
 */
export function capabilitiesOf(
  capabilities: RunnerCapabilitiesMap,
  runnerId: string,
  model?: string,
): RunnerCapabilities | undefined {
  const entry = capabilities[runnerId];
  if (entry === undefined) return undefined;
  return typeof entry === 'function' ? entry(model) : entry;
}

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
  /**
   * Which stage is resolving, when the caller knows.
   *
   * Only used to apply `roles.<role>.stages.<stage>` — a role serving stages with
   * different needs can send one of them somewhere else. Absent for a caller that
   * resolves a role in the abstract (`doctor`, the capability report), and a role
   * with no overrides resolves identically either way.
   */
  readonly stage?: string;
  /** Read-only stages (§35): discovery, architecture, SDD, planning, reviews. */
  readonly readOnly?: boolean;
  /** True only when a prompted-and-validated fallback is unacceptable. */
  readonly nativeStructuredOutput?: boolean;
  /**
   * True when the stage's prompt reads or writes the repository.
   *
   * Declared by the prompt rather than assumed of every role. `discovery` explores the
   * project and `implementation` changes it; the other nine shipped prompts receive their
   * whole input as variables and open no file — which is what makes an inference endpoint
   * a legitimate runner for them, and not for these two.
   */
  readonly workingDirectory?: boolean;
}

export interface ResolvedAgentConfig {
  readonly role: WorkflowRole;
  readonly runner: string;
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  readonly reasoningClamped: boolean;
  /**
   * The level the configuration asked for, before the pair's capabilities were applied.
   *
   * Carried rather than recomputed, because C-03 requires the `reasoning_clamped`
   * degradation to record "requested, effective, supported set and reason" — and until
   * now two of those three were discarded at the exact moment they were known. A caller
   * that recomputed them would have to consult the capabilities map a second time, and a
   * second answer to one question is the one that eventually disagrees.
   *
   * Equal to {@link reasoning} whenever nothing was clamped. Present on both paths on
   * purpose: a field that appears only on the unhappy path is a field every reader has to
   * guard.
   */
  readonly requestedReasoning: ReasoningLevel;
  /** What the resolved (runner, model) pair declared. The third fact C-03 asks for. */
  readonly supportedReasoningLevels: readonly ReasoningLevel[];
  readonly timeoutSeconds: number;
  readonly structuredOutputStrategy: 'native' | 'prompted';
}

/** The tool classes AD-32 makes explicit. Never a free-form string. */
export type NonInteractiveToolClass = 'fileEdit' | 'commandExecution';

/**
 * A permission gap, named (AD-32, C-04).
 *
 * Deliberately a *value* rather than an exception. `supportsNonInteractive: true` says the
 * process will not stop at a prompt; it does not say the agent may run the tools the work
 * requires, and one runner in the evidence run was non-interactive and still failed
 * because local policy soft-denied a shell command with nobody present to confirm it.
 *
 * The response to that is a person granting something, and stopping the run would not help
 * them grant it any sooner — so this is reported, never thrown (I-22: discovering it costs
 * no attempt either).
 */
export interface PermissionFinding {
  readonly failureClass: FailureClass;
  readonly runner: string;
  readonly model?: string;
  readonly toolClass: NonInteractiveToolClass;
  /** The one specific action. "Check your permissions" is a contract violation (AR §3.6). */
  readonly action: string;
}

export interface PermissionReadinessInput {
  readonly capabilities: RunnerCapabilities;
  /** What the stage's prompt front-matter declares (AD-12). */
  readonly permissions: 'read-only' | 'write';
  readonly runner: string;
  readonly model?: string;
}

/**
 * Whether the resolved pair may exercise the tools this stage's work requires.
 *
 * Returns `undefined` when it may, or when the stage asks for nothing that needs a grant:
 * a read-only stage observes and writes nothing, and warning about a command grant it will
 * never use would train the reader to ignore the warning that matters.
 *
 * File edits are checked before command execution because a write stage that cannot edit a
 * file cannot do any of its work, whereas one that cannot run a command can often still do
 * most of it. One finding at a time, most disabling first.
 */
export function permissionReadiness(
  input: PermissionReadinessInput,
): PermissionFinding | undefined {
  if (input.permissions !== 'write') return undefined;

  const grants = input.capabilities.nonInteractiveToolGrants;
  const missing: NonInteractiveToolClass | undefined = !grants.fileEdit
    ? 'fileEdit'
    : !grants.commandExecution
      ? 'commandExecution'
      : undefined;

  if (missing === undefined) return undefined;

  return {
    failureClass: 'permission_not_ready',
    runner: input.runner,
    ...(input.model === undefined ? {} : { model: input.model }),
    toolClass: missing,
    action: permissionAction(missing, input.runner),
  };
}

function permissionAction(toolClass: NonInteractiveToolClass, runner: string): string {
  return toolClass === 'fileEdit'
    ? `Grant non-interactive file edits to "${runner}" in its own CLI configuration`
    : `Grant non-interactive command execution to "${runner}" in its own CLI configuration`;
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
  /**
   * The team member answering for this role, when one is (M5).
   *
   * **Who answers a role is not always what `roles:` says.** A team member declares its
   * own runner and model, and the role table declares the default for a run with no
   * team. Resolving the role's runner for a member is answering about somebody else —
   * which passed a member on an inference endpoint through the implementation
   * capability check, because the *role* pointed at a coding agent.
   *
   * An override rather than a second resolver: every check below — registered, enabled,
   * non-interactive, working directory, read-only, structured output, reasoning clamp —
   * has to apply to a member exactly as it applies to a role, and a second copy of that
   * list is a second chance to drop one from it.
   */
  member?: { readonly runner: string; readonly model?: string },
): ResolvedAgentConfig {
  // The stage's override when the caller named one, the role's own config otherwise.
  // Merged, not replaced: an override naming only `runner` keeps the role's effort and
  // timeout, which is the case an operator actually writes.
  const roleConfig =
    requirements.stage === undefined
      ? roleConfigOf(config.roles, role)
      : roleConfigForStage(config.roles, role, requirements.stage);
  const runnerId = member?.runner ?? roleConfig.runner;
  const model = member?.model ?? roleConfig.model;

  const runnerConfig = config.runners[runnerId];
  // Resolved with the model that will actually be used, which is the whole of AD-30: the
  // capabilities that matter are those of the (runner, model) pair, not of the CLI in
  // the abstract.
  const runnerCapabilities = capabilitiesOf(capabilities, runnerId, model);

  if (!runnerConfig) {
    const known = Object.keys(config.runners).join(', ') || '(none)';
    throw new RoleResolutionError(
      'unknown_runner',
      role,
      `Role "${role}" is configured to use runner "${runnerId}", which is not declared.\n` +
        `  Declared runners: ${known}`,
    );
  }

  /**
   * **Checked before the capability map, and the order is the whole fix (PRI-26).**
   *
   * `buildRegistry` skips a disabled runner, so it contributes no capabilities — and the
   * guard above used to read `!runnerConfig || !runnerCapabilities`, which meant a runner
   * that was *declared and turned off* took the `unknown_runner` branch and this one was
   * unreachable. The message that reached the screen was self-contradictory:
   *
   *     Role "architect" is configured to use runner "claude", which is not
   *     registered. Known runners: claude, codex, agy
   *
   * Not registered, and there it is in the list — because "known" was read off the
   * declared runners and "registered" off the enabled ones. Six roles said that at once,
   * and the one thing the operator needed to know, that a toggle was off, was the one
   * thing it did not say.
   */
  if (!runnerConfig.enabled) {
    throw new RoleResolutionError(
      'runner_disabled',
      role,
      `Role "${role}" uses runner "${runnerId}", which is declared but turned off.\n` +
        `  Enable it under runners.${runnerId}.enabled, or point the role at another runner.`,
    );
  }

  if (!runnerCapabilities) {
    const known = Object.keys(config.runners).join(', ') || '(none)';
    throw new RoleResolutionError(
      'unknown_runner',
      role,
      `Role "${role}" is configured to use runner "${runnerId}", which is enabled but ` +
        `has no registered adapter.\n  Declared runners: ${known}`,
    );
  }

  if (!runnerCapabilities.supportsNonInteractive) {
    throw new RoleResolutionError(
      'missing_capability',
      role,
      `Runner "${runnerId}" cannot run non-interactively, which every role requires.`,
    );
  }

  // **Only when the role's prompts actually read the repository.**
  //
  // This used to say "which every role requires", and the prompts disprove it: nine of the
  // eleven shipped ones carry their whole input — `sdd`, `planning`, both reviews,
  // `verification`, `final-review`, `architecture-impact` all receive text and produce text
  // or JSON, and open no file. The two that do are `discovery`, whose prompt says "prefer
  // reading a file over inferring from its name", and `implementation`.
  //
  // The requirement therefore comes from the prompt, exactly as `readOnly` already does,
  // rather than from a blanket claim. That is what lets an inference endpoint — which has
  // no filesystem and says so — serve the nine while being refused for the two.
  if (requirements.workingDirectory === true && !runnerCapabilities.supportsWorkingDirectory) {
    throw new RoleResolutionError(
      'missing_capability',
      role,
      `Role "${role}" reads the repository, but runner "${runnerId}" has no working ` +
        `directory. Point this role at a coding agent, or at a runner that does.`,
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
    ...(model === undefined ? {} : { model }),
    reasoning,
    reasoningClamped: clamped,
    requestedReasoning: roleConfig.effort,
    supportedReasoningLevels: runnerCapabilities.supportedReasoningLevels,
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
  // The fallback's own model, not the primary's: a fallback entry is resolved as a role
  // in its own right, and sending the primary's model name to a runner that has never
  // heard of it is the defect this signature already existed to avoid.
  const runnerCapabilities = capabilitiesOf(
    capabilities,
    fallbackConfig.runner,
    fallbackConfig.model,
  );
  if (runnerConfig?.enabled !== true || runnerCapabilities === undefined) return undefined;

  // A fallback that cannot satisfy the stage is no fallback. Using it anyway
  // would quietly break the guarantee the requirement expresses — a read-only
  // stage has to stay read-only even when the primary runner is down.
  if (!runnerCapabilities.supportsNonInteractive) return undefined;
  if (requirements.workingDirectory === true && !runnerCapabilities.supportsWorkingDirectory) {
    return undefined;
  }
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
    requestedReasoning: fallbackConfig.effort,
    supportedReasoningLevels: runnerCapabilities.supportedReasoningLevels,
    timeoutSeconds: fallbackConfig.timeoutSeconds,
    structuredOutputStrategy: runnerCapabilities.structuredOutputStrategy,
  };
}
