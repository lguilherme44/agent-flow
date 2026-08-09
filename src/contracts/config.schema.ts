import { z } from 'zod';
import {
  FALLBACK_TRIGGERS,
  FallbackTriggerSchema,
  ReasoningLevelSchema,
  WORKFLOW_ROLES,
  type WorkflowRole,
} from './common.schema.js';

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
       * One in MVP 1 (AD-05). The scheduler is already written for N; raising
       * this is what MVP 2 costs, plus worktrees to stop tasks colliding.
       */
      maxTasks: z.number().int().positive().default(1),
    })
    .prefault({}),
  retry: z.object({ maxAttempts: z.number().int().min(1).default(2) }).prefault({}),
  git: z.object({ useWorktrees: z.boolean().default(false) }).prefault({}),
  approval: z.object({ requiredBeforeImplementation: z.boolean().default(true) }).prefault({}),
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
