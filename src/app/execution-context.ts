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
import type { RunnerCapabilitiesMap } from '../core/role.js';
import { resolveTaskConcurrency, type ConcurrencyDecision } from '../core/concurrency.js';
import { createRunnerFactory } from './runner-factory.js';
import { recordFallback } from './fallback-audit.js';
import { TaskWorkspaces } from './task-workspaces.js';
import { Integrator } from './integrator.js';
import {
  checkWorktreePreconditions,
  observePlanningBaseDrift,
} from './run-git-identity.js';
import { createGitCommand, type GitCommand } from '../adapters/git/git-command.js';
import { createGitWorkspaces, type GitWorkspaces } from '../adapters/git/git-workspaces.js';
import type { Clock, FileSystem, Host, ProcessRunner } from '../ports/index.js';

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
   * What the configured task limit became, and why (M2-00.3).
   *
   * Published rather than kept inside the scheduler because two callers need the
   * same answer: `start` records the reduction on the run, and `run --dry-run`
   * prints it. Two computations of one number would eventually disagree, and the
   * one on screen would be the wrong one.
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

  const registry = buildRegistry(config.global, { processRunner, fs });
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

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config: config.global,
    capabilities: registry.capabilities(),
    promptLoader: new PromptLoader({ fs, promptsDir: options.promptsDir }),
    getRunner,
    projectDir: options.projectDir,
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
  const concurrency = resolveTaskConcurrency(config.global.parallelism.maxTasks);

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

  const scheduler = new Scheduler({
    store,
    executor,
    workspaces: taskWorkspaces,
    integrator,
    maxConcurrency: concurrency.effective,
    maxAttempts: config.global.retry.maxAttempts,
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

      return `${preconditions.code}: ${preconditions.detail}`;
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
