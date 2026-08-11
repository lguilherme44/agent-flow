import { RunStageSchema, type RunStage } from '../contracts/index.js';
import { buildExecutionContext, buildPlanningPipeline } from '../app/execution-context.js';
import { resolveRole } from '../core/role.js';
import { runPaths } from '../app/paths.js';
import { revise } from '../app/run-actions.js';
import { actionDeps, currentRunId, exitCodeFor, render } from './approve.js';
import { nodeAdapters } from './adapters.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

export interface FeatureOptions {
  readonly cache?: boolean;
  readonly from?: string;
  readonly skipReview?: boolean;
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
  try {
    const from = options.from === undefined ? undefined : parseStage(options.from);

    // Assembles the whole graph, and validates the roles while doing it — a role
    // pointing at a runner that is not registered is a configuration mistake, and
    // finding it three expensive stages in would waste everything already spent.
    const context = await buildExecutionContext({
      ...nodeAdapters(),
      projectDir: globals.cwd,
      globalConfigPath: globals.globalConfigPath,
    });

    if (globals.dryRun) {
      printExecutionPlan(context.config.global, context.capabilities, globals);
      return ExitCode.OK;
    }

    // Resuming must continue the existing run, not start a fresh one. Creating a
    // new run here would leave its artifacts empty and silently re-run the very
    // stages `--from` exists to skip — the opposite of the intent, at full cost.
    const run =
      from === undefined
        ? await context.store.createRun(description)
        : ((await context.store.loadCurrentRun()) ??
          (() => {
            throw new Error(
              'No run to resume. Start one with `agent-flow feature "<description>"` first.',
            );
          })());

    // The same pipeline the revise use case builds, from the same helper. Two
    // wirings of one pipeline is how the two stop being identical.
    const pipeline = buildPlanningPipeline(context);

    process.stdout.write(`Run ${run.runId} — ${description}\n\n`);

    const result = await pipeline.run(run.runId, description, {
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
        nextStepAfterPlanning(result.review?.verdict),
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
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run to revise.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await revise(deps, runId, instruction);

    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    if (outcome.value.approvalCleared) {
      process.stdout.write('The previous approval no longer applies and has been cleared.\n\n');
    }

    process.stdout.write(
      [
        `${String(outcome.value.taskCount)} tasks planned.`,
        '',
        nextStepAfterPlanning(outcome.value.reviewVerdict),
        '',
      ].join('\n'),
    );

    return ExitCode.OK;
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

/**
 * What to do next, given what the review actually said.
 *
 * Written as one function because the previous version was a constant string:
 * a run whose plan review returned FAIL still closed with "Then: agent-flow
 * approve", and following that advice hits a gate that refuses. The verdict was
 * printed three lines above and never consulted.
 *
 * `--force` is named rather than hidden. It exists, it is recorded on the run,
 * and someone who has read the findings is entitled to overrule them; omitting
 * it would be its own kind of misdirection.
 */
export function nextStepAfterPlanning(verdict: 'PASS' | 'FAIL' | undefined): string {
  if (verdict !== 'FAIL') return 'Then: agent-flow approve';

  return [
    'The automated review rejected this plan. Its findings are above.',
    '',
    'Fix the plan with: agent-flow revise "<instruction>"',
    'Or approve anyway with: agent-flow approve --force  (recorded on the run)',
  ].join('\n');
}
