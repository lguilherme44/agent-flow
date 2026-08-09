import type { TaskState } from '../contracts/index.js';
import { approvalCoversPlan } from '../app/approval.js';
import { buildExecutionContext, loadPlan } from '../app/execution-context.js';
import { explainRouting, routeTask } from '../core/router.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow run` — execute the approved plan.
 *
 * Two refusals guard the entrance, and the second is the one that matters:
 * approval is granted to a *specific* plan (§17). If the plan changed after it
 * was approved, the gate was satisfied for a different document, and running
 * anyway would execute work no human ever read.
 */
export async function runRunCommand(
  options: { taskId?: string },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const context = await buildExecutionContext({
      projectDir: globals.cwd,
      globalConfigPath: globals.globalConfigPath,
      onTaskStart: (taskId) => {
        if (globals.verbose) process.stdout.write(`  → ${taskId}\n`);
      },
      onTaskFinish: (result) => {
        const mark = result.status === 'completed' ? '✓' : '✗';
        process.stdout.write(`  ${mark} ${result.task} (${result.status})\n`);
      },
    });

    const state = await context.store.loadCurrentRun();
    if (state === null) {
      process.stderr.write('No active run. Start one with: agent-flow feature "<description>"\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const plan = await loadPlan(context.store, state.runId);
    if (plan === null) {
      process.stderr.write('This run has no plan yet.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    if (context.config.global.approval.requiredBeforeImplementation) {
      if (!state.approved) {
        process.stderr.write(
          'This plan has not been approved.\n\nReview it, then: agent-flow approve\n',
        );
        return ExitCode.GATE_NOT_SATISFIED;
      }

      if (!approvalCoversPlan(state, plan)) {
        process.stderr.write(
          [
            'The plan changed after it was approved.',
            '',
            'Approval applies to a specific plan, not to the run. Re-read it and',
            'approve again: agent-flow approve',
            '',
          ].join('\n'),
        );
        return ExitCode.GATE_NOT_SATISFIED;
      }
    }

    const sdd = await context.store.readArtifact(state.runId, 'sdd');
    if (sdd === null) {
      process.stderr.write('This run has no SDD, which the implementation agent requires.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    // Resume from what was persisted: work already completed is not paid for
    // twice, and a killed terminal is a normal event.
    const previous = Object.fromEntries(
      state.tasks.map((task) => [task.id, task.state as TaskState]),
    );

    if (globals.dryRun) {
      process.stdout.write(`Execution plan for ${state.runId}\n\n`);
      for (const task of plan.tasks) {
        const role = routeTask(task);
        const done = previous[task.id] === 'completed' ? ' (already completed)' : '';
        process.stdout.write(
          `  ${task.id}  ${role.padEnd(18)} ${explainRouting(task).padEnd(28)}${done}\n`,
        );
      }
      process.stdout.write('\nNo runner was invoked.\n');
      return ExitCode.OK;
    }

    const selected =
      options.taskId === undefined
        ? plan
        : { ...plan, tasks: plan.tasks.filter((task) => task.id === options.taskId) };

    if (selected.tasks.length === 0) {
      process.stderr.write(`No task ${options.taskId ?? ''} in this plan.\n`);
      return ExitCode.EXECUTION_ERROR;
    }

    if (options.taskId !== undefined) {
      // A single task still respects its dependencies: running one on top of
      // work that was never done produces a result nobody can trust.
      const target = selected.tasks[0];
      const unmet = (target?.dependencies ?? []).filter(
        (dep) => previous[dep] !== 'completed',
      );
      if (unmet.length > 0) {
        process.stderr.write(
          `${options.taskId} depends on ${unmet.join(', ')}, which ${
            unmet.length === 1 ? 'has' : 'have'
          } not completed.\n`,
        );
        return ExitCode.GATE_NOT_SATISFIED;
      }
    }

    process.stdout.write(`Running ${state.runId} — ${String(selected.tasks.length)} task(s)\n\n`);

    const outcome = await context.scheduler.run(
      options.taskId === undefined ? plan : selected,
      state.runId,
      sdd,
      previous,
    );

    process.stdout.write('\n');

    if (outcome.complete) {
      await context.store.updateRun(state.runId, (current) => ({
        ...current,
        stage: 'implementation',
      }));
      process.stdout.write('All tasks completed.\n\nNext: agent-flow review\n');
      return ExitCode.OK;
    }

    process.stdout.write(`Stopped: ${outcome.haltedBy ?? 'not all tasks completed'}.\n`);

    if (outcome.blocked.length > 0) {
      process.stdout.write(
        `Blocked by that failure: ${outcome.blocked.join(', ')}\n`,
      );
    }

    const needsHuman = outcome.results.filter(
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
 * Retry is explicit and bounded (§23). The scheduler deliberately never retries
 * on its own, because an automatic loop would keep paying for the same failure.
 */
export async function runRetryCommand(
  taskId: string,
  options: { force?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const context = await buildExecutionContext({
      projectDir: globals.cwd,
      globalConfigPath: globals.globalConfigPath,
    });

    const state = await context.store.loadCurrentRun();
    if (state === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const entry = state.tasks.find((task) => task.id === taskId);
    if (entry === undefined) {
      process.stderr.write(`${taskId} has not run in this run.\n`);
      return ExitCode.EXECUTION_ERROR;
    }

    if (entry.state === 'blocked' && options.force !== true) {
      // BLOCKED means a decision is missing (§20). Re-running the same prompt
      // produces the same gap, or a guess — which is worse.
      process.stderr.write(
        [
          `${taskId} is BLOCKED: it stopped because something the SDD does not answer.`,
          '',
          'Retrying will not supply that answer. Fix the SDD or the plan, or force',
          'the retry deliberately with --force.',
          '',
        ].join('\n'),
      );
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const maxAttempts = context.config.global.retry.maxAttempts;
    if (entry.attempts >= maxAttempts && options.force !== true) {
      process.stderr.write(
        `${taskId} has already been attempted ${String(entry.attempts)} times ` +
          `(limit ${String(maxAttempts)}). Use --force to try again.\n`,
      );
      return ExitCode.GATE_NOT_SATISFIED;
    }

    await context.store.updateRun(state.runId, (current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === taskId ? { ...task, state: 'queued' as const } : task,
      ),
    }));
    await context.store.appendEvent(state.runId, 'task_requeued', {
      task: taskId,
      forced: options.force === true,
    });

    process.stdout.write(`${taskId} is queued again.\n\nRun it with: agent-flow run\n`);
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}
