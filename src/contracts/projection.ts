/**
 * The runtime projection (AR §7, C-19 … C-22).
 *
 * A contract rather than a core detail, because it is the shape the CLI, the HTTP API and
 * the dashboard are all held to. `core/run-projection.ts` is the single function that
 * produces it; this is what it produces, and what a reader is entitled to receive.
 *
 * **Deliberately not a `*.schema.ts` module** (I-26, AD-48). Every file with that suffix
 * describes something written to disk, and mixing a projected status in among them is how a
 * crash mid-write comes to persist an opinion. Nothing here has a Zod schema, because
 * nothing here is ever parsed back in — it is computed, shipped and discarded.
 */

/**
 * What the run is doing right now.
 *
 * Wider than `RunStatus` on purpose: `recovering`, `correcting`, `blocked_on_human` and
 * `auto_recovery_exhausted` are conditions over persisted state, the event log and the
 * DAG. None of them is a lifecycle state, and none is ever written to disk.
 */
export const RUNTIME_STATUSES = [
  'planning',
  'awaiting_human_approval',
  'plan_rejected_revisable',
  'implementing',
  /** At least one task is in an automatic recovery step. */
  'recovering',
  'verifying',
  'reviewing',
  /** A corrective round is in flight. */
  'correcting',
  /** Held at a gate. Carries which gate, and the one action that clears it. */
  'blocked_on_human',
  'auto_recovery_exhausted',
  'complete',
  'failed',
  /**
   * An operator stopped it (PRI-14).
   *
   * Beside `complete` and `failed` rather than folded into either. A cancelled run that
   * reported `failed` would show a person's decision as a defect on every surface that
   * reads this; one that reported `complete` would be worse.
   */
  'cancelled',
] as const;

export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

/**
 * The three progress axes (C-21).
 *
 * Three values because they answer three questions, and collapsing them into one is what
 * produced a percentage that read 100% with verification pending and then *fell* when
 * corrective tasks were appended. A number that can go down is not progress.
 */
export interface ProgressAxes {
  /** How far along the pipeline the run is: stages reached over stages required. */
  readonly workflow: { readonly done: number; readonly total: number };
  /** Planned tasks completed over planned tasks. Corrective tasks are not counted here. */
  readonly implementation: { readonly done: number; readonly total: number };
  /**
   * Corrective tasks completed over corrective tasks, or `undefined` when none exist.
   *
   * `undefined` rather than `0/0`: a run with no corrective work has no corrective
   * progress, and rendering `0%` would suggest something is pending.
   */
  readonly corrective?: { readonly done: number; readonly total: number };
}

export interface RuntimeGate {
  /** Which gate holds the run. */
  readonly gate: 'approval' | 'task_review' | 'agent_blocked' | 'final_acceptance';
  /** The one action that clears it (AR §3.6). Never "inspect logs". */
  readonly action: string;
  /** The tasks involved, when the gate is about tasks. */
  readonly tasks: readonly string[];
}

/**
 * What an exhausted run has to say for itself (C-22).
 *
 * Structurally `RecoveryExhaustion` minus the budget object, which is a policy input rather
 * than something a reader acts on. Present exactly when the status is
 * `auto_recovery_exhausted`, and assembled here rather than by each surface — three
 * surfaces reassembling the same event log is how they came to disagree about what had
 * already been tried.
 */
export interface RuntimeEscalation {
  readonly task: string;
  readonly failureClass: string;
  /** Every counter as it stood, so the numbers are re-checkable. Empty on an older run. */
  readonly counts: Readonly<Record<string, number>>;
  /** Redacted and bounded (AD-35, I-21). Never raw runner output. */
  readonly evidence: readonly string[];
  /** Each repair attempted, in order, and how it ended. */
  readonly attemptedRepairs: readonly { readonly step: string; readonly outcome: string }[];
  /** Exactly one, and specific. Never "inspect logs". */
  readonly humanAction: string;
}

export interface RunProjection {
  readonly status: RuntimeStatus;
  /**
   * Whether the DAG yields executable work **now** (C-19).
   *
   * `Resume` is offered if and only if this is true, and `run` refuses before taking the
   * execution lock when it is false. The evidence run took and released the lock three
   * times with nothing runnable, because nothing distinguished "held at a gate" from
   * "resumable".
   */
  readonly resumable: boolean;
  /** Present exactly when the status is `blocked_on_human`. */
  readonly gate?: RuntimeGate;
  readonly progress: ProgressAxes;
  /**
   * Whether the newest review artifact is the one describing the current state (C-20).
   *
   * A review is a statement about one tree at one time. A planning stage that started
   * *after* the review was written supersedes it, and presenting it as current is how
   * `plan_rejected` stayed on screen while revision 2 was already running.
   */
  readonly reviewFreshness: 'current' | 'superseded' | 'absent';
  /** Present exactly when the status is `auto_recovery_exhausted` (C-22). */
  readonly escalation?: RuntimeEscalation;
}
