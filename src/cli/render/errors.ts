import { ConfigError } from '../../config/loader.js';
import { PromptError } from '../../app/prompt-loader.js';
import { StageFailure } from '../../app/stage-runner.js';
import { StateError } from '../../app/state-store.js';
import { RoleResolutionError } from '../../core/role.js';
import { RegistryError } from '../../adapters/runners/registry.js';
import { DagError } from '../../core/dag.js';
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

  const parts = [`Stage "${error.stage}" failed: ${error.errorCode}`, '', error.message];
  const hint = hints[error.errorCode];
  if (hint) parts.push('', hint);
  if (error.raw) parts.push('', '--- runner output ---', error.raw.slice(0, 2000));

  return parts.join('\n');
}
