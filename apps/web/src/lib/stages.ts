/**
 * Pipeline order, for the browser.
 *
 * A local copy, and on purpose. `RUN_STAGES` and `PIPELINE_STAGES` live in
 * `src/contracts`, next to the Zod schemas that validate them — importing either
 * one as a *value* would pull the whole contracts module, and Zod with it, into a
 * bundle whose every other import from there is type-only.
 *
 * A copy that can drift is worse than no copy, so it does not get to drift:
 * `stages.test.ts` imports the real lists and asserts these are identical. The
 * copy is checked by a test rather than by a comment.
 */

/** The nine stages a run's `stage` field can name. Mirrors `RUN_STAGES`. */
export const RUN_STAGE_ORDER = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'implementation',
  'code-review',
  'verification',
  'final-review',
] as const;

/**
 * The ten steps the pipeline *shows*. Mirrors `PIPELINE_STAGES`.
 *
 * One more than the list above: `approval` is a step in the reader's mental model
 * with nothing that executes for it, so it can appear in a pipeline and never in
 * `state.stage`.
 */
export const PIPELINE_STAGE_ORDER = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'approval',
  'implementation',
  'code-review',
  'verification',
  'final-review',
] as const;

/** Where a stage sits in the pipeline; unknown stages sort last. */
export function stageIndex(stage: string): number {
  const index = PIPELINE_STAGE_ORDER.indexOf(stage as (typeof PIPELINE_STAGE_ORDER)[number]);
  return index === -1 ? PIPELINE_STAGE_ORDER.length : index;
}

/**
 * The stages present in a set of runs, in pipeline order.
 *
 * Derived from the data rather than offered wholesale: a filter listing eight
 * stages when the history only reaches three is eight options, five of which
 * silently return nothing.
 */
export function stagesPresent(stages: readonly string[]): string[] {
  return [...new Set(stages)].sort((a, b) => stageIndex(a) - stageIndex(b));
}
