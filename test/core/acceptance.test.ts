import { describe, it, expect } from 'vitest';
import {
  assertObservableChange,
  assertScopeContainment,
  buildAcceptanceMap,
  outsideScope,
} from '../../src/core/acceptance.js';

/**
 * AD-38 and AD-39 (AR-05a) — the milestone that stops false-positive acceptance.
 *
 * The evidence run's decisive finding: three of six tasks produced a Git tree identical to
 * their base, were recorded `completed`, and were integrated. The run's final FAIL was
 * caused by that, not by anything the corrective path could have fixed. Both tree hashes
 * were already in `attempt-<n>.json`; nothing compared them.
 *
 * Everything here is pure and mechanical. "The agent said it changed src/x.ts" is a claim;
 * `git diff --name-only <base> <validated>` is evidence, and only one of the two may decide
 * whether a task is done.
 */

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

describe('assertion 1 — a completed task produced observable change (AD-38, C-12)', () => {
  it('accepts a task whose validated tree differs from its base', () => {
    expect(
      assertObservableChange({ baseTree: TREE_A, validatedTree: TREE_B }),
    ).toEqual({ satisfied: true });
  });

  it('refuses a task whose tree is identical to its base', () => {
    // TASK-002, TASK-005 and TASK-006, reproduced.
    const result = assertObservableChange({ baseTree: TREE_A, validatedTree: TREE_A });

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.failureClass).toBe('acceptance_evidence_missing');
  });

  it('records both hashes, because the refusal has to be checkable', () => {
    const result = assertObservableChange({ baseTree: TREE_A, validatedTree: TREE_A });

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.detail).toContain(TREE_A.slice(0, 12));
  });

  it('accepts an empty diff when the plan declared it would be empty', () => {
    // TASK-006 was a legitimate verification task with an empty diff. The difference
    // between "correctly changed nothing" and "did nothing" is intent, and intent belongs
    // in the plan, declared before the fact.
    expect(
      assertObservableChange({
        baseTree: TREE_A,
        validatedTree: TREE_A,
        expectsNoChange: true,
      }),
    ).toEqual({ satisfied: true });
  });

  it('treats an absent declaration as "change is required"', () => {
    // Containment is the default. A plan written before this field existed is not thereby
    // granted permission to complete without doing anything.
    const result = assertObservableChange({
      baseTree: TREE_A,
      validatedTree: TREE_A,
      expectsNoChange: undefined,
    });

    expect(result.satisfied).toBe(false);
  });

  it('says nothing when there is no validated tree to compare', () => {
    // A sequential run captures no tree. The assertion cannot be evaluated, and asserting
    // it anyway would fail every sequential task on the strength of a measurement nobody
    // took.
    expect(assertObservableChange({ baseTree: TREE_A })).toEqual({ satisfied: true });
    expect(assertObservableChange({ validatedTree: TREE_B })).toEqual({ satisfied: true });
  });
});

describe('assertion 2 — a completed task stayed inside its scope (AD-38, C-13)', () => {
  const declared = ['src/recurrence.ts', 'test/recurrence.test.ts'];

  it('accepts a diff entirely inside files.likely', () => {
    expect(
      assertScopeContainment({ changedFiles: ['src/recurrence.ts'], filesLikely: declared }),
    ).toEqual({ satisfied: true });
  });

  it('refuses a diff that reaches outside, and names the paths', () => {
    // TASK-003 wrote four files belonging to other tasks, and three downstream tasks
    // inherited work they had not done.
    const result = assertScopeContainment({
      changedFiles: ['src/recurrence.ts', 'src/cli/index.ts', 'package.json'],
      filesLikely: declared,
    });

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.failureClass).toBe('scope_violation');
    expect(result.offendingPaths).toEqual(['src/cli/index.ts', 'package.json']);
  });

  it('accepts anything when the plan declared an open scope', () => {
    expect(
      assertScopeContainment({
        changedFiles: ['anything/at/all.ts'],
        filesLikely: declared,
        scopeMode: 'open',
      }),
    ).toEqual({ satisfied: true });
  });

  it('treats an absent scopeMode as declared, which is the strict reading', () => {
    // §8.3: containment is the default. Scope is an assertion made *about* a diff after
    // the fact, so the safe reading of silence is the strict one.
    const result = assertScopeContainment({
      changedFiles: ['src/elsewhere.ts'],
      filesLikely: declared,
      scopeMode: undefined,
    });

    expect(result.satisfied).toBe(false);
  });

  it('accepts a file inside a declared directory', () => {
    // A plan may declare a directory rather than enumerate every file in it, and a task
    // told to work in `src/recurrence/` has not left its scope by creating a file there.
    expect(
      assertScopeContainment({
        changedFiles: ['src/recurrence/rrule.ts', 'src/recurrence/index.ts'],
        filesLikely: ['src/recurrence/'],
      }),
    ).toEqual({ satisfied: true });
  });

  it('does not let a prefix match cross a path segment', () => {
    // `src/recurrence` must not admit `src/recurrence-legacy.ts`. String prefixes are the
    // obvious implementation and the wrong one.
    const result = assertScopeContainment({
      changedFiles: ['src/recurrence-legacy.ts'],
      filesLikely: ['src/recurrence'],
    });

    expect(result.satisfied).toBe(false);
  });

  it('says nothing when the plan declared no files', () => {
    // An empty `files.likely` is "the plan did not say", not "nothing is allowed".
    // Refusing here would fail every task in a plan that omits the field.
    expect(assertScopeContainment({ changedFiles: ['a.ts'], filesLikely: [] })).toEqual({
      satisfied: true,
    });
  });

  it('exposes the offending set on its own, for a caller that only needs the paths', () => {
    expect(outsideScope(['a.ts', 'src/x.ts'], ['src/'])).toEqual(['a.ts']);
  });
});

describe('per-AC evidence (C-15)', () => {
  const criteria = ['Types compile.', 'Recurrence rules round-trip.'];

  it('maps every criterion, so a missing one is visible rather than absent', () => {
    const map = buildAcceptanceMap({
      criteria,
      validation: [{ id: 'typecheck', exitCode: 0 }],
      changedFiles: ['src/recurrence.ts'],
    });

    expect(map).toHaveLength(2);
    expect(map.map((entry) => entry.criterion)).toEqual(criteria);
  });

  it('cites a validation command when one ran', () => {
    const [first] = buildAcceptanceMap({
      criteria: ['Types compile.'],
      validation: [{ id: 'typecheck', exitCode: 0 }],
      changedFiles: [],
    });

    expect(first?.evidence.kind).toBe('validation');
    if (first?.evidence.kind !== 'validation') return;
    expect(first.evidence.id).toBe('typecheck');
    expect(first.evidence.exitCode).toBe(0);
  });

  it('cites the diff when validation ran but the criterion has no command', () => {
    const map = buildAcceptanceMap({
      criteria: ['Types compile.', 'Docs updated.'],
      validation: [{ id: 'typecheck', exitCode: 0 }],
      changedFiles: ['docs/x.md'],
    });

    expect(map[1]?.evidence.kind).toBe('diff');
  });

  it('says "none" explicitly rather than leaving a criterion unmentioned', () => {
    // C-15: "an AC with no mechanical evidence says so explicitly rather than being
    // absent". A gap that renders as silence is a gap nobody reviews.
    const [only] = buildAcceptanceMap({ criteria: ['Looks nice.'], validation: [], changedFiles: [] });

    expect(only?.evidence.kind).toBe('none');
  });

  it('never accepts the agent’s own claim as evidence', () => {
    // The shape refuses to express it: there is no `claim` variant. This is the security
    // model as a type, not as a rule somebody has to remember.
    const map = buildAcceptanceMap({ criteria, validation: [], changedFiles: [] });

    for (const entry of map) {
      expect(['validation', 'diff', 'none']).toContain(entry.evidence.kind);
    }
  });
});
