import { BYTES_PER_TOKEN } from './prompt-budget.js';

/**
 * Whether a task can fit in the window at all, decided before any model is called.
 *
 * `measurePromptComposition` already weighs the prompt the harness assembles. That is the
 * static half, and on its own it clears a task that cannot possibly finish: a run measured
 * in November 2026 opened with ≈8 600 tokens of preamble against a 49 152 window — 18 %,
 * comfortably under every warning — and then died without editing a single file, because
 * the one service it had to change is 76 kB on disk and an agent reads such a file more
 * than once. It opened that file 94 times.
 *
 * The missing half is the cost the agent is *about* to incur. It is knowable from `wc -c`
 * and costs no tokens to compute:
 *
 *     working  = contextWindow − preamble − outputReserve
 *     affords  = working ÷ largest target file, in tokens
 *
 * The same task, same prompt and same weights, with the window raised to 131 072: the
 * ratio went from 1,6 to 5,7 and the run produced 7 files, 513 lines and 43 passing tests.
 * Two observations, so the thresholds below are calibrated, not derived — see
 * `READS_FOR_COMFORT`.
 *
 * Pure, and it decides nothing on its own: it returns a verdict for a caller to act on,
 * the same division of labour as `measurePromptComposition`. A review proposes and a gate
 * decides.
 */

/** A file the work is expected to change, and its size on disk. */
export interface TargetFile {
  readonly path: string;
  readonly bytes: number;
}

export interface TaskBudgetInput {
  /** The runner's declared window. Absent means the operator never said, and nothing is inferred. */
  readonly contextWindow?: number;
  /** What the harness spends before the task starts. Measured, not assumed. */
  readonly preambleTokens: number;
  /** Room kept for the reply and tool traffic. */
  readonly outputReserveTokens: number;
  readonly targets: readonly TargetFile[];
}

export type BudgetVerdict = 'unknown' | 'impossible' | 'tight' | 'fits';

export interface TaskBudget {
  readonly verdict: BudgetVerdict;
  /** Tokens left for reading, editing and testing. Zero when the preamble already exceeds the window. */
  readonly workingTokens: number;
  readonly largestTarget?: { readonly path: string; readonly tokens: number };
  /** How many times the largest target fits in what is left. Absent when there is no target. */
  readonly readsAfforded?: number;
  /** One sentence naming the file to split around, not just the fact that it is big. */
  readonly detail: string;
}

/**
 * Below this the run is not at risk, it is arithmetically out of room: an agent that reads
 * the file, reasons, re-reads and edits needs it resident more than twice.
 */
export const READS_FOR_IMPOSSIBLE = 2;

/**
 * Measured, not derived. 1,6 failed without one edit; 5,7 finished the same task. Four is
 * the midpoint rounded towards the failure, and it is a threshold to calibrate against a
 * corpus, not a constant to trust.
 */
export const READS_FOR_COMFORT = 4;

/**
 * Room kept for the reply and the tool traffic around it, when the caller has no better
 * number. The local endpoint measured in November 2026 was configured for 8 192 output
 * tokens, and a stage that fills its window with reading has nothing left to answer with.
 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;

const toTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

/** One task weighed, with the id that names it in the plan. */
export interface TaskFit {
  readonly task: string;
  readonly budget: TaskBudget;
}

/**
 * Which tasks in a plan cannot fit, decided before a single one runs.
 *
 * Separate from `measureTaskBudget` because the unit of the decision is different: the
 * stage event answers "how did this attempt go", and approval answers "should any of this
 * start". The person approving is the one who can still split a task; after `run` the
 * cheapest remedy is gone.
 *
 * Sizes arrive already measured, so this stays pure and a test can state a repository's
 * shape without writing one.
 */
export function weighPlan(input: {
  readonly tasks: readonly { readonly id: string; readonly files: readonly string[] }[];
  readonly sizes: ReadonlyMap<string, number>;
  readonly contextWindow?: number;
  readonly preambleTokens: number;
  readonly outputReserveTokens?: number;
}): readonly TaskFit[] {
  const reserve = input.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  return input.tasks.map((task) => ({
    task: task.id,
    budget: measureTaskBudget({
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
      preambleTokens: input.preambleTokens,
      outputReserveTokens: reserve,
      // A path with no measured size is omitted rather than counted as zero, for the same
      // reason the stage skips a missing file: a task that creates one has nothing to read.
      targets: task.files.flatMap((path) => {
        const bytes = input.sizes.get(path);
        return bytes === undefined ? [] : [{ path, bytes }];
      }),
    }),
  }));
}

export function measureTaskBudget(input: TaskBudgetInput): TaskBudget {
  const { contextWindow, preambleTokens, outputReserveTokens, targets } = input;

  // Nothing is inferred. Assuming a frontier window is what makes the failure late and
  // expensive; assuming a small one would refuse runs that never had a problem.
  if (contextWindow === undefined) {
    return {
      verdict: 'unknown',
      workingTokens: 0,
      detail: 'no context window declared for this runner, so the fit cannot be checked',
    };
  }

  const workingTokens = Math.max(0, contextWindow - preambleTokens - outputReserveTokens);

  const largest = targets.reduce<TargetFile | undefined>(
    (worst, file) => (worst === undefined || file.bytes > worst.bytes ? file : worst),
    undefined,
  );

  // No target named is not the same as nothing to read, and saying "fits" here would be a
  // guess wearing a verdict's clothes.
  if (largest === undefined) {
    return {
      verdict: 'unknown',
      workingTokens,
      detail: `${String(workingTokens)} tokens of working room, but no target file was named`,
    };
  }

  const largestTokens = toTokens(largest.bytes);
  const readsAfforded =
    largestTokens === 0 ? Number.POSITIVE_INFINITY : workingTokens / largestTokens;

  const verdict: BudgetVerdict =
    readsAfforded < READS_FOR_IMPOSSIBLE
      ? 'impossible'
      : readsAfforded < READS_FOR_COMFORT
        ? 'tight'
        : 'fits';

  const rounded = Number.isFinite(readsAfforded) ? readsAfforded.toFixed(1) : '∞';
  const detail =
    verdict === 'fits'
      ? `${String(workingTokens)} tokens of working room fit ${rounded} reads of ` +
        `${largest.path} (${String(largestTokens)} tokens), the largest target`
      : `${largest.path} is ${String(largestTokens)} tokens and only fits ${rounded} times in ` +
        `the ${String(workingTokens)} tokens left after preamble and reply — ` +
        `split the work so this file is not read alongside the rest, or raise the window`;

  return {
    verdict,
    workingTokens,
    largestTarget: { path: largest.path, tokens: largestTokens },
    readsAfforded,
    detail,
  };
}
