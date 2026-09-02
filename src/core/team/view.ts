import type {
  CandidateView,
  GlobalConfig,
  RunEvent,
  TaskAssignmentView,
  TeamMemberView,
  TeamTotals,
  TeamView,
  WaveDeferralView,
} from '../../contracts/index.js';
import { normaliseSkills } from '../../contracts/index.js';
import { teamMembers, type AgentRoster } from '../collaboration/roster.js';

/**
 * A run's team, folded out of the audit log (M5-08, M5-ACC-15).
 *
 * **One projection, three surfaces.** The CLI renders this, the HTTP API returns it, and
 * the dashboard draws it. None of them computes an assignment: a browser that ranked
 * candidates would be a second assignment authority, and the first time it disagreed with
 * the run the operator would be reading a screen describing a decision nobody made
 * (I-33). The same rule `projectThreads` follows, for the same reason.
 *
 * Pure, and a fold over facts the run already recorded. Nothing here re-derives who
 * *should* have got a task — that question was answered once, by `core/team/policy.ts`,
 * at the instant the task started, and the answer is in the log.
 *
 * **Status is derived, never stored** (I-39). A member is `working` because a task the
 * run says is running was assigned to it. A persisted `busy` flag would be a second copy
 * of task state, and after a crash it would be the copy claiming somebody is working on a
 * task that is not.
 */

export interface TeamProjectionInput {
  /** Absent when the configuration would not load. Reported as unconfigured, not guessed. */
  readonly config: GlobalConfig | undefined;
  readonly roster: AgentRoster | undefined;
  /** The run's tasks and their states, for the `working` half of a derived status. */
  readonly tasks: readonly { readonly id: string; readonly state: string }[];
  /** The run's audit events, already parsed. Malformed lines are dropped at the boundary. */
  readonly events: readonly RunEvent[];
}

const EMPTY_TOTALS: TeamTotals = {
  assignments: 0,
  reassignments: 0,
  capacityDeferrals: 0,
  ownershipDeferrals: 0,
  candidatesConsidered: 0,
  exclusions: {},
};

export const EMPTY_TEAM: TeamView = {
  configured: false,
  members: [],
  assignments: [],
  deferrals: [],
  totals: EMPTY_TOTALS,
};

export function projectTeam(input: TeamProjectionInput): TeamView {
  const members = input.config === undefined ? [] : teamMembers(input.config);
  const assignments = assignmentsOf(input);
  const deferrals = deferralsOf(input.events);

  // The last assignment per task, which is the one in force. A reassignment appends
  // rather than rewrites, so the log keeps the whole history and this keeps the answer.
  const current = new Map<string, TaskAssignmentView>();
  for (const assignment of assignments) current.set(assignment.taskId, assignment);

  const running = new Set(
    input.tasks.filter((task) => task.state === 'running').map((task) => task.id),
  );

  return {
    configured: members.length > 0,
    members: members.map(({ agentId, member }) => {
      const identity = input.roster?.byId(agentId);
      const assigned = [...current.values()]
        .filter((held) => held.agentId === agentId && running.has(held.taskId))
        .map((held) => held.taskId)
        .sort();

      const view: TeamMemberView = {
        id: agentId,
        displayName: identity?.displayName ?? member.displayName ?? agentId,
        role: member.roles[0] ?? 'executor.normal',
        runner: member.runner,
        ...(member.model === undefined ? {} : { model: member.model }),
        skills: normaliseSkills(member.skills),
        specializations: normaliseSkills(member.specializations),
        maxConcurrentTasks: member.capacity.maxConcurrentTasks,
        ownership: {
          preferred: [...member.ownership.preferred],
          exclusive: [...member.ownership.exclusive],
          shared: [...member.ownership.shared],
        },
        assigned,
        assignedTotal: assignments.filter((held) => held.agentId === agentId).length,
        status:
          assigned.length >= member.capacity.maxConcurrentTasks
            ? 'full'
            : assigned.length > 0
              ? 'working'
              : 'idle',
      };

      return view;
    }),
    assignments,
    deferrals,
    totals: {
      assignments: assignments.length,
      reassignments: assignments.filter((held) => held.previousAgentId !== undefined).length,
      capacityDeferrals: deferrals.filter((held) => held.reason === 'capacity').length,
      ownershipDeferrals: deferrals.filter((held) => held.reason === 'ownership').length,
      candidatesConsidered: assignments.reduce((sum, held) => sum + held.candidates.length, 0),
      exclusions: exclusionsOf(assignments),
    },
  };
}

/**
 * Every assignment the run recorded, in the order it recorded them.
 *
 * `task_assigned` is emitted only when the answer is not the router's, so a legacy run
 * projects an empty list — which is correct rather than missing: there was no decision to
 * explain, and inventing one row per task would put a ranking on screen that never ran.
 */
function assignmentsOf(input: TeamProjectionInput): TaskAssignmentView[] {
  const views: TaskAssignmentView[] = [];

  for (const event of input.events) {
    if (event.type !== 'task_assigned' && event.type !== 'task_reassigned') continue;

    const detail = event.detail;
    const taskId = stringOf(detail['task']);
    const agentId = stringOf(detail['agent']);
    if (taskId === undefined || agentId === undefined) continue;

    views.push({
      taskId,
      agentId,
      agentName: input.roster?.byId(agentId)?.displayName ?? agentId,
      role: stringOf(detail['role']) ?? '',
      reason: stringOf(detail['reason']) ?? '',
      ...(stringOf(detail['detail']) === undefined ? {} : { detail: stringOf(detail['detail']) }),
      ...(stringOf(detail['previousAgent']) === undefined
        ? {}
        : { previousAgentId: stringOf(detail['previousAgent']) }),
      assignedAt: event.at,
      candidates: candidatesOf(detail['candidates'], input.roster),
    });
  }

  return views;
}

/**
 * The ranking as it was recorded, or nothing.
 *
 * Read defensively because this is a fold over a log a previous version of the product
 * wrote: a row from before the ranking existed has no `candidates`, and that is a shape
 * to render as "not recorded" rather than a reason to drop the assignment.
 */
function candidatesOf(raw: unknown, roster: AgentRoster | undefined): CandidateView[] {
  if (!Array.isArray(raw)) return [];

  const views: CandidateView[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const agentId = stringOf(record['agentId']);
    if (agentId === undefined) continue;

    views.push({
      agentId,
      agentName: roster?.byId(agentId)?.displayName ?? agentId,
      score: numberOf(record['score']),
      skillMatch: numberOf(record['skillMatch']),
      ownership: numberOf(record['ownership']),
      riskFit: numberOf(record['riskFit']),
      matchedSkills: Array.isArray(record['matchedSkills'])
        ? record['matchedSkills'].filter((skill): skill is string => typeof skill === 'string')
        : [],
      ...(stringOf(record['excludedBy']) === undefined
        ? {}
        : { excludedBy: stringOf(record['excludedBy']) }),
    });
  }

  return views;
}

/**
 * How often each filter fired, across every ranking the run recorded.
 *
 * Sorted by key so two reads of one log produce the same object, which is what lets a
 * dashboard diff a run against itself without reporting a change that is only key order.
 */
function exclusionsOf(assignments: readonly TaskAssignmentView[]): Record<string, number> {
  const counts = new Map<string, number>();

  for (const assignment of assignments) {
    for (const candidate of assignment.candidates) {
      if (candidate.excludedBy === undefined) continue;
      counts.set(candidate.excludedBy, (counts.get(candidate.excludedBy) ?? 0) + 1);
    }
  }

  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function deferralsOf(events: readonly RunEvent[]): WaveDeferralView[] {
  const views: WaveDeferralView[] = [];

  for (const event of events) {
    const reason =
      event.type === 'wave_deferred_for_capacity'
        ? ('capacity' as const)
        : event.type === 'wave_deferred_for_ownership'
          ? ('ownership' as const)
          : undefined;
    if (reason === undefined) continue;

    const taskId = stringOf(event.detail['task']);
    if (taskId === undefined) continue;

    views.push({
      taskId,
      reason,
      detail: stringOf(event.detail['detail']) ?? '',
      ...(stringOf(event.detail['waitsFor']) === undefined
        ? {}
        : { waitsFor: stringOf(event.detail['waitsFor']) }),
      patterns: stringsOf(event.detail['patterns']),
      agents: stringsOf(event.detail['agents']),
    });
  }

  return views;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
