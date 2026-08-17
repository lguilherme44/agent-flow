import type { Plan } from '../../contracts/index.js';
import { buildDag, DagError } from '../../core/dag.js';
import { checkCoverage } from '../../core/coverage.js';
import { unsafeConcurrentPairs } from '../../core/file-overlap.js';
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
  // For lightweight workflows (SIMPLE/TRIVIAL), SDD is dispensed with.
  if (sddText.trim().length > 0) {
    const declared = extractRequirementIds(sddText);
    const coverage = checkCoverage({ declared }, plan.tasks);
    problems.push(...coverage.problems);
  }

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

  // **File contention, reported before a reviewer is called** (AD-43 layer 1, C-17). Two
  // mutually-independent tasks declaring the same file will be dispatched together and
  // fight over it. The evidence run's corrective round produced exactly that pair, and it
  // was caught by a model call and then by a human writing a revision — for what is an
  // intersection of two string sets.
  //
  // A *report*, never an edit. Injecting the dependency here would silently rewrite the
  // plan a human is about to read and approve, which is the one thing the approval gate
  // exists to prevent.
  for (const pair of unsafeConcurrentPairs(
    plan.tasks.map((task) => ({
      id: task.id,
      dependencies: task.dependencies,
      files: task.files.likely,
    })),
  )) {
    problems.push(
      `tasks ${pair.a} and ${pair.b} are independent of each other and both declare ` +
        `${pair.paths.join(', ')} — they would run at the same time and contend for it. ` +
        `Make one depend on the other, or split the file between them.`,
    );
  }

  return problems;
}
