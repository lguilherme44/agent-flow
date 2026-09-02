import type {
  QualityConfig,
  ReviewResult,
  Task,
} from '../../contracts/index.js';
import { blockingFindings } from './decision.js';
import type { ProjectedFinding } from './findings.js';

/**
 * Which findings become work, and in what shape the generator already accepts (M6-05).
 *
 * **No second corrective generator.** `core/corrective-plan.ts` already turns findings
 * into tasks that re-enter the pipeline — routed by the assignment policy, isolated in a
 * worktree, validated and integrated like any other. §28 asks for exactly that, and it
 * has existed since MVP 3. What M6 adds is a different *trigger*: per-task review
 * findings rather than one run-level verdict.
 *
 * So this is a shim, deliberately thin: it selects and reshapes, and the mechanism that
 * does the work is untouched.
 *
 * Pure. It reads projections and produces a value; nothing here writes a plan.
 */

export interface CorrectiveSelection {
  /** In the shape `applyFixes` takes. `FAIL` because there is something to correct. */
  readonly review: ReviewResult;
  /** What was selected, so a caller can record the link between finding and task. */
  readonly findings: readonly ProjectedFinding[];
}

/**
 * The findings that still need work, as a review the generator understands.
 *
 * **Only what is blocking and still open.** A finding already `fixed` has corrective work
 * behind it; one already `verified` has been looked at again; and a `low` or `info`
 * finding is worth reading and not worth a task. Generating for those would spend an
 * agent call on something nobody asked to change.
 *
 * `undefined` when there is nothing to do — which is the common case, and not a failure.
 */
export function correctiveSelection(input: {
  readonly findings: readonly ProjectedFinding[];
  readonly quality: QualityConfig;
  readonly reviewer: string;
}): CorrectiveSelection | undefined {
  const actionable = blockingFindings(input.findings, input.quality).filter(
    (held) => held.status === 'open' || held.status === 'acknowledged' || held.status === 'disputed',
  );

  if (actionable.length === 0) return undefined;

  return {
    findings: actionable,
    review: {
      verdict: 'FAIL',
      // Provenance the generator records on every task it creates. The reviewer is a
      // member id rather than a runner, which is what a team makes it.
      independence: 'cross-provider',
      reviewer: { runner: input.reviewer, reasoning: 'high' },
      findings: actionable.map((held) => held.finding),
      adjudications: [],
      residualRisks: [],
    },
  };
}

/**
 * Which corrective task addresses which finding, from the tasks the generator produced.
 *
 * Read off `correctiveFor.finding` rather than matched by description, because a
 * description is prose and two findings about one file can share most of it. The id is
 * carried precisely so this join is exact.
 */
export function correctiveLinks(added: readonly Task[]): { task: string; finding: string }[] {
  return added.flatMap((task) => {
    const finding = task.correctiveFor?.finding;
    return finding === undefined ? [] : [{ task: task.id, finding }];
  });
}
