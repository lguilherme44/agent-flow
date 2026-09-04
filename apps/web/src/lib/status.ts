import type { PipelineStatus, RunStatus, RuntimeStatus, TaskState } from '@contracts/index.js';

/**
 * The one place a status becomes a colour.
 *
 * Every status in the app maps to a *tone* — one of six — and components render
 * a tone. A component choosing `text-danger` for a failed task and another
 * choosing `text-warning` for the same thing is how a dashboard stops being
 * readable, and it happens the moment there are two places to decide.
 *
 * A tone is never the whole signal. §97 requires status to be icon plus text as
 * well as colour, because a screenshot in greyscale, a colour-blind reader, and
 * a person glancing from three feet away all need the same answer.
 */
export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'primary' | 'muted';

export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
  primary: 'text-primary',
  muted: 'text-muted',
};

export const TONE_BG: Record<Tone, string> = {
  success: 'bg-success-soft',
  info: 'bg-info-soft',
  warning: 'bg-warning-soft',
  danger: 'bg-danger-soft',
  primary: 'bg-primary-soft',
  muted: 'bg-surface-3',
};

export const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  danger: 'bg-danger',
  primary: 'bg-primary',
  muted: 'bg-faint',
};

/**
 * Magnitude, which is not a status and therefore not a tone (UI-29).
 *
 * Brightest first, so rank reads as brightness. Lives here because §67 says a
 * colour is written down once, and this ramp was previously duplicated as a
 * `SLICE_COLOURS` array in both `AnalyticsPage` and `bottom-cards` — each one
 * built from the four reserved signal hues plus the accent.
 *
 * That palette failed on measurement, not on taste: the adjacent pair
 * `--af-info` ↔ `--af-primary-bright` scores ΔE 1.1 under deuteranopia and 11.7
 * under normal vision, against a floor of 15. It is also the pair the status
 * system rests on — a running task is blue, a running stage is violet — so the
 * two donuts were putting the least separable pair in the palette in the only
 * two places where colour was the sole channel, with no ring, glyph or word to
 * carry the meaning instead.
 *
 * A sixth series folds into the last step rather than generating a hue.
 */
export const MAGNITUDE_SCALE: readonly string[] = [
  'var(--af-scale-5)',
  'var(--af-scale-4)',
  'var(--af-scale-3)',
  'var(--af-scale-2)',
  'var(--af-scale-1)',
];

/**
 * Clamped at both ends, not just the top.
 *
 * Every caller today passes a `map` index, so the lower bound is unreachable —
 * and the `as string` is what makes that worth closing anyway: with only
 * `Math.min`, a negative index returns `undefined` and the cast asserts it is a
 * colour. The failure would be a transparent chart segment with no error, which
 * is the kind of bug that gets found by a person squinting at a donut.
 */
export function magnitudeStep(index: number): string {
  const step = Math.min(Math.max(index, 0), MAGNITUDE_SCALE.length - 1);
  return MAGNITUDE_SCALE[step] as string;
}

/** Ring colour for an outlined status marker. */
export const TONE_BORDER: Record<Tone, string> = {
  success: 'border-success/60',
  info: 'border-info/60',
  warning: 'border-warning/60',
  danger: 'border-danger/60',
  primary: 'border-primary-border',
  muted: 'border-border-strong',
};

export function taskTone(state: TaskState): Tone {
  switch (state) {
    case 'completed':
      return 'success';
    case 'running':
      // Blue, not purple. Purple is reserved for the *pipeline's* running step,
      // which is the one thing on the screen that answers "where is this run
      // right now" — and it only reads as special if nothing else shares it.
      return 'info';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'review_required':
    case 'interrupted':
      return 'warning';
    default:
      return 'muted';
  }
}

export function stageTone(status: PipelineStatus): Tone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'primary';
    // Satisfied, so not `muted` — it fell into the default before this case
    // existed and drew identically to a stage that never ran, which is the one
    // thing it is not. `info` rather than `success` because the two are not the
    // same claim: green says this run did the work, and a reused artifact is as
    // old as whatever produced it. A stale cache is a real failure mode, and it
    // can only be noticed if the reuse is visible.
    case 'cached':
      return 'info';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'waiting_approval':
      return 'warning';
    default:
      return 'muted';
  }
}

export function runTone(status: RunStatus): Tone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'primary';
    case 'failed':
    case 'plan_rejected':
      return 'danger';
    case 'waiting_for_approval':
      return 'warning';
    case 'approved':
      return 'info';
    default:
      return 'muted';
  }
}

/** Short, upper-case, and derived from the status rather than chosen per screen. */
export function taskLabel(state: TaskState): string {
  return state.replace(/_/g, ' ').toUpperCase();
}

/**
 * One label per run status, used everywhere a run status is written.
 *
 * Mostly mechanical, with one deliberate exception: `waiting_for_approval` reads
 * "WAITING APPROVAL". Spelled out it is twenty characters, which is wider than
 * any status column a dense list can afford — and a chip reading "WAITING FOR…"
 * is not a status, it is a status you have to hover to learn. Dropping the
 * preposition is the smallest change that keeps the whole word visible, and it is
 * made here rather than in the table so the run header, the runs list, the
 * projects list and the filter menu cannot end up with three vocabularies for
 * one state.
 */
const RUN_LABELS: Partial<Record<RunStatus, string>> = {
  waiting_for_approval: 'WAITING APPROVAL',
};

export function runLabel(status: RunStatus): string {
  return RUN_LABELS[status] ?? status.replace(/_/g, ' ').toUpperCase();
}

/**
 * Tone and label for the AR-07 runtime projection (C-19, C-20).
 *
 * A distinct pair from `runTone`/`runLabel` because the two vocabularies genuinely
 * differ — `implementing`, `recovering`, `correcting` and `plan_rejected_revisable`
 * have no `RunStatus` counterpart, and the reverse is true of `running`. Reusing the
 * persisted-status functions with a cast would be the one place this file did not
 * write a colour down before choosing it.
 *
 * `running`'s stage-level counterparts — `planning`, `implementing`, `verifying`,
 * `reviewing`, `correcting`, `recovering` — get the same violet the pipeline's
 * running step uses: each one *is* the pipeline actively moving, just named for
 * where rather than restated as "running".
 */
export function runtimeTone(status: RuntimeStatus): Tone {
  switch (status) {
    case 'complete':
      return 'success';
    case 'failed':
    case 'plan_rejected_revisable':
    case 'auto_recovery_exhausted':
      return 'danger';
    case 'awaiting_human_approval':
    case 'blocked_on_human':
      return 'warning';
    case 'planning':
    case 'implementing':
    case 'verifying':
    case 'reviewing':
    case 'correcting':
    case 'recovering':
      return 'primary';
    default:
      return 'muted';
  }
}

export function runtimeLabel(status: RuntimeStatus): string {
  return status.replace(/_/g, ' ').toUpperCase();
}

/**
 * The same mappings, for a status that arrived as an aggregate key.
 *
 * Analytics groups by whatever string the run recorded, so its keys are `string`
 * rather than the unions above. Both switches end in a `default`, so an unknown
 * key becomes `muted` — which is the honest answer for a status this build does
 * not recognise, and better than either a crash or a confident colour.
 */
export function runToneOf(status: string): Tone {
  return runTone(status as RunStatus);
}

export function taskToneOf(state: string): Tone {
  return taskTone(state as TaskState);
}

export interface FormattedReviewVerdict {
  readonly label: string;
  readonly fullLabel: string;
  readonly tone: Tone;
  readonly isPassing: boolean;
  readonly isPassingWithFindings: boolean;
  readonly isBlocking: boolean;
  readonly severityCounts: Record<string, number>;
  readonly totalFindings: number;
}

/**
 * Derived presentation for plan review verdicts (§27, MVP2.1 M2.1-B).
 *
 * Verdict is preserved strictly as PASS | FAIL in the domain / storage contract.
 * PASS WITH FINDINGS is purely a presentation-level derivation when verdict is PASS
 * and findings.length > 0.
 */
export function formatPlanReviewVerdict(review?: {
  verdict: string;
  findings?: Array<{ severity: string }>;
}): FormattedReviewVerdict {
  if (review === undefined) {
    return {
      label: 'NO REVIEW',
      fullLabel: 'No review',
      tone: 'warning',
      isPassing: false,
      isPassingWithFindings: false,
      isBlocking: false,
      severityCounts: {},
      totalFindings: 0,
    };
  }

  const findings = review.findings ?? [];
  const severityCounts: Record<string, number> = {};
  for (const f of findings) {
    severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
  }
  const totalFindings = findings.length;

  if (review.verdict === 'FAIL') {
    return {
      label: 'FAIL',
      fullLabel: 'Plan review: FAIL',
      tone: 'danger',
      isPassing: false,
      isPassingWithFindings: false,
      isBlocking: true,
      severityCounts,
      totalFindings,
    };
  }

  if (totalFindings > 0) {
    return {
      label: 'PASS WITH FINDINGS',
      fullLabel: 'Plan review: PASS WITH FINDINGS',
      tone: 'warning',
      isPassing: true,
      isPassingWithFindings: true,
      isBlocking: false,
      severityCounts,
      totalFindings,
    };
  }

  return {
    label: 'PASS',
    fullLabel: 'Plan review: PASS',
    tone: 'success',
    isPassing: true,
    isPassingWithFindings: false,
    isBlocking: false,
    severityCounts: {},
    totalFindings: 0,
  };
}
