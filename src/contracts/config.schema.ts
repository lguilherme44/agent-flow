import { z } from 'zod';
import {
  FALLBACK_TRIGGERS,
  FallbackTriggerSchema,
  ReasoningLevelSchema,
  WORKFLOW_ROLES,
  type WorkflowRole,
} from './common.schema.js';
import { UtilityModelConfigSchema } from './utility-model-config.schema.js';

/** Default per-role timeout. A hung CLI must not stall a run forever (R-11). */
export const DEFAULT_TIMEOUT_SECONDS = 900;

export const RunnerConfigSchema = z.object({
  /** Adapter identifier, e.g. `claude-code-cli`. Resolved by the registry. */
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Overrides the executable looked up on PATH. */
  command: z.string().min(1).optional(),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export const RoleConfigSchema = z.object({
  runner: z.string().min(1),
  /**
   * Optional on purpose (AD-13). Pinned model names rot: when omitted the
   * adapter drops the flag and the CLI applies whatever the user already
   * configured for it.
   */
  model: z.string().min(1).optional(),
  effort: ReasoningLevelSchema,
  timeoutSeconds: z.number().int().positive().default(DEFAULT_TIMEOUT_SECONDS),
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

/**
 * Mirrors the YAML shape of §6, where executors are nested. The flat logical
 * role (`executor.normal`) is produced by the resolver in AF-05 — configuration
 * ergonomics and the core's vocabulary are allowed to differ.
 */
export const RolesConfigSchema = z.object({
  architect: RoleConfigSchema,
  sdd: RoleConfigSchema,
  planner: RoleConfigSchema,
  planReviewer: RoleConfigSchema,
  executors: z.object({
    trivial: RoleConfigSchema,
    normal: RoleConfigSchema,
    complex: RoleConfigSchema,
  }),
  verification: RoleConfigSchema,
  finalReviewer: RoleConfigSchema,
});
export type RolesConfig = z.infer<typeof RolesConfigSchema>;

export const FallbackConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Constrained by the schema itself — see FALLBACK_TRIGGERS (§55). */
  on: z.array(FallbackTriggerSchema).default([...FALLBACK_TRIGGERS]),
  /** Per-role replacement config. Roles absent here simply have no fallback. */
  roles: z.record(z.string(), RoleConfigSchema).default({}),
});
export type FallbackConfig = z.infer<typeof FallbackConfigSchema>;

export const GlobalConfigSchema = z.object({
  version: z.literal(1).default(1),
  runners: z.record(z.string(), RunnerConfigSchema),
  roles: RolesConfigSchema,
  fallback: FallbackConfigSchema.prefault({}),
  parallelism: z
    .object({
      /**
       * How many tasks a run *asks* to execute at once. One in MVP 1 (AD-05).
       *
       * Still a positive integer rather than a literal 1, because this records an
       * intention and the intention is part of the MVP 2 contract. What it is not
       * is an instruction: `core/concurrency.ts` resolves it against what the
       * product can isolate, and until tasks have workspaces of their own that
       * resolves to one however this is written. Narrowing the schema instead
       * would make the eventual change a migration of everybody's config file.
       */
      maxTasks: z.number().int().positive().default(1),
    })
    .prefault({}),
  retry: z.object({ maxAttempts: z.number().int().min(1).default(2) }).prefault({}),
  /**
   * Reserved for task isolation (MVP 2), and inert.
   *
   * Kept because it is part of a design that is coming and removing it would
   * churn config files twice. Read by nothing that executes anything: no
   * execution path creates a worktree, so switching it on isolates nothing and
   * — deliberately — raises no limit. An architecture test pins the list of
   * modules allowed to name it.
   */
  git: z.object({ useWorktrees: z.boolean().default(false) }).prefault({}),
  approval: z.object({ requiredBeforeImplementation: z.boolean().default(true) }).prefault({}),
  /**
   * The local dashboard (§65).
   *
   * Global only, and deliberately absent from `OVERRIDABLE_KEYS`: how deep
   * `agent-flow ui ~/wk` looks for projects is a fact about the machine and the
   * directory it was pointed at, and letting one discovered project change it
   * would let a repository decide what else the server publishes.
   *
   * Bounded at six for the same reason the default is two — an unbounded scan of
   * a home directory reads places nobody asked it to and takes minutes to start.
   */
  ui: z
    .object({ workspaceDepth: z.number().int().min(0).max(6).default(2) })
    .prefault({}),
  /**
   * The optional local UtilityModel that *advisory* context comes from (§18).
   *
   * Global only, and deliberately absent from `OVERRIDABLE_KEYS` for the same
   * reason as `ui`: which local endpoint — and which environment variable holds
   * its key — is a fact about the machine, and letting one discovered project
   * change it would let a repository decide what secrets the machine reads.
   *
   * Disabled by default. When disabled, the workflow behaves exactly as before
   * MVP3: no retrieval, no advisory blocks, no utility telemetry.
   *
   * `apiKeyEnv` names the environment variable to read at the composition
   * boundary; the resolved value is never persisted, serialized or logged.
   */
  utilityModel: UtilityModelConfigSchema.prefault({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const ProjectConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    /** Free-form label from stack detection. Never branches core behaviour. */
    type: z.string().min(1),
  }),
  /**
   * Validation commands run by the orchestrator, never by an agent (AD-10).
   * All optional: an unrecognised stack must still yield a usable config.
   */
  commands: z
    .object({
      install: z.string().optional(),
      lint: z.string().optional(),
      typecheck: z.string().optional(),
      test: z.string().optional(),
      build: z.string().optional(),
    })
    .prefault({}),

  /**
   * Extra commands a task may reference by id, beyond the standard steps above.
   *
   * This is the trusted side of the boundary. A plan names an id; the
   * orchestrator looks the command up here. Nothing a model writes is ever
   * executed, because a plan cannot carry a command in the first place — only a
   * reference to one a human put in this file.
   *
   * ```yaml
   * validationCommands:
   *   recurrence: npm test -- recurrence
   *   contract: npm run test:contract
   * ```
   */
  validationCommands: z.record(z.string(), z.string().min(1)).prefault({}),
  paths: z
    .object({
      source: z.array(z.string()).default([]),
      tests: z.array(z.string()).default([]),
    })
    .prefault({}),
  rules: z.object({ architecture: z.array(z.string()).default([]) }).prefault({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Global config merged with the project overlay — what the app actually runs on. */
export const EffectiveConfigSchema = z.object({
  global: GlobalConfigSchema,
  project: ProjectConfigSchema.optional(),
});
export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;

/** Flat logical role → its slot in the nested config shape. */
export function roleConfigOf(roles: RolesConfig, role: WorkflowRole): RoleConfig {
  switch (role) {
    case 'executor.trivial':
      return roles.executors.trivial;
    case 'executor.normal':
      return roles.executors.normal;
    case 'executor.complex':
      return roles.executors.complex;
    default:
      return roles[role];
  }
}

export const ALL_WORKFLOW_ROLES: readonly WorkflowRole[] = WORKFLOW_ROLES;
