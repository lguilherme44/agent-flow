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
import { createRunnerFactory } from './runner-factory.js';
import { recordFallback } from './fallback-audit.js';
import type { Clock, FileSystem, ProcessRunner } from '../ports/index.js';

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
  readonly processRunner: ProcessRunner;
  /** The adapter type behind a runner id — what independence is judged on. */
  readonly providerOf: (runnerId: string) => string | undefined;
  readonly projectDir: string;
}

export interface BuildContextOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
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
  });

  const scheduler = new Scheduler({
    store,
    executor,
    maxConcurrency: config.global.parallelism.maxTasks,
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
    processRunner,
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
