import type { Task } from '../contracts/index.js';

/**
 * What a prompt is made of, and whether that is proportionate (AR-09).
 *
 * **Autonomy must not be bought with context explosion.** A one-`grep` call in the
 * evidence environment reported ≈49 000 input tokens before Agent Flow contributed
 * anything of its own, and the repository's global rule block had already been truncated
 * from ≈25 k to ≈24 k characters on the way in. Recovery then adds a Failure Context
 * Packet to *that*, which is why §6.5's budgets are as conservative as they are and why
 * the packet carries a diff `--stat` rather than a patch.
 *
 * The measurement is the deliverable. "The prompt got big" is not something anybody can
 * act on; "`AGENTS.md` is 31 kB of a 38 kB prompt, on a task classified trivial" names the
 * file to shrink and the reason to bother.
 *
 * Pure, and it changes nothing about what is sent. AR-09's non-goals are explicit: no
 * change to MVP 3's advisory context, and no prompt rewriting.
 */

/**
 * Where a byte of prompt came from. Five sources, five different owners.
 *
 * `collaboration` joined in M4 and is the one an operator can turn off outright, which is
 * exactly why it has to be attributable: "the prompt got big" is not actionable, and
 * "the team context is 40% of it" names both the cause and the switch.
 */
export type PromptSource =
  | 'stagePrompt'
  | 'advisory'
  | 'agentsMd'
  | 'failureContext'
  | 'collaborationBootstrap'
  | 'collaboration';

export interface PromptPart {
  readonly source: PromptSource;
  readonly bytes: number;
  /** Percentage of the whole, rounded. What makes one part comparable to another. */
  readonly share: number;
}

export interface PromptComposition {
  readonly totalBytes: number;
  /** Largest first, so the thing worth shrinking is the thing read first. */
  readonly parts: readonly PromptPart[];
  /** True when a `trivial` task received more than the documented ceiling. */
  readonly overCeiling: boolean;
  /** Which source pushed it over, named. Absent unless `overCeiling`. */
  readonly ceilingDetail?: string;
  /**
   * True when the prompt is close enough to the runner's declared context window
   * to be worth saying so before the call.
   *
   * A different question from `overCeiling`, and deliberately not folded into it.
   * That one is about *proportion* — a task called trivial receiving more context
   * than the repository's own standing rules. This one is about *capacity*: a
   * window is a wall, and hitting it is not a smell but a refused request.
   *
   * Absent for every runner that does not declare `contextWindow`, which is all of
   * them until an operator says otherwise.
   */
  readonly nearModelWindow?: boolean;
  /** What was measured against what, when `nearModelWindow`. */
  readonly windowDetail?: string;
}

/**
 * How much context a task classified `trivial` may receive before it is worth a warning.
 *
 * 24 kB, chosen against the one measurement there is: the evidence environment truncated a
 * global rule block from ≈25 k to ≈24 k characters, and a task the planner called trivial
 * receiving more than that whole block is receiving more than the repository's own
 * standing rules.
 *
 * A warning rather than a limit. Nothing here refuses to send a prompt — the ceiling is
 * about *proportion*, and a person who knows why their `AGENTS.md` is large is entitled to
 * keep it.
 */
export const TRIVIAL_CONTEXT_CEILING_BYTES = 24 * 1024;

export interface PromptParts {
  readonly stagePrompt: string;
  readonly agentsMd: string;
  /** MVP 3's retrieval block, when a utility model produced one. */
  readonly advisory: string;
  /** AD-40's packet, when this is a retry. */
  readonly failureContext: string;
  /**
   * The invitation: the channel exists and here is its contract (M5).
   *
   * **Separate from `collaboration` because the two answer different questions.** M4
   * measured one number — 1 373 bytes on every prompt — which could not distinguish what
   * *availability* cost from what *relevance* cost. It turned out to be almost all
   * availability: five agents received it and one had anything to read. Two sources make
   * that visible on every run rather than only in a dogfood.
   */
  readonly collaborationBootstrap: string;
  /**
   * What other agents actually said that concerns this agent.
   *
   * Empty on the ordinary task, which is the point. An empty source is *omitted* from the
   * composition rather than reported at zero — so "no relevant activity" and "the feature
   * is off" do not both render as a row of zeroes.
   */
  readonly collaboration: string;
}

/**
 * Bytes per token, for turning a measured prompt into the unit a window is in.
 *
 * 3.8 rather than 4, measured rather than assumed: a 38.822-byte stage prompt was
 * counted by a real server at 10.262 tokens. Deliberately a rough number — the
 * question it answers is "is this close to the wall", and a tokenizer per model
 * would be precision nobody acts on differently.
 */
const BYTES_PER_TOKEN = 3.8;

/**
 * How much of the window may be spent on the prompt before it is worth warning.
 *
 * The remainder is not slack: it is what the turn needs to *work* — tool
 * definitions, the model's own output, and whatever the agent reads on the way.
 * At 80% a stage still runs; at 100% the server refuses, mid-task, with the work
 * already done.
 */
const WINDOW_WARN_SHARE = 0.8;

export function measurePromptComposition(
  parts: PromptParts,
  task?: Pick<Task, 'complexity'>,
  /** The runner's declared window, in tokens. Absent unless configured. */
  contextWindow?: number,
): PromptComposition {
  const measured: { source: PromptSource; bytes: number }[] = (
    [
      'stagePrompt',
      'agentsMd',
      'advisory',
      'failureContext',
      'collaborationBootstrap',
      'collaboration',
    ] as const
  )
    .map((source) => ({ source, bytes: bytesOf(parts[source]) }))
    // A source that contributed nothing is omitted rather than reported at zero: "no
    // advisory model is configured" and "the advisory block came back empty" are different
    // facts, and a row of zeroes tells them apart from neither.
    .filter((part) => part.bytes > 0);

  const totalBytes = measured.reduce((sum, part) => sum + part.bytes, 0);

  const withShare = measured
    .map((part) => ({
      ...part,
      share: totalBytes === 0 ? 0 : Math.round((part.bytes / totalBytes) * 100),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  // The ceiling applies to `trivial` alone. A complex task legitimately receives a lot, and
  // warning there would train the reader to ignore the warning that matters.
  const overCeiling =
    task?.complexity === 'trivial' && totalBytes > TRIVIAL_CONTEXT_CEILING_BYTES;

  const largest = withShare[0];

  // Only when the operator declared a window. Nothing is inferred: assuming a
  // frontier window is what makes the failure late and expensive, and assuming a
  // small one would warn on every run that never had a problem.
  const estimatedTokens = Math.round(totalBytes / BYTES_PER_TOKEN);
  const nearModelWindow =
    contextWindow !== undefined && estimatedTokens > contextWindow * WINDOW_WARN_SHARE;

  return {
    totalBytes,
    parts: withShare,
    overCeiling,
    ...(nearModelWindow
      ? {
          nearModelWindow,
          windowDetail:
            `this prompt is about ${String(estimatedTokens)} tokens against a declared ` +
            `window of ${String(contextWindow)} — ` +
            `${String(Math.round((estimatedTokens / (contextWindow as number)) * 100))}% of it, ` +
            `leaving little for tools and the reply`,
        }
      : {}),
    ...(overCeiling && largest !== undefined
      ? {
          ceilingDetail:
            `a task classified trivial received ${describeBytes(totalBytes)} of context, ` +
            `over the ${describeBytes(TRIVIAL_CONTEXT_CEILING_BYTES)} ceiling — ` +
            `${largest.source} is ${String(largest.share)}% of it`,
        }
      : {}),
  };
}

export interface RecoveryCost {
  /** Negative when the retry was cheaper, which happens and is worth saying. */
  readonly addedBytes: number;
  readonly addedShare: number;
}

/**
 * What a retry's context cost against the attempt it replaced (AR-09).
 *
 * `undefined` when there is no baseline. A first attempt whose size nobody recorded cannot
 * be compared against, and reporting 0% or 100% would both be assertions nobody measured.
 */
export function recoveryCostAgainstBaseline(input: {
  readonly baselineBytes?: number;
  readonly retryBytes: number;
}): RecoveryCost | undefined {
  const baseline = input.baselineBytes;
  if (baseline === undefined || baseline <= 0) return undefined;

  const addedBytes = input.retryBytes - baseline;
  return { addedBytes, addedShare: Math.round((addedBytes / baseline) * 100) };
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

function describeBytes(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} kB`;
}
