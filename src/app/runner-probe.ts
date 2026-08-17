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

/**
 * The smallest question that cannot be answered without using a tool (AR-01).
 *
 * `supportsNonInteractive` says the process will not block on a prompt; it does not say
 * the agent may run the tools the work requires. One runner in the evidence run was
 * non-interactive and still failed — it asked to run a shell command, local policy demanded
 * a confirmation, nobody was present, and the run recorded a generic `execution_failed`.
 * No amount of asking "reply with ok" would have found that.
 *
 * **Minimal, read-only, and provider-neutral.** It asks the agent to observe the working
 * directory it was already given and report a count. It names no tool, because the core is
 * not allowed to know which tools a runner has (AD-13); a runner that cannot look will fail,
 * and the failure is the finding.
 *
 * The probe never escalates. It runs with `read-only` permissions and passes no
 * skip-permissions flag — that containment belongs to the runner (AD-14), and a health
 * check that granted itself more rights than the work gets would be measuring the wrong
 * environment. Repairing a missing grant is a later milestone's job; this one reports it.
 */
export const TOOL_USE_PROBE_PROMPT =
  'List the entries in the current working directory and reply with their count as a number.';

/** Kept low deliberately: a probe that hangs is a probe nobody runs. */
export const PROBE_TIMEOUT_SECONDS = 60;

/** What one effort, or one tool-use attempt, actually did. */
export interface ProbeStep {
  readonly outcome: ProbeOutcome;
  /** The runner's own message on failure. Never a credential, never inferred. */
  readonly detail?: string;
}

export interface EffortProbeResult extends ProbeStep {
  readonly reasoning: ReasoningLevel;
}

export interface ProbeResult {
  readonly id: string;
  readonly outcome: ProbeOutcome;
  readonly durationMs: number;
  /** The runner's own message on failure. Never a credential, never inferred. */
  readonly detail?: string;
  /**
   * One entry per effort exercised, when the caller asked for more than one.
   *
   * Absent for the default single-question probe, so an existing caller sees exactly the
   * shape it always saw. Present as a list rather than a verdict because "the runner is
   * broken" and "this runner cannot do `medium`" are different facts with different fixes,
   * and the second is the one AF-2026-002 needed.
   */
  readonly efforts?: readonly EffortProbeResult[];
  /** Present only when the tool-use probe was requested. */
  readonly toolUse?: ProbeStep;
}

export interface ProbeOptions {
  readonly workingDirectory: string;
  readonly timeoutSeconds?: number;
  /**
   * Exercise these efforts, one call each, instead of the single cheapest one.
   *
   * The gap this closes: `cheapestReasoning` asked the runner the one question it was
   * most likely to answer, so a pair that could not do `medium` looked healthy right up
   * until a task tried it.
   */
  readonly efforts?: readonly ReasoningLevel[];
  /** Also ask a question that cannot be answered without a tool. Off by default. */
  readonly toolUse?: boolean;
}

/**
 * Asks a runner to actually do something, and reports what happened.
 *
 * Opt-in from the CLI, because this spends quota on every runner — the reason
 * the shallow check never does it, and the reason it stays a separate flag. Asking for
 * several efforts or for a tool-use probe spends proportionally more, which is why neither
 * happens unless the caller says so.
 *
 * Goes through `AgentRunner` and nothing else. There is no branch here for a
 * particular CLI, no flag, no provider name: a runner that can be registered can
 * be probed, and adding one must not require touching this file.
 *
 * Read-only permissions throughout. A health check has no business being allowed to write.
 */
export async function probeRunner(
  runner: AgentRunner,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const timeoutSeconds = options.timeoutSeconds ?? PROBE_TIMEOUT_SECONDS;
  const efforts =
    options.efforts !== undefined && options.efforts.length > 0
      ? options.efforts
      : [cheapestReasoning(runner)];

  let durationMs = 0;
  const steps: EffortProbeResult[] = [];

  // Sequential on purpose. These are real invocations against real quota, and firing them
  // all at once is how a health check turns into a rate limit.
  for (const reasoning of efforts) {
    const result = await runner.run({
      prompt: PROBE_PROMPT,
      reasoning,
      workingDirectory: options.workingDirectory,
      permissions: 'read-only',
      timeoutSeconds,
    });

    durationMs += result.durationMs;
    steps.push({ reasoning, ...stepOf(result) });
  }

  let toolUseStep: ProbeStep | undefined;

  if (options.toolUse === true) {
    const result = await runner.run({
      prompt: TOOL_USE_PROBE_PROMPT,
      reasoning: cheapestReasoning(runner),
      workingDirectory: options.workingDirectory,
      // Never escalated. See TOOL_USE_PROBE_PROMPT.
      permissions: 'read-only',
      timeoutSeconds,
    });

    durationMs += result.durationMs;
    toolUseStep = stepOf(result);
  }

  // The worst thing that happened, because a runner that answers two of three questions is
  // not healthy — and the caller needs one word before it needs the breakdown.
  const failure =
    steps.find((step) => step.outcome !== 'healthy') ??
    (toolUseStep?.outcome !== undefined && toolUseStep.outcome !== 'healthy'
      ? toolUseStep
      : undefined);

  return {
    id: runner.id,
    outcome: failure?.outcome ?? 'healthy',
    durationMs,
    ...(failure?.detail === undefined ? {} : { detail: failure.detail }),
    // Reported only when the caller asked for a breakdown, so the default shape is
    // unchanged for every existing reader.
    ...(options.efforts !== undefined && options.efforts.length > 0 ? { efforts: steps } : {}),
    ...(toolUseStep === undefined ? {} : { toolUse: toolUseStep }),
  };
}

function stepOf(result: Awaited<ReturnType<AgentRunner['run']>>): ProbeStep {
  if (result.ok) return { outcome: 'healthy' };

  return {
    outcome: outcomeOf(result.errorCode),
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
