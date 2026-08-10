import type { Plan } from '../../contracts/index.js';
import { buildDag, DagError } from '../../core/dag.js';
import { checkCoverage } from '../../core/coverage.js';
import { extractRequirementIds } from '../../core/sdd-validator.js';
import { unknownValidationIds, type ValidationRegistry } from '../../core/validation-registry.js';

/**
 * Mechanical checks a plan must pass before anyone is asked to review it.
 *
 * The spec asks the plan reviewer to notice missing coverage and bad ordering
 * (§16, §41). Those particular questions are arithmetic over two lists, and
 * arithmetic is not what a model should be spending a call on — nor something it
 * can be relied on to do exhaustively. Running them as code means the reviewer
 * receives a plan that is already structurally sound and can spend its attention
 * on judgement instead.
 *
 * Graph validation delegates to core/dag.ts rather than re-implementing cycle
 * detection here: one implementation of topological logic, enforced by an
 * architecture test.
 */
export function checkPlan(
  plan: Plan,
  sddText: string,
  validation?: ValidationRegistry,
): string[] {
  const problems: string[] = [];

  // Every id the SDD defines is a legitimate citation; only the functional ones
  // must each have a task. Passing just the FRs here would report a task that
  // correctly cites NFR-003 as referencing something undefined — which is what
  // happened the first time this ran against a real SDD.
  const declared = extractRequirementIds(sddText);
  const coverage = checkCoverage({ declared }, plan.tasks);
  problems.push(...coverage.problems);

  // The second half of the validation trust boundary. The schema already
  // guarantees an id cannot express a command; this guarantees the id is one the
  // project actually declared, so a planner cannot invent a step that silently
  // does nothing — or, worse, that someone later "fixes" by adding a command
  // matching the invented name.
  if (validation !== undefined) {
    for (const { task, id } of unknownValidationIds(validation, plan.tasks)) {
      const known = validation.ids.length > 0 ? validation.ids.join(', ') : '(none configured)';
      problems.push(
        `task ${task} references validation "${id}", which the project does not define ` +
          `(available: ${known})`,
      );
    }
  }

  try {
    buildDag(plan.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })));
  } catch (error) {
    problems.push(
      error instanceof DagError ? error.message : `invalid dependency graph: ${String(error)}`,
    );
  }

  return problems;
}
