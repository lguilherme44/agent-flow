import { describe, it, expect } from 'vitest';
import {
  deriveOverlapDependencies,
  overlappingPaths,
  unsafeConcurrentPairs,
  type OverlapTask,
} from '../../src/core/file-overlap.js';

/**
 * AD-42 and AD-43 (AR-06) — two tasks never contend for one file.
 *
 * The evidence run produced it twice, from both directions. `applyFixes` hardcoded
 * `dependencies: []`, so FIX-001 and FIX-002 both targeted `test/cli/cli.test.ts` with
 * nothing between them — same wave, same file, guaranteed conflict. And TASK-003 wrote four
 * files belonging to three other tasks, which then "passed" on work they had not done.
 *
 * Overlap is an intersection of two string sets: deterministic, conservative and cheap.
 * It is emphatically **not** graph topology — `DagNode` stays `{ id, dependencies }`, and
 * an architecture test keeps it that way.
 */

const task = (id: string, files: string[], dependencies: string[] = []): OverlapTask => ({
  id,
  dependencies,
  files,
});

describe('overlappingPaths', () => {
  it('finds the paths two tasks share', () => {
    expect(
      overlappingPaths(['a.ts', 'b.ts'], ['b.ts', 'c.ts']),
    ).toEqual(['b.ts']);
  });

  it('is empty for disjoint sets', () => {
    expect(overlappingPaths(['a.ts'], ['b.ts'])).toEqual([]);
  });

  it('treats a declared directory as covering what is inside it', () => {
    // A plan may declare `src/auth/` where another declares `src/auth/login.ts`. Those two
    // tasks contend, and a set intersection on raw strings would say they do not.
    expect(overlappingPaths(['src/auth/'], ['src/auth/login.ts'])).toEqual(['src/auth/login.ts']);
  });

  it('does not let a prefix match cross a path segment', () => {
    // `src/auth` must not collide with `src/authz.ts`. The same mistake the scope
    // assertion guards against, in the other module that compares paths.
    expect(overlappingPaths(['src/auth'], ['src/authz.ts'])).toEqual([]);
  });

  it('ignores a leading ./ so two spellings of one path still collide', () => {
    expect(overlappingPaths(['./a.ts'], ['a.ts'])).toEqual(['a.ts']);
  });
});

describe('deriving corrective dependencies from overlap (AD-42, C-16)', () => {
  it('orders two fixes that touch the same file', () => {
    // FIX-001 and FIX-002, reproduced. Both targeted `test/cli/cli.test.ts` and neither
    // waited for the other.
    const ordered = deriveOverlapDependencies([
      task('FIX-001', ['test/cli/cli.test.ts']),
      task('FIX-002', ['test/cli/cli.test.ts']),
    ]);

    expect(ordered[0]?.dependencies).toEqual([]);
    expect(ordered[1]?.dependencies).toEqual(['FIX-001']);
  });

  it('makes a task depend on every earlier one it overlaps, not just the last', () => {
    const ordered = deriveOverlapDependencies([
      task('FIX-001', ['a.ts']),
      task('FIX-002', ['b.ts']),
      task('FIX-003', ['a.ts', 'b.ts']),
    ]);

    expect(ordered[2]?.dependencies).toEqual(['FIX-001', 'FIX-002']);
  });

  it('leaves disjoint tasks parallel, which is the whole point of not serialising everything', () => {
    const ordered = deriveOverlapDependencies([
      task('FIX-001', ['a.ts']),
      task('FIX-002', ['b.ts']),
    ]);

    expect(ordered.every((entry) => entry.dependencies.length === 0)).toBe(true);
  });

  it('keeps dependencies a task already declared', () => {
    const ordered = deriveOverlapDependencies([
      task('FIX-001', ['a.ts']),
      task('FIX-002', ['b.ts'], ['FIX-001']),
    ]);

    expect(ordered[1]?.dependencies).toEqual(['FIX-001']);
  });

  it('never adds the same dependency twice', () => {
    const ordered = deriveOverlapDependencies([
      task('FIX-001', ['a.ts']),
      task('FIX-002', ['a.ts'], ['FIX-001']),
    ]);

    expect(ordered[1]?.dependencies).toEqual(['FIX-001']);
  });

  it('is order-stable, so the same findings produce the same plan', () => {
    // A corrective plan that differed between two runs of the same findings would make
    // every downstream comparison meaningless.
    const input = [task('FIX-001', ['a.ts']), task('FIX-002', ['a.ts']), task('FIX-003', ['a.ts'])];

    expect(deriveOverlapDependencies(input)).toEqual(deriveOverlapDependencies(input));
    expect(deriveOverlapDependencies(input)[2]?.dependencies).toEqual(['FIX-001', 'FIX-002']);
  });

  it('declares nothing for a task with no files', () => {
    // An empty `files.likely` is "the plan did not say", not "this task touches
    // everything". Serialising on unknown would make every corrective plan a chain.
    const ordered = deriveOverlapDependencies([task('FIX-001', []), task('FIX-002', [])]);

    expect(ordered.every((entry) => entry.dependencies.length === 0)).toBe(true);
  });
});

describe('the planning-time guard (AD-43 layer 1, C-17)', () => {
  it('reports two independent tasks that declare the same file', () => {
    const pairs = unsafeConcurrentPairs([
      task('TASK-001', ['src/x.ts']),
      task('TASK-002', ['src/x.ts']),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 'TASK-001', b: 'TASK-002', paths: ['src/x.ts'] });
  });

  it('says nothing when one depends on the other', () => {
    // Ordered tasks cannot run together, so their overlap is not a hazard — it is the
    // ordinary case of a later task editing what an earlier one wrote.
    expect(
      unsafeConcurrentPairs([
        task('TASK-001', ['src/x.ts']),
        task('TASK-002', ['src/x.ts'], ['TASK-001']),
      ]),
    ).toEqual([]);
  });

  it('follows the dependency chain, not just the direct edge', () => {
    // A depends on nothing, B on A, C on B. A and C overlap but can never be concurrent.
    expect(
      unsafeConcurrentPairs([
        task('TASK-001', ['src/x.ts']),
        task('TASK-002', [], ['TASK-001']),
        task('TASK-003', ['src/x.ts'], ['TASK-002']),
      ]),
    ).toEqual([]);
  });

  it('reports each pair once', () => {
    expect(
      unsafeConcurrentPairs([
        task('TASK-001', ['src/x.ts']),
        task('TASK-002', ['src/x.ts']),
        task('TASK-003', ['src/x.ts']),
      ]),
    ).toHaveLength(3);
  });

  it('says nothing about a plan whose tasks declare no files', () => {
    expect(unsafeConcurrentPairs([task('TASK-001', []), task('TASK-002', [])])).toEqual([]);
  });
});
