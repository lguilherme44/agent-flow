import type { FailureClass } from '../contracts/index.js';

/**
 * The mechanical assertions a task must pass before it may be called done (AD-38, AD-39).
 *
 * **This module is the security model, expressed as code.** The rule "mechanical evidence
 * outranks model claims" was true of validation — agent-flow runs the commands itself and
 * reads exit codes — and quietly false of everything else: `filesChanged` came from the
 * agent's prose, and whether a task had done anything at all was never asked. Three of six
 * tasks in the evidence run produced a Git tree identical to their base, were recorded
 * `completed`, and were integrated. Both tree hashes were already on disk.
 *
 * Pure by construction. Nothing here reads a file, spawns Git, or calls a model; it is
 * handed hashes and paths that a caller obtained mechanically, and it decides.
 */

export type AcceptanceAssertion =
  | { readonly satisfied: true }
  | {
      readonly satisfied: false;
      readonly failureClass: FailureClass;
      /** What is wrong, in the words a caller puts in front of a person. */
      readonly detail: string;
      /** The paths that broke containment, when that is the assertion that failed. */
      readonly offendingPaths?: readonly string[];
    };

/**
 * Assertion 1: did this task change anything? (C-12, I-23)
 *
 * `expectsNoChange` is **required rather than inferred**, and the evidence run is why:
 * TASK-006 was a legitimate verification task with an empty diff, and it declared three
 * files it was meant to leave untouched — so inferring intent from an empty `files.likely`
 * would have been exactly backwards. The difference between "correctly changed nothing"
 * and "did nothing" is intent, and intent belongs in the plan, declared before the fact.
 *
 * Unevaluable when either tree is absent, which is a sequential run: no workspace was cut,
 * so no tree was captured. Failing every sequential task on the strength of a measurement
 * nobody took would be worse than the gap this closes.
 */
export function assertObservableChange(input: {
  readonly baseTree?: string;
  readonly validatedTree?: string;
  readonly expectsNoChange?: boolean;
  /**
   * A person declared it after the plan was written (PRI-20).
   *
   * A separate input from `expectsNoChange` rather than the same one pre-combined,
   * because the two have different authors and this function is where the decision is
   * made. The planner's claim is made before the fact and the operator's after it; both
   * are declarations of intent, neither is inferred, and a caller that flattened them
   * would lose the only distinction worth keeping.
   */
  readonly declaredUnchangedByOperator?: boolean;
}): AcceptanceAssertion {
  if (input.baseTree === undefined || input.validatedTree === undefined) {
    return SATISFIED;
  }
  if (input.baseTree !== input.validatedTree) return SATISFIED;
  if (input.expectsNoChange === true) return SATISFIED;
  if (input.declaredUnchangedByOperator === true) return SATISFIED;

  return {
    satisfied: false,
    failureClass: 'acceptance_evidence_missing',
    detail:
      `the validated tree is identical to the base tree (${short(input.baseTree)}), so this ` +
      `task produced no observable change; declare expectsNoChange: true in the plan if that ` +
      `is what it was meant to do, or retry it with --expect-no-change to say so now`,
  };
}

/**
 * Assertion 2: did this task stay where the plan put it? (C-13)
 *
 * Not auto-recoverable, and the evidence run shows why: a task that wrote outside its
 * declared scope may already have changed another task's outcome. One task wrote four
 * files belonging to three others, which then "passed" on work they had not done. A retry
 * cannot undo that.
 *
 * An empty `filesLikely` means the plan did not say, not that nothing is permitted.
 */
export function assertScopeContainment(input: {
  readonly changedFiles: readonly string[];
  readonly filesLikely: readonly string[];
  readonly scopeMode?: 'declared' | 'open';
}): AcceptanceAssertion {
  if (input.scopeMode === 'open') return SATISFIED;
  if (input.filesLikely.length === 0) return SATISFIED;

  const offending = outsideScope(input.changedFiles, input.filesLikely);
  if (offending.length === 0) return SATISFIED;

  return {
    satisfied: false,
    failureClass: 'scope_violation',
    detail:
      `${String(offending.length)} changed path(s) fall outside the task's declared files: ` +
      offending.join(', '),
    offendingPaths: offending,
  };
}

/**
 * The changed paths that no declared entry covers.
 *
 * A declared entry matches a path exactly, or contains it as a directory. **Segment-aware,
 * deliberately**: a plain string prefix would let `src/recurrence` admit
 * `src/recurrence-legacy.ts`, which is a different file belonging to somebody else — and
 * that is precisely the class of mistake this assertion exists to catch.
 */
export function outsideScope(
  changedFiles: readonly string[],
  filesLikely: readonly string[],
): string[] {
  const declared = filesLikely.map(normalise);

  return changedFiles
    .map(normalise)
    .filter((path) => !declared.some((entry) => covers(entry, path)));
}

function covers(declared: string, path: string): boolean {
  if (declared === path) return true;
  // A directory, whether or not the plan wrote the trailing slash.
  return path.startsWith(`${declared}/`);
}

function normalise(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * What a criterion was judged on (C-15).
 *
 * A closed union with **no `claim` variant**, and its absence is the point: an agent's
 * account of its own work can never be an acceptance criterion's evidence, and the shape
 * refuses to express it rather than leaving that to a reviewer's discipline.
 */
export type AcceptanceEvidence =
  | { readonly kind: 'validation'; readonly id: string; readonly exitCode: number }
  | { readonly kind: 'diff'; readonly path: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface AcceptanceEntry {
  readonly criterion: string;
  readonly evidence: AcceptanceEvidence;
}

/**
 * Every acceptance criterion, mapped to what actually demonstrates it.
 *
 * Every criterion appears, including the ones nothing demonstrates: C-15 requires that an
 * AC with no mechanical evidence *says so*, because a gap rendered as silence is a gap
 * nobody reviews.
 *
 * The pairing is positional and deliberately unclever. Criteria are prose and validation
 * ids are configuration; matching them semantically would need a model, and a model may
 * never decide whether evidence exists (§11). Ordinal correspondence is a convention a
 * plan author can see and rely on, and where it runs out the answer degrades to the diff
 * and then to `none` — never to a guess.
 */
export function buildAcceptanceMap(input: {
  readonly criteria: readonly string[];
  readonly validation: readonly { readonly id: string; readonly exitCode: number }[];
  readonly changedFiles: readonly string[];
}): AcceptanceEntry[] {
  return input.criteria.map((criterion, index) => {
    const command = input.validation[index];
    if (command !== undefined) {
      return {
        criterion,
        evidence: { kind: 'validation', id: command.id, exitCode: command.exitCode },
      };
    }

    const path = input.changedFiles[0];
    if (path !== undefined) {
      return { criterion, evidence: { kind: 'diff', path } };
    }

    return {
      criterion,
      evidence: {
        kind: 'none',
        // The reason is required by the schema, and requiring it is the point: "no
        // evidence" with no explanation is the shape a reviewer skims past.
        reason:
          input.validation.length === 0
            ? 'no validation command ran and the attempt changed nothing'
            : 'no validation command corresponds to this criterion and the attempt changed nothing',
      },
    };
  });
}

const SATISFIED: AcceptanceAssertion = { satisfied: true };

function short(oid: string): string {
  return oid.slice(0, 12);
}
