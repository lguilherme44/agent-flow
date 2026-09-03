import type { QualityGateResult } from './review.schema.js';
import type {
  DeliveryView,
  RunDetailView,
  TaskSummaryView,
  TeamMemberView,
  TeamTotals,
  ReviewTotals,
} from './api.schema.js';

/**
 * The control plane's shapes (M8 §4, §5, §7).
 *
 * **Deliberately not a `*.schema.ts` module**, and for the reason `projection.ts` gives:
 * every file with that suffix describes something written to disk, and a lane or a
 * priority written to disk is an opinion a crash mid-write would persist. Nothing here has
 * a Zod schema because nothing here is ever parsed back in — it is computed, shipped and
 * discarded.
 *
 * Nor is any of it a second workflow authority. Every field below is a fold over a fact
 * some other projection already decided; M8 adds an *order* and a *lane*, and nothing else.
 */

/* ─── Attention (M8 §4) ────────────────────────────────────────────────────── */

/**
 * The ladder, and it is a policy stated in one place rather than a truth.
 *
 * Deterministic on purpose. An LLM-ranked queue is a queue whose order changes between two
 * reads of the same facts, and reproducibility is the one property an operator's queue
 * cannot do without: "this moved to the top" has to mean something changed.
 */
export const ATTENTION_PRIORITIES = [
  /** Safety or integrity. Acting wrongly here loses work. */
  'P0',
  /** A human decision is the only thing between the run and progress. */
  'P1',
  /** Something authoritative failed. */
  'P2',
  /** Degraded, still moving. */
  'P3',
  /** Actionable, not urgent. */
  'P4',
] as const;
export type AttentionPriority = (typeof ATTENTION_PRIORITIES)[number];

/**
 * Every reason this system can ask for a person, by name.
 *
 * A closed vocabulary rather than free text, so a surface can group, count and test them —
 * and so adding a reason is a deliberate act with a priority attached rather than a new
 * sentence appearing in a list.
 *
 * `required_gate_not_run` is separate from `required_gate_failed` on purpose. M6 settled
 * that distinction at run granularity and it survives here in words: an environment that
 * could not answer is not a codebase that answered no, and rendering both as one red thing
 * teaches people that red means "look into it".
 */
export const ATTENTION_KINDS = [
  // P0 — integrity
  'remote_diverged',
  'integration_conflict',
  'ownership_conflict',
  // P1 — a person is the blocker
  'approval_required',
  'task_review_required',
  'agent_blocked',
  'recovery_exhausted',
  // P2 — something authoritative failed
  'task_failed',
  'required_gate_failed',
  'required_gate_not_run',
  'blocking_finding_open',
  'delivery_failed',
  /**
   * The remote's own checks went red.
   *
   * A P2 beside the local failures and **never merged with them**. M7 §10 is unchanged: a
   * remote check is an observation and never a local verdict, so the sentence says which
   * one it is. Found by the first real-data read of this projection — a run with three
   * failed GitHub checks produced an empty queue, which is the exact silence this
   * milestone exists to remove.
   */
  'remote_checks_red',
  // P3 — degraded
  'review_stale',
  'capacity_starvation',
  'run_paused',
  'degradation_recorded',
  // P4 — informational
  'checks_pending',
  'delivery_not_published',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/**
 * What the one recommended action does.
 *
 * Every value except `inspect` is a use case that already exists and that the CLI already
 * calls. `inspect` is navigation — the honest answer when the next step is a person
 * reading something, and far better than a button that pretends to fix it.
 */
export const ATTENTION_ACTIONS = [
  'approve',
  'revise',
  'retry',
  'resume',
  'start',
  'cancel',
  'forge_publish',
  'forge_sync',
  'inspect',
] as const;
export type AttentionActionKind = (typeof ATTENTION_ACTIONS)[number];

/**
 * Where the operator lands, as a *surface* rather than a URL.
 *
 * The core does not know about routes, and it must not: a projection that emitted
 * `/runs/AF-2026-001?view=board` would be the domain deciding the browser's information
 * architecture. The browser maps this to a route, which is presentation and is the one
 * thing it is allowed to decide.
 */
export const ATTENTION_FOCUSES = [
  'run',
  'plan',
  'task',
  'review',
  'quality',
  'delivery',
  'team',
] as const;
export type AttentionFocus = (typeof ATTENTION_FOCUSES)[number];

export interface AttentionAction {
  readonly kind: AttentionActionKind;
  /** Imperative and specific. "Approve plan", never "Take action". */
  readonly label: string;
  /**
   * Whether this action ends or spends something (M8 §8).
   *
   * Carried here rather than decided by the button, so a confirmation is a property of the
   * action instead of a habit of whoever wrote that component.
   */
  readonly destructive: boolean;
}

export interface AttentionScope {
  readonly runId: string;
  readonly taskId?: string;
  readonly findingId?: string;
  readonly agentId?: string;
  readonly gateId?: string;
}

export interface AttentionItem {
  /**
   * Stable across reads, derived from the cause.
   *
   * Never an index or a counter. The queue is live: an item whose identity changes between
   * two reads remounts, loses focus, and animates a row that did not change.
   */
  readonly id: string;
  readonly priority: AttentionPriority;
  readonly kind: AttentionKind;
  /** What. One sentence, specific. Never "something failed — check the logs". */
  readonly what: string;
  /** Why: the fact this was folded from, in the operator's vocabulary. */
  readonly why: string;
  readonly scope: AttentionScope;
  /** When the underlying fact became true. */
  readonly since: string;
  /** Exactly one. A queue with ten buttons per row is a queue nobody reads. */
  readonly action: AttentionAction;
  readonly focus: AttentionFocus;
}

/* ─── Board (M8 §5) ────────────────────────────────────────────────────────── */

/**
 * Six lanes, and `unknown` is the seventh for a reason.
 *
 * A task carrying a state this build does not know — an older run, a forward-compatible
 * write — must not fall into `backlog`. A task nobody can see is worse than a task in a
 * lane labelled honestly, and silently defaulting is exactly how a board comes to disagree
 * with the run it claims to describe.
 */
export const BOARD_LANES = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'blocked',
  'done',
  'unknown',
] as const;
export type BoardLane = (typeof BOARD_LANES)[number];

/**
 * Why a card is in the lane it is in, in one sentence a person can act on.
 *
 * The reason M8 is worth building. Every fact below already existed — the DAG knew the
 * task waits on TASK-004, `TeamView.deferrals` knew the wave held it for capacity, the
 * review thread knew two findings block it — and none of them was ever joined to the card
 * the operator was looking at. A Kanban without this is a prettier task table.
 */
export interface BoardReason {
  /** The sentence. Always present for a card that is not `done`. */
  readonly text: string;
  /**
   * What kind of thing is holding it, for grouping and for tests.
   *
   * `none` for a card that is simply progressing.
   */
  readonly cause:
    | 'none'
    | 'dependency'
    | 'capacity'
    | 'ownership'
    | 'attempt'
    | 'integration'
    | 'review'
    | 'human'
    | 'failure'
    | 'unknown';
  /** Tasks this one waits on, when the cause is a dependency. */
  readonly waitsFor?: readonly string[];
}

export interface BoardCardView {
  readonly task: TaskSummaryView;
  readonly lane: BoardLane;
  readonly reason: BoardReason;
  /** The agent holding it, when the run recorded an assignment. */
  readonly agentId?: string;
  readonly agentName?: string;
  /** Open blocking findings on this task, from the review projection. Never recounted. */
  readonly blockingFindings: number;
  /**
   * Whether this task appears in the attention queue, and at what priority.
   *
   * Carried on the card so the board can mark it without the component joining two lists —
   * which is the join a component gets wrong the first time one of them is stale.
   */
  readonly attention?: AttentionPriority;
}

export interface BoardLaneView {
  readonly lane: BoardLane;
  readonly count: number;
}

/* ─── The snapshot (M8 §7) ─────────────────────────────────────────────────── */

/**
 * Team pressure, small enough to ship with every snapshot.
 *
 * The full `TeamView` stays at `/team`; this is the half the control plane reads on every
 * paint. `load` is derived from running assignments and is never stored — a persisted
 * `busy` is a second copy of task state, and after a crash it is the copy claiming
 * somebody is working on a task that is not.
 */
export interface TeamPressureView {
  readonly configured: boolean;
  readonly members: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly role: string;
    readonly running: number;
    readonly capacity: number;
    readonly status: TeamMemberView['status'];
  }[];
  readonly totals: TeamTotals;
}

export interface ReviewPressureView {
  readonly reviewed: boolean;
  readonly totals: ReviewTotals;
  /** Required gates that are not satisfied — the server's answer, never recounted. */
  readonly unsatisfiedGates: readonly QualityGateResult[];
}

/**
 * One read, one instant (M8 §7).
 *
 * The board and the attention queue read from separate endpoints could show a task
 * `running` beside an item saying it failed — both correct, milliseconds apart. This is
 * the fix, and its cost is honest: it is a second read path over the same facts. It
 * *composes* the existing readers rather than reimplementing them, and an architecture
 * rule asserts that composition rather than trusting it.
 */
export interface ControlSnapshotView {
  readonly run: RunDetailView;
  readonly cards: readonly BoardCardView[];
  readonly lanes: readonly BoardLaneView[];
  readonly attention: readonly AttentionItem[];
  readonly team: TeamPressureView;
  readonly review: ReviewPressureView;
  readonly delivery: DeliveryView;
  /**
   * The instant this snapshot describes.
   *
   * The live stream can deliver an event about a task a newer snapshot already reflects.
   * A repaint back to `running` after a task completed is a lie with a timestamp on it, so
   * the browser accepts a snapshot only when this is not older than the one on screen.
   */
  readonly observedAt: string;
}

/* ─── Workspace (M8 §37) ───────────────────────────────────────────────────── */

/**
 * A project, at the density a list of fifty of them can afford.
 *
 * Explicitly *not* a `RunDetailView` each. Reading fifty run directories in full to render
 * fifty rows is the N+1 this level exists to avoid, and the operator's question here is
 * "which of these wants me", which needs a count and a top priority rather than a plan.
 */
export interface WorkspaceProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly runId?: string;
  readonly feature?: string;
  readonly status?: string;
  /** The runtime status, which is what "is it moving" actually asks. */
  readonly runtime?: string;
  readonly progress: number;
  readonly taskCount: number;
  readonly blockedCount: number;
  readonly attentionCount: number;
  /** The most urgent priority present, or absent when nothing needs anybody. */
  readonly topPriority?: AttentionPriority;
  readonly delivery?: DeliveryView['state'];
  readonly teamLoad?: { readonly running: number; readonly capacity: number };
  readonly lastActivityAt?: string;
}

export interface WorkspaceView {
  readonly projects: readonly WorkspaceProjectView[];
  readonly observedAt: string;
}
