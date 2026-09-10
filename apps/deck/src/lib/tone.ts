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

/**
 * How severe a finding is, as a colour — `FINDING_SEVERITIES`, least severe first.
 *
 * The gate dialog spelled this inline as a nested ternary before the outcome panel needed
 * the same answer. Two copies of "which severities are red" is exactly the disagreement
 * this file exists to prevent, and the dialog now asks here.
 */
export function severityTone(severity: string | undefined): Tone {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'bad';
    case 'medium':
      return 'warn';
    case 'low':
      return 'idle';
    case 'info':
      return 'ghost';
    default:
      return 'ghost';
  }
}

/**
 * A finding's place in its lifecycle.
 *
 * `disputed` is `warn` rather than `bad`: two agents disagreeing is a thing for a person to
 * settle, not a defect. `fixed` is `live` rather than `ok` — a corrective task claims the
 * fix, and only `verified` says somebody looked.
 */
export function findingTone(status: string | undefined): Tone {
  switch (status) {
    case 'verified':
      return 'ok';
    case 'fixed':
      return 'live';
    case 'disputed':
    case 'acknowledged':
      return 'warn';
    case 'open':
      return 'bad';
    default:
      return 'ghost';
  }
}

/** `GATE_STATUSES`. `not_run` is never shown as a pass (I-24), so it is not `ok`. */
export function gateTone(status: string | undefined): Tone {
  switch (status) {
    case 'passed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'not_run':
      return 'idle';
    case 'not_applicable':
      return 'ghost';
    default:
      return 'ghost';
  }
}

/** One review thread's status, as the review projection answered it. */
export function threadTone(status: string | undefined): Tone {
  switch (status) {
    case 'approved':
      return 'ok';
    case 'in_review':
    case 'awaiting_recheck':
      return 'live';
    case 'changes_requested':
      return 'warn';
    case 'blocked':
      return 'bad';
    default:
      return 'ghost';
  }
}

/**
 * A remote check, from the forge's own two fields.
 *
 * The conclusion is the answer once there is one, and the status is the answer until then —
 * a check that is `completed` with no conclusion is a forge that told us less than it
 * promised, and `ghost` says exactly that rather than guessing green.
 */
export function checkTone(status: string | undefined, conclusion: string | undefined): Tone {
  if (conclusion !== undefined) {
    switch (conclusion) {
      case 'success':
        return 'ok';
      case 'neutral':
      case 'skipped':
        return 'ghost';
      case 'cancelled':
      case 'stale':
        return 'idle';
      default:
        return 'bad';
    }
  }
  switch (status) {
    case 'queued':
      return 'idle';
    case 'in_progress':
      return 'live';
    default:
      return 'ghost';
  }
}

/**
 * How far the reviewer stood from the author (§19), as a colour.
 *
 * `0` is unreachable by configuration and `bad` if it ever appears; `1` is a fresh context
 * on the same model, which is the level a degradation lands on.
 */
export function independenceTone(level: number | undefined): Tone {
  switch (level) {
    case 3:
      return 'ok';
    case 2:
      return 'live';
    case 1:
      return 'warn';
    case 0:
      return 'bad';
    default:
      return 'ghost';
  }
}

/** Whether a statement still describes the current tree (C-20, and the review's own field). */
export function freshnessTone(freshness: string | undefined): Tone {
  switch (freshness) {
    case 'current':
      return 'ok';
    case 'stale':
    case 'superseded':
      return 'warn';
    case 'unverifiable':
      return 'bad';
    case 'absent':
      return 'ghost';
    default:
      return 'ghost';
  }
}

/**
 * One conversation between two agents, as `core/collaboration/threads.ts` folded it.
 *
 * Not `threadTone`: that one answers for a *review* thread, whose words are `approved`
 * and `changes_requested`. These four are a different vocabulary over a different log,
 * and one function trying to serve both would answer `ghost` to half of each — which is
 * how an open question comes to look like an absence.
 *
 * `open` is `warn` and `answered` is `live`: an unanswered question is the one waiting on
 * somebody, and a run that ended mid-conversation (`abandoned`) is history, not a fault.
 */
export function conversationTone(status: string | undefined): Tone {
  switch (status) {
    case 'resolved':
      return 'ok';
    case 'answered':
      return 'live';
    case 'open':
      return 'warn';
    case 'abandoned':
      return 'ghost';
    default:
      return 'ghost';
  }
}

/** A handoff request, from `projectHandoffs`. `requested` is the only one still waiting. */
export function handoffTone(status: string | undefined): Tone {
  switch (status) {
    case 'accepted':
      return 'ok';
    case 'rejected':
      return 'bad';
    case 'requested':
      return 'warn';
    case 'expired':
      return 'ghost';
    default:
      return 'ghost';
  }
}

/**
 * A blackboard entry's standing (M4-06).
 *
 * `contested` is `warn` rather than `bad` for the reason `findingTone` gives disputes the
 * same colour: two agents disagreeing is a thing for a person to settle, not a defect.
 * `superseded` is `ghost` because a corrected entry is history — and the core is explicit
 * that the two are different, which is why there are three statuses and not two.
 */
export function entryTone(status: string | undefined): Tone {
  switch (status) {
    case 'active':
      return 'ok';
    case 'contested':
      return 'warn';
    case 'superseded':
      return 'ghost';
    default:
      return 'ghost';
  }
}

/*
  `words()` used to live here, and it does not any more.

  This file's first line says what it is for: "the one place a status becomes a colour".
  Turning a token into *language* is a different job that was sitting here because both
  start from the same string — and the day the Deck learned a second language, the two
  stopped being the same size. It is `word(t, token)` in `lib/i18n`, where the table that
  answers it lives.
*/
