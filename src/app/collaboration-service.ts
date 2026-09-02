import type {
  AgentId,
  AgentIdentity,
  BlackboardEntry,
  CollaborationConfig,
  GlobalConfig,
  Task,
  TaskAssignment,
  WorkflowRole,
} from '../contracts/index.js';
import type { AgentRoster } from '../core/collaboration/roster.js';
import {
  buildCollaborationBootstrap,
  buildCollaborationContext,
} from '../core/collaboration/context.js';
import { projectThreads } from '../core/collaboration/threads.js';
import { projectBlackboard } from '../core/collaboration/blackboard.js';
import { projectHandoffs } from '../core/collaboration/handoffs.js';
import { resolveTaskAgent } from '../core/team/policy.js';
import type { Clock, FileSystem, Host } from '../ports/index.js';
import type { CollaborationStore } from './collaboration-store.js';
import { harvestOutbox, type HarvestOutcome } from './collaboration-harvest.js';

/**
 * The one thing this service needs from the run's persistence: the ability to say
 * something happened.
 *
 * **A narrowed interface rather than `StateStore`, and the architecture test is why.**
 * The first version of this file imported the store, and the I-27 rule failed it
 * immediately: `StateStore` can write task states, so a collaboration module holding one
 * is a module that *could* complete a task. The prose said it never would; the import
 * said it could, and an import is the half a future refactor reads.
 *
 * `StateStore` satisfies this structurally, so the wiring is unchanged and no adapter
 * exists to keep in sync. What changed is that there is now no expressible way for
 * anything in this file to move a run.
 */
export interface RunEventSink {
  appendEvent(runId: string, type: string, detail?: Record<string, unknown>): Promise<void>;
}

/**
 * What one attempt's collaboration costs the rest of the product: one call (M4-02).
 *
 * The executor's job is to run an agent and judge its work. Teaching it about mailboxes,
 * rosters, budgets and blackboards would spread a feature across the module that must stay
 * legible — `task-executor.ts` is where I-3 and AD-38 live, and a reader tracing "how does
 * a task complete" should not have to step over message handling on the way.
 *
 * So the whole of M4's behaviour reaches the executor as `collaboration?.harvest(...)`,
 * optional in exactly the way `workspaces` and `integrator` are: absent, nothing happens
 * and every existing caller behaves as it did.
 *
 * **Nothing here can move a run** (I-27). It appends to two logs and to the audit trail.
 * It returns notes, which the executor puts on the `TaskResult` — a note is prose for a
 * person, and no reader branches on it.
 */

export interface CollaborationServiceOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  /** The audit trail, and nothing else — see {@link RunEventSink}. */
  readonly store: RunEventSink;
  readonly collaboration: CollaborationStore;
  readonly roster: AgentRoster;
  readonly config: CollaborationConfig;
  /**
   * The whole configuration, for the assignment policy (M5).
   *
   * The policy reasons about `teams:` and about `collaboration.handoffsReassignExecution`
   * together, so handing it the collaboration slice alone would make one of the two
   * flags unreachable from the module that has to weigh both.
   */
  readonly globalConfig: GlobalConfig;
  /** For its home directory — redaction's second root (AD-35). */
  readonly host?: Host;
}

export interface HarvestAttemptRequest {
  readonly runId: string;
  readonly taskId: string;
  /**
   * Who was speaking.
   *
   * In M4 this is the executor role the router chose, which is also the agent's id. M4-04
   * replaces the caller's expression with `resolveTaskAgent`, and this signature does not
   * change — which is the point of an agent id being its own field from the start.
   */
  readonly agentId: AgentId;
  /** The worktree, or the project directory in sequential mode. */
  readonly workspaceDir: string;
}

export interface HarvestSummary {
  /** For the `TaskResult`. Empty when the agent said nothing, which is the ordinary case. */
  readonly notes: readonly string[];
  readonly outcome: HarvestOutcome;
}

/**
 * The two halves an implementation prompt may receive (M5, I-40).
 *
 * Separate fields rather than one concatenated string, so the executor can hand each to
 * its own telemetry source and a reader can tell what *availability* cost from what
 * *relevance* cost. M4 had one number and could not.
 */
export interface CollaborationBlocks {
  /** Always present when the channel is open. Absent only when it is closed. */
  readonly bootstrap?: string;
  /** Present only when a mechanical rule says something concerns this agent. */
  readonly context?: string;
}

/** A closed channel: no invitation, no payload. */
const SILENT_BLOCKS: CollaborationBlocks = {};

const SILENT: HarvestSummary = {
  notes: [],
  outcome: {
    messages: [],
    entries: [],
    rejections: [],
    found: false,
    refused: false,
    senderClaimed: false,
    removed: true,
  },
};

export class CollaborationService {
  constructor(private readonly options: CollaborationServiceOptions) {}

  /** Whether this run reads outboxes at all. */
  get enabled(): boolean {
    return this.options.config.enabled;
  }

  /**
   * What this agent should be told about what the others have been saying (M4-06).
   *
   * **Read before the agent is dispatched, and derived rather than stored.** Every answer
   * in the block — a thread's status, an entry's supersession — is a fold over the two
   * logs, computed here so that the CLI, the dashboard and the prompt cannot disagree
   * about what the state of a conversation is.
   *
   * Returns `undefined` when there is nothing worth spending prompt bytes on, which is the
   * common case and stays the common case: a heading with nothing under it costs real
   * bytes and teaches the agent that the section is noise.
   */
  async contextFor(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly agentId: AgentId;
    readonly files: readonly string[];
  }): Promise<CollaborationBlocks> {
    if (!this.enabled) return SILENT_BLOCKS;

    // **The invitation is unconditional** (I-40). It does not depend on the log, the
    // task or the agent, so it is composed before anything is read — and before the
    // roster is consulted: an agent that is not told the channel exists never uses it,
    // which is the deadlock M4 shipped.
    //
    // **The roster lookup used to gate this, and the live dogfood caught it.** When no
    // team member is eligible the assignment falls back to the router's *role*, and a
    // team roster contains a legacy role identity only for the roles no member staffs —
    // so `executor.trivial` resolved to nobody, this returned silence, and one
    // implementation prompt in six went out with no mention of the channel at all. That
    // is the M4 condition, reintroduced through a path nothing scripted exercises: it
    // needs a team, a task the team cannot take, and a retry.
    const bootstrap = buildCollaborationBootstrap();

    // Only the *context* needs to know who is reading it. An unknown agent gets the
    // invitation and no payload, which is the same shape a quiet run produces.
    const agent = this.options.roster.byId(request.agentId);
    if (agent === undefined) return { bootstrap };

    const messages = await this.options.collaboration.readMessages(request.runId);
    const entries = await this.options.collaboration.readEntries(request.runId);

    // The ordinary task ends here with a bootstrap and nothing else, which is what the
    // live run says eight tasks in ten look like.
    const rendered = buildCollaborationContext({
      agent,
      taskId: request.taskId,
      files: request.files,
      threads: projectThreads(messages),
      entries: projectBlackboard(entries),
      handoffs: projectHandoffs(messages),
      roster: this.options.roster.agents,
      config: this.options.config,
    });

    return { bootstrap, ...(rendered?.text ? { context: rendered.text } : {}) };
  }

  /**
   * Who executes this task (M4-04).
   *
   * Asked unconditionally, and it answers with the router's role for almost every task.
   * The seam is always live so that a function guarded by a flag never becomes a module
   * nobody calls; the *policy* is what `handoffsReassignExecution` moves.
   */
  async assignmentFor(request: {
    readonly runId: string;
    readonly task: Task;
    readonly routedRole: WorkflowRole;
    readonly canImplement: (agent: AgentIdentity) => boolean;
    /** How many tasks each member currently holds, derived from run state (I-39). */
    readonly inFlight?: ReadonlyMap<AgentId, number>;
  }): Promise<TaskAssignment> {
    // **Asked on every task, whether or not a team is configured.** With none, the policy
    // answers `routed` — the router's role, byte-identical to M4 — which is the whole of
    // the legacy guarantee and what M5-ACC-01 compares against task by task.
    //
    // Not gated on `collaboration.enabled`: assignment is a *team* concern, and a project
    // that configures a team without turning on the channel still expects its members to
    // receive work. The channel decides who may talk; this decides who works.
    const messages = this.enabled
      ? await this.options.collaboration.readMessages(request.runId)
      : [];

    return resolveTaskAgent({
      task: request.task,
      routedRole: request.routedRole,
      config: this.options.globalConfig,
      roster: this.options.roster,
      handoffs: projectHandoffs(messages),
      inFlight: request.inFlight ?? new Map(),
      canImplement: request.canImplement,
      now: this.options.clock.now(),
    });
  }

  /**
   * Reads what the agent left, records what survives, and says what was refused.
   *
   * **Called after the agent's process exits and before the validated tree is captured**
   * (I-32). The caller owns that ordering; this method assumes it and does not re-check
   * it, because a second opinion about when it is safe to read a file is a second answer
   * to a question the executor already answered by where it put the call.
   */
  async harvest(request: HarvestAttemptRequest): Promise<HarvestSummary> {
    if (!this.enabled) return SILENT;

    const { collaboration, clock } = this.options;

    const existingMessages = await collaboration.readMessages(request.runId);
    const existingEntries = await collaboration.readEntries(request.runId);

    const outcome = await harvestOutbox(this.options.fs, {
      runId: request.runId,
      taskId: request.taskId,
      agentId: request.agentId,
      workspaceDir: request.workspaceDir,
      roster: this.options.roster,
      config: this.options.config,
      existingMessages,
      existingEntries,
      now: clock.now(),
      ...(this.options.host === undefined ? {} : { homeDir: this.options.host.homeDir }),
    });

    if (!outcome.found) return { notes: [], outcome };

    // Appended before the events, so an event describing a message is never written for a
    // message that is not on disk. The reverse order would let a crash between the two
    // leave the audit trail claiming something the log cannot show.
    await collaboration.appendMessages(request.runId, outcome.messages);
    await collaboration.appendEntries(request.runId, outcome.entries);

    await this.record(request, outcome, existingEntries);

    return { notes: notesFor(outcome), outcome };
  }

  private async record(
    request: HarvestAttemptRequest,
    outcome: HarvestOutcome,
    existingEntries: readonly BlackboardEntry[],
  ): Promise<void> {
    const { store } = this.options;
    const base = { task: request.taskId, agent: request.agentId };

    if (outcome.senderClaimed) {
      await store.appendEvent(request.runId, 'collaboration_sender_claimed', base);
    }

    if (!outcome.removed) {
      await store.appendEvent(request.runId, 'collaboration_outbox_not_removed', {
        ...base,
        impact: 'the outbox will be staged into this attempt’s validated tree',
      });
    }

    for (const message of outcome.messages) {
      await store.appendEvent(request.runId, 'collaboration_message_posted', {
        ...base,
        message: message.id,
        thread: message.threadId,
        type: message.type,
        to: message.to.kind === 'agent' ? message.to.id : message.to.kind,
        truncated: message.truncated,
      });
    }

    const authorOf = new Map(existingEntries.map((entry) => [entry.id, entry.author]));
    for (const entry of outcome.entries) {
      await store.appendEvent(request.runId, 'blackboard_entry_recorded', {
        ...base,
        entry: entry.id,
        kind: entry.kind,
        subject: entry.subject,
        ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
      });

      // **The §42 defence, made visible.** Superseding an entry somebody else wrote is
      // not refused — an executor that discovers the architect's contract is wrong has to
      // be able to say so — but it does not silently win either. Both entries stay live,
      // both reach the next agent, and this event is how a person finds out there is a
      // disagreement to settle.
      const previousAuthor =
        entry.supersedes === undefined ? undefined : authorOf.get(entry.supersedes);
      if (previousAuthor !== undefined && previousAuthor !== entry.author) {
        await store.appendEvent(request.runId, 'blackboard_entry_contested', {
          ...base,
          entry: entry.id,
          supersedes: entry.supersedes,
          originalAuthor: previousAuthor,
        });
      }
    }

    for (const rejection of outcome.rejections) {
      // **Whole-file refusals are tested first, and the order is the fix.** It used to
      // branch on the reason before the scope, so an *oversized* outbox — which is a
      // budget refusal and a whole-file refusal at once — was recorded as
      // `collaboration_budget_exhausted`. The declared vocabulary says
      // `collaboration_outbox_refused` covers "unparseable, oversized, or pointing
      // somewhere it should not", so the code and its own contract disagreed, and a
      // reader looking for the documented meaning would not have found that case.
      //
      // Scope is also the more useful fact: "none of it was read" is a different thing
      // to act on than "this one item did not fit beside the others that did".
      const type = outcome.refused
        ? 'collaboration_outbox_refused'
        : rejection.reason === 'budget_exhausted' || rejection.reason === 'thread_depth_exceeded'
          ? 'collaboration_budget_exhausted'
          : 'collaboration_message_rejected';

      await store.appendEvent(request.runId, type, {
        ...base,
        reason: rejection.reason,
        subject: rejection.subject,
        detail: rejection.detail,
      });
    }
  }
}

/**
 * What the attempt's result should say about all this.
 *
 * Notes rather than a structured field, because nothing branches on them and a
 * `TaskResult` field that nothing reads is a contract nobody can change later. A person
 * reading a result wants to know that three messages were posted and one was refused;
 * everything precise is in the log and the events.
 */
function notesFor(outcome: HarvestOutcome): string[] {
  const notes: string[] = [];

  if (outcome.messages.length > 0) {
    notes.push(`collaboration: posted ${String(outcome.messages.length)} message(s)`);
  }
  if (outcome.entries.length > 0) {
    notes.push(`collaboration: recorded ${String(outcome.entries.length)} blackboard entry(ies)`);
  }
  for (const rejection of outcome.rejections) {
    notes.push(`collaboration_rejected: ${rejection.reason} — ${rejection.detail}`);
  }
  if (!outcome.removed) {
    notes.push(
      'collaboration: the outbox could not be removed and will appear in this attempt’s diff',
    );
  }

  return notes;
}
