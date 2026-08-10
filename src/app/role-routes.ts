import {
  ALL_WORKFLOW_ROLES,
  roleConfigOf,
  type GlobalConfig,
  type ReasoningLevel,
  type WorkflowRole,
} from '../contracts/index.js';
import {
  RoleResolutionError,
  resolveFallback,
  resolveRole,
  type RoleRequirements,
  type RunnerCapabilitiesMap,
} from '../core/role.js';
import type { PromptLoader } from './prompt-loader.js';
import {
  ARCHITECTURE_IMPACT_STAGE,
  DISCOVERY_STAGE,
  PLANNING_STAGE,
  SDD_STAGE,
} from './stages/definitions.js';
import { PLAN_REVIEW_STAGE } from './stages/plan-review.js';
import { FINAL_REVIEW_STAGE, VERIFICATION_STAGE } from './stages/final-review.js';

/**
 * What each logical role would actually run, without running anything.
 *
 * The question the Agents & Models page exists to answer, and the question
 * `doctor` answers only for the environment as a whole: given this configuration,
 * which runner and model does `planner` resolve to, at what effort, and is there
 * anything to fall back to if it fails.
 *
 * Three layers, kept visibly distinct because conflating them is how a routing
 * bug becomes invisible (§3):
 *
 *   **logical role** — `executor.complex`. What the workflow asks for.
 *   **configured route** — runner id, model name, effort, timeout. What a human
 *   wrote in YAML.
 *   **resolved route** — what would run: the same runner, with the effort clamped
 *   to what that runner supports, or a `RoleResolutionError` if the configuration
 *   points somewhere unusable.
 *
 * The requirements a role must satisfy come from the *prompts* it runs, not from
 * a table here — `StageRunner` reads `permissions` and `nativeStructuredOutput`
 * out of the prompt front matter, so anything else would be a second opinion. A
 * role serving several stages is held to the union of their requirements, which is
 * the only honest summary: a route that fails one of them fails the role.
 */

/**
 * Role → the prompts it runs, derived from the stage definitions themselves.
 *
 * Assembled from the exported `StageDefinition`s rather than written out, so a
 * stage that changes its role or its prompt changes this too. The executors are
 * the one entry with no `StageDefinition` — the task executor names
 * `implementation` inline, because a task is not a pipeline stage.
 */
export const PROMPTS_BY_ROLE: Readonly<Record<WorkflowRole, readonly string[]>> = (() => {
  const map = new Map<WorkflowRole, string[]>();

  for (const stage of [
    DISCOVERY_STAGE,
    ARCHITECTURE_IMPACT_STAGE,
    SDD_STAGE,
    PLANNING_STAGE,
    PLAN_REVIEW_STAGE,
    VERIFICATION_STAGE,
    FINAL_REVIEW_STAGE,
  ]) {
    map.set(stage.role, [...(map.get(stage.role) ?? []), stage.prompt]);
  }

  for (const role of ['executor.trivial', 'executor.normal', 'executor.complex'] as const) {
    map.set(role, ['implementation']);
  }

  const byRole = {} as Record<WorkflowRole, readonly string[]>;
  for (const role of ALL_WORKFLOW_ROLES) byRole[role] = map.get(role) ?? [];
  return byRole;
})();

/** Prompt name → the logical roles that run it. The inverse of the map above. */
export const ROLES_BY_PROMPT: Readonly<Record<string, readonly WorkflowRole[]>> = (() => {
  const map = new Map<string, WorkflowRole[]>();

  for (const role of ALL_WORKFLOW_ROLES) {
    for (const prompt of PROMPTS_BY_ROLE[role]) {
      map.set(prompt, [...(map.get(prompt) ?? []), role]);
    }
  }

  return Object.fromEntries(map);
})();

/**
 * Prompt name → the pipeline stages that run it.
 *
 * Empty for `implementation`: it runs once per task rather than as a stage, which
 * is a real difference and not a gap in this table.
 */
export const STAGES_BY_PROMPT: Readonly<Record<string, readonly string[]>> = (() => {
  const map = new Map<string, string[]>();

  for (const stage of [
    DISCOVERY_STAGE,
    ARCHITECTURE_IMPACT_STAGE,
    SDD_STAGE,
    PLANNING_STAGE,
    PLAN_REVIEW_STAGE,
    VERIFICATION_STAGE,
    FINAL_REVIEW_STAGE,
  ]) {
    map.set(stage.prompt, [...(map.get(stage.prompt) ?? []), stage.name]);
  }

  return Object.fromEntries(map);
})();

export interface RoutedAgent {
  readonly runner: string;
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  readonly reasoningClamped: boolean;
  readonly structuredOutput: 'native' | 'prompted';
}

/** Why a role has no fallback. Absent is not the same as broken. */
export type FallbackAbsence = 'disabled' | 'not_configured' | 'unusable';

export interface RoleRoute {
  readonly role: WorkflowRole;
  /** The prompts this role runs, and therefore what it must be able to do. */
  readonly prompts: readonly string[];
  /** Requirements the union of those prompts imposes. */
  readonly requirements: RoleRequirements;
  readonly configured: {
    readonly runner: string;
    readonly model?: string;
    readonly reasoning: ReasoningLevel;
    readonly timeoutSeconds: number;
  };
  /** Absent when the configuration cannot be resolved at all. */
  readonly resolved?: RoutedAgent;
  readonly error?: { readonly kind: string; readonly message: string };
  readonly fallback?: RoutedAgent;
  readonly fallbackAbsent?: FallbackAbsence;
}

export interface DescribeRoutesOptions {
  readonly config: GlobalConfig;
  readonly capabilities: RunnerCapabilitiesMap;
  readonly promptLoader: PromptLoader;
}

export async function describeRoleRoutes(
  options: DescribeRoutesOptions,
): Promise<RoleRoute[]> {
  const routes: RoleRoute[] = [];

  for (const role of ALL_WORKFLOW_ROLES) {
    const prompts = PROMPTS_BY_ROLE[role];
    const requirements = await unionRequirements(options.promptLoader, prompts);
    const roleConfig = roleConfigOf(options.config.roles, role);

    routes.push({
      role,
      prompts,
      requirements,
      configured: {
        runner: roleConfig.runner,
        ...(roleConfig.model === undefined ? {} : { model: roleConfig.model }),
        reasoning: roleConfig.effort,
        timeoutSeconds: roleConfig.timeoutSeconds,
      },
      ...resolvePrimary(role, options, requirements),
      ...describeFallback(role, options, requirements),
    });
  }

  return routes;
}

function resolvePrimary(
  role: WorkflowRole,
  options: DescribeRoutesOptions,
  requirements: RoleRequirements,
): Pick<RoleRoute, 'resolved' | 'error'> {
  try {
    return { resolved: routed(resolveRole(role, options.config, options.capabilities, requirements)) };
  } catch (error) {
    // A role pointing at a runner that is not registered, is disabled, or cannot
    // do what its prompt needs. Reported per role rather than raised: one broken
    // role must not hide the eight that are fine, which is exactly the page a
    // person opens when something is wrong.
    if (error instanceof RoleResolutionError) {
      return { error: { kind: error.kind, message: error.message } };
    }
    throw error;
  }
}

function describeFallback(
  role: WorkflowRole,
  options: DescribeRoutesOptions,
  requirements: RoleRequirements,
): Pick<RoleRoute, 'fallback' | 'fallbackAbsent'> {
  const resolved = resolveFallback(role, options.config, options.capabilities, requirements);
  if (resolved !== undefined) return { fallback: routed(resolved) };

  // `resolveFallback` collapses three different situations into `undefined`, and
  // they are not the same news: fallback switched off everywhere, this role
  // simply having none, and one configured that cannot serve the role. The last
  // is a configuration mistake wearing the costume of a deliberate choice.
  if (!options.config.fallback.enabled) return { fallbackAbsent: 'disabled' };
  if (options.config.fallback.roles[role] === undefined) {
    return { fallbackAbsent: 'not_configured' };
  }
  return { fallbackAbsent: 'unusable' };
}

function routed(resolved: ReturnType<typeof resolveRole>): RoutedAgent {
  return {
    runner: resolved.runner,
    ...(resolved.model === undefined ? {} : { model: resolved.model }),
    reasoning: resolved.reasoning,
    reasoningClamped: resolved.reasoningClamped,
    structuredOutput: resolved.structuredOutputStrategy,
  };
}

/**
 * The strictest requirement across every prompt a role runs.
 *
 * A prompt that cannot be read contributes nothing rather than failing the whole
 * description: a missing prompt file is worth showing on the page beside the role
 * it affects, not worth turning into a blank screen.
 */
async function unionRequirements(
  loader: PromptLoader,
  prompts: readonly string[],
): Promise<RoleRequirements> {
  let readOnly = false;
  let nativeStructuredOutput = false;

  for (const name of prompts) {
    try {
      const prompt = await loader.load(name);
      if (prompt.meta.permissions === 'read-only') readOnly = true;
      if (prompt.meta.nativeStructuredOutput) nativeStructuredOutput = true;
    } catch {
      continue;
    }
  }

  return { readOnly, nativeStructuredOutput };
}
