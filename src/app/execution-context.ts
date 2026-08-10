import {
  PlanSchema,
  type EffectiveConfig,
  type Plan,
  type RunState,
  type TaskResult,
} from '../contracts/index.js';
import { loadConfig } from '../config/loader.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { buildRegistry, type RunnerRegistry } from '../adapters/runners/registry.js';
import { StateStore } from './state-store.js';
import { StageRunner } from './stage-runner.js';
import { PromptLoader } from './prompt-loader.js';
import { resolvePromptsDir } from './prompt-paths.js';
import { TaskExecutor } from './task-executor.js';
import { Scheduler } from './scheduler.js';
import type { RunnerCapabilitiesMap } from '../core/role.js';
import { createRunnerFactory } from './runner-factory.js';
import { recordFallback } from './fallback-audit.js';

/**
 * The wiring every execution command needs.
 *
 * Assembled in one place because `run`, `task`, `retry` and `review` all need
 * the same graph of collaborators, and repeating it four times is how the four
 * quietly drift apart.
 */
export interface ExecutionContext {
  readonly fs: NodeFileSystem;
  readonly clock: SystemClock;
  readonly store: StateStore;
  readonly registry: RunnerRegistry;
  readonly capabilities: RunnerCapabilitiesMap;
  readonly config: EffectiveConfig;
  readonly stageRunner: StageRunner;
  readonly executor: TaskExecutor;
  readonly scheduler: Scheduler;
  readonly processRunner: NodeProcessRunner;
  readonly projectDir: string;
}

export interface BuildContextOptions {
  readonly projectDir: string;
  readonly globalConfigPath: string;
  readonly onTaskStart?: (taskId: string) => void;
  readonly onTaskFinish?: (result: TaskResult) => void;
}

export async function buildExecutionContext(
  options: BuildContextOptions,
): Promise<ExecutionContext> {
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const processRunner = new NodeProcessRunner();

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
    promptLoader: new PromptLoader({ fs, promptsDir: resolvePromptsDir() }),
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
    projectDir: options.projectDir,
  };
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
