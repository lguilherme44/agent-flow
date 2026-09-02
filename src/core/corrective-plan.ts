import {
  PlanSchema,
  type CorrectiveOriginStage,
  type Plan,
  severityAtLeast,
  type FindingSeverity,
  type ReviewResult,
} from '../contracts/index.js';
import { deriveOverlapDependencies } from './file-overlap.js';

/**
 * Severity at or above which a finding becomes work rather than a note.
 *
 * The order comes from the contract rather than from a copy of it here. It was a copy
 * until `info` was added at the bottom and this file kept comparing against a four-value
 * list — two orderings of one concept, and the second one silently treated an `info`
 * finding as unrecognised.
 */

export interface FixOptions {
  /**
   * Validation ids the corrective tasks should run.
   *
   * Passed in rather than assumed: they have to resolve against the project's
   * own configuration, and an id that does not resolve fails a task for the
   * wrong reason. The caller knows the registry; this function must not guess.
   */
  readonly validation: readonly string[];
  /**
   * Which review produced these findings.
   *
   * Required, and deliberately not defaulted: the origin is the traceability a
   * corrective task has instead of a requirement, and a default would let a
   * caller record a provenance it never established.
   */
  readonly origin: CorrectiveOriginStage;
  /**
   * The origin of individual findings, when they did not all come from the same place.
   *
   * `agent-flow review --fix` carries two kinds at once: the run-level final review, and
   * the per-task code reviews M6 added. They are different statements and the vocabulary
   * distinguishes them, so a batch-wide origin would record `final-review` on work that a
   * code review asked for — losing exactly the traceability `'code-review'` was added for.
   *
   * Keyed by finding id. Run-level findings have none and fall through to `origin`.
   */
  readonly originFor?: ReadonlyMap<string, CorrectiveOriginStage>;
  readonly minSeverity?: FindingSeverity;
}

/**
 * Adds a corrective task per actionable finding, leaving the rest of the plan alone.
 *
 * §29 says findings re-enter the same pipeline — routed, executed and verified
 * like any other task — rather than being handed to a model to patch directly.
 * The point is that a fix passes through the same gates as the work it fixes.
 *
 * The plan changes, which means its hash changes, which means the approval
 * stops covering it. That is not a side effect to work around: the human
 * approved a set of tasks, and this is a different set. `agent-flow revise`
 * already behaves this way, and a correction round is no more exempt than a
 * revision is.
 *
 * Existing tasks are copied untouched. They have already run, and their results
 * on disk describe work that actually happened.
 */
export function applyFixes(plan: Plan, review: ReviewResult, options: FixOptions): Plan {
  const threshold = options.minSeverity ?? 'medium';
  const actionable = review.findings.filter((finding) =>
    severityAtLeast(finding.severity, threshold),
  );

  if (actionable.length === 0) return plan;

  // Continues the sequence rather than restarting it: a second review of an
  // already-corrected plan would otherwise produce a second FIX-001, and the
  // DAG would hold two tasks under one id.
  const existing = plan.tasks.filter((task) => task.id.startsWith('FIX-')).length;

  const fixes = actionable.map((finding, index) => ({
    id: `FIX-${String(existing + index + 1).padStart(3, '0')}`,
    title: finding.description.slice(0, 80),
    description: `${finding.description}\n\nSuggested action: ${finding.suggestedAction}`,
    // **Complexity is the shape of the work, not the weight of the finding** (AD-42).
    // Severity measures how much a defect *matters*; complexity measures how much work it
    // *is*. Mapping one to the other is a category error, and in the evidence run it put
    // the highest-effort model on a one-line test fix — all three corrections classified
    // `complex` because all three findings were `high`.
    //
    // Risk still follows severity, and correctly: a critical defect is a risky thing to
    // touch however small the edit.
    complexity: complexityOf(finding),
    risk: finding.severity === 'critical' ? 'high' : finding.severity === 'high' ? 'medium' : 'low',
    // Filled in below, from declared file overlap. Left empty here so the derivation has
    // one home rather than being half-computed in this literal.
    dependencies: [],
    // Exactly what the finding said, and nothing more. The generator this
    // replaces wrote `FR-001` whenever a finding named no requirement, which
    // made an `out_of_scope` or `security` finding look like work against a
    // functional requirement nobody had connected it to.
    requirements: finding.requirement === undefined ? [] : [finding.requirement],
    correctiveFor: {
      stage: originOf(finding, options),
      findingType: finding.type,
      // **Carried when the finding has one, which is what makes `fixed` a fact.** A
      // finding's status is projected, and `fixed` asks whether a corrective task for
      // *it* completed — unanswerable while the task carried the description and not the
      // id. The run-level reviews produce findings with no id, and those carry none.
      ...('id' in finding && typeof finding.id === 'string' ? { finding: finding.id } : {}),
      severity: finding.severity,
      ...(finding.requirement === undefined ? {} : { requirement: finding.requirement }),
      description: finding.description,
      ...(finding.file === undefined ? {} : { file: finding.file }),
    },
    // **The finding's category becomes the task's scope**, which is the field
    // `deriveTaskRequirements` already turns into a required skill. A `test-gap` finding
    // therefore asks for a member who declares `test-gap`, and a `security` one for a
    // member who declares `security` — which is how QA picks up the work that is QA's
    // (§34) without a role, a router or a mapping table to get wrong.
    scope: finding.type,
    files: { likely: finding.file === undefined ? [] : [finding.file] },
    acceptanceCriteria: [finding.suggestedAction],
    // The generator this replaces emitted an empty list, so a fix for a review
    // finding ran no validation at all — the one outcome this workflow exists
    // to prevent.
    validation: [...options.validation],
  }));

  // **Ordered by the files they share** (AD-42, C-16). The generator this replaces
  // hardcoded `dependencies: []`, and the evidence run's FIX-001 and FIX-002 both targeted
  // `test/cli/cli.test.ts` with nothing between them — same wave, same file, guaranteed
  // conflict, caught by a model call and then by a human writing a revision.
  //
  // Derived only among the *new* tasks: an existing task has already run, and adding an
  // edge to it would reorder work that is finished.
  //
  // Only the dependencies are taken from the result. The first version of this spread the
  // whole task through the overlap helper under a flattened `files` key and then stripped
  // that key on the way back — which deleted the task's real `files: { likely }` object,
  // so every generated fix came out declaring no files at all. Silent, because the plan
  // still parsed and the ordering it computed was correct; what broke was everything
  // downstream that asks a corrective task which files it will touch.
  const overlapOrder = deriveOverlapDependencies(
    fixes.map((fix) => ({ id: fix.id, dependencies: fix.dependencies, files: fix.files.likely })),
  );

  const ordered = fixes.map((fix, index) => ({
    ...fix,
    dependencies: overlapOrder[index]?.dependencies ?? fix.dependencies,
  }));

  return PlanSchema.parse({ ...plan, tasks: [...plan.tasks, ...ordered] });
}

/** Where one finding came from, falling back to the batch's origin. */
function originOf(
  finding: ReviewResult['findings'][number],
  options: FixOptions,
): CorrectiveOriginStage {
  const id = 'id' in finding && typeof finding.id === 'string' ? finding.id : undefined;
  if (id === undefined) return options.origin;
  return options.originFor?.get(id) ?? options.origin;
}

/**
 * How much work a correction is, from its shape (AD-42).
 *
 * A finding naming one file with one suggested action is a small edit; one naming no file
 * is a cross-cutting change nobody has localised yet, which is the harder case rather than
 * the easier one.
 */
function complexityOf(finding: ReviewResult['findings'][number]): 'trivial' | 'normal' | 'complex' {
  // No file named: the correction has to be located before it can be made.
  if (finding.file === undefined) return 'complex';

  // A test or documentation file with one action is the one-line fix that used to be
  // classified `complex` because the finding was `high`.
  if (/(^|\/)(test|tests|spec|docs)\//.test(finding.file) || /\.(md|txt)$/.test(finding.file)) {
    return 'trivial';
  }

  return 'normal';
}
