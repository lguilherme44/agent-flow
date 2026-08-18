import type { Plan, Task } from '../contracts/index.js';
import { deriveOverlapDependencies } from './file-overlap.js';

/**
 * A corrective plan repairs itself against mechanical constraints (AD-47, C-16).
 *
 * `runCorrectiveRound` was one-shot: `checkPlan` fails, the round returns `invalid_plan`,
 * and a person writes the revision. AD-42 exists to stop *generating* the plans that failed
 * in the evidence run — same file, no dependency, wrong complexity — and this loop exists
 * for the residue, because "AD-42 is complete" is not a claim worth betting a stuck run on.
 *
 * **The repair set is closed, and that is the decision rather than a detail.** Four repairs,
 * every one of them mechanical and every one of them legible by reading the resulting plan:
 * an overlap-derived dependency, a corrected complexity, a dropped duplicate, and a
 * validation id replaced with the project's defaults.
 *
 * A model-authored repair is explicitly out of scope. The reviewer's objection is semantic,
 * and answering a model's objection with a model's rewrite is how a system talks itself past
 * its own gate.
 *
 * Pure, and it touches corrective tasks only: a planned task's result is on disk and
 * describes work that happened, so a repair that could reach it could rewrite history.
 */

/** Which repair was applied. Named, because the caller records them and a person reads them. */
export type RepairKind =
  | 'overlap_dependency'
  | 'complexity'
  | 'duplicate_finding'
  | 'validation_id';

export interface RepairResult {
  readonly plan: Plan;
  /** Empty when nothing mechanical applied — the signal a repair loop needs to stop. */
  readonly applied: readonly RepairKind[];
}

export interface RepairInput {
  /** The ids the repair may touch. Everything else is history. */
  readonly correctiveIds: readonly string[];
  /** What the project actually defines, and what to fall back to. */
  readonly validation?: { readonly ids: readonly string[]; readonly defaults: readonly string[] };
}

export function repairCorrectivePlan(plan: Plan, input: RepairInput): RepairResult {
  const touchable = new Set(input.correctiveIds);
  const applied = new Set<RepairKind>();

  // 1. Duplicates first. Dropping a task changes what the later repairs see, and repairing
  //    a task that is about to be deleted spends the budget on nothing.
  let tasks = dropDuplicates(plan.tasks, touchable, applied);

  // 2. Complexity, from the work's shape rather than the finding's severity (AD-42).
  tasks = tasks.map((task) => (touchable.has(task.id) ? correctComplexity(task, applied) : task));

  // 3. Validation ids the project does not define.
  tasks = tasks.map((task) =>
    touchable.has(task.id) ? correctValidation(task, input.validation, applied) : task,
  );

  // 4. Overlap last, because it is derived from the set that survived the first three.
  tasks = addOverlapDependencies(tasks, touchable, applied);

  return {
    plan: applied.size === 0 ? plan : { ...plan, tasks },
    applied: [...applied],
  };
}

/**
 * A duplicate finding produces two tasks that edit the same thing for the same reason.
 *
 * Identical title *and* identical declared files. Title alone would merge two real fixes a
 * reviewer happened to phrase alike; files alone would merge two different fixes to one
 * module, which is ordinary and correct.
 */
function dropDuplicates(
  tasks: readonly Task[],
  touchable: ReadonlySet<string>,
  applied: Set<RepairKind>,
): Task[] {
  const seen = new Set<string>();
  const kept: Task[] = [];

  for (const task of tasks) {
    if (!touchable.has(task.id)) {
      kept.push(task);
      continue;
    }

    const key = `${task.title} ${[...task.files.likely].sort().join(',')}`;
    if (seen.has(key)) {
      applied.add('duplicate_finding');
      continue;
    }
    seen.add(key);
    kept.push(task);
  }

  // A dropped task must not leave a dangling edge behind it.
  const alive = new Set(kept.map((task) => task.id));
  return kept.map((task) => ({
    ...task,
    dependencies: task.dependencies.filter((id) => alive.has(id)),
  }));
}

/** Severity measures how much a defect matters; complexity, how much work it is (AD-42). */
function correctComplexity(task: Task, applied: Set<RepairKind>): Task {
  const files = task.files.likely;
  // Nothing localised: the correction has to be found before it can be made, which is the
  // harder case rather than the easier one.
  const shape =
    files.length === 0 ? 'complex' : files.every(isSmallEditTarget) ? 'trivial' : 'normal';

  if (shape === task.complexity) return task;
  applied.add('complexity');
  return { ...task, complexity: shape };
}

function isSmallEditTarget(file: string): boolean {
  return /(^|\/)(test|tests|spec|docs)\//.test(file) || /\.(md|txt)$/.test(file);
}

/**
 * An id the project does not define fails the task for the wrong reason.
 *
 * Replaced with the project's defaults, and with **nothing** when the project defines none.
 * "Not invented" beats "plausible": admitting there is nothing to run is honest, and a
 * fabricated id is a failure somebody has to debug before they reach the real one.
 */
function correctValidation(
  task: Task,
  validation: RepairInput['validation'],
  applied: Set<RepairKind>,
): Task {
  if (validation === undefined) return task;

  const known = new Set(validation.ids);
  if (task.validation.every((id) => known.has(id))) return task;

  applied.add('validation_id');
  return { ...task, validation: [...validation.defaults] };
}

/**
 * Two independent corrective tasks declaring the same file would be dispatched together and
 * contend for it (C-17).
 *
 * `checkPlan` reports this and deliberately does not fix it — injecting a dependency into a
 * plan a human is about to approve is the one thing the gate exists to prevent. Inside a
 * *corrective* round the trade is different: the round is machine-generated in the first
 * place, the repair is recorded and named, and the alternative is a stuck run.
 */
function addOverlapDependencies(
  tasks: readonly Task[],
  touchable: ReadonlySet<string>,
  applied: Set<RepairKind>,
): Task[] {
  const ordered = deriveOverlapDependencies(
    tasks.map((task) => ({
      id: task.id,
      dependencies: [...task.dependencies],
      files: [...task.files.likely],
    })),
  );

  return tasks.map((task) => {
    if (!touchable.has(task.id)) return task;

    const derived = ordered.find((entry) => entry.id === task.id)?.dependencies ?? [];
    // Never an edge to a task that already ran: that would reorder finished work.
    const next = derived.filter((id) => touchable.has(id));
    const unchanged =
      next.length === task.dependencies.length &&
      next.every((id, index) => id === task.dependencies[index]);
    if (unchanged) return task;

    applied.add('overlap_dependency');
    return { ...task, dependencies: next };
  });
}
