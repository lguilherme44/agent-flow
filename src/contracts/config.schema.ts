import { z } from 'zod';
import {
  FALLBACK_TRIGGERS,
  FallbackTriggerSchema,
  ReasoningLevelSchema,
  WORKFLOW_ROLES,
  type WorkflowRole,
} from './common.schema.js';
import { UtilityModelConfigSchema } from './utility-model-config.schema.js';
import { CollaborationConfigSchema } from './collaboration-config.schema.js';
import { TeamsConfigSchema } from './team.schema.js';
import { QualityConfigSchema } from './review.schema.js';
import { ForgeConfigSchema } from './forge.schema.js';

/**
 * Default per-role timeout. A hung CLI must not stall a run forever (R-11).
 *
 * **Calibrated for a frontier CLI, and it is short for anything else.** Measured
 * against a local endpoint: one task died with `errorCode: 'timeout'` at exactly
 * 900 seconds; the same task, after context was freed, finished in 248. Both
 * numbers are ordinary for a model generating at tens of tokens per second, and
 * neither is a sign the model was failing.
 *
 * Raise it per role — `roles.executors.normal.timeoutSeconds` — when a role points
 * at a slower runner. The floor is not raised globally because a frontier CLI that
 * has genuinely hung should be cut loose in fifteen minutes, not forty-five.
 */
export const DEFAULT_TIMEOUT_SECONDS = 900;

export const RunnerConfigSchema = z.object({
  /** Adapter identifier, e.g. `claude-code-cli`. Resolved by the registry. */
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Overrides the executable looked up on PATH. */
  command: z.string().min(1).optional(),
  /**
   * Base URL for a runner that speaks HTTP rather than spawning a CLI.
   *
   * `http://host:port/v1`, or a bare origin. Required by the `openai-compatible` type and
   * meaningless to the others, which is why it is optional here and validated by the
   * factory that needs it — the registry is where a type's requirements belong.
   */
  baseUrl: z.string().min(1).optional(),
  /**
   * **The name of an environment variable, never a key** (§7.1).
   *
   * The same rule the utility model already follows: configuration is committed to a
   * repository, and a secret in a committed file is a secret. A local endpoint whose key
   * is the word `local` is not an exception worth making a second rule for.
   */
  apiKeyEnv: z.string().min(1).optional(),
  /** The model id to request. Optional for the same reason `RoleConfig.model` is (AD-13). */
  model: z.string().min(1).optional(),
  /**
   * Extra arguments appended to the argv the adapter builds.
   *
   * The seam for a CLI that has to be told something this schema does not model —
   * most concretely, pointing a coding CLI at a different inference endpoint, which
   * every such CLI spells differently and none of them spell the same way twice.
   *
   * Without it, that need is met by a wrapper script on each operator's machine:
   * it works, and it is a shell file outside version control that nobody reviews
   * and nobody else can reproduce. This makes it configuration.
   *
   * Appended, never merged: the adapter owns the argv it builds — the subcommand,
   * `-m`, the effort flag, the output path — and these ride after it. A value that
   * fights the adapter is the operator's to resolve, not this schema's.
   */
  args: z.array(z.string()).default([]),
  /**
   * The model's context window in tokens, when the operator knows it.
   *
   * Nothing infers this, and the default is to say nothing rather than to assume a
   * frontier model. It exists because a local endpoint's window is small enough to
   * matter — measured at 49k on one — and the failure without it is expensive and
   * late: the request is refused mid-task, with the work already done and lost.
   *
   * `stage_context_measured` already records what each stage sent. This is the
   * ceiling to compare it against, which is the half that was missing.
   */
  contextWindow: z.number().int().positive().optional(),
});
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

/**
 * What a single stage may override on the role that serves it.
 *
 * A subset of `RoleConfig`, and deliberately not the whole of it: nesting a role
 * inside a role would let an override carry overrides, and there is no question
 * an operator asks that needs two levels.
 */
export const StageOverrideSchema = z.object({
  runner: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: ReasoningLevelSchema.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});
export type StageOverride = z.infer<typeof StageOverrideSchema>;

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
  /**
   * Per-stage overrides, for a role that serves stages with different needs.
   *
   * `architect` serves `discovery`, which reads the repository, and
   * `architecture-impact`, which reads nothing. Runner is chosen per role, so the
   * first forces the second onto a coding CLI — measured on one run, 22 kB of
   * context through a frontier CLI that an inference endpoint would have absorbed
   * at no quota cost.
   *
   * Keyed by stage name. Absent for every role until an operator writes one, and
   * a stage not named here resolves exactly as it did before this field existed.
   */
  stages: z.record(z.string(), StageOverrideSchema).default({}),
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

/**
 * How many times a review may go round before a person is asked (M6, §30).
 *
 * Small numbers on purpose. "Reviewer: issue exists / Developer: disagree", repeated, has
 * to end — and it has to end in a person with something to act on, not in a loop that
 * quietly stops.
 */
export const ReviewPolicySchema = z.object({
  maxRounds: z.number().int().min(1).max(10).default(3),
  maxCorrectionRounds: z.number().int().min(1).max(10).default(2),
  maxDisputeRounds: z.number().int().min(0).max(5).default(1),
  maxFindingsPerReview: z.number().int().min(1).max(200).default(50),
});
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;

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
   * How work is spawned (PRI-17).
   *
   * `passEnv` names variables a coding agent may inherit beyond the built-in list in
   * `core/process-environment.ts`. Empty by default, and the emptiness is the defence: a
   * child used to receive `{ ...process.env }`, which is every credential the operator's
   * shell exports — cloud keys, database URLs, registry tokens — handed to a program with
   * a model inside it reading a repository somebody else wrote.
   *
   * An entry ending in `_` is a prefix; anything else is an exact name, and `MY_VAR` does
   * **not** admit `MY_VAR_SECRET`. Deliberately not a regular expression: this is a list
   * somebody has to be able to audit, and a pattern matching more than intended would be
   * invisible.
   *
   * `agent-flow doctor` prints what was dropped, so a runner that stops authenticating
   * after a CLI upgrade has one obvious thing to check.
   *
   * Global only, and absent from `OVERRIDABLE_KEYS` for the reason `ui` and `utilityModel`
   * are: what a spawned agent may read is a fact about the *machine*, and letting a
   * discovered project widen it would let a repository decide which secrets its own agent
   * receives.
   */
  execution: z
    .object({
      passEnv: z.array(z.string().trim().min(1).max(256)).default([]),
    })
    .prefault({}),
  /**
   * The budgets that bound autonomous recovery (AR §6).
   *
   * Every one is configurable, every one has a default, and exhausting any of them
   * produces `AUTO_RECOVERY_EXHAUSTED` with the AR §3.6 escalation contract — never a
   * loop that keeps going because a different budget still had room.
   *
   * `retry.maxAttempts` above is unchanged and stays where it is: it counts *work*
   * attempts, it is what `retry` already gates on, and moving it would migrate every
   * config file for no gain. What is new is everything beside it.
   *
   * `enabled` is the kill switch AR-03 requires: `false` restores the previous behaviour
   * exactly, because the scheduler's standing rule that it never retried on its own has
   * to remain available as configuration.
   *
   * **Default `true` since AR-03.** AR-00 shipped it `false` with a stated expiry — "a
   * budget that nothing reads must not read as a feature that is on… turning it on is a
   * later milestone's decision" — and AR-03 is that milestone: the scheduler now reads
   * every budget here, and each one is covered by a test that proves it terminates its
   * loop.
   *
   * Leaving it off would have been the more comfortable choice and the less honest one.
   * A recovery engine that is built, tested and switched off is a run that still stops on
   * a failing validation command and asks a person to re-explain the failure by hand,
   * which is the behaviour the whole milestone exists to remove. The bounds are what make
   * this safe rather than the switch: the class outranks the budget, `maxIdenticalFailures`
   * stops a loop that has learned nothing, and every exhaustion names one human action.
   */
  recovery: z
    .object({
      enabled: z.boolean().default(true),
      // Per task (AR §6.1).
      maxEnvironmentRepairs: z.number().int().min(0).default(2),
      /**
       * Consecutive failures with an identical `(class, command, exit)`.
       *
       * The anti-thrash rule: an automatic loop that produces the same failure twice
       * has learned nothing and must stop, whatever the other budgets allow.
       */
      maxIdenticalFailures: z.number().int().min(1).default(2),
      maxModelCallsPerTask: z.number().int().min(1).default(4),
      // Per run (AR §6.2).
      maxCorrectiveRounds: z.number().int().min(0).default(2),
      maxCorrectivePlanRepairs: z.number().int().min(0).default(2),
      maxVerificationCycles: z.number().int().min(1).default(3),
      /**
       * AgentRunner calls made with no intervening human action. The global stop.
       *
       * The evidence run used 21 calls *with* a human in the loop; an autonomous run
       * that exceeds this without one has stopped converging.
       */
      maxAutonomousModelCalls: z.number().int().min(1).default(24),
      // Context growth (AR §6.5). Bytes, because the budget is a byte budget.
      maxPacketBytes: z.number().int().min(1).default(8 * 1024),
      maxRawExcerptBytes: z.number().int().min(1).default(2 * 1024),
      maxDiffStatLines: z.number().int().min(1).default(40),
    })
    .prefault({}),
  /**
   * Task isolation: one Git worktree and one branch per attempt (MVP 2).
   *
   * **Live since M2-04, and this comment used to say the opposite.** It read
   * "reserved… and inert. Read by nothing that executes anything: no execution
   * path creates a worktree" — true when it was written and false from the
   * milestone that built `TaskWorkspaces`, the Integrator and worktree recovery.
   * A comment that describes a flag as dead is worse than no comment: it is the
   * one a reader trusts instead of tracing the callers.
   *
   * What is true is the containment around it. Exactly one module *decides*
   * anything from this value — `app/run-git-identity.ts`, which turns it into the
   * run's `isolationMode` once, at creation. Everything downstream reads the
   * run's mode and never this flag (I-13), so editing it changes the next run and
   * never one in flight. An architecture test pins the list of modules allowed to
   * name it, and a second pins that only the deciding module assigns from it.
   *
   * Off by default because isolation is not free: a worktree per task costs a
   * checkout and a dependency install, and the repository has to satisfy
   * preconditions the sequential path never asks about.
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
    .object({
      workspaceDepth: z.number().int().min(0).max(6).default(2),
      /**
       * Extra host names the dashboard answers to (§93, PRI-05).
       *
       * Empty by default, and that emptiness is the defence. The server refuses any
       * `Host` header that is a *name* it was not told about, because a name an
       * attacker controls can be pointed at `127.0.0.1` — which makes their page
       * same-origin with this server and takes CORS out of the picture entirely.
       * Address literals need no entry here: an address answers no DNS question and
       * therefore cannot be rebound.
       *
       * Add one only when something legitimate sits in front of the server under a
       * name, such as a reverse proxy.
       */
      allowedHosts: z.array(z.string().trim().min(1)).default([]),
    })
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
  /**
   * What agents may say to each other, and how much of it (M4).
   *
   * Global only, and deliberately absent from `OVERRIDABLE_KEYS` for the same reason as
   * `ui` and `utilityModel`: whether agents talk, and how far their autonomy runs before
   * a budget stops it, is a property of the operator's setup. Letting one discovered
   * repository raise its own message budget would let a repository decide how much of
   * itself reaches the next prompt.
   *
   * Disabled by default. When disabled, the workflow behaves exactly as it did before M4:
   * no outbox is read, no collaboration directory is created, and no prompt gains a byte.
   */
  collaboration: CollaborationConfigSchema.prefault({}),
  /**
   * Who forms a team, and who is expected to touch what (M5).
   *
   * **Optional, and absent means legacy.** A configuration with only `roles:` derives the
   * same nine agents M4 derived and assigns exactly what `core/router.ts` would have
   * assigned — asserted task by task rather than promised, because "unchanged" is a claim
   * a comparison can make and a comment cannot.
   *
   * Global only, and deliberately absent from `OVERRIDABLE_KEYS` for the reason `ui`,
   * `utilityModel` and `collaboration` are: which agents exist, what they may take and
   * how much at once is a property of the operator's setup. Letting one discovered
   * repository add a member would let a repository decide who runs code on this machine.
   */
  teams: TeamsConfigSchema.prefault({}),
  /**
   * What a quality gate means, and how a review blocks (M6).
   *
   * **Metadata beside the validation registry, not a second registry** (§36). The command
   * behind `test` is still whatever `commands.test` or `validationCommands.test` says,
   * written by a person; this block says whether that gate is required, what category of
   * evidence it produces, and which changes it applies to.
   *
   * Global only, and absent from `OVERRIDABLE_KEYS` for the reason `collaboration` and
   * `teams` are: a discovered repository must not be able to declare its own gate
   * optional. Whether the build has to pass is the operator's call, not the codebase's.
   *
   * Absent means M5: no per-gate policy, and the run-level Definition of Done unchanged.
   */
  quality: QualityConfigSchema.prefault({}),
  /**
   * The review protocol's own budgets (M6, §9 of its specification).
   *
   * Every loop here terminates, and exhaustion escalates rather than stopping quietly.
   * `enabled` is absent on purpose: whether a task is reviewed follows from whether the
   * team has a member with review skills, which is a fact the configuration already
   * carries. A second switch would be a second way to say the same thing, and the two
   * would eventually disagree.
   */
  review: ReviewPolicySchema.prefault({}),
  /**
   * Remote delivery (M7). Off by default, and every write separately opt-in.
   *
   * Global rather than project-overridable: a repository overlay that could enable a
   * network write, name the token variable or move the API host would let a checked-in
   * file spend the operator credentials.
   */
  forge: ForgeConfigSchema.prefault({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;



/**
 * The recovery budgets, on their own.
 *
 * Extracted so `core/recovery-policy.ts` takes only what it reasons about. Handing it
 * the whole `GlobalConfig` would give a pure policy module access to runners, roles and
 * the utility model — none of which a budget decision may consult.
 */
export type RecoveryConfig = GlobalConfig['recovery'];

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
/**
 * The role config a given stage resolves to, with its override applied.
 *
 * Merged rather than replaced: an override naming only `runner` keeps the role's
 * effort and timeout, which is the common case — the operator is moving one stage
 * to a cheaper runner, not re-describing the role.
 */
export function roleConfigForStage(
  roles: RolesConfig,
  role: WorkflowRole,
  stage: string,
): RoleConfig {
  const base = roleConfigOf(roles, role);
  const override = base.stages[stage];
  if (override === undefined) return base;

  return {
    ...base,
    ...(override.runner === undefined ? {} : { runner: override.runner }),
    ...(override.model === undefined ? {} : { model: override.model }),
    ...(override.effort === undefined ? {} : { effort: override.effort }),
    ...(override.timeoutSeconds === undefined ? {} : { timeoutSeconds: override.timeoutSeconds }),
  };
}

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
