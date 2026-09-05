/**
 * The one place a status becomes a colour.
 *
 * Six tones, and every string the server can send lands on one of them here and nowhere
 * else. A component never asks "is this state failed"; it asks for the tone of a value the
 * server already chose, and renders that. Two components mapping the same word to two
 * colours is how a screen comes to disagree with itself.
 *
 *   ok     done, merged, passed, green
 *   live   moving right now
 *   warn   waiting on a person, degraded, held
 *   bad    failed, refused, red
 *   idle   not yet, queued, pending
 *   ghost  absent, unknown, cached, disabled
 */
export type Tone = 'ok' | 'live' | 'warn' | 'bad' | 'idle' | 'ghost';

export function taskTone(state: string | undefined): Tone {
  switch (state) {
    case 'completed':
      return 'ok';
    case 'running':
      return 'live';
    case 'review_required':
    case 'blocked':
      return 'warn';
    case 'failed':
    case 'interrupted':
      return 'bad';
    case 'queued':
    case 'ready':
      return 'idle';
    default:
      return 'ghost';
  }
}

export function stageTone(status: string | undefined): Tone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'running':
      return 'live';
    case 'waiting_approval':
    case 'blocked':
      return 'warn';
    case 'failed':
      return 'bad';
    case 'cached':
    case 'reused':
      return 'ghost';
    case 'pending':
      return 'idle';
    default:
      return 'ghost';
  }
}

export function runtimeTone(status: string | undefined): Tone {
  switch (status) {
    case 'complete':
      return 'ok';
    case 'planning':
    case 'implementing':
    case 'verifying':
    case 'reviewing':
    case 'recovering':
    case 'correcting':
      return 'live';
    case 'awaiting_human_approval':
    case 'plan_rejected_revisable':
    case 'blocked_on_human':
      return 'warn';
    case 'failed':
    case 'auto_recovery_exhausted':
      return 'bad';
    case 'cancelled':
      return 'ghost';
    default:
      return 'idle';
  }
}

export function runStatusTone(status: string | undefined): Tone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'running':
    case 'approved':
      return 'live';
    case 'waiting_for_approval':
    case 'plan_rejected':
      return 'warn';
    case 'failed':
      return 'bad';
    case 'cancelled':
      return 'ghost';
    default:
      return 'idle';
  }
}

export function priorityTone(priority: string | undefined): Tone {
  switch (priority) {
    case 'P0':
    case 'P2':
      return 'bad';
    case 'P1':
    case 'P3':
      return 'warn';
    case 'P4':
      return 'idle';
    default:
      return 'ghost';
  }
}

export function deliveryTone(state: string | undefined): Tone {
  switch (state) {
    case 'checks_green':
      return 'ok';
    case 'published':
    case 'pr_open':
    case 'checks_pending':
      return 'live';
    case 'remote_diverged':
    case 'checks_red':
    case 'delivery_failed':
      return 'bad';
    case 'not_published':
      return 'idle';
    default:
      return 'ghost';
  }
}

export function memberTone(status: string | undefined): Tone {
  switch (status) {
    case 'working':
      return 'live';
    case 'full':
      return 'warn';
    case 'idle':
      return 'idle';
    default:
      return 'ghost';
  }
}

/** A human label for a machine word: `awaiting_human_approval` → `awaiting human approval`. */
export function words(value: string | undefined): string {
  if (value === undefined) return '—';
  return value.replace(/[_-]+/g, ' ');
}
