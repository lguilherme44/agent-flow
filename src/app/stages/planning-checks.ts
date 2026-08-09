import type { Plan } from '../../contracts/index.js';
import { buildDag, DagError } from '../../core/dag.js';
import { checkCoverage } from '../../core/coverage.js';
import { extractRequirementIds } from '../../core/sdd-validator.js';

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
export function checkPlan(plan: Plan, sddText: string): string[] {
  const problems: string[] = [];

  // Every id the SDD defines is a legitimate citation; only the functional ones
  // must each have a task. Passing just the FRs here would report a task that
  // correctly cites NFR-003 as referencing something undefined — which is what
  // happened the first time this ran against a real SDD.
  const declared = extractRequirementIds(sddText);
  const coverage = checkCoverage({ declared }, plan.tasks);
  problems.push(...coverage.problems);

  try {
    buildDag(plan.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })));
  } catch (error) {
    problems.push(
      error instanceof DagError ? error.message : `invalid dependency graph: ${String(error)}`,
    );
  }

  return problems;
}
