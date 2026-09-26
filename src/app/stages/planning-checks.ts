import type { Plan, Task } from '../../contracts/index.js';
import { buildDag, DagError } from '../../core/dag.js';
import { checkCoverage } from '../../core/coverage.js';
import {
  commandCitations,
  uncoveredCitations,
  type ExecutorCommands,
} from '../../core/command-grants.js';
import { unsafeConcurrentPairs } from '../../core/file-overlap.js';
import { extractRequirementIds } from '../../core/sdd-validator.js';
import {
  declareValidationRemedy,
  unknownValidationIds,
  type ValidationRegistry,
} from '../../core/validation-registry.js';

/**
 * What a planner plan's text is checked against (FR-009, FR-024).
 *
 * Passed only for plans the **planner** wrote. A corrective round's FIX tasks transcribe the
 * reviewer's prose and carry no `requiredEvidence`, and the round's original tasks were
 * checked when they were planned — so the round passes nothing, and a legacy plan approved
 * before these rules is not refused on its next round.
 */
export interface PlanCitations {
  /** The trimmed command behind every validation-registry id. Agent Flow runs these itself. */
  readonly declared: readonly string[];
  /** What the executor may run, from `executorCommandsOf`. */
  readonly executor: ExecutorCommands;
}

/** The task fields a planner writes as prose, in the order a problem names them. */
const PROSE_FIELDS = ['title', 'description', 'acceptanceCriteria'] as const;

function proseOf(task: Task, field: (typeof PROSE_FIELDS)[number]): string {
  return field === 'acceptanceCriteria' ? task.acceptanceCriteria.join('\n') : task[field];
}

/**
 * Tasks that ask for a command nobody in the run can execute (FR-009).
 *
 * Off when the executor's command set is unknown or unbounded: with `known: false` nothing
 * says what it cannot run, and with `any: true` it can run everything — either way a refusal
 * would be a guess, and a wrong one spends the planner's single repair.
 */
function uncoveredCommandProblems(
  plan: Plan,
  citations: PlanCitations,
  validation: ValidationRegistry | undefined,
): string[] {
  const { executor } = citations;
  if (!executor.known || executor.any) return [];

  const commands = [...citations.declared, ...executor.prefixes];
  const runs = executor.prefixes.length > 0 ? executor.prefixes.join(', ') : '(no command)';
  const ids = validation === undefined || validation.ids.length === 0 ? '(none configured)' : validation.ids.join(', ');

  const problems: string[] = [];
  for (const task of plan.tasks) {
    for (const field of PROSE_FIELDS) {
      const text = proseOf(task, field);
      for (const citation of uncoveredCitations(commandCitations(text, commands), commands)) {
        problems.push(
          `task ${task.id} cites \`${citation}\` in its ${field}, which neither a declared ` +
            `validation command nor the executor can run (the executor may run: ${runs}). ` +
            `Name a declared validation id in the task's validation instead (available: ${ids}), ` +
            `or move the measurement to the plan's operatorVerifications for a person to make.`,
        );
      }
    }
  }
  return problems;
}

/**
 * A `requiredEvidence` id the same task does not validate with (FR-024).
 *
 * Evidence is produced by running the task's `validation`; an id listed only as evidence is
 * run by nothing, so the requirement could never be met and the task would fail for a reason
 * no amount of correct work fixes.
 */
function unrunEvidenceProblems(plan: Plan): string[] {
  return plan.tasks.flatMap((task) =>
    (task.requiredEvidence ?? [])
      .filter((id) => !task.validation.includes(id))
      .map(
        (id) =>
          `task ${task.id} lists requiredEvidence "${id}", which is not in its validation, ` +
          `so nothing would run it — add "${id}" to the task's validation or drop it from requiredEvidence.`,
      ),
  );
}

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
  citations?: PlanCitations,
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
          `(available: ${known}); ${declareValidationRemedy(id)}`,
      );
    }
  }

  if (citations !== undefined) {
    problems.push(...uncoveredCommandProblems(plan, citations, validation));
    problems.push(...unrunEvidenceProblems(plan));
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
