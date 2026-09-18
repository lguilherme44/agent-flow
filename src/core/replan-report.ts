import type { RunEvent } from '../contracts/index.js';

/**
 * What the run says about the last replan's findings, and how to say it (D14).
 *
 * **Reading the log is the decision; printing is not.** `status` selects events by type
 * and renders what it finds — so which of two events is the later one, and which
 * sentence a reason deserves, are judgements that belong somewhere they can be tested
 * without a terminal. This module is that somewhere.
 */

/** Why a rejected review's findings did not reach the planner. */
export const REPLAN_WITHHELD_REASONS = [
  /** `--from discovery|architecture-impact|sdd`: those stages run before planning does. */
  'stage_before_planning',
  /** The description given is not the request the refused plan answered. */
  'request_changed',
  /** The review names no plan, or the plan it names is not on disk. */
  'unverifiable_review',
  /** The review names a different plan than the one in hand. */
  'stale_review',
] as const;
export type ReplanWithheldReason = (typeof REPLAN_WITHHELD_REASONS)[number];

export type ReplanReport =
  | { readonly kind: 'forwarded'; readonly findings: number }
  | {
      readonly kind: 'withheld';
      readonly findings: number;
      readonly reason: ReplanWithheldReason;
    };

/**
 * The last thing that happened to a replan's findings, or nothing if none has.
 *
 * **Three event types, not two.** `revise` records its forwarding inside its own
 * `revision_requested` rather than writing a second event — so a projection that read
 * only the two `replan_findings_*` events would show "did not receive" for a refused
 * revise and *nothing at all* for one that worked. A screen that can only report the bad
 * news is a screen nobody learns to trust.
 *
 * Latest wins, because a run replans more than once and the question is always about the
 * attempt in hand. An unrecognised `reason` is ignored rather than printed: a value this
 * module has no sentence for would reach the operator as a raw identifier, which is the
 * thing the phrasing below exists to avoid.
 */
export function lastReplanReport(events: readonly RunEvent[]): ReplanReport | undefined {
  let latest: ReplanReport | undefined;

  for (const event of events) {
    if (event.type === 'replan_findings_forwarded') {
      const findings = countOf(event.detail['findingsForwarded']);
      if (findings > 0) latest = { kind: 'forwarded', findings };
      continue;
    }

    if (event.type === 'revision_requested') {
      const findings = countOf(event.detail['findingsForwarded']);
      if (findings > 0) latest = { kind: 'forwarded', findings };
      continue;
    }

    if (event.type !== 'replan_findings_withheld') continue;

    const reason = event.detail['reason'];
    const findings = countOf(event.detail['findings']);
    if (findings > 0 && isWithheldReason(reason)) {
      latest = { kind: 'withheld', findings, reason };
    }
  }

  return latest;
}

/**
 * One line, and it has to end with something to do.
 *
 * The defect this closes was silence, and a sentence that names a failure without naming
 * the command that clears it is a quieter version of the same thing. Each reason
 * therefore carries the action that actually produces a different outcome — never a
 * command that would not.
 */
export function describeReplanReport(report: ReplanReport): string {
  const count = `${String(report.findings)} finding(s)`;

  if (report.kind === 'forwarded') {
    return `Last replan received ${count} from the previous plan review.`;
  }

  return `Last replan did not receive the ${count} from the previous plan review: ${explain(
    report.reason,
  )}`;
}

function explain(reason: ReplanWithheldReason): string {
  switch (reason) {
    case 'stale_review':
      return (
        'it describes a different plan (stale_review). Re-plan with --from planning, ' +
        'which reviews the plan it produces.'
      );
    case 'unverifiable_review':
      return (
        'it names no plan, so nothing ties it to this one (unverifiable_review). ' +
        'Re-plan with --from planning, which reviews the plan it produces.'
      );
    case 'request_changed':
      return (
        'the description given was not the request that plan answered (request_changed). ' +
        'Resume with the same description, or use: agent-flow revise "<instruction>"'
      );
    case 'stage_before_planning':
      return (
        'the resume re-ran stages that come before planning (stage_before_planning). ' +
        'Use --from planning, or: agent-flow revise "<instruction>"'
      );
  }
}

function isWithheldReason(value: unknown): value is ReplanWithheldReason {
  return (
    typeof value === 'string' &&
    (REPLAN_WITHHELD_REASONS as readonly string[]).includes(value)
  );
}

/** A count that is not a positive whole number is not a count worth printing. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}
