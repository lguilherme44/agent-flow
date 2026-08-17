import { ConfigError } from '../../config/loader.js';
import { PromptError } from '../../app/prompt-loader.js';
import { StageFailure } from '../../app/stage-runner.js';
import { PlanningRefusal } from '../../app/planning-pipeline.js';
import { StateError } from '../../app/state-store.js';
import { RoleResolutionError } from '../../core/role.js';
import { RegistryError } from '../../adapters/runners/registry.js';
import { DagError } from '../../core/dag.js';
import {
  consumesAttempt,
  defaultClassForRunnerError,
  failureClassDefinition,
} from '../../core/failure-classification.js';
import { ExitCode, type ExitCodeValue } from '../exit-codes.js';

export interface RenderedError {
  readonly message: string;
  readonly exitCode: ExitCodeValue;
}

/**
 * Turns an error into something a person can act on.
 *
 * A stack trace tells the user where our code was, not what they should do.
 * Configuration mistakes in particular are the most likely way this tool fails,
 * and they always have a concrete fix — so each known error type gets a hint
 * rather than a trace. Unknown errors keep their stack, because there the trace
 * genuinely is the most useful thing available.
 */
export function renderError(error: unknown): RenderedError {
  if (error instanceof ConfigError) {
    return { message: error.message, exitCode: ExitCode.CONFIG_ERROR };
  }

  if (error instanceof RoleResolutionError || error instanceof RegistryError) {
    return {
      message: `${error.message}\n\nRun \`agent-flow doctor\` to see which runners are available.`,
      exitCode: ExitCode.CONFIG_ERROR,
    };
  }

  if (error instanceof PromptError) {
    return { message: error.message, exitCode: ExitCode.CONFIG_ERROR };
  }

  // Before `StageFailure`, and a different sentence: nothing ran. A gate refused,
  // the code is Appendix A's, and the action is what resolves it. Nothing here
  // suggests retrying, on this runner or another — §6.4's refusals are not
  // overridden, they are met.
  //
  // The exit code follows the refusal's own `kind` rather than a code string matched
  // here. AR-01's C-01 requires `CONFIG_ERROR` for an uninitialised project, and every
  // repository refusal keeps `EXECUTION_ERROR`; which of the two a code is belongs to
  // the layer that raised it, not to the renderer.
  if (error instanceof PlanningRefusal) {
    return {
      message: `${error.message}\n\n${error.action}`,
      exitCode:
        error.kind === 'configuration' ? ExitCode.CONFIG_ERROR : ExitCode.EXECUTION_ERROR,
    };
  }

  if (error instanceof StageFailure) {
    return { message: renderStageFailure(error), exitCode: ExitCode.EXECUTION_ERROR };
  }

  if (error instanceof StateError || error instanceof DagError) {
    return { message: error.message, exitCode: ExitCode.EXECUTION_ERROR };
  }

  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return { message, exitCode: ExitCode.EXECUTION_ERROR };
}

/**
 * Stage failures get an explanation of what the code means, because the
 * difference between "you ran out of quota" and "the model produced something
 * unusable" changes what the user should do next — and one of them must never
 * look like it can be papered over by retrying elsewhere.
 */
function renderStageFailure(error: StageFailure): string {
  const hints: Record<string, string> = {
    quota_exceeded: 'The runner reported a usage limit. Retry later, or configure a fallback runner.',
    auth_required: 'The runner is not authenticated. Log in with its own CLI, then retry.',
    runner_unavailable: 'The runner could not be executed. Check `agent-flow doctor`.',
    timeout: 'The runner exceeded its timeout. Raise timeoutSeconds for this role if this is expected.',
    invalid_output:
      'The runner produced output that never satisfied the contract. This is not retried on ' +
      'another runner on purpose: a different model would hide the mismatch rather than fix it.',
    blocked: 'The agent stopped and reported BLOCKED. This needs a human decision, not a retry.',
    execution_failed: 'The runner failed. The original message is above.',
  };

  // The class first, because it is the sentence that changes what the reader does. The
  // transport code stays beside it rather than being replaced: the two are a refinement,
  // and someone matching on `execution_failed` in a script must still find it (AD-36).
  const definition = failureClassDefinition(error.failureClass);
  const parts = [
    `Stage "${error.stage}" failed: ${error.failureClass} (${error.errorCode})`,
    '',
    error.message,
  ];

  if (error.deniedCommand !== undefined) {
    // C-06: the escalation names the grant. "Grant something" is what AR §3.6 calls a
    // contract violation, and it is what this run reported before the classifier existed.
    parts.push('', `The runner was refused the tool "${error.deniedCommand}".`);
  }

  // Which advice is *more specific* wins, and specificity is decidable rather than a
  // matter of taste: when the class is the code's default refinement, the classifier
  // learned nothing the code did not already say, and the hint written for this terminal
  // is the better sentence. When the class is sharper than the default — a denied command
  // hiding inside `execution_failed` — the taxonomy's own action is the one that names
  // what to do, and the generic hint would bury it.
  const sharpened = defaultClassForRunnerError(error.errorCode) !== error.failureClass;
  const hint = hints[error.errorCode];

  if (sharpened && definition.humanAction !== undefined) {
    parts.push('', `Next: ${definition.humanAction}`);
  } else if (hint !== undefined) {
    parts.push('', hint);
  } else if (definition.humanAction !== undefined) {
    // No hint for this code. The taxonomy is what keeps an escalation from degrading into
    // "something failed, inspect logs" (AR §3.6).
    parts.push('', `Next: ${definition.humanAction}`);
  }

  if (!consumesAttempt(error.failureClass)) {
    // Worth saying out loud: the previous run reached for `retry --force` to work around
    // a counter that should never have moved (AD-37, I-22).
    parts.push('', 'This did not spend one of the task’s attempts.');
  }

  if (error.raw) parts.push('', '--- runner output (redacted) ---', error.raw.slice(0, 2000));

  return parts.join('\n');
}
