import {
  RunStateSchema,
  type AgentView,
  type BlackboardEntryView,
  type CollaborationView,
  type HandoffView,
  type MessageThread,
  type MessageView,
  type ProjectedEntry,
  type ThreadView,
  type AgentMessage,
  type RunEvent,
  type TeamView,
  RunEventSchema,
} from '../contracts/index.js';
import { CollaborationStore } from '../app/collaboration-store.js';
import { runPaths } from '../app/paths.js';
import { loadConfig } from '../config/loader.js';
import { projectBlackboard } from '../core/collaboration/blackboard.js';
import { projectHandoffs } from '../core/collaboration/handoffs.js';
import { projectThreads } from '../core/collaboration/threads.js';
import { deriveAgentRoster, type AgentRoster } from '../core/collaboration/roster.js';
import { EMPTY_TEAM, projectTeam } from '../core/team/view.js';
import type { FileSystem } from '../ports/index.js';
import type { RegisteredProject } from './project-registry.js';

/**
 * A run's collaboration, rendered for the browser and the CLI (M4-07).
 *
 * **Every answer comes out of the same two logs and the same four projections the
 * prompt reads.** Nothing here re-derives a thread's status or an entry's supersession;
 * if the dashboard and the block an agent was shown ever disagreed, one of them would be
 * a second source of truth, and it would be this one.
 *
 * One response rather than four endpoints, and the reason is not convenience: a thread's
 * status and an entry's status are folds over logs that have to be read at one instant.
 * Four calls would let a repaint show a thread as open beside the entry that closed it.
 *
 * Nothing here reads a credential, an auth file or an environment variable, and nothing
 * it returns contains a filesystem path — an agent id is a configuration key and a runner
 * id is the name the operator gave an adapter.
 */

export interface CollaborationReaderOptions {
  readonly fs: FileSystem;
  /**
   * Where the global configuration lives, for two facts: whether the feature is on, and
   * who the agents are.
   *
   * Optional, and its absence is reported honestly rather than guessed at: a project
   * whose configuration will not load reports `enabled: false` with an empty roster,
   * because "we cannot tell" and "nobody is configured" both mean there is nothing to
   * render — and inventing a roster would put agents on screen that no run would resolve.
   */
  readonly globalConfigPath?: string;
}

/**
 * How far back a team projection reads, and how long a line it will parse.
 *
 * Bounded for the same reason the context-telemetry reader is: an events log is written
 * by the run and read by a browser, and an unbounded read is a way to make one request
 * cost a run's whole history. The most recent window is the one an operator is looking
 * at — an assignment from four hundred events ago belongs to a task that has finished.
 */
const MAX_TEAM_EVENT_SCAN = 2_000;
const MAX_TEAM_EVENT_LINE_CHARACTERS = 65_536;

const EMPTY: CollaborationView = {
  enabled: false,
  agents: [],
  threads: [],
  handoffs: [],
  entries: [],
};

export class CollaborationReader {
  constructor(private readonly options: CollaborationReaderOptions) {}

  /**
   * The run's collaboration, or `null` when the run does not exist.
   *
   * `null` and "nothing was said" are different answers and the caller renders them
   * differently: one is a 404 and the other is an empty tab. A run created before M4 is
   * the second — it has no logs, and that is not an error.
   */
  async collaboration(
    project: RegisteredProject,
    runId: string,
  ): Promise<CollaborationView | null> {
    const state = await this.readState(project, runId);
    if (state === null) return null;

    const config = await this.configOf(project);
    const roster = config === undefined ? undefined : deriveAgentRoster(config);

    const store = new CollaborationStore({ fs: this.options.fs, projectDir: project.path });
    const messages = await store.readMessages(runId);
    const entries = await store.readEntries(runId);

    // The run's own terminal status decides whether an unfinished thread is *open* or
    // *abandoned*. Read from the state rather than from the clock, because "the run is
    // over" is a fact the run records and not one a reader infers from silence.
    const runTerminated = state.status === 'completed' || state.status === 'failed';

    return {
      enabled: config?.collaboration.enabled ?? false,
      agents: (roster?.agents ?? []).map(agentView),
      threads: projectThreads(messages, { runTerminated }).map((thread) =>
        threadView(thread, roster),
      ),
      handoffs: projectHandoffs(messages, { runTerminated }).map(handoffView),
      entries: projectBlackboard(entries).map((projected) => entryView(projected, roster)),
    };
  }

  /**
   * The run's team, or `null` when the run does not exist (M5-08, M5-ACC-15).
   *
   * **Beside the collaboration rather than in it**, and in the same class rather than a
   * second reader, because both fold the same roster out of the same configuration. Two
   * readers deriving a roster is two rosters, and they would disagree the first time a
   * member was renamed — which is the failure this class's own doc comment describes for
   * threads and entries.
   *
   * Separate responses because they are separate tabs read at separate moments; a team is
   * a fold over the audit log and a conversation is a fold over the message log, and
   * neither has to be read at the other's instant.
   *
   * A run with no `teams:` block answers `configured: false` with empty lists. That is
   * not an error, and it is a different empty state from a configured team with nothing
   * assigned yet.
   */
  async team(project: RegisteredProject, runId: string): Promise<TeamView | null> {
    const state = await this.readState(project, runId);
    if (state === null) return null;

    const config = await this.configOf(project);
    if (config === undefined) return EMPTY_TEAM;

    return projectTeam({
      config,
      roster: deriveAgentRoster(config),
      tasks: state.tasks.map((task) => ({ id: task.id, state: task.state })),
      events: await this.readEvents(project, runId),
    });
  }

  /**
   * The run's audit events, bounded and tolerant.
   *
   * A malformed line is skipped rather than fatal: this renders a screen an operator
   * opens *because* something is wrong, and a log a crash truncated mid-write must not be
   * the reason they cannot see the run. The strict read belongs to the workflow, which
   * has to fail closed; a read model has to show what it can.
   */
  private async readEvents(project: RegisteredProject, runId: string): Promise<RunEvent[]> {
    const path = runPaths(project.path, runId).events;
    if (!(await this.options.fs.exists(path))) return [];

    try {
      const raw = await this.options.fs.readFile(path);
      const events: RunEvent[] = [];

      for (const line of raw.split('\n').slice(-MAX_TEAM_EVENT_SCAN)) {
        if (line.length === 0 || line.length > MAX_TEAM_EVENT_LINE_CHARACTERS) continue;
        try {
          const parsed = RunEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) events.push(parsed.data);
        } catch {
          continue;
        }
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * The run's persisted state, or `null`.
   *
   * Read directly rather than through `StateStore`, which is the writer's class: this
   * needs one field and a construction of the writer would give a read model a method
   * that can move a run.
   */
  private async readState(project: RegisteredProject, runId: string) {
    const path = runPaths(project.path, runId).state;
    if (!(await this.options.fs.exists(path))) return null;

    try {
      const parsed = RunStateSchema.safeParse(JSON.parse(await this.options.fs.readFile(path)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async configOf(project: RegisteredProject) {
    const globalConfigPath = this.options.globalConfigPath;
    if (globalConfigPath === undefined) return undefined;

    try {
      const effective = await loadConfig({
        fs: this.options.fs,
        globalConfigPath,
        projectDir: project.path,
      });
      return effective.global;
    } catch {
      // A read model that cannot resolve a fact omits it rather than inventing one
      // (§21.2). The same rule `RunReader.configOf` follows, for the same reason.
      return undefined;
    }
  }
}

function agentView(agent: {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly runner: string;
  readonly model?: string;
  readonly skills: readonly string[];
}): AgentView {
  return {
    id: agent.id,
    displayName: agent.displayName,
    role: agent.role,
    runner: agent.runner,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    skills: [...agent.skills],
  };
}

/**
 * A name for an id, resolved once, here.
 *
 * Through the roster rather than by a lookup at each render, so the CLI and the dashboard
 * cannot disagree about what to call an agent. An id nobody configured falls back to
 * itself — which is what a message from a run whose configuration has since changed
 * should read as, rather than as a blank.
 */
function nameOf(roster: AgentRoster | undefined, id: string): string {
  return roster?.byId(id)?.displayName ?? id;
}

function messageView(message: AgentMessage, roster: AgentRoster | undefined): MessageView {
  const to =
    message.to.kind === 'agent'
      ? message.to.id
      : message.to.kind === 'role'
        ? `@${message.to.role}`
        : 'everyone';

  return {
    id: message.id,
    threadId: message.threadId,
    from: message.from,
    fromName: nameOf(roster, message.from),
    to,
    type: message.type,
    ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
    subject: message.subject,
    body: message.body,
    truncated: message.truncated,
    createdAt: message.createdAt,
  };
}

function threadView(thread: MessageThread, roster: AgentRoster | undefined): ThreadView {
  return {
    id: thread.id,
    status: thread.status,
    subject: thread.subject,
    opener: thread.opener,
    ...(thread.taskId === undefined ? {} : { taskId: thread.taskId }),
    participants: thread.participants.map((id) => nameOf(roster, id)),
    messages: thread.messages.map((message) => messageView(message, roster)),
    openedAt: thread.openedAt,
    lastMessageAt: thread.lastMessageAt,
  };
}

function handoffView(handoff: {
  readonly threadId: string;
  readonly taskId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly settledAt?: string;
}): HandoffView {
  return {
    threadId: handoff.threadId,
    taskId: handoff.taskId,
    from: handoff.from,
    to: handoff.to,
    reason: handoff.reason,
    status: handoff.status,
    requestedAt: handoff.requestedAt,
    ...(handoff.settledAt === undefined ? {} : { settledAt: handoff.settledAt }),
  };
}

function entryView(
  projected: ProjectedEntry,
  roster: AgentRoster | undefined,
): BlackboardEntryView {
  const { entry, status } = projected;

  return {
    id: entry.id,
    kind: entry.kind,
    status,
    subject: entry.subject,
    author: entry.author,
    authorName: nameOf(roster, entry.author),
    statement: entry.statement,
    ...(entry.rationale === undefined ? {} : { rationale: entry.rationale }),
    affects: [...entry.affects],
    ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
    ...(projected.supersededBy === undefined ? {} : { supersededBy: projected.supersededBy }),
    createdAt: entry.createdAt,
  };
}

export { EMPTY as EMPTY_COLLABORATION };
