import type { PipelineStatus, RunStatus, TaskState } from '@contracts/index.js';

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
