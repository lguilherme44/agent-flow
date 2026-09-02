import { describe, it, expect } from 'vitest';
import { resolveTaskAgent, type AssignmentInput } from '../../../src/core/team/policy.js';
import { projectHandoffs } from '../../../src/core/collaboration/handoffs.js';
import { deriveAgentRoster } from '../../../src/core/collaboration/roster.js';
import {
  AgentMessageSchema,
  GlobalConfigSchema,
  TaskSchema,
  type AgentMessage,
  type GlobalConfig,
  type Task,
} from '../../../src/contracts/index.js';

/**
 * Who executes a task, and why (M5-ACC-02 … 09, I-33 … I-36).
 *
 * **`resolveTaskAgent` moved here from `core/collaboration/handoffs.ts` and kept its
 * position in the call graph.** The M4 block that covered it moved with it, unchanged in
 * intent, because a milestone that quietly dropped the tests for the function it rewrote
 * would be a milestone claiming a property nobody checks any more. The legacy describe
 * below is that block; everything after it is new.
 *
 * The single property worth more than the rest: **an agent-authored message is an input
 * to this function and never an instruction.** A handoff says who *would like* the task;
 * this decides, and it can refuse.
 */

const NOW = '2026-08-09T21:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: 'TASK-003',
    title: 'Wire the endpoint',
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: ['src/server/routes/run.ts'] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
    ...overrides,
  });
}

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: 'AF-2026-001',
    threadId: 'THR-0001',
    from: 'executor.normal',
    to: { kind: 'everyone' },
    type: 'question',
    subject: 'a subject',
    body: 'a body',
    createdAt: '2026-08-09T20:00:00.000Z',
    ...overrides,
  });
}

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

function config(overrides: Record<string, unknown> = {}): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: ROLES,
    ...overrides,
  });
}

/**
 * A configuration with one team, so the member ids are the test's to choose.
 *
 * Members arrive as raw objects rather than as `TeamMemberConfig`, because that is how
 * they arrive from a YAML file: the schema's defaults are part of what is under test, and
 * pre-filling them here would test a shape no operator ever writes.
 */
function withTeam(
  members: Record<string, Record<string, unknown>>,
  policies: Record<string, unknown> = {},
  collaboration: Record<string, unknown> = {},
): GlobalConfig {
  return config({
    collaboration: { enabled: true, ...collaboration },
    teams: {
      core: {
        members: Object.fromEntries(
          Object.entries(members).map(([id, member]) => [
            id,
            { role: 'executor.normal', runner: 'claude', ...member },
          ]),
        ),
        policies: { admitHandoffs: true, ...policies },
      },
    },
  });
}

function input(overrides: Partial<AssignmentInput> = {}): AssignmentInput {
  const global = overrides.config ?? config();
  return {
    task: task(),
    routedRole: 'executor.normal',
    config: global,
    roster: deriveAgentRoster(global),
    handoffs: [],
    inFlight: new Map(),
    canImplement: () => true,
    now: NOW,
    ...overrides,
  };
}

/* ─── Legacy: the M4 block, moved with the function it covers ──────────────── */

describe('resolveTaskAgent without a team — what M4 did, unchanged (M5-ACC-01)', () => {
  const accepted = [
    message({
      id: 'MSG-0001',
      type: 'handoff_request',
      from: 'executor.normal',
      to: { kind: 'agent', id: 'architect' },
      taskId: 'TASK-003',
    }),
    message({
      id: 'MSG-0002',
      type: 'handoff_accepted',
      from: 'architect',
      to: { kind: 'agent', id: 'executor.normal' },
      taskId: 'TASK-003',
    }),
  ];

  it('answers the router with no handoff at all', () => {
    const assignment = resolveTaskAgent(input());

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('routed');
    expect(assignment.candidates).toEqual([]);
  });

  it('records the handoff but keeps the router’s answer while re-routing is off', () => {
    // The default, and the reason for it: re-routing execution from model output is an
    // ownership transfer, and ownership is not a model's to decide.
    const assignment = resolveTaskAgent(
      input({
        handoffs: projectHandoffs(accepted),
        config: config({ collaboration: { enabled: true, handoffsReassignExecution: false } }),
      }),
    );

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_not_admitted');
    expect(assignment.detail).toContain('architect');
  });

  it('honours an accepted handoff when the operator turned it on', () => {
    // **The compatibility that matters.** Every configuration written before M5 has no
    // `teams:`, and taking this away from them would be M5 quietly disabling an M4
    // feature. The ranking is what a team buys; the permission is not.
    const assignment = resolveTaskAgent(
      input({
        handoffs: projectHandoffs(accepted),
        config: config({ collaboration: { enabled: true, handoffsReassignExecution: true } }),
      }),
    );

    expect(assignment.agentId).toBe('architect');
    expect(assignment.reason).toBe('handoff_admitted');
    expect(assignment.previousAgentId).toBe('executor.normal');
  });

  it('refuses a target that cannot implement, and says why', () => {
    // A handoff to an agent whose runner has no working directory produces an attempt
    // that cannot begin. Refused before it is spent, not discovered afterwards.
    const assignment = resolveTaskAgent(
      input({
        handoffs: projectHandoffs(accepted),
        config: config({ collaboration: { enabled: true, handoffsReassignExecution: true } }),
        canImplement: () => false,
      }),
    );

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_refused_capability');
    expect(assignment.detail).toContain('architect');
  });

  it('refuses a target nobody configured', () => {
    const toNobody = [
      message({
        id: 'MSG-0001',
        type: 'handoff_request',
        from: 'executor.normal',
        to: { kind: 'agent', id: 'nobody.at.all' },
        taskId: 'TASK-003',
      }),
      message({
        id: 'MSG-0002',
        type: 'handoff_accepted',
        from: 'nobody.at.all',
        to: { kind: 'agent', id: 'executor.normal' },
        taskId: 'TASK-003',
      }),
    ];

    const assignment = resolveTaskAgent(
      input({
        handoffs: projectHandoffs(toNobody),
        config: config({ collaboration: { enabled: true, handoffsReassignExecution: true } }),
      }),
    );

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_refused_capability');
  });

  it('stops a task that is being passed around', () => {
    const twice = [
      ...accepted,
      message({
        id: 'MSG-0003',
        threadId: 'THR-0002',
        type: 'handoff_request',
        from: 'architect',
        to: { kind: 'agent', id: 'planner' },
        taskId: 'TASK-003',
      }),
      message({
        id: 'MSG-0004',
        threadId: 'THR-0002',
        type: 'handoff_accepted',
        from: 'planner',
        to: { kind: 'agent', id: 'architect' },
        taskId: 'TASK-003',
      }),
    ];

    const assignment = resolveTaskAgent(
      input({
        handoffs: projectHandoffs(twice),
        config: config({
          collaboration: {
            enabled: true,
            handoffsReassignExecution: true,
            maxHandoffsPerTask: 1,
          },
        }),
      }),
    );

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_budget_exhausted');
  });

  it('ignores a handoff belonging to another task', () => {
    const assignment = resolveTaskAgent(
      input({
        task: task({ id: 'TASK-009' }),
        handoffs: projectHandoffs(accepted),
        config: config({ collaboration: { enabled: true, handoffsReassignExecution: true } }),
      }),
    );

    expect(assignment.reason).toBe('routed');
  });
});

/* ─── The team path ────────────────────────────────────────────────────────── */

describe('resolveTaskAgent with a team (M5-ACC-02 … 06)', () => {
  const twoMembers = {
    backend: { skills: ['typescript'], ownership: { preferred: ['src/server/**'] } },
    frontend: { skills: ['vue'], ownership: { preferred: ['apps/web/**'] } },
  };

  it('picks the member who owns the area the task lands in', () => {
    const assignment = resolveTaskAgent(input({ config: withTeam(twoMembers) }));

    expect(assignment.agentId).toBe('backend');
    expect(assignment.reason).toBe('team_match');
  });

  it('follows the files rather than the member’s name', () => {
    const assignment = resolveTaskAgent(
      input({
        task: task({ files: { likely: ['apps/web/pages/run.vue'] } }),
        config: withTeam(twoMembers),
      }),
    );

    expect(assignment.agentId).toBe('frontend');
  });

  it('keeps the router’s role on the assignment beside the agent', () => {
    // The plan is written in roles and stays that way; a team adds who, not what.
    const assignment = resolveTaskAgent(input({ config: withTeam(twoMembers) }));

    expect(assignment.role).toBe('executor.normal');
    expect(assignment.taskId).toBe('TASK-003');
    expect(assignment.assignedAt).toBe(NOW);
  });

  it('answers “why not the other one” by keeping every candidate (I-34)', () => {
    // A filtered list cannot answer the question an operator actually asks.
    const assignment = resolveTaskAgent(input({ config: withTeam(twoMembers) }));

    expect(assignment.candidates.map((candidate) => candidate.agentId).sort()).toEqual([
      'backend',
      'frontend',
    ]);
  });

  it('says in words why the winner won', () => {
    const assignment = resolveTaskAgent(input({ config: withTeam(twoMembers) }));

    expect(assignment.detail).toContain('backend');
    expect(assignment.detail).toContain('ownership');
  });
});

describe('eligibility precedes ranking (M5-ACC-05, I-36)', () => {
  it('excludes a member serving another role, however well it would score', () => {
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({
          reviewer: { role: 'finalReviewer', ownership: { preferred: ['src/server/**'] } },
          backend: {},
        }),
      }),
    );

    expect(assignment.agentId).toBe('backend');
    const reviewer = assignment.candidates.find((c) => c.agentId === 'reviewer');
    expect(reviewer?.excludedBy).toBe('role_mismatch');
  });

  it('excludes a member whose runner cannot do the work', () => {
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({ backend: {}, standby: {} }),
        canImplement: (agent) => agent.id !== 'backend',
      }),
    );

    expect(assignment.agentId).toBe('standby');
    expect(assignment.candidates.find((c) => c.agentId === 'backend')?.excludedBy).toBe(
      'runner_capability',
    );
  });

  it('excludes a member already at its capacity', () => {
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({
          backend: { ownership: { preferred: ['src/server/**'] } },
          standby: {},
        }),
        inFlight: new Map([['backend', 1]]),
      }),
    );

    expect(assignment.agentId).toBe('standby');
    expect(assignment.candidates.find((c) => c.agentId === 'backend')?.excludedBy).toBe('capacity');
  });

  it('lets a member with room for two take a second task', () => {
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({ backend: { capacity: { maxConcurrentTasks: 2 } } }),
        inFlight: new Map([['backend', 1]]),
      }),
    );

    expect(assignment.agentId).toBe('backend');
  });

  it('excludes a member from an area somebody else holds exclusively', () => {
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({
          dba: { ownership: { exclusive: ['src/server/**'] } },
          backend: {},
        }),
      }),
    );

    expect(assignment.agentId).toBe('dba');
    expect(assignment.candidates.find((c) => c.agentId === 'backend')?.excludedBy).toBe('ownership');
  });

  it('does not exclude the holder from its own exclusive area', () => {
    // Owning an area exclusively is a reason to get the work, not to be refused it.
    const assignment = resolveTaskAgent(
      input({ config: withTeam({ dba: { ownership: { exclusive: ['src/server/**'] } } }) }),
    );

    expect(assignment.agentId).toBe('dba');
    expect(assignment.candidates[0]?.excludedBy).toBeUndefined();
  });

  it('reports the most disabling reason when several apply', () => {
    // A member with the wrong role is not "at capacity"; it is the wrong member, and the
    // recorded reason has to be the one a person can act on.
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({ reviewer: { role: 'finalReviewer' }, backend: {} }),
        inFlight: new Map([['reviewer', 5]]),
        canImplement: (agent) => agent.id !== 'reviewer',
      }),
    );

    expect(assignment.candidates.find((c) => c.agentId === 'reviewer')?.excludedBy).toBe(
      'role_mismatch',
    );
  });
});

describe('when nobody is eligible', () => {
  it('falls back to the role the router chose and names every filter that fired', () => {
    // A refusal that names itself, rather than a task nobody holds.
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({ backend: {}, frontend: {} }),
        inFlight: new Map([
          ['backend', 1],
          ['frontend', 1],
        ]),
      }),
    );

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('no_eligible_member');
    expect(assignment.detail).toContain('2 capacity');
    expect(assignment.candidates).toHaveLength(2);
  });
});

describe('the ranking is total and stable (I-35, M5-ACC-06)', () => {
  const tied = { alpha: { skills: ['typescript'] }, omega: { skills: ['typescript'] } };

  it('breaks a perfect tie by agent id, ascending', () => {
    expect(resolveTaskAgent(input({ config: withTeam(tied) })).agentId).toBe('alpha');
  });

  it('gives the same answer however the configuration file was ordered', () => {
    // Object key order comes from a YAML file. Without a total order, the same team
    // written in a different order assigns differently and a resumed run reroutes for
    // no reason at all.
    const forwards = resolveTaskAgent(input({ config: withTeam(tied) }));
    const backwards = resolveTaskAgent(
      input({ config: withTeam({ omega: tied.omega, alpha: tied.alpha }) }),
    );

    expect(forwards.agentId).toBe(backwards.agentId);
    expect(forwards.candidates).toEqual(backwards.candidates);
  });

  it('never ranks an excluded member above an eligible one', () => {
    const assignment = resolveTaskAgent(
      input({
        // `aaa` would score highest and cannot take it; `zzz` can.
        config: withTeam({
          aaa: { skills: ['typescript'], ownership: { preferred: ['src/server/**'] } },
          zzz: {},
        }),
        inFlight: new Map([['aaa', 1]]),
      }),
    );

    expect(assignment.candidates[0]?.agentId).toBe('zzz');
    expect(assignment.agentId).toBe('zzz');
  });

  it('puts an owner ahead of a stranger at equal score', () => {
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({
          zowner: { ownership: { preferred: ['src/server/**'] } },
          astranger: {},
        }),
      }),
    );

    expect(assignment.agentId).toBe('zowner');
  });
});

describe('a handoff on the team path is a request, not an instruction (I-33)', () => {
  const accepted = projectHandoffs([
    message({
      id: 'MSG-0001',
      type: 'handoff_request',
      from: 'backend',
      to: { kind: 'agent', id: 'frontend' },
      taskId: 'TASK-003',
    }),
    message({
      id: 'MSG-0002',
      type: 'handoff_accepted',
      from: 'frontend',
      to: { kind: 'agent', id: 'backend' },
      taskId: 'TASK-003',
    }),
  ]);

  const members = {
    backend: { ownership: { preferred: ['src/server/**'] } },
    frontend: {},
  };

  it('moves the work to a target the ordinary path would also have allowed', () => {
    const assignment = resolveTaskAgent(
      input({ config: withTeam(members), handoffs: accepted }),
    );

    expect(assignment.agentId).toBe('frontend');
    expect(assignment.reason).toBe('handoff_admitted');
  });

  it('refuses a target the ordinary path would have excluded', () => {
    // **The property the whole design exists for.** A handoff cannot route work to a
    // member that is out of capacity, out of role, or locked out of the area — an agent
    // saying "I'll take it" is a request and this is the decision.
    const assignment = resolveTaskAgent(
      input({
        config: withTeam(members),
        handoffs: accepted,
        inFlight: new Map([['frontend', 1]]),
      }),
    );

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_refused_capability');
    expect(assignment.detail).toContain('capacity');
  });

  it('is not admitted when the team said no, whatever the message said', () => {
    const assignment = resolveTaskAgent(
      input({
        config: withTeam(members, { admitHandoffs: false }),
        handoffs: accepted,
      }),
    );

    expect(assignment.reason).toBe('handoff_not_admitted');
    expect(assignment.agentId).toBe('executor.normal');
  });

  it('keeps the ranking on a handoff, so the choice is still auditable', () => {
    const assignment = resolveTaskAgent(
      input({ config: withTeam(members), handoffs: accepted }),
    );

    expect(assignment.candidates).toHaveLength(2);
  });
});

describe('what the assignment is not allowed to do', () => {
  it('assigns nothing an agent named that is not in the team', () => {
    // An outbox can name any id it likes. The roster is the closed set.
    const assignment = resolveTaskAgent(
      input({
        config: withTeam({ backend: {} }),
        handoffs: projectHandoffs([
          message({
            id: 'MSG-0001',
            type: 'handoff_request',
            from: 'backend',
            to: { kind: 'agent', id: 'ghost' },
            taskId: 'TASK-003',
          }),
          message({
            id: 'MSG-0002',
            type: 'handoff_accepted',
            from: 'ghost',
            to: { kind: 'agent', id: 'backend' },
            taskId: 'TASK-003',
          }),
        ]),
      }),
    );

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_refused_capability');
  });

  it('is deterministic — the same question twice gives the same answer', () => {
    const ask = (): unknown => resolveTaskAgent(input({ config: withTeam({ a: {}, b: {} }) }));
    expect(ask()).toEqual(ask());
  });
});
