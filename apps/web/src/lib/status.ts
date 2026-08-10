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

export function taskTone(state: TaskState): Tone {
  switch (state) {
    case 'completed':
      return 'success';
    case 'running':
      return 'primary';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'review_required':
    case 'interrupted':
      return 'warning';
    case 'ready':
      return 'info';
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

/** Short, upper-case, and the same words the CLI prints. */
export function taskLabel(state: TaskState): string {
  return state.replace(/_/g, ' ').toUpperCase();
}

export function runLabel(status: RunStatus): string {
  return status.replace(/_/g, ' ').toUpperCase();
}
