import {
  approve,
  reject,
  type ActionError,
  type ActionOutcome,
  type RunActionDeps,
} from '../app/run-actions.js';
import { StateStore } from '../app/state-store.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { nodeAdapters } from './adapters.js';
import type { GlobalOptions } from './index.js';

/**
 * `agent-flow approve` — the gate before anything is implemented (§17).
 *
 * A thin adapter now. The refusals are still the point of the command, but they
 * are decided in `app/run-actions.ts`, which the local server calls too: the gate
 * has to hold identically whether it is opened from a terminal or from a browser,
 * and two implementations of it would eventually disagree in silence.
 *
 * What is left here is what a CLI is for — turning an outcome into words and an
 * exit code.
 */
export async function runApproveCommand(
  options: { force?: boolean },
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run to approve.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await approve(deps, runId, { force: options.force === true });

    // Printed either way, and before the decision: someone approving a degraded
    // run should know what was lost while they still have the choice (R-16).
    printWarnings(outcome);

    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    if (outcome.value.forced) {
      process.stdout.write('Overrode the review gate because --force was given.\n\n');
    }

    process.stdout.write(
      [
        `Approved ${outcome.value.runId} — ${String(outcome.value.taskCount)} tasks.`,
        '',
        'The approval is bound to this exact plan: revise it and the gate closes',
        'again.',
        '',
        'Next: agent-flow run',
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

/** `agent-flow reject` — closes a run without implementing it. */
export async function runRejectCommand(
  reason: string | undefined,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  try {
    const deps = actionDeps(globals);
    const runId = await currentRunId(deps);
    if (runId === null) {
      process.stderr.write('No active run to reject.\n');
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const outcome = await reject(deps, runId, reason);
    if (!outcome.ok) {
      process.stderr.write(`${render(outcome.error)}\n`);
      return exitCodeFor(outcome.error);
    }

    process.stdout.write(`Rejected ${outcome.value.runId}.\n`);
    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

/**
 * A refusal as the CLI shows it: what happened, then what to do about it.
 *
 * `--force` is named where it applies and nowhere else. The use case reports which
 * refusals are forcible, so this does not keep its own list — a copy of that list
 * is a thing that can be wrong.
 */
export function render(error: ActionError): string {
  const lines = [error.message];

  if (error.action !== undefined) lines.push('', error.action);
  if (error.forcible === true) {
    lines.push('', 'Or --force, which is recorded on the run as a degradation.');
  }

  const findings = error.detail?.['findings'];
  if (Array.isArray(findings)) {
    lines.push('');
    for (const finding of findings as {
      severity: string;
      description: string;
      suggestedAction: string;
    }[]) {
      lines.push(
        `  [${finding.severity}] ${finding.description}`,
        `      → ${finding.suggestedAction}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * The exit code a refusal deserves.
 *
 * Only `run_busy` is separated out, and for a practical reason: it is the one refusal
 * where retrying unchanged is the right thing to do, so a script needs to be able to
 * tell it apart without parsing the message.
 */
export function exitCodeFor(error: ActionError): ExitCodeValue {
  return error.code === 'run_busy' ? ExitCode.RUN_BUSY : ExitCode.GATE_NOT_SATISFIED;
}

export function printWarnings(outcome: ActionOutcome<unknown>): void {
  if (outcome.warnings.length === 0) return;
  for (const warning of outcome.warnings) process.stdout.write(`⚠ ${warning}\n`);
  process.stdout.write('\n');
}

/** The real adapters plus this invocation's project. What a use case needs. */
export function actionDeps(globals: GlobalOptions): RunActionDeps {
  return {
    ...nodeAdapters(),
    projectDir: globals.cwd,
    globalConfigPath: globals.globalConfigPath,
    // Which entry point is asking. Written into the execution lock, so a person
    // refused by one can see whether the other is what has it.
    owner: 'cli',
  };
}

/**
 * The run every CLI action operates on.
 *
 * The CLI has always acted on `.agent-flow/current-run` and says so in its help;
 * the use cases take an explicit run id, because the write API can name any run
 * the dashboard shows. This is where the CLI's convention is applied — once, in
 * one place, rather than inside each command.
 */
export async function currentRunId(deps: RunActionDeps): Promise<string | null> {
  const store = new StateStore({
    fs: deps.fs,
    clock: deps.clock,
    projectDir: deps.projectDir,
  });
  return store.currentRunId();
}
