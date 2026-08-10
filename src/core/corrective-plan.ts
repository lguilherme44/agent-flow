import {
  PlanSchema,
  type CorrectiveOriginStage,
  type Plan,
  type ReviewResult,
} from '../contracts/index.js';

/** Severity at or above which a finding becomes work rather than a note. */
const ORDER = ['low', 'medium', 'high', 'critical'] as const;

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
  readonly minSeverity?: (typeof ORDER)[number];
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
  const threshold = ORDER.indexOf(options.minSeverity ?? 'medium');
  const actionable = review.findings.filter(
    (finding) => ORDER.indexOf(finding.severity) >= threshold,
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
    complexity:
      finding.severity === 'critical' || finding.severity === 'high' ? 'complex' : 'normal',
    risk: finding.severity === 'critical' ? 'high' : finding.severity === 'high' ? 'medium' : 'low',
    dependencies: [],
    // Exactly what the finding said, and nothing more. The generator this
    // replaces wrote `FR-001` whenever a finding named no requirement, which
    // made an `out_of_scope` or `security` finding look like work against a
    // functional requirement nobody had connected it to.
    requirements: finding.requirement === undefined ? [] : [finding.requirement],
    correctiveFor: {
      stage: options.origin,
      findingType: finding.type,
      severity: finding.severity,
      ...(finding.requirement === undefined ? {} : { requirement: finding.requirement }),
      description: finding.description,
      ...(finding.file === undefined ? {} : { file: finding.file }),
    },
    files: { likely: finding.file === undefined ? [] : [finding.file] },
    acceptanceCriteria: [finding.suggestedAction],
    // The generator this replaces emitted an empty list, so a fix for a review
    // finding ran no validation at all — the one outcome this workflow exists
    // to prevent.
    validation: [...options.validation],
  }));

  return PlanSchema.parse({ ...plan, tasks: [...plan.tasks, ...fixes] });
}
