import { REASONING_ORDER, type ReasoningLevel } from '../contracts/index.js';
import type { ProbeOutcome } from '../core/health.js';
import type { AgentRunner } from '../ports/index.js';

/**
 * The cheapest possible question.
 *
 * Short enough to cost almost nothing, and specific enough that a runner which
 * answers it is genuinely working rather than merely reachable. The answer is
 * never inspected: what matters is that the call completed, not what it said.
 * Judging the reply would turn output quality into an environment verdict, and
 * that is the confusion the fallback policy exists to prevent.
 */
export const PROBE_PROMPT = 'Reply with the single word: ok';

/** Kept low deliberately: a probe that hangs is a probe nobody runs. */
export const PROBE_TIMEOUT_SECONDS = 60;

export interface ProbeResult {
  readonly id: string;
  readonly outcome: ProbeOutcome;
  readonly durationMs: number;
  /** The runner's own message on failure. Never a credential, never inferred. */
  readonly detail?: string;
}

export interface ProbeOptions {
  readonly workingDirectory: string;
  readonly timeoutSeconds?: number;
}

/**
 * Asks a runner to actually do something, and reports what happened.
 *
 * Opt-in from the CLI, because this spends quota on every runner — the reason
 * the shallow check never does it, and the reason it stays a separate flag.
 *
 * Goes through `AgentRunner` and nothing else. There is no branch here for a
 * particular CLI, no flag, no provider name: a runner that can be registered can
 * be probed, and adding one must not require touching this file.
 *
 * Read-only permissions, and the lowest effort the runner supports. A health
 * check has no business being allowed to write, and paying for reasoning to
 * answer "ok" would be spending the quota this exists to protect.
 */
export async function probeRunner(
  runner: AgentRunner,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const result = await runner.run({
    prompt: PROBE_PROMPT,
    reasoning: cheapestReasoning(runner),
    workingDirectory: options.workingDirectory,
    permissions: 'read-only',
    timeoutSeconds: options.timeoutSeconds ?? PROBE_TIMEOUT_SECONDS,
  });

  if (result.ok) {
    return { id: runner.id, outcome: 'healthy', durationMs: result.durationMs };
  }

  return {
    id: runner.id,
    outcome: outcomeOf(result.errorCode),
    durationMs: result.durationMs,
    ...(result.raw.length === 0 ? {} : { detail: firstLine(result.raw) }),
  };
}

/**
 * The three infrastructure codes keep their identity; everything else collapses.
 *
 * `timeout`, `invalid_output`, `execution_failed` and `blocked` all mean the
 * runner was there and this particular call did not work out. Naming them
 * separately in a health report would invite treating a badly formatted answer
 * as a broken environment.
 */
function outcomeOf(errorCode: string): ProbeOutcome {
  switch (errorCode) {
    case 'auth_required':
      return 'auth_required';
    case 'quota_exceeded':
      return 'quota_exceeded';
    case 'runner_unavailable':
      return 'runner_unavailable';
    default:
      return 'execution_failed';
  }
}

function cheapestReasoning(runner: AgentRunner): ReasoningLevel {
  const supported = new Set(runner.capabilities().supportedReasoningLevels);
  return REASONING_ORDER.find((level) => supported.has(level)) ?? 'low';
}

function firstLine(raw: string): string {
  return raw.trim().split('\n')[0] ?? '';
}
