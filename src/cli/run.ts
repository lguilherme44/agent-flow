import { describeIsolation } from '../app/run-git-identity.js';
import { buildExecutionContext, loadPlan } from '../app/execution-context.js';
import { retryTask, start } from '../app/run-actions.js';
import { explainRouting, routeTask } from '../core/router.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { actionDeps, currentRunId, exitCodeFor, printWarnings, render } from './approve.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow run` — execute the approved plan.
 *
 * The gates that guard the entrance live in `app/run-actions.ts` now, because the
 * write API calls the same ones: "the UI may only start execution through the same
 * logic `agent-flow run` uses" is only true if there is one implementation of that
 * logic, and this file is no longer it.
 *
 * The second gate is still the one that matters. Approval is granted to a specific
 * plan (§17); if the plan changed after it was approved, the gate was satisfied for
 * a different document and running anyway would execute work no human read.
 */
export async function runRunCommand(
  options: { taskId?: string },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run. Start one with: agent-flow feature "<description>"\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    if (globals.dryRun) return await printExecutionPlan(deps, runId);

    process.stdout.write(`Running ${runId}\n\n`);

    const outcome = await start(deps, runId, {
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      onTaskStart: (taskId) => {
        if (globals.verbose) process.stdout.write(`  → ${taskId}\n`);
      },
      onTaskFinish: (result) => {
        const mark = result.status === 'completed' ? '✓' : '✗';
        process.stdout.write(`  ${mark} ${result.task} (${result.status})\n`);
      },
    });

    printWarnings(outcome);

    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    const scheduled = outcome.value.outcome;
    process.stdout.write('\n');

    if (scheduled.planComplete) {
      process.stdout.write('All tasks completed.\n\nNext: agent-flow review\n');
      return ExitCode.OK;
    }

    if (scheduled.complete) {
      // The requested task finished. The plan has not, and the message says so —
      // but this invocation did what it was asked, and exits accordingly.
      const remaining = Object.values(scheduled.states).filter(
        (taskState) => taskState !== 'completed',
      ).length;
      process.stdout.write(
        `${options.taskId ?? 'The requested work'} completed. ` +
          `${String(remaining)} task(s) remaining.\n\nNext: agent-flow run\n`,
      );
      return ExitCode.OK;
    }

    process.stdout.write(`Stopped: ${scheduled.haltedBy ?? 'not all tasks completed'}.\n`);

    if (scheduled.blocked.length > 0) {
      process.stdout.write(`Blocked by that failure: ${scheduled.blocked.join(', ')}\n`);
    }

    const needsHuman = scheduled.results.filter(
      (result) => result.status === 'blocked' || result.status === 'review_required',
    );

    for (const result of needsHuman) {
      process.stdout.write(`\n${result.task} — ${result.status}\n`);
      for (const note of result.notes) process.stdout.write(`  ${note}\n`);
    }

    // Not an error the shell should treat as a crash: the run stopped for a
    // reason a person needs to act on.
    return ExitCode.GATE_NOT_SATISFIED;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * `agent-flow retry <task>` — put a finished-badly task back in the queue.
 *
 * Retry is explicit and bounded (§23). The scheduler deliberately never retries on
 * its own, because an automatic loop would keep paying for the same failure.
 */
export async function runRetryCommand(
  taskId: string,
  options: { force?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await retryTask(deps, runId, taskId, { force: options.force === true });

    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    process.stdout.write(`${taskId} is queued again.\n\nRun it with: agent-flow run\n`);
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * `--dry-run`: the routing and the limits, without invoking anything.
 *
 * Stays in the CLI because it is a CLI feature. The write API has no equivalent,
 * and a use case taking a "print it instead of doing it" flag would be two use
 * cases wearing one name.
 *
 * Assembles the real execution context now, where it used to build a bare
 * StateStore. That is deliberate and it does change one thing: a project whose
 * configuration will not load, or whose roles resolve to nothing, is refused here
 * rather than printing a plan it could never execute. Both refusals are named
 * config errors with exit code 2, not crashes — and a dry run of an execution
 * that cannot be configured is not a dry run of anything.
 *
 * Nothing is spawned. The registry is built from configuration and its roles are
 * checked against declared capabilities; no runner is invoked, which is the
 * promise the last line makes.
 */
/**
 * The run's isolation mode beside the current configuration.
 *
 * Without this line the tool looks broken to the one user who did exactly what
 * the documentation told them to do and then wondered why it had no effect.
 */
function renderIsolation(
  state: Parameters<typeof describeIsolation>[0],
  config: Parameters<typeof describeIsolation>[1],
): string {
  const report = describeIsolation(state, config);
  const lines = [
    `Run isolation:    ${report.runMode ?? 'legacy (predates workspace isolation)'}`,
    `Current config:   useWorktrees: ${String(report.configuredWorktrees)}`,
  ];
  if (report.note !== undefined) lines.push(`  ${report.note}`);
  return lines.join('\n');
}

async function printExecutionPlan(
  deps: ReturnType<typeof actionDeps>,
  runId: string,
): Promise<ExitCodeValue> {
  const context = await buildExecutionContext(deps);
  const state = await context.store.loadRun(runId);
  const plan = await loadPlan(context.store, runId);

  if (plan === null) {
    process.stderr.write('This run has no plan yet.\n');
    return ExitCode.GATE_NOT_SATISFIED;
  }

  const previous = Object.fromEntries(state.tasks.map((task) => [task.id, task.state]));

  process.stdout.write(`Execution plan for ${runId}\n\n`);
  for (const task of plan.tasks) {
    const role = routeTask(task);
    const already = previous[task.id] === 'completed' ? ' (already completed)' : '';
    process.stdout.write(
      `  ${task.id}  ${role.padEnd(18)} ${explainRouting(task).padEnd(28)}${already}\n`,
    );
  }

  // Printed before any quota is spent, which is the point of a dry run. The two
  // numbers are separate lines rather than one, because "4" and "1" are different
  // facts and a reader who saw only the configured one would plan around it.
  const { requested, effective, clamped, reason } = context.concurrency;
  process.stdout.write(`\nParallelism requested: ${String(requested)}\n`);
  process.stdout.write(`Parallelism effective: ${String(effective)}\n`);
  if (clamped && reason !== undefined) process.stdout.write(`  ${reason}\n`);

  // §21.4. This is the command that answers "why is this still running one task
  // at a time", so the run's frozen mode and the configuration in front of the
  // user are printed as two separate facts — and when they disagree, which one
  // applies is said in words rather than left to be worked out.
  process.stdout.write(`\n${renderIsolation(state, context.config)}\n`);

  process.stdout.write('\nNo runner was invoked.\n');
  return ExitCode.OK;
}
