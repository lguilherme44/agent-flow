import type { RunStage } from '../contracts/index.js';
import type { WorkflowClass } from './adaptive-workflow.js';

/**
 * What a `--from <stage>` resume actually keeps, and what it pays for again (§D7).
 *
 * **Written because three surfaces promised something the pipeline does not do.** The
 * refusal after a failed stage, `agent-flow feature`'s own footer and `agent-flow status`
 * all said some version of *"the stages before this one are kept"*. Measured on a run that
 * timed out in `sdd` and was resumed with `--from sdd`: `stage_started` for **discovery**
 * appeared seven seconds later. Of the three stages before `sdd`, one was kept and one was
 * redone at full cost — ten minutes of a frontier model, on a promise.
 *
 * The cause is that the resume point reaches exactly two stages. `architecture-impact` and
 * `sdd` go through the pipeline's `stageOrExisting`, which compares the stage's index
 * against the resume point and reuses the artifact. `discovery` has its own cache, which
 * `high-risk` turns off on purpose so a plan is never built on a stale map; and `planning`
 * calls `planUntilChecksPass` directly, which never sees the resume point at all.
 *
 * So the rule is folded here, once, and the three sentences are generated from it. A
 * sentence written by hand is a sentence that goes stale the day the pipeline changes —
 * which is precisely what happened.
 */

/** The planning half, in the order the pipeline runs it. */
export const RESUMABLE_PLANNING_STAGES: readonly RunStage[] = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
];

/**
 * The two stages that honour a resume point, whatever the workflow class.
 *
 * Both reach it through `stageOrExisting`, and both reuse a persisted artifact. Named as a
 * constant rather than inlined so the fold below and the pipeline cannot drift apart
 * without one of them being edited.
 */
const REUSES_ARTIFACT: ReadonlySet<RunStage> = new Set(['architecture-impact', 'sdd']);

export interface PlanningResume {
  /** Stages before `from` whose artifact is reused: nothing is spent on these. */
  readonly kept: readonly RunStage[];
  /** Stages before `from` that run again, at full cost. */
  readonly rerun: readonly RunStage[];
}

/**
 * Which stages before `from` survive the resume.
 *
 * `high-risk` is the case worth knowing: it refreshes discovery deliberately (§the
 * pipeline's own note — a high-risk plan must not rest on a cached map), so on that class
 * discovery is always redone. On every other class it is reused unless the caller asked
 * for `--no-cache`.
 */
export function planningResume(
  from: RunStage,
  workflow: WorkflowClass,
  options: { readonly noCache?: boolean } = {},
): PlanningResume {
  const index = RESUMABLE_PLANNING_STAGES.indexOf(from);
  if (index <= 0) return { kept: [], rerun: [] };

  const before = RESUMABLE_PLANNING_STAGES.slice(0, index);
  const discoveryCached = workflow !== 'high-risk' && options.noCache !== true;

  const kept: RunStage[] = [];
  const rerun: RunStage[] = [];

  for (const stage of before) {
    const reused =
      REUSES_ARTIFACT.has(stage) || (stage === 'discovery' && discoveryCached);
    (reused ? kept : rerun).push(stage);
  }

  return { kept, rerun };
}
