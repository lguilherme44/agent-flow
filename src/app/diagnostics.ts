import type { RunnerRegistry } from '../adapters/runners/registry.js';
import { registryFor } from './executor-commands.js';
import { en, type Phrases } from '../core/phrases/index.js';
import { createGitCommand } from '../adapters/git/git-command.js';
import {
  createGitWorkspaces,
  type GitWorkspaces,
  MINIMUM_SUPPORTED_GIT_VERSION,
  compareGitVersions,
  formatGitVersion,
} from '../adapters/git/git-workspaces.js';
import {
  assessHealth,
  classifyUnavailability,
  referencedRunners,
  withProbeEvidence,
  type HealthVerdict,
  type ObservedRunner,
} from '../core/health.js';
import {
  capabilitiesOf,
  permissionReadiness,
  type PermissionFinding,
  type RunnerCapabilitiesMap,
} from '../core/role.js';
import { compareReasoning } from '../core/reasoning.js';
import {
  commandGrantsFor,
  runnerCommandGrants,
  type CommandGrantExclusionReason,
  type RunnerCommandGrants,
} from '../core/command-grants.js';
import { buildValidationRegistry } from '../core/validation-registry.js';
import { fileNamedEnv, patternNamesEnvFile } from '../core/env-exposure.js';
import { THROWAWAY_WORKSPACE_PREFIXES } from '../core/worktree-policy.js';
import {
  ALL_WORKFLOW_ROLES,
  roleConfigForStage,
  roleConfigOf,
  type EffectiveConfig,
  type GlobalConfig,
  type ReasoningLevel,
  type WorkflowRole,
} from '../contracts/index.js';
import type { IgnoredLoosening } from '../config/resolver.js';
import type { FileSystem } from '../ports/file-system.js';
import type { Host } from '../ports/host.js';
import type { ProcessRunner } from '../ports/process-runner.js';
import { describeRoleRoutes, type RoleRoute } from './role-routes.js';
import { PromptLoader } from './prompt-loader.js';
import { probeRunner, type ProbeResult } from './runner-probe.js';
import { runCommands } from './verification-commands.js';

/**
 * "Can this machine work?", answered as data rather than as a screen (§59, AR-01).
 *
 * `doctor` was the only command whose answer existed nowhere but in the terminal: every
 * check computed a fact and immediately appended a line, so the CLI was both the only
 * caller and the only possible one. That is fine right up until the intended surface is
 * the Deck, where the first question of every day — is anything broken before I start —
 * had no route to ask it through.
 *
 * The split is deliberate and one-directional. **Nothing here renders.** Every function
 * returns the finding; the CLI turns findings into lines, the server turns the same
 * findings into JSON, and a disagreement between the two is now a type error rather than
 * a second implementation that drifts.
 *
 * What did *not* move is the decision of what is worth checking. The checks, their order
 * and the reasoning behind each one are unchanged from the command they came from — this
 * is an extraction, not a redesign, and the comments that explain *why* a check exists
 * travelled with it.
 */

/** A prerequisite of the tool itself, found or not found on PATH. */
export interface ToolCheck {
  readonly name: 'node' | 'git';
  readonly present: boolean;
  readonly version?: string;
  /**
   * The version this tool has to reach, so the answer sits beside the question (§23).
   *
   * Git's is the worktree-mode floor. Node's is the runtime the product itself needs —
   * below it the dashboard cannot start, and it fails naming a dependency rather than the
   * runtime.
   */
  readonly floor?: string;
  /** Information, never a gate — M2-03 owns turning this into a refusal. */
  readonly belowFloor?: boolean;
  /**
   * Node only, and only below the floor: the version `agent-flow ui` runs on instead,
   * because it re-runs itself under a newer Node it finds. Absent when none qualifies —
   * which is the one case `belowFloor` is a real problem.
   */
  readonly dashboardNode?: string;
}

/**
 * What one role's configured (runner, model) pair can actually do (AR-01).
 *
 * Every field here is read from declarations and configuration — no process is spawned and
 * no quota is spent. That is the whole point: the configuration that cost the AF-2026-002
 * dogfood a task attempt was visibly wrong on disk, and nothing looked at it.
 */
export type CapabilityObservation =
  | {
      readonly kind: 'resolved';
      readonly role: WorkflowRole;
      readonly runner: string;
      readonly model?: string;
      /** What the role's `effort` asks for. */
      readonly requestedReasoning: ReasoningLevel;
      /** What the pair would actually be invoked at. */
      readonly effectiveReasoning: ReasoningLevel;
      readonly supportedReasoningLevels: readonly ReasoningLevel[];
      readonly reasoningClamped: boolean;
      /** What this role's prompts declare, read from the prompts rather than assumed. */
      readonly permissions: 'read-only' | 'write';
      /** Present when a write role's runner cannot exercise a tool class it needs (C-04). */
      readonly permissionFinding?: PermissionFinding;
      /**
       * What a write role's runner may run without asking (FR-021), as its adapter reports
       * it. Absent for a read-only role and for a runner that does not report it — "not
       * reported" is not "nothing", and rendering one as the other would be a false finding.
       */
      readonly commandGrants?: RunnerCommandGrants;
    }
  | {
      /**
       * The role cannot be resolved at all: its runner is unknown, disabled, or cannot do
       * something the role's prompts require.
       *
       * A distinct variant rather than an optional field, so the renderer has to handle it.
       * The first version of this section skipped these roles on the assumption that
       * `assessHealth` already reported them — it does not. That function asks whether the
       * *runner* is usable (installed, authenticated); this asks whether the runner can do
       * what the role needs. A perfectly healthy CLI with no read-only mode fails the
       * second question and passes the first, and the result was a role that vanished from
       * the report under an `OK` verdict.
       */
      readonly kind: 'unresolvable';
      readonly role: WorkflowRole;
      readonly runner: string;
      readonly model?: string;
      readonly requestedReasoning: ReasoningLevel;
      /** `RoleResolutionErrorKind` — `unknown_runner`, `runner_disabled`, `missing_capability`. */
      readonly errorKind: string;
      readonly reason: string;
    };

/** A pipeline stage, the role that serves it, and the prompt it renders. */
export interface StageRouting {
  readonly stage: string;
  readonly role: WorkflowRole;
  readonly prompt: string;
}

/**
 * The stage/role/prompt triples, in pipeline order.
 *
 * Written out rather than derived from `app/stages/definitions.ts` on purpose: that module
 * describes stages the *workflow* selects between, including three planning variants only
 * one of which ever runs, and a routing report listing all three would describe a pipeline
 * nobody executes. The test asserts this list against the real definitions, so a drift is
 * a red test rather than a quiet lie in a report.
 */
export const PIPELINE_ROUTING: readonly StageRouting[] = [
  { stage: 'discovery', role: 'architect', prompt: 'discovery' },
  { stage: 'architecture-impact', role: 'architect', prompt: 'architecture-impact' },
  { stage: 'sdd', role: 'sdd', prompt: 'sdd' },
  { stage: 'planning', role: 'planner', prompt: 'planning' },
  { stage: 'plan-review', role: 'planReviewer', prompt: 'plan-review' },
  { stage: 'implementation', role: 'executor.normal', prompt: 'implementation' } as StageRouting,
  { stage: 'code-review', role: 'finalReviewer', prompt: 'code-review' },
  { stage: 'verification', role: 'verification', prompt: 'verification' },
  { stage: 'final-review', role: 'finalReviewer', prompt: 'final-review' },
];

/**
 * One stage, the runner that serves it, and whether that is more than it needs.
 *
 * The judgement is deliberately narrow — `overpowered` marks a stage that reads no file
 * being served by a runner that spawns a process, because it is the only case that is
 * unambiguously a cost with no benefit. Whether a *cheaper model* should serve a stage is
 * a quality decision, and this report has no opinion on it.
 */
export interface StageRoutingRow {
  readonly stage: string;
  readonly role: WorkflowRole;
  readonly runner: string;
  readonly runnerType: string;
  readonly readsRepository: boolean;
  readonly overpowered: boolean;
}

/** A runner that exists in configuration and serves no role. */
export interface UnusedRunnerRow {
  readonly id: string;
  readonly type: string;
}

/**
 * Does the configured install leave a fresh checkout clean? (§8.4)
 *
 * `skipped` is a finding too: it names *why* nothing was measured, so a report with no
 * install section is distinguishable from one where the probe could not run.
 */
export type InstallProbe =
  | {
      readonly outcome: 'skipped';
      /**
       * `not_requested` is the one a caller chooses, and it exists because this probe is
       * the slowest thing `doctor` does by an order of magnitude — a throwaway checkout
       * plus the project's own install. Measured on this repository: minutes. A terminal
       * can block for that and say so first; a page cannot, and the first version of
       * `GET /doctor` proved it by timing out before it painted anything at all.
       */
      readonly reason:
        | 'not_requested'
        | 'no_install_command'
        | 'no_head'
        | 'no_worktree'
        | 'no_status';
    }
  | { readonly outcome: 'dirty_before'; readonly command: string; readonly entries: readonly string[] }
  | { readonly outcome: 'install_failed'; readonly command: string }
  | { readonly outcome: 'clean'; readonly command: string }
  | { readonly outcome: 'dirties_checkout'; readonly command: string; readonly entries: readonly string[] };

/**
 * A role whose runner is unusable and which has no fallback to fall back to.
 *
 * Carries the runner's name rather than only the role's: "planner has nowhere to run" and
 * "planner points at `codex`, which is unusable" are the same fact, and only the second
 * one names the thing to repair.
 */
export interface OrphanRole {
  readonly role: WorkflowRole;
  readonly primary: string;
}

export interface DoctorRemediation {
  readonly problem: string;
  readonly fix: string;
}

/** One runner's shallow health, plus whatever a deep probe added. */
export interface ObservedRunnerReport extends ObservedRunner {
  readonly version?: string;
  /** Present when the runner is installed but will not run — a repair, not an install. */
  readonly detail?: string;
}

export interface Diagnosis {
  /**
   * The verdict, already widened for the fault `assessHealth` cannot see.
   *
   * A role that cannot resolve fails the check outright, whatever the runners' health
   * says: the stage it serves dies on contact, every time. `assessHealth` asks whether
   * each *runner* is usable and never sees this, so the widening happens here — once —
   * rather than in each caller.
   */
  readonly status: HealthVerdict['status'];
  readonly tools: readonly ToolCheck[];
  readonly install: InstallProbe;
  readonly capabilities: readonly CapabilityObservation[];
  readonly stageRouting: readonly StageRoutingRow[];
  readonly unusedRunners: readonly UnusedRunnerRow[];
  readonly runners: readonly ObservedRunnerReport[];
  /** Empty unless `deep` was asked for: a live probe spends quota on every runner. */
  readonly probes: readonly ProbeResult[];
  readonly orphanRoles: readonly OrphanRole[];
  readonly degradations: HealthVerdict['degradations'];
  readonly notes: readonly string[];
  readonly unresolvableRoles: readonly WorkflowRole[];
  readonly remediations: readonly DoctorRemediation[];
  /**
   * Whether this diagnosis could read the process environment.
   *
   * `false` from the server, which may not (§93), and the difference is not cosmetic: a
   * runner authenticated by `apiKeyEnv` answers `401` to a health check made without its
   * key and is reported `not configured`. Surfacing the flag lets that reader say "not
   * checked from here" instead of repeating a false negative as a finding.
   */
  readonly readsEnvironment: boolean;
  /**
   * Remote access status (FR-023).
   *
   * Known when diagnosed from the running server process; unknown from the standalone
   * CLI command (`agent-flow doctor`), which cannot inspect in-memory pairing state.
   */
  readonly remoteAccess: DiagnosisRemoteAccess;
}

/**
 * Remote access status as reported by `diagnose` (FR-023).
 *
 * Known by the running server process; unknown from a standalone CLI command.
 */
export type DiagnosisRemoteAccess =
  | { readonly known: false }
  | {
      readonly known: true;
      readonly enabled: boolean;
      readonly admittedAddresses: readonly string[];
      readonly liveSessions: number;
    };

export interface DiagnoseOptions {
  readonly fs: FileSystem;
  readonly processRunner: ProcessRunner;
  readonly host: Host;
  readonly config: EffectiveConfig;
  /**
   * What the resolver refused from an untrusted project, from `loadConfigWithReport`.
   *
   * Passed in rather than recomputed: `config` is already the screened result and no longer
   * says what was dropped, and re-reading the files here would be a second resolver.
   */
  readonly ignoredLoosenings?: readonly IgnoredLoosening[];
  readonly projectDir: string;
  readonly promptsDir: string;
  /** Reads an environment variable, for a runner configured with `apiKeyEnv`. */
  readonly env?: (name: string) => string | undefined;
  /** Runs a real prompt against each runner. Opt-in: it consumes quota. */
  readonly deep?: boolean;
  /**
   * The Node the dashboard would run on, asked only when the PATH one is below the floor.
   * The CLI answers with what `agent-flow ui` would pick; the server with its own runtime.
   */
  readonly dashboardNode?: () => string | undefined;
  /**
   * Runs the §8.4 install probe. Opt-out, because a terminal should keep doing it.
   *
   * The two opt-ins here cost different things and are therefore separate. `deep` spends
   * **quota**; this spends **time** — a fresh checkout and the project's own install, which
   * on a large repository is minutes. `agent-flow doctor` blocks for it and announces it
   * first; `GET /doctor` asks for it only when somebody does, because a page that waits
   * minutes for its first paint is not a page.
   */
  readonly installProbe?: boolean;
  /**
   * Called once, before the slowest check runs.
   *
   * The install probe is slower than everything else here by an order of magnitude — a
   * throwaway checkout plus the project's own install command — and measured on a Vue
   * project it spent minutes with zero bytes of output and was taken for a hang and
   * killed. The caller decides how to say so; this only says *when*.
   */
  readonly onInstallProbe?: (command: string) => void;
  /** The reader's language for the remediations. English when a caller does not ask. */
  readonly say?: Phrases;
  /**
   * What the *running server* knows about remote access (FR-023).
   *
   * Optional, and absent from `src/cli/doctor.ts` on purpose. The pairing store lives
   * in the `agent-flow ui` process and nowhere else, so a terminal cannot read it —
   * and a terminal that reported `off` would be reporting a fact about itself as a
   * fact about the server. The same shape as `readsEnvironment`: a reader that cannot
   * see something says so rather than guessing.
   */
  readonly remoteAccess?: {
    readonly enabled: boolean;
    readonly admittedAddresses: readonly string[];
    readonly liveSessions: number;
  };
}

/**
 * Everything `doctor` knows, computed once.
 *
 * The order is the order the checks were written in, and it matters in one place: the
 * install probe is announced and run before the registry is built, so the slow thing
 * starts as early as it can rather than after a series of fast ones.
 */
export async function diagnose(options: DiagnoseOptions): Promise<Diagnosis> {
  const { fs, processRunner, host, config, projectDir, promptsDir } = options;

  const pathNode = await checkTool(processRunner, projectDir, 'node', ['--version']);
  const dashboardNode = pathNode.belowFloor === true ? options.dashboardNode?.() : undefined;
  const node: ToolCheck = dashboardNode === undefined ? pathNode : { ...pathNode, dashboardNode };
  // Through the wrapper, not through `checkTool`. `git --version` runs no hooks and could
  // not have hurt anything, but "only one module spawns git" (§26.1 rule 1) is worth
  // exactly as much as its least-defended exception, and a probe is the easiest place for
  // the next one to appear.
  const git = await checkGit(processRunner, fs, host.homeDir, projectDir);

  const wantsInstallProbe = options.installProbe !== false;
  const installCommand = config.project?.commands?.install;
  if (wantsInstallProbe && installCommand !== undefined && installCommand.trim().length > 0) {
    options.onInstallProbe?.(installCommand);
  }
  const install: InstallProbe = wantsInstallProbe
    ? await probeInstallCleanliness({ fs, processRunner, config, projectDir, host })
    : { outcome: 'skipped', reason: 'not_requested' };

  const registry = registryFor(config, {
    processRunner,
    fs,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const health = await registry.health();

  const shallow: ObservedRunnerReport[] = referencedRunners(config.global).map((id) => {
    const reported = health[id];
    return reported === undefined
      ? {
          id,
          installed: false,
          executable: false,
          auth: 'not_configured' as const,
          // The registry never built this one, so nothing above was measured. Saying
          // *which* configuration state caused that is the whole point: without it the
          // report reads "not installed", and the remediation sends the reader to
          // reinstall a CLI that was there all along.
          unavailable: classifyUnavailability(config.global, id),
        }
      : {
          id,
          installed: reported.installed,
          executable: reported.executable,
          auth: reported.auth,
          ...(reported.version === undefined ? {} : { version: reported.version }),
          ...(reported.detail === undefined ? {} : { detail: reported.detail }),
        };
  });

  // Mechanical capability discovery (AR-01). Free: it reads what the adapters declare for
  // each role's configured (runner, model) pair and compares it with what the role asks
  // for. This is the check whose absence let a `medium` effort reach a model that offers
  // only `low` and `high`, at the cost of a task attempt.
  const routes = await describeRoleRoutes({
    config: config.global,
    capabilities: registry.capabilities(),
    promptLoader: new PromptLoader({ fs, promptsDir }),
  });
  const capabilities = observeCapabilities(routes, registry.capabilities());

  // The capability report is by role, which is how configuration is written. These two are
  // by stage and by runner, which is how routing actually lands — the three views disagree
  // on purpose, and each disagreement is a finding.
  const stageRouting = await describeStageRouting({ config: config.global, promptsDir, fs });
  const unusedRunners = describeUnusedRunners(config.global);

  // Live probe, only when asked for. It spends quota on every runner, which is the entire
  // reason the shallow check exists as the default.
  const probes =
    options.deep === true
      ? await probeAll(registry, shallow, projectDir, effortsByRunner(config.global))
      : [];
  // Re-joined by id rather than by position. `withProbeEvidence` returns `ObservedRunner`,
  // which has no `version` and no `detail`, so the two fields the shallow check read from
  // the adapter would be erased by a probe that changed nothing about them.
  const reported = new Map(shallow.map((runner) => [runner.id, runner]));
  const runners: ObservedRunnerReport[] = withProbeEvidence(shallow, probes).map((runner) => {
    const before = reported.get(runner.id);
    return {
      ...runner,
      ...(before?.version === undefined ? {} : { version: before.version }),
      ...(before?.detail === undefined ? {} : { detail: before.detail }),
    };
  });

  const say = options.say ?? en;
  const baseVerdict = assessHealth(config.global, runners, say);

  // The failure a run otherwise meets at its first task, after the expensive half is paid
  // for: a coding CLI spawned with `--permission-mode acceptEdits` auto-approves edits and
  // ONLY edits, and `--setting-sources ''` shuts out the operator's own
  // `permissions.allow`. In a non-interactive session nobody can approve, so every shell
  // command is refused — measured on a task whose whole job was to run `flutter analyze`
  // and `flutter test` to capture a baseline, which reported *"Blocking reason is a
  // permission grant, not a missing decision"* and stopped the run.
  //
  // Said here rather than in `assessHealth` for two reasons. It needs the PROJECT config —
  // firing only when the repository actually declares commands an executor would have to
  // run, so a project with none is never nagged. And it is a note rather than a
  // degradation: with no grant configured anywhere it would otherwise be true of every
  // default installation, and a DEGRADED that is always on is worth nothing (C-4).
  //
  // "Declares commands" is read over the validation registry (FR-022), not `commands` alone:
  // a project whose only gates are `validationCommands` entries asks the executor for exactly
  // the same thing, and reading `commands` alone left it with no note at all.
  const declaresCommands =
    config.project !== undefined && buildValidationRegistry(config.project).ids.length > 0;
  const grantless = new Set<string>();
  if (declaresCommands) {
    for (const role of ['executor.trivial', 'executor.normal', 'executor.complex'] as const) {
      const roleConfig = roleConfigOf(config.global.roles, role);
      if (!roleConfig.enabled) continue;

      const runnerConfig = config.global.runners[roleConfig.runner];
      if (runnerConfig?.type !== 'claude-code-cli') continue;
      // The adapter's answer, the one the executor's preflight reads. Checking the args here
      // for `--allowedTools` gave a second answer: a Windows grant naming only `Bash(...)`
      // silenced this note while the preflight warned, and `--allowed-tools` the reverse.
      const grants = capabilitiesOf(registry.capabilities(), roleConfig.runner, roleConfig.model)?.nonInteractiveToolGrants;
      if (grants?.commandExecution === true) continue;
      if (runnerConfig.dangerouslySkipPermissions) continue;

      grantless.add(roleConfig.runner);
    }
  }

  // One note per loosening an untrusted project set and did not get (FR-026). A note, not a
  // degradation: the machine works exactly as the operator configured it — what is lost is
  // the repository's opinion, and naming `trust.projectConfig` is the whole remediation.
  // Without it, a project whose `--allowedTools` grants stopped applying would find out from
  // an agent that returned BLOCKED on a denied command, with nothing pointing back here.
  const ignoredLoosenings = (options.ignoredLoosenings ?? []).map((loosening) =>
    say.doctor.projectLooseningIgnored(loosening.path.join('.')),
  );

  // Why the executor was granted none of the declared commands, when the reason is trust
  // (FR-003). Without it the grantless note above would send the operator to hand-write
  // `--allowedTools` rules for commands the project already declares — the real switch is
  // `trust.projectConfig`, and `registryFor` read the same flag to decide.
  const untrustedCommands =
    declaresCommands && config.projectTrusted !== true ? [say.doctor.projectCommandsNotGranted] : [];

  // One note per declared line that gets no grant (FR-004), from the same computation
  // `registryFor` used, so the note names exactly what the executor was not given. Said
  // whatever the trust: a line with shell syntax stays ungranted once the project is trusted,
  // and finding that out after trusting it would be a second round trip.
  const excludedCommands = commandGrantsFor(config.project, config.projectTrusted === true).excluded.map(
    (exclusion) =>
      say.doctor.declaredCommandNotGranted(exclusion.id, exclusion.line, exclusionReason(exclusion.reason, say)),
  );

  const envExposure = await describeEnvExposure({
    fs,
    processRunner,
    homeDir: host.homeDir,
    projectDir,
    patterns: config.global.worktree?.copy ?? [],
    say,
  });

  const verdict = {
    ...baseVerdict,
    notes: [
      ...baseVerdict.notes,
      ...[...grantless]
        .sort()
        .map(
          (runner) =>
            `${say.doctor.runnerGrantsNoTools(runner)} — ${say.doctor.implementationCannotRunCommands(runner)}`,
        ),
      ...untrustedCommands,
      ...excludedCommands,
      ...ignoredLoosenings,
      ...envExposure,
    ],
  };
  const unresolvableRoles = rolesThatCannotRun(capabilities);

  return {
    status: unresolvableRoles.length > 0 ? 'FAIL' : verdict.status,
    tools: [node, git],
    install,
    capabilities,
    stageRouting,
    unusedRunners,
    runners,
    probes,
    orphanRoles: verdict.orphanRoles.map((role) => ({
      role,
      primary: verdict.routes.find((candidate) => candidate.role === role)?.primary ?? '?',
    })),
    degradations: verdict.degradations,
    notes: verdict.notes,
    unresolvableRoles,
    remediations: generateRemediations(runners, node, git, options.say ?? en),
    readsEnvironment: options.env !== undefined,
    remoteAccess: options.remoteAccess !== undefined
      ? {
          known: true,
          enabled: options.remoteAccess.enabled,
          admittedAddresses: options.remoteAccess.admittedAddresses,
          liveSessions: options.remoteAccess.liveSessions,
        }
      : { known: false },
  };
}

/** The sentence for why a declared line gets no grant, in the reader's book (FR-004). */
function exclusionReason(reason: CommandGrantExclusionReason, say: Phrases): string {
  switch (reason) {
    case 'install':
      return say.doctor.grantExcludedInstall;
    case 'empty':
      return say.doctor.grantExcludedEmpty;
    case 'line_break':
      return say.doctor.grantExcludedLineBreak;
    case 'wildcard':
      return say.doctor.grantExcludedWildcard;
    case 'shell_syntax':
      return say.doctor.grantExcludedShellSyntax;
  }
}

/**
 * Reads what each role's pair declares, mechanically (AR-01).
 *
 * Every configured role produces exactly one observation, including the ones that cannot
 * run. Silence about a role is the one answer this section may never give.
 */
export function observeCapabilities(
  routes: readonly RoleRoute[],
  capabilities: RunnerCapabilitiesMap,
): CapabilityObservation[] {
  const observations: CapabilityObservation[] = [];

  for (const route of routes) {
    const resolved = route.resolved;

    if (resolved === undefined) {
      observations.push({
        kind: 'unresolvable',
        role: route.role,
        runner: route.configured.runner,
        ...(route.configured.model === undefined ? {} : { model: route.configured.model }),
        requestedReasoning: route.configured.reasoning,
        errorKind: route.error?.kind ?? 'unknown',
        reason: route.error?.message ?? 'the configured runner could not be resolved',
      });
      continue;
    }

    const declared = capabilitiesOf(capabilities, resolved.runner, resolved.model);
    if (declared === undefined) continue;

    // Read from the prompts, exactly as `StageRunner` reads them. A table here would be a
    // second opinion, and the two would eventually disagree.
    const permissions = route.requirements.readOnly === true ? 'read-only' : 'write';

    observations.push({
      kind: 'resolved',
      role: route.role,
      runner: resolved.runner,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      requestedReasoning: route.configured.reasoning,
      effectiveReasoning: resolved.reasoning,
      supportedReasoningLevels: declared.supportedReasoningLevels,
      reasoningClamped: resolved.reasoningClamped,
      permissions,
      ...(() => {
        const finding = permissionReadiness({
          capabilities: declared,
          permissions,
          runner: resolved.runner,
          ...(resolved.model === undefined ? {} : { model: resolved.model }),
        });
        return finding === undefined ? {} : { permissionFinding: finding };
      })(),
      ...(() => {
        // Write roles only: a read-only invocation never carries a derived grant (SEC-004),
        // so reporting one under a reviewer would describe a permission it never has.
        const grants = permissions === 'write' ? runnerCommandGrants(declared.nonInteractiveToolGrants) : undefined;
        return grants === undefined ? {} : { commandGrants: grants };
      })(),
    });
  }

  return observations;
}

/**
 * The roles that cannot run, by name.
 *
 * Separate from the rendering so a caller can turn them into a verdict. A role that cannot
 * resolve is not a degradation to work around — the stage it serves dies every time it is
 * reached — so it fails the check outright.
 */
export function rolesThatCannotRun(
  observations: readonly CapabilityObservation[],
): WorkflowRole[] {
  return observations
    .filter((observation) => observation.kind === 'unresolvable')
    .map((observation) => observation.role);
}

/**
 * One row per stage: what serves it, and whether that is more than it needs.
 *
 * The finding is a cost with a price, not a free saving. A stage whose prompt does not
 * require the repository still gets a read-only checkout on a coding CLI, and uses it:
 * measured 23/09/2026 on a Node monorepo, `architecture-impact` — then declared as
 * reading nothing — was the stage that found the facts that changed the plan, by reading
 * code. It and `sdd` now declare `workingDirectory: true`, because both confirm the
 * request against the repository. What is left flagged works from the earlier documents,
 * and the sentence says what moving it to an endpoint gives up.
 */
export async function describeStageRouting(options: {
  readonly config: GlobalConfig;
  readonly promptsDir: string;
  readonly fs: FileSystem;
}): Promise<StageRoutingRow[]> {
  const rows: StageRoutingRow[] = [];

  for (const entry of PIPELINE_ROUTING) {
    // Resolved through the stage override, or the report describes a routing the run will
    // not take — which is what it did on the first pass here.
    const role = roleConfigForStage(options.config.roles, entry.role, entry.stage);
    if (role === undefined) continue;

    const runnerType = options.config.runners[role.runner]?.type ?? '(unknown)';
    const readsRepository = await needsWorkingDirectory(options.fs, options.promptsDir, entry.prompt);

    rows.push({
      stage: entry.stage,
      role: entry.role,
      runner: role.runner,
      runnerType,
      readsRepository,
      overpowered: !readsRepository && runnerType !== 'openai-compatible',
    });
  }

  return rows;
}

/**
 * Runners that exist in configuration and serve no role.
 *
 * Information, never a failure: an operator may keep a runner configured for a profile
 * they switch to. What it is not is invisible, which is what it was — "I configured it and
 * it is not listed" reads as a broken configuration rather than as one nobody uses.
 */
export function describeUnusedRunners(config: GlobalConfig): UnusedRunnerRow[] {
  const routed = new Set<string>();
  for (const entry of PIPELINE_ROUTING) {
    // Through the override too: a runner used only by one stage is routed.
    const role = roleConfigForStage(config.roles, entry.role, entry.stage);
    if (role !== undefined) routed.add(role.runner);
  }
  for (const fallbackRole of Object.values(config.fallback.roles)) {
    routed.add(fallbackRole.runner);
  }

  return Object.keys(config.runners)
    .filter((id) => !routed.has(id))
    .sort()
    .map((id) => ({ id, type: config.runners[id]?.type ?? '' }));
}

/** Whether a prompt declares that it reads the repository. */
async function needsWorkingDirectory(
  fs: FileSystem,
  promptsDir: string,
  prompt: string,
): Promise<boolean> {
  try {
    return /^\s*workingDirectory:\s*true\s*$/m.test(await fs.readFile(`${promptsDir}/${prompt}.md`));
  } catch {
    // A prompt that cannot be read is not a routing finding. `doctor` has other sections
    // for a broken installation, and inventing a requirement here would put a warning on a
    // stage nobody can even run.
    return false;
  }
}

/**
 * Does the configured install leave a fresh checkout clean? (§8.4)
 *
 * Diagnostic only: it reports and **never edits configuration**. A finding here is the
 * difference between "worktree mode refused every task and I do not know why" and one line
 * naming the file the install rewrote.
 *
 * Runs in a throwaway worktree under Agent Flow's own root — never in the user's working
 * tree — and removes it afterwards. That removal is the *only* one in this milestone: a
 * **failed attempt's** worktree is retained for diagnosis (§7.4), and this one holds
 * nothing anybody needs.
 *
 * `skipped` for a project with no install command, for one that is not a repository, or
 * for a Git that cannot answer — `doctor` has other checks for all three, and a second
 * voice saying the same thing is noise.
 */
export async function probeInstallCleanliness(options: {
  fs: FileSystem;
  processRunner: ProcessRunner;
  config: EffectiveConfig;
  projectDir: string;
  host: Host;
  /**
   * The Git adapter, when a caller has one. Built here otherwise.
   *
   * A seam rather than a convenience. The measured leak was a `worktree remove` that
   * *failed* — six directories from six `doctor` calls, each holding a full
   * `node_modules` — and the branch that now falls back to the filesystem is unreachable
   * from a fixture: the three residue scenarios below all remove cleanly, which is why
   * they were green while the leak was happening in the wild. A test has to be able to
   * make the removal fail.
   */
  workspaces?: GitWorkspaces;
}): Promise<InstallProbe> {
  const install = options.config.project?.commands?.install;
  if (install === undefined || install.trim().length === 0) {
    return { outcome: 'skipped', reason: 'no_install_command' };
  }

  const homeDir = options.host.homeDir;
  const git = await createGitCommand({
    processRunner: options.processRunner,
    fs: options.fs,
    homeDir,
  });
  const workspaces = options.workspaces ?? (await createGitWorkspaces({ git, fs: options.fs, homeDir }));

  const head = await workspaces.resolveHead(options.projectDir);
  if (!head.ok || head.value === null) return { outcome: 'skipped', reason: 'no_head' };

  // A single segment under the owned root, named so it cannot collide with a run's
  // workspace. Flat on purpose: `git worktree remove` deletes the worktree directory and
  // not its parent, so a nested layout would leave an empty directory behind on every
  // `doctor`.
  // Through the `Host` port rather than `process.pid`, for the reason the port's own
  // doc-comment gives: a use case that reads the process table directly is a use case a
  // test cannot pin down.
  const probeDirectory = `${THROWAWAY_WORKSPACE_PREFIXES[0]}pid-${String(options.host.pid)}`;
  const location = { segments: [probeDirectory], relativePath: probeDirectory };

  const added = await workspaces.addWorktree({
    cwd: options.projectDir,
    location,
    base: head.value,
    reason: 'agent-flow doctor install probe',
  });
  if (!added.ok) return { outcome: 'skipped', reason: 'no_worktree' };

  try {
    const before = await workspaces.status({ cwd: added.value });
    if (!before.ok) return { outcome: 'skipped', reason: 'no_status' };
    if (!before.value.clean) {
      return {
        outcome: 'dirty_before',
        command: install,
        entries: before.value.entries.slice(0, 5).map((entry) => entry.path),
      };
    }

    // The budget the real preparation gets (`execution.commandTimeoutSeconds`). A shorter
    // one here would report `install_failed` for an install that `run` completes. `?.`
    // because a configuration built by hand may predate the key; absent is the default.
    const timeoutSeconds = options.config.global.execution?.commandTimeoutSeconds;
    const ran = await runCommands({
      processRunner: options.processRunner,
      commands: [install],
      cwd: added.value,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    });
    if (!ran.passed) return { outcome: 'install_failed', command: install };

    const after = await workspaces.status({ cwd: added.value });
    if (!after.ok) return { outcome: 'skipped', reason: 'no_status' };
    if (after.value.clean) return { outcome: 'clean', command: install };

    return {
      outcome: 'dirties_checkout',
      command: install,
      entries: after.value.entries.slice(0, 5).map((entry) => entry.path),
    };
  } finally {
    // The probe's own worktree, and only it. Unlocked first because it was created locked,
    // and removed through Git rather than with `rm -rf` (§20.2).
    //
    // Forced, and this is the one place in the milestone where that is right. The probe's
    // whole job is to find out whether the install dirties a fresh checkout, so on the path
    // that matters it has *just made one dirty* — and Git refuses to reclaim a worktree
    // holding a modified tracked file or an untracked non-ignored one. Without `force` a
    // `doctor` run would leak a worktree every time it had something to warn about. Nothing
    // here is evidence: the report already names the changed paths, and a *failed attempt's*
    // worktree is retained precisely because it is evidence (§7.4).
    await workspaces.unlockWorktree({ cwd: options.projectDir, location });
    const reclaimed = await workspaces.removeWorktree({
      cwd: options.projectDir,
      location,
      force: true,
    });

    // **Git's answer is read, and that is the whole fix.**
    //
    // Measured: six `doctor-install-probe-pid-*` directories in the owned root after six
    // `doctor` calls on one repository, each holding nothing but `node_modules`, none
    // registered with Git. The probe is on by default in a terminal, so five `doctor` runs
    // paid for five `npm ci` and kept five copies.
    //
    // The first explanation was that `--force` spares ignored files. It was measured and it
    // is false — a worktree holding `dist/` and `node_modules/` came back gone. These were
    // removals that *failed*, from a caller that discarded the `GitResult`. A cleanup
    // nobody checks is a cleanup that leaks silently, and the only evidence is a folder
    // somebody notices months later.
    //
    // The filesystem as a last resort, and §20.2 is not violated: Git has either
    // unregistered this worktree or refused to touch it, the path was composed here under
    // Agent Flow's own root, and the probe's whole premise is that nothing in it is worth
    // keeping. Nothing throws — this is a `finally`, and a `doctor` that crashed while
    // tidying up would report the machine as broken because a directory would not go away.
    if (!reclaimed.ok) {
      try {
        if (await options.fs.exists(added.value)) await options.fs.remove(added.value);
      } catch {
        // Left on disk, which is a disk cost. Nothing here is worth failing `doctor` over.
      }
    }
  }
}

/**
 * Probes every runner a role could actually be sent to.
 *
 * A runner the shallow check already found missing is skipped: spawning a binary that is
 * not on PATH tells nobody anything new, and the probe would report `runner_unavailable`
 * for a fact already on the screen.
 *
 * Sequential on purpose. These are real invocations against real quota, and firing them
 * all at once is how a health check turns into a rate limit.
 */
async function probeAll(
  registry: RunnerRegistry,
  observed: readonly ObservedRunner[],
  workingDirectory: string,
  efforts: ReadonlyMap<string, readonly ReasoningLevel[]>,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const runner of observed) {
    if (!runner.installed || !runner.executable) continue;
    if (!registry.has(runner.id)) continue;

    results.push(
      await probeRunner(registry.get(runner.id), {
        workingDirectory,
        // Every effort this configuration would actually ask for (AR-01). The old probe
        // used the cheapest level the runner supported, so a pair that could not do
        // `medium` looked perfectly healthy right up until a task tried it.
        efforts: efforts.get(runner.id) ?? [],
        // And a question that cannot be answered without a tool — read-only, and never
        // escalated. Non-interactive is not the same as permitted, and the difference is
        // what the evidence run spent an attempt discovering.
        toolUse: true,
      }),
    );
  }

  return results;
}

/**
 * The distinct efforts each runner is configured to be asked for.
 *
 * From the configuration rather than from the runner's declared set: probing a level no
 * role uses spends quota to learn nothing, and probing only the cheapest one — which is
 * what happened before — learns nothing about the level that breaks.
 */
function effortsByRunner(config: GlobalConfig): Map<string, readonly ReasoningLevel[]> {
  const byRunner = new Map<string, Set<ReasoningLevel>>();

  for (const role of ALL_WORKFLOW_ROLES) {
    const roleConfig = roleConfigOf(config.roles, role);
    const existing = byRunner.get(roleConfig.runner) ?? new Set<ReasoningLevel>();
    existing.add(roleConfig.effort);
    byRunner.set(roleConfig.runner, existing);
  }

  return new Map(
    [...byRunner].map(([id, levels]) => [
      id,
      // Cheapest first, so a runner that is simply broken fails on the cheap call.
      [...levels].sort((a, b) => compareReasoning(a, b)),
    ]),
  );
}

/**
 * One note per `worktree.copy` pattern that would put a `.env` file in front of the model
 * (FR-018, SEC-007).
 *
 * A note rather than a degradation: copying is opt-in and the operator may mean it — a
 * `.env.test` holding fixture values is exactly what N2 exists to carry. What must not
 * happen is carrying one without having been told, and a project may set `worktree.copy`
 * itself (Risk 3), so this is the only place the operator hears about it.
 *
 * Rule (a) reads the pattern as text; rule (b) asks Git what the pattern matches **today**,
 * with the listing the copy itself uses, and looks at those names — see `core/env-exposure`
 * for why no glob is matched against `.env`. One listing per pattern, so a failure is
 * attributed to the pattern it concerns rather than to the whole list, and one warning per
 * pattern however many rules and files agree.
 *
 * With no patterns nothing is built and nothing is spawned (NFR-003): a `doctor` on a
 * machine that never opted in costs exactly what it cost before.
 */
async function describeEnvExposure(options: {
  fs: FileSystem;
  processRunner: ProcessRunner;
  homeDir: string;
  projectDir: string;
  patterns: readonly string[];
  say: Phrases;
}): Promise<string[]> {
  if (options.patterns.length === 0) return [];

  const git = await createGitCommand({ processRunner: options.processRunner, fs: options.fs, homeDir: options.homeDir });
  const workspaces = await createGitWorkspaces({ git, fs: options.fs, homeDir: options.homeDir });

  const notes: string[] = [];
  for (const pattern of options.patterns) {
    const byName = patternNamesEnvFile(pattern);
    const listed = await workspaces.listIgnoredFiles({ cwd: options.projectDir, patterns: [pattern] });
    const byMatch = listed.ok && listed.value.some((path) => fileNamedEnv(path));

    if (byName || byMatch) {
      notes.push(options.say.doctor.worktreeCopyExposesEnv(pattern));
    } else if (!listed.ok) {
      // Only when (a) did not already warn: a pattern that names `.env` is answered, and
      // saying its listing failed as well would be a second note about a settled question.
      notes.push(options.say.doctor.worktreeCopyEnvUnchecked(pattern));
    }
  }
  return notes;
}

/**
 * Git's version, read through the one wrapper that may spawn it.
 *
 * Reports the floor alongside the installed version so the answer to "is my Git new enough
 * for worktree mode" is on the same screen as the version itself (§23). It is
 * **information, not a gate**: M2-02 pins the floor and offers the probe, and M2-03 is the
 * milestone that turns a version below it into `git_version_unsupported` on a run.
 */
async function checkGit(
  processRunner: ProcessRunner,
  fs: FileSystem,
  homeDir: string,
  cwd: string,
): Promise<ToolCheck> {
  const git = await createGitCommand({ processRunner, fs, homeDir });
  const workspaces = await createGitWorkspaces({ git, fs, homeDir });

  const floor = formatGitVersion(MINIMUM_SUPPORTED_GIT_VERSION);
  const version = await workspaces.version(cwd);
  if (!version.ok) return { name: 'git', present: false, floor };

  return {
    name: 'git',
    present: true,
    version: version.value.raw,
    floor,
    belowFloor: compareGitVersions(version.value, MINIMUM_SUPPORTED_GIT_VERSION) < 0,
  };
}

/**
 * The Node the product itself needs, which is not the one `engines` used to claim.
 *
 * `engines.node` said `>=20`, and on 20.10 two things do not work: `agent-flow ui` dies at
 * startup with `ERR_REQUIRE_ESM` — `@fastify/static` requires `content-disposition`, which
 * is ESM-only, and `require()` of an ES module landed in **20.19** — and the repository's
 * own `vitest` fails to boot on `styleText`, added in 20.12. Neither failure names Node:
 * the first points at a dependency and the second at a missing export, so the operator
 * reads a broken install rather than an old runtime.
 *
 * `doctor` says "OK — nothing here blocks a run" while the dashboard cannot start, which is
 * the check earning its place: the floor is knowable before anything is spent.
 */
const MINIMUM_SUPPORTED_NODE = { major: 20, minor: 19 } as const;

/** `v20.10.0` → `{ major: 20, minor: 10 }`, or nothing when the shape is not recognised. */
function parseNodeVersion(raw: string): { major: number; minor: number } | undefined {
  const match = /v?(\d+)\.(\d+)\./.exec(raw.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : undefined;
}

async function checkTool(
  processRunner: ProcessRunner,
  cwd: string,
  command: 'node',
  args: string[],
): Promise<ToolCheck> {
  const result = await processRunner.run({ command, args, cwd, timeoutSeconds: 10 });
  if (result.spawnFailed || result.exitCode !== 0) return { name: command, present: false };

  const version = result.stdout.trim().split('\n')[0] ?? '';
  const floor = `${String(MINIMUM_SUPPORTED_NODE.major)}.${String(MINIMUM_SUPPORTED_NODE.minor)}`;
  const parsed = parseNodeVersion(version);

  // An unparseable version is reported without a verdict. Asserting "below the floor"
  // about a string nothing understood would be the check inventing a failure.
  if (parsed === undefined) return { name: command, present: true, version, floor };

  const below =
    parsed.major < MINIMUM_SUPPORTED_NODE.major ||
    (parsed.major === MINIMUM_SUPPORTED_NODE.major && parsed.minor < MINIMUM_SUPPORTED_NODE.minor);

  return { name: command, present: true, version, floor, belowFloor: below };
}

export function generateRemediations(
  observed: readonly ObservedRunner[],
  node: ToolCheck,
  git: ToolCheck,
  say: Phrases = en,
): DoctorRemediation[] {
  const remediations: DoctorRemediation[] = [];

  if (!node.present) {
    remediations.push({
      problem: say.doctor.nodeMissing,
      fix: say.doctor.installNode,
    });
  }

  if (!git.present) {
    remediations.push({
      problem: say.doctor.gitMissingOrOld,
      fix: say.doctor.installGit,
    });
  }

  for (const runner of observed) {
    // Configuration first, and it returns: a disabled runner was never spawned, so
    // "not installed or executable" below would be a claim about a binary nothing
    // looked at, and the install guide the wrong fix.
    if (runner.unavailable !== undefined) {
      remediations.push(
        runner.unavailable === 'disabled'
          ? { problem: say.doctor.runnerDisabled(runner.id), fix: say.doctor.enableRunner(runner.id) }
          : {
              problem: say.doctor.runnerUndeclared(runner.id),
              fix: say.doctor.declareRunner(runner.id),
            },
      );
      continue;
    }

    if (!runner.installed || !runner.executable) {
      const guide = getRunnerInstallGuide(runner.id, say);
      if (guide) {
        remediations.push({
          problem: say.doctor.runnerNotInstalled(runner.id),
          fix: guide,
        });
      }
    } else if (runner.auth === 'not_configured') {
      const guide = getRunnerAuthGuide(runner.id, say);
      if (guide) {
        remediations.push({
          problem: say.doctor.runnerMissingCredentials(runner.id),
          fix: guide,
        });
      }
    }
  }

  return remediations;
}

function getRunnerInstallGuide(runnerId: string, say: Phrases): string | undefined {
  switch (runnerId) {
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code';
    case 'codex':
      return 'npm install -g @openai/codex';
    case 'cursor':
      return say.doctor.installAndEnsurePath('Cursor CLI', 'cursor');
    case 'agy':
      // Named rather than piped. The line here used to be
      // `curl -fsSL https://antigravity.run/install.sh | bash`, which installs nothing:
      // the host answers every path with the same HTML landing page — a fabricated one
      // included — so the pipeline feeds a redirect stub to a shell. A URL belongs here
      // again when somebody has fetched it and seen a script come back.
      return say.doctor.installAndEnsurePath('Antigravity CLI', 'agy');
    default:
      return undefined;
  }
}

function getRunnerAuthGuide(runnerId: string, say: Phrases): string | undefined {
  switch (runnerId) {
    case 'claude':
      return say.doctor.runLoginOrExport('claude login', 'ANTHROPIC_API_KEY');
    case 'codex':
      return say.doctor.runLoginOrExport('codex login', 'OPENAI_API_KEY');
    case 'cursor':
      return say.doctor.runInTerminal('cursor auth login');
    case 'agy':
      return say.doctor.runLoginOrExport('agy auth login', 'ANTIGRAVITY_API_KEY');
    default:
      return undefined;
  }
}
