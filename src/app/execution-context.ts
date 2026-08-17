import {
  PlanSchema,
  type EffectiveConfig,
  type Plan,
  type RunState,
  type TaskResult,
} from '../contracts/index.js';
import { loadConfig } from '../config/loader.js';
import { buildRegistry, type RunnerRegistry } from '../adapters/runners/registry.js';
import { StateStore } from './state-store.js';
import { StageRunner } from './stage-runner.js';
import { PromptLoader } from './prompt-loader.js';
import { TaskExecutor } from './task-executor.js';
import { Scheduler } from './scheduler.js';
import { PlanningPipeline } from './planning-pipeline.js';
import { RepositoryContextAdvisor } from './repository-context-advisor.js';
import { resolveUtilityModel } from './resolve-utility-model.js';
import { ContextTelemetryRecorder } from './context-telemetry-recorder.js';
import { RepositoryRetriever, FileSystemCandidateDiscovery } from '../core/repository-retriever.js';
import type { RunnerCapabilitiesMap } from '../core/role.js';
import {
  resolveTaskConcurrency,
  type ConcurrencyDecision,
  type IsolationMode,
} from '../core/concurrency.js';
import { createRunnerFactory } from './runner-factory.js';
import { recordFallback } from './fallback-audit.js';
import { TaskWorkspaces } from './task-workspaces.js';
import { Integrator } from './integrator.js';
import { WorktreeRecovery } from './worktree-recovery.js';
import {
  checkWorktreePreconditions,
  observePlanningBaseDrift,
  worktreeRefusalAction,
} from './run-git-identity.js';
import { createGitCommand, type GitCommand } from '../adapters/git/git-command.js';
import { createGitWorkspaces, type GitWorkspaces } from '../adapters/git/git-workspaces.js';
import type { Clock, FileSystem, Host, ProcessRunner, UtilityModel } from '../ports/index.js';

/**
 * The wiring every execution command needs.
 *
 * Assembled in one place because `run`, `task`, `retry` and `review` all need
 * the same graph of collaborators, and repeating it four times is how the four
 * quietly drift apart.
 *
 * The ports arrive as arguments rather than being constructed here. They used to
 * be `new NodeFileSystem()` and friends, which was fine while the CLI was the only
 * caller and became the thing standing between the local server and this graph:
 * the server holds its own `FileSystem`, and in tests that is an in-memory one. A
 * use case that reaches for a concrete adapter is a use case only one adapter can
 * drive.
 */
export interface ExecutionContext {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly store: StateStore;
  readonly registry: RunnerRegistry;
  readonly capabilities: RunnerCapabilitiesMap;
  readonly config: EffectiveConfig;
  readonly stageRunner: StageRunner;
  readonly executor: TaskExecutor;
  readonly scheduler: Scheduler;
  /**
   * What the configured task limit becomes for a run in a given mode (§4.4).
   *
   * A function rather than a value, and that is the whole of M2-11. The answer
   * depends on the mode the run was **born** in, and this context is assembled
   * before any run is named — so a single number computed here could only ever be
   * the sequential one, which is what made `maxTasks: 4` a setting with no effect
   * on an isolated run.
   *
   * `isolation` is `state.isolationMode`, read from the run. Never
   * `config.global.git.useWorktrees`, never a probe (I-13): a run created
   * sequential stays sequential however the configuration reads at the moment it
   * executes, and a run created isolated is not demoted by a later edit.
   *
   * The same function feeds the scheduler, the degradation `start` records and the
   * number the read model publishes, which is why the page and the run cannot
   * disagree about how many tasks are executing.
   */
  readonly concurrencyFor: (isolation: IsolationMode | undefined) => ConcurrencyDecision;
  /**
   * The sequential answer, for a caller that has no run in hand.
   *
   * Kept because `doctor` and the configuration page ask "what would this
   * configuration do" rather than "what is this run doing". Every execution path
   * asks {@link ExecutionContext.concurrencyFor} with the run's own mode.
   */
  readonly concurrency: ConcurrencyDecision;
  readonly processRunner: ProcessRunner;
  /**
   * The one hook-isolated `git` spawner (M2-02, §12.3).
   *
   * Assembled here for the same reason every other collaborator is: `review`
   * needs one for its `GitClient` and planning needs one for the discovery
   * fingerprint, and two constructions of it would be two chances to point
   * `core.hooksPath` somewhere else.
   */
  readonly git: GitCommand;
  /**
   * The typed Git operations. Present so the M2-03 preconditions read the
   * repository through the same boundary everything else does; no run path
   * calls a worktree lifecycle method on it yet.
   */
  readonly workspaces: GitWorkspaces;
  /**
   * §14 and §19. Published rather than kept inside the scheduler because `review`
   * needs the same object: the tree it verifies must be the tree the merges
   * happened in, and two constructions of it would be two chances to disagree
   * about which commit that is.
   */
  readonly integrator: Integrator;
  /** The machine, for the home directory the worktree root is projected under. */
  readonly host: Host;
  /** The adapter type behind a runner id — what independence is judged on. */
  readonly providerOf: (runnerId: string) => string | undefined;
  readonly projectDir: string;
}

export interface BuildContextOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  /**
   * Needed for its home directory, which is where `~/.agent-flow/no-hooks` and
   * `~/.agent-flow/worktrees` live (§7.1). Passed rather than resolved so a test
   * can point both at a temporary directory instead of at a real home.
   */
  readonly host: Host;
  readonly projectDir: string;
  readonly globalConfigPath: string;
  /** Where the shipped prompts live. Resolved by whoever knows the install. */
  readonly promptsDir: string;
  /**
   * Optional local model that *advisory* context comes from (§18, M3-08).
   *
   * When absent, the workflow runs exactly as before M3: no retrieval, no
   * advisory blocks, no telemetry. When present, repository retrieval and
   * ranking feed an advisory block into the primary runner's prompt — which the
   * runner is never forced to trust, and which never becomes workflow truth.
   *
   * Defaults to the config-driven adapter resolved from `config.global.utilityModel`
   * (see `resolveUtilityModel`). Tests override it here with a fake so they never
   * depend on the machine's environment.
   */
  readonly utilityModel?: UtilityModel;
  /**
   * Injectable env reader for config-driven resolution. Tests override it to
   * avoid touching `process.env`; production callers leave it unset.
   */
  readonly env?: (name: string) => string | undefined;
  readonly onTaskStart?: (taskId: string) => void;
  readonly onTaskFinish?: (result: TaskResult) => void;
}

export async function buildExecutionContext(
  options: BuildContextOptions,
): Promise<ExecutionContext> {
  const { fs, clock, processRunner } = options;

  const git = await createGitCommand({ processRunner, fs, homeDir: options.host.homeDir });
  const workspaces = await createGitWorkspaces({ git, fs, homeDir: options.host.homeDir });

  const config = await loadConfig({
    fs,
    globalConfigPath: options.globalConfigPath,
    projectDir: options.projectDir,
  });

  const registry = buildRegistry(config.global, {
    processRunner,
    fs,
    // For a runner configured with `apiKeyEnv`. Injected rather than read here, so a test
    // can withhold a credential the production path supplies (§7.1).
    env: options.env ?? ((name) => process.env[name]),
  });
  // Fails here rather than after the first expensive invocation.
  registry.validateRoles(config.global);

  const store = new StateStore({ fs, clock, projectDir: options.projectDir });

  // Where a configured fallback becomes actual behaviour. Every substitution is
  // recorded on the run: a run that quietly finished on a different provider
  // than the one configured should be able to say so afterwards (R-16).
  const getRunner = createRunnerFactory({
    registry,
    config: config.global,
    onFallback: recordFallback(store),
  });

  // M3-08: advisory context is optional by contract. A configured utility model
  // earns the workflow an advisory block on primary-runner prompts; its absence
  // leaves every prompt exactly as-rendered (§14.3, §18). Telemetry flows
  // through the recorder whenever the advisor runs, at no cost when absent.
  //
  // The adapter is resolved here, at the composition boundary, from config —
  // never earlier. `options.utilityModel` is an explicit override used by tests
  // (a fake); production leaves it unset and pays for retrieval only when the
  // global config enabled a local model whose apiKeyEnv variable is present.
  // A missing or blank key resolves to no adapter, which is the pre-MVP3 path.
  const utilityModel =
    options.utilityModel ??
    resolveUtilityModel({ config: config.global.utilityModel, env: options.env });
  const allowedEffectiveModels =
    config.global.utilityModel?.model !== undefined
      ? [config.global.utilityModel.model]
      : undefined;
  const advisor =
    utilityModel === undefined
      ? undefined
      : new RepositoryContextAdvisor({
          retriever: new RepositoryRetriever({
            utilityModel,
            candidateDiscovery: new FileSystemCandidateDiscovery(fs),
            projectDir: options.projectDir,
          }),
          telemetry: new ContextTelemetryRecorder(store),
          trust: { allowedEffectiveModels },
        });

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config: config.global,
    capabilities: registry.capabilities(),
    promptLoader: new PromptLoader({ fs, promptsDir: options.promptsDir }),
    getRunner,
    projectDir: options.projectDir,
    // For its home directory, which is the second root evidence redaction needs (AD-35):
    // in worktree mode an agent runs under `~/.agent-flow/worktrees/…`, so its output
    // quotes a path that names this machine's user.
    host: options.host,
    ...(advisor === undefined ? {} : { advisor }),
  });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner,
    processRunner,
    config,
    projectDir: options.projectDir,
    // §11.2: an isolated attempt captures its validated tree and mints its
    // receipt here, after the agent has exited. Wired unconditionally — a
    // sequential run never reaches either of them, because the executor only
    // asks when the workspace it was handed carries an isolation block.
    workspaces,
    host: options.host,
  });

  // The configured number is an intention; the scheduler needs an instruction.
  // Handing `maxTasks` straight through is what made `maxTasks: 4` run four
  // agents against one working tree — see core/concurrency.ts.
  //
  // **M2-11: the mode is passed, and it comes from the run** (§4.4, I-13). The
  // resolver has been able to answer for an isolated run since M2-01 and was
  // deliberately never asked, because until M2-04…M2-08 there was no isolation to
  // point at. There is now: each dispatched task owns a worktree and a branch, its
  // validated tree is bound to a marker, and the Integrator is the only writer of
  // `completed`. Those are what make this argument safe rather than optimistic.
  const concurrencyFor = (isolation: IsolationMode | undefined): ConcurrencyDecision =>
    resolveTaskConcurrency(config.global.parallelism.maxTasks, isolation ?? 'none');

  const concurrency = concurrencyFor('none');

  // §8: one prepared workspace per dispatched attempt. Sequential and legacy
  // runs take the project directory from it without reaching Git.
  const taskWorkspaces = new TaskWorkspaces({
    workspaces,
    fs,
    host: options.host,
    projectDir: options.projectDir,
    processRunner,
    config,
    clock,
  });

  // §14: the only writer of `completed` in worktree mode. Wired unconditionally
  // and asked per run — it answers `sequential` for a run whose `isolationMode`
  // is not `worktree`, so the mode is decided by the run rather than by the
  // wiring (I-13), and a sequential run never reaches an integration branch.
  const integrator = new Integrator({
    workspaces,
    fs,
    host: options.host,
    projectDir: options.projectDir,
    store,
    clock,
  });

  // §17: the Git half of crash recovery. Given **the same** Integrator rather
  // than a second one — two would have two integration mutexes, and the
  // serialisation of §18.2 would quietly stop existing.
  const recovery = new WorktreeRecovery({
    workspaces,
    fs,
    host: options.host,
    projectDir: options.projectDir,
    store,
    clock,
    integrator,
  });

  const scheduler = new Scheduler({
    store,
    executor,
    workspaces: taskWorkspaces,
    integrator,
    recovery,
    // §4.4: the run decides, not this wiring. `state.isolationMode` is the
    // discriminant, and it was captured before anything observed the repository.
    concurrencyFor: (state) => concurrencyFor(state.isolationMode).effective,
    maxAttempts: config.global.retry.maxAttempts,
    // AR-03. Ships `enabled: false`, so the scheduler keeps its standing rule of never
    // retrying on its own until a project turns it on — automatic retry is new behaviour,
    // and the kill switch is an acceptance criterion rather than a convenience.
    recoveryConfig: config.global.recovery,
    fs,
    projectDir: options.projectDir,
    ...(options.onTaskStart === undefined ? {} : { onTaskStart: options.onTaskStart }),
    ...(options.onTaskFinish === undefined ? {} : { onTaskFinish: options.onTaskFinish }),
  });

  return {
    fs,
    clock,
    store,
    registry,
    capabilities: registry.capabilities(),
    config,
    stageRunner,
    executor,
    scheduler,
    concurrencyFor,
    concurrency,
    processRunner,
    git,
    workspaces,
    integrator,
    host: options.host,
    providerOf: (id) => registry.providerOf(id),
    projectDir: options.projectDir,
  };
}

/**
 * The planning half, from an already-assembled context.
 *
 * `feature` built this graph itself and `revise` needed the same one, which is
 * how two wirings of the same pipeline start out identical and stop being so. One
 * function, two callers: the CLI command and the revise use case the write API
 * calls.
 */
export function buildPlanningPipeline(context: ExecutionContext): PlanningPipeline {
  return new PlanningPipeline({
    fs: context.fs,
    clock: context.clock,
    store: context.store,
    stageRunner: context.stageRunner,
    processRunner: context.processRunner,
    git: context.git,
    // §6.2's between-stage gate. Sequential and legacy runs never reach Git
    // through it: `checkWorktreePreconditions` returns satisfied for them before
    // asking anything.
    planningBaseGate: async (runId, moment) => {
      const state = await context.store.loadRun(runId);
      const repository = {
        workspaces: context.workspaces,
        fs: context.fs,
        host: context.host,
        projectDir: context.projectDir,
      };

      if (state.isolationMode !== 'worktree') {
        // §6.2's stated deviation: a sequential run is observed, never refused.
        // Recorded whatever the result, because Appendix B's payload is
        // `{ clean, head, planningBase, matches }` — a shape that exists to say
        // "clean and matching" as readily as the opposite.
        const observation = await observePlanningBaseDrift(repository, state);
        if (observation !== null) {
          await context.store.appendEvent(runId, 'planning_base_observation', {
            moment,
            ...observation,
          });
        }
        return null;
      }

      const preconditions = await checkWorktreePreconditions(repository, state);
      if (preconditions.satisfied) return null;

      await context.store.appendEvent(runId, 'worktree_mode_refused', {
        moment,
        code: preconditions.code,
        detail: preconditions.detail,
      });

      // The canonical code and the action that resolves it, rather than one
      // string with both flattened into it. The caller renders a refusal, and a
      // refusal a person can act on needs the two apart.
      return {
        code: preconditions.code,
        detail: preconditions.detail,
        action: worktreeRefusalAction(preconditions.code),
      };
    },
    config: context.config,
    capabilities: context.capabilities,
    providerOf: context.providerOf,
    projectDir: context.projectDir,
  });
}

/** Loads the plan of a run, or null when planning has not produced one. */
export async function loadPlan(store: StateStore, runId: string): Promise<Plan | null> {
  const raw = await store.readArtifact(runId, 'plan');
  return raw === null ? null : PlanSchema.parse(JSON.parse(raw));
}

/** Task states as last persisted, for resuming. */
export function statesOf(state: RunState): Record<string, string> {
  return Object.fromEntries(state.tasks.map((task) => [task.id, task.state]));
}
