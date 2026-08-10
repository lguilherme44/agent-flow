import { RunStageSchema, type RunStage } from '../contracts/index.js';
import { loadConfig } from '../config/loader.js';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { buildRegistry } from '../adapters/runners/registry.js';
import { StateStore } from '../app/state-store.js';
import { StageRunner } from '../app/stage-runner.js';
import { PromptLoader } from '../app/prompt-loader.js';
import { resolvePromptsDir } from '../app/prompt-paths.js';
import { PlanningPipeline } from '../app/planning-pipeline.js';
import { createRunnerFactory } from '../app/runner-factory.js';
import { resolveRole } from '../core/role.js';
import { runPaths } from '../app/paths.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

export interface FeatureOptions {
  readonly cache?: boolean;
  readonly from?: string;
  readonly skipReview?: boolean;
  /** Extra instruction appended to the feature request by `revise`. */
  readonly revision?: string;
}

/**
 * `agent-flow feature "<description>"` — the planning half of the workflow.
 *
 * Stops at a plan on purpose. Nothing is implemented until a human has read the
 * SDD and the task breakdown and approved them (§17).
 */
export async function runFeatureCommand(
  description: string,
  options: FeatureOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const clock = new SystemClock();

  try {
    const config = await loadConfig({
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: globals.cwd,
    });

    const processRunner = new NodeProcessRunner();
    const registry = buildRegistry(config.global, { processRunner, fs });
    // Fails here rather than three expensive stages in: a role pointing at a
    // runner that is not registered is a configuration mistake, and finding it
    // late would waste everything already spent.
    registry.validateRoles(config.global);

    const from = options.from === undefined ? undefined : parseStage(options.from);

    if (globals.dryRun) {
      printExecutionPlan(config.global, registry.capabilities(), globals);
      return ExitCode.OK;
    }

    const store = new StateStore({ fs, clock, projectDir: globals.cwd });

    // Resuming must continue the existing run, not start a fresh one. Creating a
    // new run here would leave its artifacts empty and silently re-run the very
    // stages `--from` exists to skip — the opposite of the intent, at full cost.
    const run =
      from === undefined
        ? await store.createRun(description)
        : ((await store.loadCurrentRun()) ??
          (() => {
            throw new Error(
              'No run to resume. Start one with `agent-flow feature "<description>"` first.',
            );
          })());

    const stageRunner = new StageRunner({
      fs,
      clock,
      store,
      config: config.global,
      capabilities: registry.capabilities(),
      promptLoader: new PromptLoader({ fs, promptsDir: resolvePromptsDir() }),
      getRunner: createRunnerFactory({ registry, config: config.global }),
      projectDir: globals.cwd,
    });

    const pipeline = new PlanningPipeline({
      fs,
      clock,
      store,
      stageRunner,
      processRunner,
      config,
      capabilities: registry.capabilities(),
      projectDir: globals.cwd,
    });

    process.stdout.write(`Run ${run.runId} — ${description}\n\n`);

    const request =
      options.revision === undefined
        ? description
        : `${description}\n\n---\n\nRevision requested by the reviewer:\n${options.revision}`;

    const result = await pipeline.run(run.runId, request, {
      ...(options.cache === false ? { noCache: true } : {}),
      ...(from === undefined ? {} : { from }),
      ...(options.skipReview === true ? { skipReview: true } : {}),
      onProgress: (stage, status) => {
        const mark = status === 'completed' ? '✓' : status === 'cached' ? '·' : '→';
        if (status !== 'started' || globals.verbose) {
          process.stdout.write(`  ${mark} ${stage}${status === 'cached' ? ' (cached)' : ''}\n`);
        }
      },
    });

    const paths = runPaths(globals.cwd, run.runId);

    if (globals.json) {
      process.stdout.write(`${JSON.stringify({ runId: run.runId, plan: result.plan }, null, 2)}\n`);
      return ExitCode.OK;
    }

    process.stdout.write(
      [
        '',
        `${String(result.plan.tasks.length)} tasks planned.`,
        '',
        `  SDD   ${paths.sdd}`,
        `  Plan  ${paths.plan}`,
        '',
        'Read both before approving — the automated review checks the plan against',
        'the SDD, but it is not the one accountable for it.',
        '',
        'Then: agent-flow approve',
        '',
      ].join('\n'),
    );

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`\n${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * `agent-flow revise "<instruction>"` — re-plan with extra guidance.
 *
 * Invalidates any approval before re-running. The gate is granted to a specific
 * plan (§17), so a plan produced after approval has not been through it — and
 * leaving the flag set would let unreviewed work execute.
 */
export async function runReviseCommand(
  instruction: string,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const store = new StateStore({ fs, clock, projectDir: globals.cwd });

  try {
    const state = await store.loadCurrentRun();
    if (state === null) {
      process.stderr.write('No active run to revise.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    if (state.approved) {
      await store.updateRun(state.runId, (current) => ({
        ...current,
        approved: false,
        approvedPlanHash: undefined,
        approvedAt: undefined,
        status: 'running',
      }));
      await store.appendEvent(state.runId, 'approval_invalidated', { reason: 'revise' });
      process.stdout.write('The previous approval no longer applies and has been cleared.\n\n');
    }

    const request = (await store.readArtifact(state.runId, 'request')) ?? state.feature;

    return await runFeatureCommand(
      request.trim(),
      { from: 'planning', revision: instruction },
      globals,
    );
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

function parseStage(value: string): RunStage {
  const result = RunStageSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Unknown stage "${value}". Valid values: discovery, architecture-impact, sdd, planning.`,
    );
  }
  return result.data;
}

/**
 * `--dry-run`: what would run, and on what.
 *
 * With the default configuration a feature costs four heavy calls before a line
 * of code exists. Being able to see the routing without spending any of it is
 * worth the few lines this takes (R-08).
 */
function printExecutionPlan(
  config: Parameters<typeof resolveRole>[1],
  capabilities: Parameters<typeof resolveRole>[2],
  globals: GlobalOptions,
): void {
  const stages: Array<[string, Parameters<typeof resolveRole>[0]]> = [
    ['discovery', 'architect'],
    ['architecture-impact', 'architect'],
    ['sdd', 'sdd'],
    ['planning', 'planner'],
  ];

  process.stdout.write(`Execution plan for ${globals.cwd}\n\n`);

  for (const [stage, role] of stages) {
    const resolved = resolveRole(role, config, capabilities, { readOnly: true });
    const model = resolved.model ?? '(runner default)';
    const clamped = resolved.reasoningClamped ? ' [clamped]' : '';
    process.stdout.write(
      `  ${stage.padEnd(20)} ${role.padEnd(12)} ${resolved.runner.padEnd(10)} ` +
        `${model.padEnd(20)} ${resolved.reasoning}${clamped}\n`,
    );
  }

  process.stdout.write('\nNo runner was invoked.\n');
}
