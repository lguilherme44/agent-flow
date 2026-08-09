/**
 * Requirement → task coverage (§41).
 *
 * The spec asks the plan reviewer to notice that "FR-004 has no implementation
 * task". Asking a model to do arithmetic over two lists is both unreliable and
 * expensive when the check is this mechanical — so it runs as code, before any
 * reviewer is invoked, and cannot be argued out of.
 *
 * Two distinct questions live here, and conflating them breaks real plans:
 *
 *   - **Coverage**: every *functional* requirement needs at least one task.
 *     Non-functional and security requirements are cross-cutting — "responses
 *     stay under 200ms" is not something one task owns — so demanding a
 *     dedicated task for each would push planners into inventing filler work.
 *   - **Existence**: every requirement a task cites must appear in the SDD, of
 *     *any* kind. A task legitimately citing NFR-003 is good practice; a task
 *     citing an id nobody wrote is a hallucination.
 */

export interface CoverageInput {
  readonly id: string;
  readonly requirements: readonly string[];
}

export interface UnknownRequirement {
  readonly task: string;
  readonly requirement: string;
}

export interface CoverageResult {
  readonly ok: boolean;
  /** Requirements that had to be covered but were not. */
  readonly uncoveredRequirements: string[];
  /** Requirements a task cites that the SDD never defines, of any kind. */
  readonly unknownRequirements: UnknownRequirement[];
  readonly problems: string[];
}

export interface CoverageOptions {
  /** Everything the SDD defines — used to judge whether a citation is real. */
  readonly declared: readonly string[];
  /** The subset that must each have a task. Defaults to the functional ones. */
  readonly mustBeCovered?: readonly string[];
}

export function checkCoverage(
  options: CoverageOptions,
  tasks: readonly CoverageInput[],
): CoverageResult {
  const declared = new Set(options.declared);
  const mustBeCovered = new Set(
    options.mustBeCovered ?? options.declared.filter((id) => id.startsWith('FR-')),
  );

  const implemented = new Set<string>();
  const unknownRequirements: UnknownRequirement[] = [];

  for (const task of tasks) {
    for (const requirement of task.requirements) {
      // A planner inventing FR-099 would otherwise produce a plan that looks
      // fully covered while implementing something nobody specified.
      if (declared.has(requirement)) implemented.add(requirement);
      else unknownRequirements.push({ task: task.id, requirement });
    }
  }

  const uncoveredRequirements = [...mustBeCovered]
    .filter((id) => !implemented.has(id))
    .sort();

  const problems: string[] = [];
  for (const requirement of uncoveredRequirements) {
    problems.push(`${requirement} has no implementation task`);
  }
  for (const { task, requirement } of unknownRequirements) {
    problems.push(`task ${task} references ${requirement}, which the SDD does not define`);
  }

  return {
    ok: problems.length === 0,
    uncoveredRequirements,
    unknownRequirements,
    problems,
  };
}
