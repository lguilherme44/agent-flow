import { describe, it, expect } from 'vitest';
import { projectTeam, EMPTY_TEAM } from '../../../src/core/team/view.js';
import { deriveAgentRoster } from '../../../src/core/collaboration/roster.js';
import {
  GlobalConfigSchema,
  RunEventSchema,
  type GlobalConfig,
  type RunEvent,
} from '../../../src/contracts/index.js';

/**
 * The one projection the CLI, the API and the dashboard all read (M5-08, M5-ACC-15).
 *
 * **Nothing here decides anything.** Every field is a fold over facts the run already
 * recorded — who was assigned, what was deferred, which tasks are running. A projection
 * that re-ranked candidates would be a second assignment authority, and its first
 * disagreement with the run would put a decision nobody made on an operator's screen
 * (I-33).
 *
 * The other property worth its own tests is at the bottom: this reads a log a *previous*
 * version of the product wrote. A row with no ranking, a truncated line, a number that
 * arrived as a string — none of them may lose the assignment they belong to.
 */

const ROLES = {
  architect: { runner: 'claude', effort: 'high' },
  sdd: { runner: 'claude', effort: 'high' },
  planner: { runner: 'claude', effort: 'high' },
  planReviewer: { runner: 'claude', effort: 'high' },
  executors: {
    trivial: { runner: 'claude', effort: 'low' },
    normal: { runner: 'claude', effort: 'medium' },
    complex: { runner: 'claude', effort: 'high' },
  },
  verification: { runner: 'claude', effort: 'medium' },
  finalReviewer: { runner: 'claude', effort: 'high' },
};

function config(members?: Record<string, Record<string, unknown>>): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: ROLES,
    ...(members === undefined
      ? {}
      : {
          teams: {
            core: {
              members: Object.fromEntries(
                Object.entries(members).map(([id, member]) => [
                  id,
                  { role: 'executor.normal', runner: 'claude', ...member },
                ]),
              ),
              policies: {},
            },
          },
        }),
  });
}

function event(type: string, detail: Record<string, unknown>, at = '2026-08-09T20:00:00.000Z'): RunEvent {
  return RunEventSchema.parse({ at, type, detail });
}

function assigned(task: string, agent: string, extra: Record<string, unknown> = {}): RunEvent {
  return event('task_assigned', {
    task,
    agent,
    role: 'executor.normal',
    reason: 'team_match',
    candidates: [
      { agentId: agent, score: 0.8, skillMatch: 1, ownership: 0.5, riskFit: 1, matchedSkills: ['typescript'] },
    ],
    ...extra,
  });
}

function project(input: {
  config?: GlobalConfig;
  tasks?: { id: string; state: string }[];
  events?: RunEvent[];
}) {
  const global = input.config ?? config({ backend: {} });
  return projectTeam({
    config: global,
    roster: deriveAgentRoster(global),
    tasks: input.tasks ?? [],
    events: input.events ?? [],
  });
}

describe('a run with no team', () => {
  it('is unconfigured rather than empty', () => {
    // Two different empty states. "No team" invites configuration; "a team with nothing
    // assigned" does not, and a screen that conflated them would ask the operator to fix
    // something that is not broken.
    expect(project({ config: config() }).configured).toBe(false);
  });

  it('reports no members and no assignments', () => {
    const view = project({ config: config(), events: [assigned('TASK-001', 'backend')] });

    expect(view.members).toEqual([]);
    // The events are still folded — a legacy config that once had a team keeps its
    // history — but there is nobody to attribute the work to.
    expect(view.assignments).toHaveLength(1);
  });

  it('has an empty value that says the same thing', () => {
    expect(EMPTY_TEAM.configured).toBe(false);
    expect(EMPTY_TEAM.totals.assignments).toBe(0);
  });
});

describe('what a member looks like', () => {
  const team = config({
    backend: {
      displayName: 'Backend',
      skills: ['TypeScript', 'node'],
      specializations: ['fastify'],
      capacity: { maxConcurrentTasks: 2 },
      ownership: { preferred: ['src/server/**'], exclusive: ['src/db/**'] },
      model: 'a-model',
    },
  });

  it('carries what the operator configured, normalised', () => {
    const [member] = project({ config: team }).members;

    expect(member?.id).toBe('backend');
    expect(member?.displayName).toBe('Backend');
    expect(member?.runner).toBe('claude');
    expect(member?.model).toBe('a-model');
    expect(member?.skills).toEqual(['typescript', 'node']);
    expect(member?.specializations).toEqual(['fastify']);
    expect(member?.maxConcurrentTasks).toBe(2);
    expect(member?.ownership.exclusive).toEqual(['src/db/**']);
  });

  it('falls back to the id when nobody gave it a name', () => {
    const [member] = project({ config: config({ backend: {} }) }).members;
    expect(member?.displayName).toBe('backend');
  });
});

describe('status is derived, never stored (I-39)', () => {
  it('is idle for a member holding nothing', () => {
    const [member] = project({ config: config({ backend: {} }) }).members;

    expect(member?.status).toBe('idle');
    expect(member?.assigned).toEqual([]);
  });

  it('is working while a task assigned to it is running', () => {
    const view = project({
      tasks: [{ id: 'TASK-001', state: 'running' }],
      events: [assigned('TASK-001', 'backend')],
      config: config({ backend: { capacity: { maxConcurrentTasks: 2 } } }),
    });

    expect(view.members[0]?.status).toBe('working');
    expect(view.members[0]?.assigned).toEqual(['TASK-001']);
  });

  it('is full at its configured capacity', () => {
    const view = project({
      tasks: [{ id: 'TASK-001', state: 'running' }],
      events: [assigned('TASK-001', 'backend')],
    });

    expect(view.members[0]?.status).toBe('full');
  });

  it('goes back to idle when the task it held completed', () => {
    // **The property a stored flag would break.** A `busy: true` written when the task
    // started outlives the crash that ended it, and the member it named is then locked
    // out of every later wave with nothing on screen to explain it.
    const view = project({
      tasks: [{ id: 'TASK-001', state: 'completed' }],
      events: [assigned('TASK-001', 'backend')],
    });

    expect(view.members[0]?.status).toBe('idle');
    expect(view.members[0]?.assigned).toEqual([]);
  });

  it('counts every assignment it ever had, running or not', () => {
    const view = project({
      tasks: [
        { id: 'TASK-001', state: 'completed' },
        { id: 'TASK-002', state: 'running' },
      ],
      events: [assigned('TASK-001', 'backend'), assigned('TASK-002', 'backend')],
    });

    expect(view.members[0]?.assignedTotal).toBe(2);
    expect(view.members[0]?.assigned).toEqual(['TASK-002']);
  });

  it('follows the last assignment when a task changed hands', () => {
    // A reassignment appends rather than rewrites, so the log keeps the history and the
    // view keeps the answer.
    const view = project({
      config: config({ backend: {}, frontend: {} }),
      tasks: [{ id: 'TASK-001', state: 'running' }],
      events: [
        assigned('TASK-001', 'backend', {}),
        event(
          'task_assigned',
          { task: 'TASK-001', agent: 'frontend', role: 'executor.normal', reason: 'handoff_admitted', previousAgent: 'backend', candidates: [] },
          '2026-08-09T20:05:00.000Z',
        ),
      ],
    });

    expect(view.members.find((member) => member.id === 'backend')?.assigned).toEqual([]);
    expect(view.members.find((member) => member.id === 'frontend')?.assigned).toEqual(['TASK-001']);
    expect(view.totals.reassignments).toBe(1);
  });
});

describe('why a task went where it did (§38, I-34)', () => {
  it('carries every candidate with each term kept apart', () => {
    const view = project({ events: [assigned('TASK-001', 'backend')] });
    const [candidate] = view.assignments[0]?.candidates ?? [];

    expect(candidate?.agentId).toBe('backend');
    expect(candidate?.score).toBe(0.8);
    expect(candidate?.skillMatch).toBe(1);
    expect(candidate?.ownership).toBe(0.5);
    expect(candidate?.riskFit).toBe(1);
    expect(candidate?.matchedSkills).toEqual(['typescript']);
  });

  it('keeps the reason a candidate was ruled out', () => {
    const view = project({
      config: config({ backend: {}, frontend: {} }),
      events: [
        event('task_assigned', {
          task: 'TASK-001',
          agent: 'backend',
          role: 'executor.normal',
          reason: 'team_match',
          candidates: [
            { agentId: 'backend', score: 0.8, skillMatch: 1, ownership: 1, riskFit: 1, matchedSkills: [] },
            { agentId: 'frontend', score: 0.2, skillMatch: 0, ownership: 0, riskFit: 1, matchedSkills: [], excludedBy: 'capacity' },
          ],
        }),
      ],
    });

    expect(view.assignments[0]?.candidates[1]?.excludedBy).toBe('capacity');
  });

  it('resolves a display name for every candidate, not only the winner', () => {
    const view = project({
      config: config({ backend: { displayName: 'Backend' } }),
      events: [assigned('TASK-001', 'backend')],
    });

    expect(view.assignments[0]?.agentName).toBe('Backend');
    expect(view.assignments[0]?.candidates[0]?.agentName).toBe('Backend');
  });
});

describe('what a wave would not take', () => {
  it('carries the members that were full', () => {
    const view = project({
      events: [
        event('wave_deferred_for_capacity', {
          task: 'TASK-002',
          agents: ['backend'],
          detail: 'everyone is full',
        }),
      ],
    });

    expect(view.deferrals).toEqual([
      { taskId: 'TASK-002', reason: 'capacity', detail: 'everyone is full', patterns: [], agents: ['backend'] },
    ]);
    expect(view.totals.capacityDeferrals).toBe(1);
  });

  it('carries the contended area and what the task waits behind', () => {
    const view = project({
      events: [
        event('wave_deferred_for_ownership', {
          task: 'TASK-002',
          waitsFor: 'TASK-001',
          patterns: ['src/db/**'],
          detail: 'one writer at a time',
        }),
      ],
    });

    expect(view.deferrals[0]).toMatchObject({
      taskId: 'TASK-002',
      reason: 'ownership',
      waitsFor: 'TASK-001',
      patterns: ['src/db/**'],
    });
    expect(view.totals.ownershipDeferrals).toBe(1);
  });
});

describe('the totals a dashboard header and a CLI line both read (§41)', () => {
  it('counts assignments, candidates and deferrals once', () => {
    const view = project({
      config: config({ backend: {}, frontend: {} }),
      events: [
        assigned('TASK-001', 'backend'),
        assigned('TASK-002', 'frontend'),
        event('wave_deferred_for_capacity', { task: 'TASK-003', agents: ['backend'], detail: 'full' }),
      ],
    });

    expect(view.totals).toEqual({
      assignments: 2,
      reassignments: 0,
      capacityDeferrals: 1,
      ownershipDeferrals: 0,
      candidatesConsidered: 2,
    });
  });
});

describe('a log written by an older build', () => {
  it('keeps an assignment that recorded no ranking', () => {
    // "Not recorded" is a shape to render, never a reason to drop the row.
    const view = project({
      events: [event('task_assigned', { task: 'TASK-001', agent: 'backend', role: 'executor.normal', reason: 'team_match' })],
    });

    expect(view.assignments).toHaveLength(1);
    expect(view.assignments[0]?.candidates).toEqual([]);
  });

  it('drops a row that names no task or no agent, and keeps the rest', () => {
    const view = project({
      events: [
        event('task_assigned', { agent: 'backend' }),
        event('task_assigned', { task: 'TASK-002' }),
        assigned('TASK-003', 'backend'),
      ],
    });

    expect(view.assignments.map((held) => held.taskId)).toEqual(['TASK-003']);
  });

  it('reads a score that arrived as something other than a number as zero', () => {
    const view = project({
      events: [
        event('task_assigned', {
          task: 'TASK-001',
          agent: 'backend',
          role: 'executor.normal',
          reason: 'team_match',
          candidates: [{ agentId: 'backend', score: 'high', matchedSkills: 'typescript' }],
        }),
      ],
    });

    expect(view.assignments[0]?.candidates[0]?.score).toBe(0);
    expect(view.assignments[0]?.candidates[0]?.matchedSkills).toEqual([]);
  });

  it('ignores an event of any other type', () => {
    const view = project({ events: [event('task_started', { task: 'TASK-001' })] });

    expect(view.assignments).toEqual([]);
    expect(view.deferrals).toEqual([]);
  });
});
