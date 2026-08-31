import { cancel, pause, resume } from '../app/run-actions.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { actionDeps, currentRunId, exitCodeFor, printWarnings, render } from './approve.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow pause`, `resume` and `cancel` (PRI-14, PRI-15).
 *
 * Thin, like every command in this directory: each gate, each state transition and each
 * refusal lives in `app/run-actions.ts`, because the dashboard calls the same functions.
 * "The UI and the terminal cannot disagree about a gate" is only true when there is one
 * implementation of the gate.
 *
 * What is genuinely here is the *sentence*. These three commands are the ones an operator
 * reaches for when something is going wrong, and each has a different next step: pause
 * says what is still finishing, resume says what it started, cancel says what it kept.
 */

/**
 * `agent-flow pause` — stop starting work.
 *
 * Never immediate, and says so. The task in flight runs to its end because its result file
 * is written once, at the end, and severing it would throw away work already paid for.
 */
export async function runPauseCommand(globals: GlobalOptions): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await pause(deps, runId);
    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    const { alreadyPaused, executing, pauseRequestedAt } = outcome.value;

    process.stdout.write(
      alreadyPaused
        ? `${runId} was already paused, since ${pauseRequestedAt}.\n`
        : executing
          ? `${runId} is pausing.\n\n` +
            'A task is in flight and will finish — its work is already paid for, and\n' +
            'there is no partial result to keep. Nothing further will start.\n\n' +
            'Watch it with: agent-flow status\n'
          : `${runId} is paused. Nothing was running.\n`,
    );

    printWarnings(outcome);
    process.stdout.write('\nContinue with: agent-flow resume\n');
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * `agent-flow resume` — clear the pause and carry on.
 *
 * Runs the plan through the same `start` the ordinary command uses, so every gate applies
 * exactly once and in one place.
 */
export async function runResumeCommand(globals: GlobalOptions): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    process.stdout.write(`Resuming ${runId}\n\n`);

    const outcome = await resume(deps, runId);
    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    printWarnings(outcome);

    const { outcome: scheduled } = outcome.value;
    process.stdout.write(
      scheduled.planComplete
        ? '\nEvery task completed.\n\nReview it with: agent-flow review\n'
        : `\nStopped: ${scheduled.haltedBy ?? 'not all tasks completed'}.\n`,
    );

    return scheduled.complete ? ExitCode.OK : ExitCode.GATE_NOT_SATISFIED;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * `agent-flow cancel` — end the run and the agents it is running.
 *
 * Terminal, and the output says what survived rather than only what stopped. A cancelled
 * run is the one somebody is most likely to want to read: nothing is deleted, and an
 * operator who is not told that will assume the opposite and re-run work that is still
 * on disk.
 *
 * `--yes` exists because this is irreversible and because a confirmation nobody can script
 * past is a confirmation people work around. The prompt is the default; the flag is the
 * deliberate act.
 */
export async function runCancelCommand(
  options: { yes?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    if (options.yes !== true) {
      process.stderr.write(
        `Cancelling ${runId} is not reversible.\n\n` +
          'Running agents are terminated, and a task that was mid-edit leaves its\n' +
          'workspace wherever it had reached. Nothing is deleted: the integration\n' +
          'branch, the worktrees and every attempt artifact stay on disk.\n\n' +
          'Confirm with: agent-flow cancel --yes\n',
      );
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await cancel(deps, runId);
    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    const { alreadyCancelled, interrupted, executing } = outcome.value;

    if (alreadyCancelled) {
      process.stdout.write(`${runId} was already cancelled.\n`);
      return ExitCode.OK;
    }

    const lines = [`${runId} is cancelled.`, ''];

    if (interrupted.length > 0) {
      lines.push(
        `Interrupted mid-flight: ${interrupted.join(', ')}.`,
        'Each left its workspace wherever the agent had reached.',
        '',
      );
    }

    if (executing) {
      lines.push(
        'A process was executing this run. It observes the cancellation and',
        'terminates its agents; give it a moment.',
        '',
      );
    }

    lines.push(
      'Nothing was deleted. The integration branch, the worktrees and every',
      'attempt artifact are still on disk — inspect them with `agent-flow status`',
      'or clean them up deliberately with `agent-flow clean`.',
      '',
    );

    process.stdout.write(lines.join('\n'));
    printWarnings(outcome);
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}
