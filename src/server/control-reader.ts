import type { Clock } from '../ports/clock.js';
import type {
  AttentionItem,
  ControlSnapshotView,
  DeliveryView,
  ReviewView,
  RunDetailView,
  TaskSummaryView,
  TeamView,
  WorkspaceProjectView,
  WorkspaceView,
} from '../contracts/index.js';
import { projectAttention } from '../core/attention.js';
import { laneCounts, projectBoard, type BoardContext } from '../core/board.js';
import type { CollaborationReader } from './collaboration-reader.js';
import type { RegisteredProject } from './project-registry.js';
import type { RunReader } from './run-reader.js';

/**
 * One read, one instant (M8 §7).
 *
 * The dashboard used to issue eight independent queries for one run. Each was correct;
 * together they could paint a board showing a task `running` beside an attention item
 * saying it failed — both true, milliseconds apart. An operator cannot tell that from a
 * bug, and a control plane whose two halves disagree is worse than the eight panels it
 * replaced.
 *
 * **This composes the existing readers and reimplements none of them.** It is the second
 * read path over facts that already have one, which is exactly the shape of defect this
 * milestone exists to remove — so the discipline is structural rather than intended: every
 * part of a snapshot comes from the same method that serves that part's own endpoint, and
 * an architecture rule asserts the composition. If any field here is ever computed
 * differently from `/tasks`, `/team`, `/review` or `/delivery`, that is the failure.
 *
 * Its own class rather than a method on `RunReader`, for the reason `CollaborationReader`
 * is its own: it needs both of them, and folding it in would make the class every run page
 * depends on grow a third job.
 */

export interface ControlReaderOptions {
  readonly runs: RunReader;
  readonly collaboration: CollaborationReader;
  readonly clock: Clock;
}

export class ControlReader {
  constructor(private readonly options: ControlReaderOptions) {}

  async snapshot(
    project: RegisteredProject,
    runId: string,
  ): Promise<ControlSnapshotView | null> {
    const run = await this.options.runs.runDetail(project, runId);
    if (run === null) return null;

    // Read together, not in sequence: the whole point of this method is one instant, and
    // four awaits in a row is four instants with a `for` loop's worth of drift between the
    // first and the last.
    const [tasks, events, team, review, delivery] = await Promise.all([
      this.options.runs.tasks(project, runId),
      this.options.runs.events(project, runId),
      this.options.collaboration.team(project, runId),
      this.options.collaboration.review(project, runId),
      this.options.collaboration.delivery(project, runId),
    ]);

    const taskList = tasks ?? [];
    const context = boardContext(run, taskList, team, review);

    const attention = projectAttention({
      runId,
      runtime: run.runtime,
      tasks: taskList,
      run: {
        updatedAt: run.updatedAt,
        degradations: run.degradationDetail,
        integrationConflicts: run.integrationConflicts,
      },
      ...(review === null ? {} : { review }),
      ...(team === null ? {} : { team }),
      ...(delivery === null ? {} : { delivery }),
      events,
    });

    const cards = projectBoard(taskList, context, attention);

    return {
      run,
      cards,
      lanes: laneCounts(cards),
      attention,
      team: teamPressure(team),
      review: reviewPressure(review),
      delivery: delivery ?? DISABLED_DELIVERY,
      observedAt: this.options.clock.now(),
    };
  }

  /**
   * Every project, at the density a list of fifty of them can afford (M8 §37).
   *
   * **Only a project with an active run pays for an attention count.** Computing one needs
   * the review, the team and the delivery record — four more file reads — and a workspace
   * where every idle project paid that would take seconds to answer a question about the
   * two that are running. An idle project reports zero, which is not an approximation: a
   * run that has finished has nothing anybody must do about it, and the one exception —
   * "finished and never published" — belongs to a project whose run is still current.
   */
  async workspace(projects: readonly RegisteredProject[]): Promise<WorkspaceView> {
    const views: WorkspaceProjectView[] = [];

    for (const project of projects) {
      // One corrupt project must not take the workspace down with it, the same rule
      // `listRuns` follows for one corrupt run.
      try {
        views.push(await this.projectRow(project));
      } catch {
        views.push({
          projectId: project.id,
          name: project.name,
          progress: 0,
          taskCount: 0,
          blockedCount: 0,
          attentionCount: 0,
        });
      }
    }

    return { projects: views, observedAt: this.options.clock.now() };
  }

  private async projectRow(project: RegisteredProject): Promise<WorkspaceProjectView> {
    const overview = await this.options.runs.projectOverview(project);
    const runId = overview.currentRunId;

    if (runId === null) {
      return {
        projectId: project.id,
        name: project.name,
        progress: 0,
        taskCount: 0,
        blockedCount: 0,
        attentionCount: 0,
        ...(overview.lastRun === undefined ? {} : { lastActivityAt: overview.lastRun.updatedAt }),
      };
    }

    const snapshot = await this.snapshot(project, runId);
    if (snapshot === null) {
      return {
        projectId: project.id,
        name: project.name,
        progress: 0,
        taskCount: 0,
        blockedCount: 0,
        attentionCount: 0,
      };
    }

    const blocked = snapshot.lanes.find((lane) => lane.lane === 'blocked')?.count ?? 0;
    const running = snapshot.team.members.reduce((sum, member) => sum + member.running, 0);
    const capacity = snapshot.team.members.reduce((sum, member) => sum + member.capacity, 0);

    return {
      projectId: project.id,
      name: project.name,
      runId,
      feature: snapshot.run.feature,
      status: snapshot.run.status,
      runtime: snapshot.run.runtime.status,
      progress: snapshot.run.progress,
      taskCount: snapshot.run.taskCount,
      blockedCount: blocked,
      attentionCount: snapshot.attention.length,
      ...(topPriority(snapshot.attention) === undefined
        ? {}
        : { topPriority: topPriority(snapshot.attention) }),
      ...(snapshot.delivery.state === 'disabled' ? {} : { delivery: snapshot.delivery.state }),
      ...(snapshot.team.configured ? { teamLoad: { running, capacity } } : {}),
      lastActivityAt: snapshot.run.updatedAt,
    };
  }
}

/**
 * What a task cannot answer about itself, joined from the views the detail panels read.
 *
 * **Readiness is not among them.** `TaskSummaryView.state` already carries it: `ready` is a
 * condition over the graph that §22 refuses to persist, and `effectiveTaskStates` — the one
 * function every reader goes through — resolves it before a view exists. Asking the DAG a
 * second time here would be a second answer to "what may start", and the server is
 * forbidden from importing `core/dag` for exactly that reason.
 *
 * So this joins three things and no more: what each task is still waiting on, which wave
 * held it, and who has it.
 */
function boardContext(
  run: RunDetailView,
  tasks: readonly TaskSummaryView[],
  team: TeamView | null,
  review: ReviewView | null,
): BoardContext {
  const states = new Map(tasks.map((task) => [task.id, task.state]));

  // Unmet dependencies, in the plan's order. Unmet rather than all: "waiting on TASK-001,
  // TASK-004" where TASK-001 finished an hour ago sends somebody to the wrong task.
  const waitingOn = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const unmet = task.dependencies.filter((dependency) => states.get(dependency) !== 'completed');
    if (unmet.length > 0) waitingOn.set(task.id, unmet);
  }

  // The last assignment per task is the one in force: a reassignment appends to the log
  // rather than rewriting it, so the log keeps the history and this keeps the answer.
  const assignments = new Map<string, { agentId: string; agentName: string }>();
  for (const assignment of team?.assignments ?? []) {
    assignments.set(assignment.taskId, {
      agentId: assignment.agentId,
      agentName: assignment.agentName,
    });
  }

  return {
    runtime: run.runtime,
    waitingOn,
    deferrals: team?.deferrals ?? [],
    threads: review?.threads ?? [],
    assignments,
  };
}

function teamPressure(team: TeamView | null): ControlSnapshotView['team'] {
  if (team === null || !team.configured) {
    return {
      configured: false,
      members: [],
      totals: {
        assignments: 0,
        reassignments: 0,
        capacityDeferrals: 0,
        ownershipDeferrals: 0,
        candidatesConsidered: 0,
        exclusions: {},
      },
    };
  }

  return {
    configured: true,
    members: team.members.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      role: member.role,
      // Derived from the assignments the run recorded, never stored. A persisted `busy`
      // is a second copy of task state, and after a crash it is the copy claiming somebody
      // is working on a task that is not.
      running: member.assigned.length,
      capacity: member.maxConcurrentTasks,
      status: member.status,
    })),
    totals: team.totals,
  };
}

function reviewPressure(review: ReviewView | null): ControlSnapshotView['review'] {
  if (review === null) {
    return {
      reviewed: false,
      totals: {
        reviews: 0,
        tasksReviewed: 0,
        findings: 0,
        openFindings: 0,
        verifiedFindings: 0,
        staleReviews: 0,
        disputes: 0,
        bySeverity: {},
        byCategory: {},
        byIndependence: {},
      },
      unsatisfiedGates: [],
    };
  }

  return {
    reviewed: review.reviewed,
    totals: review.totals,
    // The server's answer, carried rather than recomputed. `required && status !== passed`
    // is the sentence that turns evidence into a refusal, and it lives in one place.
    unsatisfiedGates: review.unsatisfiedGates,
  };
}

/** What a run with no forge configured delivers to: nowhere, and that is not a problem. */
const DISABLED_DELIVERY: DeliveryView = {
  state: 'disabled',
  provider: 'none',
  checks: [],
  checkSummary: { total: 0, green: 0, red: 0, pending: 0 },
  detail: 'no forge is configured, so this run delivers nowhere',
};

function topPriority(items: readonly AttentionItem[]): AttentionItem['priority'] | undefined {
  // The queue is already sorted by the projection, so the first item is the most urgent.
  // Re-deriving it here would be a second ordering to disagree with.
  return items[0]?.priority;
}
