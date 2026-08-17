/**
 * File contention, as set arithmetic (AD-42, AD-43).
 *
 * The evidence run produced this defect from both directions. `applyFixes` hardcoded
 * `dependencies: []`, so two corrective tasks both targeting `test/cli/cli.test.ts` landed
 * in one wave with nothing between them. And one implementation task wrote four files
 * belonging to three others, which then "passed" on work they had not done.
 *
 * **Overlap is planning and scheduling policy, never graph topology.** `core/dag.ts` stays
 * file-agnostic and `DagNode` remains `{ id, dependencies }` — teaching the graph about
 * files would couple pure topology to a scheduling concern, and an architecture test keeps
 * the two apart.
 *
 * Everything here is an intersection of two string sets: deterministic, conservative and
 * cheap enough to run on every plan.
 */

export interface OverlapTask {
  readonly id: string;
  readonly dependencies: readonly string[];
  /** `files.likely` — what the plan says this task will touch. */
  readonly files: readonly string[];
}

/**
 * The paths two tasks both claim.
 *
 * **Segment-aware, not a string intersection.** A plan may declare `src/auth/` where
 * another declares `src/auth/login.ts`; those two tasks contend, and comparing raw strings
 * would say they do not. The same care in the other direction: `src/auth` must not collide
 * with `src/authz.ts`, which is a different file belonging to somebody else.
 *
 * Returns the *concrete* side of each collision where one exists, because that is the path
 * a person needs to see.
 */
export function overlappingPaths(
  a: readonly string[],
  b: readonly string[],
): string[] {
  const left = a.map(normalise);
  const right = b.map(normalise);
  const found = new Set<string>();

  for (const one of left) {
    for (const other of right) {
      if (one === other) found.add(one);
      // The more specific path is the useful one to report.
      else if (other.startsWith(`${one}/`)) found.add(other);
      else if (one.startsWith(`${other}/`)) found.add(one);
    }
  }

  return [...found].sort();
}

/**
 * Corrective tasks, ordered by the files they share (AD-42, C-16).
 *
 * Each task depends on **every earlier task it overlaps**, not merely the previous one: a
 * fix touching two files that two earlier fixes each touched has to wait for both, and
 * depending only on the last would let it race the other.
 *
 * Generation order is the finding order and is preserved, so the same findings always
 * produce the same plan — a corrective plan that differed between two runs of one input
 * would make every downstream comparison meaningless.
 *
 * Declared dependencies are kept. This adds ordering; it never removes any.
 */
export function deriveOverlapDependencies<T extends OverlapTask>(tasks: readonly T[]): T[] {
  return tasks.map((task, index) => {
    const earlier = tasks.slice(0, index);
    const contended = earlier
      .filter((candidate) => overlappingPaths(task.files, candidate.files).length > 0)
      .map((candidate) => candidate.id);

    const dependencies = [...task.dependencies];
    for (const id of contended) {
      if (!dependencies.includes(id)) dependencies.push(id);
    }

    return { ...task, dependencies };
  });
}

export interface OverlapPair {
  readonly a: string;
  readonly b: string;
  readonly paths: readonly string[];
}

/**
 * Pairs that could run at the same time and would fight over a file (AD-43 layer 1).
 *
 * "Could run at the same time" means neither reaches the other through the dependency
 * graph — **transitively**. A depends on nothing, B on A, C on B: A and C may share every
 * file they declare and can never be concurrent, so reporting them would be noise, and
 * noise in a plan check is how a real finding gets skipped.
 *
 * A *report*, never an edit: this is what `checkPlan` shows a person before they approve.
 * Injecting the dependency automatically would silently rewrite the document being
 * approved, which is the one thing the approval gate exists to prevent.
 */
export function unsafeConcurrentPairs(tasks: readonly OverlapTask[]): OverlapPair[] {
  const reachable = transitiveClosure(tasks);
  const pairs: OverlapPair[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i] as OverlapTask;
      const b = tasks[j] as OverlapTask;

      if (reachable.get(a.id)?.has(b.id) === true) continue;
      if (reachable.get(b.id)?.has(a.id) === true) continue;

      const paths = overlappingPaths(a.files, b.files);
      if (paths.length > 0) pairs.push({ a: a.id, b: b.id, paths });
    }
  }

  return pairs;
}

/**
 * Every task each task waits for, directly or through a chain.
 *
 * Iterated to a fixed point rather than recursed, so a plan with a cycle terminates. A
 * cycle is a plan problem `checkPlan` reports separately, and this function's job is to be
 * unable to hang while it does.
 */
function transitiveClosure(tasks: readonly OverlapTask[]): Map<string, Set<string>> {
  const closure = new Map(tasks.map((task) => [task.id, new Set(task.dependencies)]));

  for (let pass = 0; pass < tasks.length; pass += 1) {
    let grew = false;

    for (const [, waitsFor] of closure) {
      for (const id of [...waitsFor]) {
        for (const inherited of closure.get(id) ?? []) {
          if (!waitsFor.has(inherited)) {
            waitsFor.add(inherited);
            grew = true;
          }
        }
      }
    }

    if (!grew) break;
  }

  return closure;
}

function normalise(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}
