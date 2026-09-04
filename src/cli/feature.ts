import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RunStageSchema,
  WorkflowClassSchema,
  WORKFLOW_CLASSES,
  type RunStage,
  type WorkflowClass,
} from '../contracts/index.js';
import { buildExecutionContext, buildPlanningPipeline } from '../app/execution-context.js';
import { resolveRole } from '../core/role.js';
import { runPaths } from '../app/paths.js';
import { revise } from '../app/run-actions.js';
import {
  chooseInstructionSource,
  readInstruction,
  type InstructionFlags,
  type InstructionIO,
} from './instruction-source.js';
import { actionDeps, currentRunId, exitCodeFor, render } from './approve.js';
import { nodeAdapters } from './adapters.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { writeProgress } from './render/progress.js';
import {
  composeRunIdentity,
  resolveRunGitIdentity,
  checkPlanningPreflight,
  renderPlanningRefusal,
  worktreeRefusalAction,
} from '../app/run-git-identity.js';
import { PlanningRefusal } from '../app/planning-pipeline.js';
import type { GlobalOptions } from './index.js';

export interface FeatureOptions {
  readonly cache?: boolean;
  readonly from?: string;
  readonly skipReview?: boolean;
  readonly workflow?: string;
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
  // Outside the `try`, because the catch is the one place it is read: the stage a
  // failed run stopped in is what makes the resume line below complete.
  let lastStarted: string | undefined;

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

    let workflowOverride: WorkflowClass | undefined;
    if (options.workflow !== undefined) {
      const parsed = WorkflowClassSchema.safeParse(options.workflow);
      if (!parsed.success) {
        process.stderr.write(
          `Invalid workflow class "${options.workflow}". Supported classes: ${WORKFLOW_CLASSES.join(', ')}\n`,
        );
        return ExitCode.CONFIG_ERROR;
      }
      workflowOverride = parsed.data;
    }

    // Resuming must continue the existing run, not start a fresh one. Creating a
    // new run here would leave its artifacts empty and silently re-run the very
    // stages `--from` exists to skip — the opposite of the intent, at full cost.
    const run =
      from === undefined
        ? await createRunWithIdentity(context, description)
        : ((await context.store.loadCurrentRun()) ??
          (() => {
            throw new Error(
              'No run to resume. Start one with `agent-flow feature "<description>"` first.',
            );
          })());

    // The same pipeline the revise use case builds, from the same helper. Two
    // wirings of one pipeline is how the two stop being identical.
    const pipeline = buildPlanningPipeline(context);

    process.stdout.write(`Run ${run.runId} — ${description}\n`);
    process.stdout.write('Planning feature...\nNo implementation will occur before approval.\n\n');

    const result = await pipeline.run(run.runId, description, {
      ...(options.cache === false ? { noCache: true } : {}),
      ...(from === undefined ? {} : { from }),
      ...(options.skipReview === true ? { skipReview: true } : {}),
      ...(workflowOverride !== undefined ? { workflow: workflowOverride } : {}),
      onProgress: (stage, status) => {
        if (status === 'started') lastStarted = stage;
        writeStageProgress(stage, status, globals.verbose);
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
    process.stderr.write(resumeHint(lastStarted));
    return rendered.exitCode;
  }
}

/**
 * Where to pick the run back up, printed at the point the run stopped.
 *
 * `--from` already resumes a stage keeping the artifacts before it, and the
 * pipeline supports it well. Nothing on the failure path said so: a planning stage
 * dying printed the runner's error and stopped, and the only command offered
 * afterwards was `revise` — which is the wrong tool here twice over. It prepends
 * *"Revision requested by the reviewer"* to the request, and no reviewer asked
 * for anything when an HTTP call failed; and it spends one of the run's revision
 * cycles, which a `standard` workflow only has two of.
 *
 * The stage is known — it is the one that had started — so the line can be
 * complete rather than a pointer to `--help`.
 *
 * Quiet when the failure happened before any stage began: there is nothing to
 * resume from, and a suggestion that cannot be followed is worse than none.
 */
export function resumeHint(stage: string | undefined): string {
  if (stage === undefined) return '';
  return (
    `\nThe stages before this one are kept. Resume with:\n` +
    `  agent-flow feature "<same description>" --from ${stage}\n` +
    `\nUse \`revise\` instead only when the plan itself needs changing — it spends a\n` +
    `revision cycle and tells the planner a reviewer asked for the change.\n`
  );
}

/**
 * One line per stage. Delegates to the shared renderer — `run` had the identical
 * defect and the fix should not exist twice.
 */
export function writeStageProgress(stage: string, status: string, verbose: boolean): void {
  writeProgress(stage, status, verbose);
}

/**
 * `agent-flow revise "<instruction>"` — re-plan with extra guidance.
 *
 * Invalidates any approval before re-running. The gate is granted to a specific
 * plan (§17), so a plan produced after approval has not been through it — and
 * leaving the flag set would let unreviewed work execute.
 */
export async function runReviseCommand(
  flags: InstructionFlags,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    // AR-08: the instruction may arrive as an argument, a file, stdin or an editor buffer.
    // Which one is decided first because it is pure and free, and a bad invocation should
    // not reach the filesystem at all.
    const source = chooseInstructionSource(flags);
    if (source.kind === 'refused') {
      process.stderr.write(`${source.reason}\n`);
      return ExitCode.CONFIG_ERROR;
    }

    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run to revise.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    // Read only once there is something to revise. `--edit` opens an editor and waits, and
    // asking someone to compose a revision for a run that does not exist is the kind of
    // wasted effort a check costing one state read prevents.
    const read = await readInstruction(source, nodeInstructionIO());
    if (!read.ok) {
      process.stderr.write(`${read.reason}\n`);
      return ExitCode.CONFIG_ERROR;
    }
    const instruction = read.instruction;

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

/**
 * The four sources, wired to the machine.
 *
 * `$VISUAL` before `$EDITOR` before `vi`, which is the order every other tool that opens an
 * editor uses. `stdio: 'inherit'` because the editor owns the terminal while it runs.
 */
function nodeInstructionIO(): InstructionIO {
  return {
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    readStdin: async () => {
      let text = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) text += chunk as string;
      return text;
    },
    openEditor: async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'agent-flow-revise-')), 'INSTRUCTION.md');
      writeFileSync(
        file,
        [
          '',
          '# Write the revision below. Lines starting with # are ignored.',
          '# Save an empty file to cancel.',
          '',
        ].join('\n'),
        'utf8',
      );

      const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'vi';
      const result = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
      if (result.status !== 0) return '';

      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n');
    },
  };
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
    'The automated review rejected this plan. Its findings are in `agent-flow status`.',
    '',
    'Fix the plan with: agent-flow revise "<instruction>"',
    'Or approve anyway with: agent-flow approve --force  (recorded on the run)',
  ].join('\n');
}

/**
 * Creates a run with its Git identity, in that order and only that order.
 *
 * The decision comes first and can refuse: a run born `worktree` in a
 * repository that cannot supply a base is refused **at creation**, before
 * discovery, planning and a plan review have been paid for (§6.1). Only once it
 * is settled does `createRun` allocate an id and write all three fields in the
 * same write that creates the run — so there is no moment at which a run exists
 * with half an identity.
 */
async function createRunWithIdentity(
  context: Awaited<ReturnType<typeof buildExecutionContext>>,
  description: string,
) {
  const deps = {
    workspaces: context.workspaces,
    fs: context.fs,
    host: context.host,
    config: context.config,
    projectDir: context.projectDir,
  };

  const preflight = await checkPlanningPreflight(deps);
  if (!preflight.satisfied) {
    // Rendered by the module that owns the codes, so `bug` and every future verb say the
    // same thing — and so the sentence stays true. It used to blame worktree mode for
    // every refusal, including refusals that have nothing to do with it and refusals a
    // sequential run can now reach (AR-01).
    const rendered = renderPlanningRefusal(preflight);
    throw new PlanningRefusal(rendered.code, rendered.message, rendered.action, rendered.kind);
  }

  const identity = await resolveRunGitIdentity(deps);
  if (!identity.ok) {
    throw new PlanningRefusal(
      identity.refusal.code,
      `Worktree mode was requested and this repository cannot support it ` +
        `(${identity.refusal.code}): ${identity.refusal.detail}`,
      worktreeRefusalAction(identity.refusal.code),
    );
  }

  return context.store.createRun(description, (runId) =>
    composeRunIdentity(runId, identity.value),
  );
}
