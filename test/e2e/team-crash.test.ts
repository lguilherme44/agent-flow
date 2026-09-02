import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { resolveTaskAgent } from '../../src/core/team/policy.js';
import { projectHandoffs } from '../../src/core/collaboration/handoffs.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import { projectTeam } from '../../src/core/team/view.js';
import { routeTask } from '../../src/core/router.js';
import {
  AgentMessageSchema,
  GlobalConfigSchema,
  TaskSchema,
  type AgentMessage,
  type GlobalConfig,
  type Task,
} from '../../src/contracts/index.js';

/**
 * A run killed at each of the three points an assignment could be lost (§12, M5-ACC-09).
 *
 * **Nothing about an assignment is cached, and that is the whole property.** It is a
 * function of the plan, the configuration and the run's own state — three things a crash
 * cannot change — so resuming re-derives the same answer rather than recovering a stored
 * one. There is no assignment store to be half-written, and no `busy` flag to outlive the
 * process that set it.
 *
 * Each kill point below is the process disappearing between two writes. What is asserted
 * is not that the run survives — that is the scheduler's, and M2 proved it — but that the
 * *answer* is the same one on the other side.
 */

const NOW = '2026-08-09T21:00:00.000Z';
const LATER = '2026-08-09T22:00:00.000Z';
const PROJECT = '/repo';

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

const TEAM: GlobalConfig = GlobalConfigSchema.parse({
  runners: { claude: { type: 'claude-code-cli' } },
  roles: ROLES,
  collaboration: { enabled: true, handoffsReassignExecution: true },
  teams: {
    core: {
      members: {
        backend: {
          roles: 'executor.normal',
          runner: 'claude',
          skills: ['typescript'],
          capacity: { maxConcurrentTasks: 1 },
          ownership: { preferred: ['src/server/**'] },
        },
        frontend: { roles: 'executor.normal', runner: 'claude', skills: ['vue'] },
      },
      policies: { admitHandoffs: true },
    },
  },
});

function task(id: string, files: readonly string[] = ['src/server/a.ts']): Task {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: [...files] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
  });
}

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: 'AF-2026-001',
    threadId: 'THR-0001',
    from: 'backend',
    to: { kind: 'everyone' },
    type: 'question',
    subject: 's',
    body: 'b',
    createdAt: '2026-08-09T20:00:00.000Z',
    ...overrides,
  });
}

/** The policy's answer, asked exactly as the executor asks it. */
function assign(options: {
  task?: Task;
  inFlight?: Map<string, number>;
  handoffs?: ReturnType<typeof projectHandoffs>;
  now?: string;
}) {
  return resolveTaskAgent({
    task: options.task ?? task('TASK-001'),
    routedRole: routeTask(options.task ?? task('TASK-001')),
    config: TEAM,
    roster: deriveAgentRoster(TEAM),
    handoffs: options.handoffs ?? [],
    inFlight: options.inFlight ?? new Map(),
    canImplement: () => true,
    now: options.now ?? NOW,
  });
}

/* ─── Kill point 1 ──────────────────────────────────────────────────────────── */

describe('killed after the assignment was recorded and before the task started', () => {
  it('re-derives the same agent, because nothing was cached to lose', async () => {
    const before = assign({});
    const after = assign({ now: LATER });

    expect(after.agentId).toBe(before.agentId);
    expect(after.reason).toBe(before.reason);
    expect(after.candidates).toEqual(before.candidates);
    // The timestamp is the one thing that legitimately moves: it says when this answer
    // was minted, not which answer it is.
    expect(after.assignedAt).not.toBe(before.assignedAt);
  });

  it('leaves the recorded answer readable by the resumed process', async () => {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('a feature');

    const assignment = assign({});
    await store.appendEvent(run.runId, 'task_assigned', {
      task: assignment.taskId,
      agent: assignment.agentId,
      role: assignment.role,
      reason: assignment.reason,
      candidates: assignment.candidates.map((candidate) => ({
        agentId: candidate.agentId,
        score: candidate.score,
      })),
    });

    // A different `StateStore` over the same filesystem: the process is gone, the log
    // is not.
    const resumed = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const team = projectTeam({
      config: TEAM,
      roster: deriveAgentRoster(TEAM),
      tasks: [],
      events: await resumed.readEvents(run.runId),
    });

    expect(team.assignments.map((held) => `${held.taskId}:${held.agentId}`)).toEqual([
      'TASK-001:backend',
    ]);
  });
});

/* ─── Kill point 2 ──────────────────────────────────────────────────────────── */

describe('killed mid-task, with the assignment in flight', () => {
  it('counts the interrupted task against its member while the run says it is running', () => {
    // `backend` holds one and takes one. A second task must not join it — and the count
    // comes from run state rather than from a flag the dead process would have left set.
    const second = assign({ task: task('TASK-002'), inFlight: new Map([['backend', 1]]) });

    expect(second.agentId).toBe('frontend');
  });

  it('frees the member the moment the run stops calling the task running', () => {
    // **The property a stored `busy` breaks.** A crash leaves no `running` task once
    // recovery has settled it, and the member is available again with nothing to clear.
    const after = assign({ task: task('TASK-002'), inFlight: new Map() });

    expect(after.agentId).toBe('backend');
  });

  it('re-derives the same agent for the interrupted task itself', async () => {
    // The retry of TASK-001 must go back to `backend`. Its own in-flight count is not
    // its own obstacle: the executor counts *other* running tasks, and on resume the
    // interrupted one has been returned to the queue.
    const retry = assign({ task: task('TASK-001'), inFlight: new Map(), now: LATER });

    expect(retry.agentId).toBe('backend');
    expect(retry.reason).toBe('team_match');
  });

  it('does not hold a member for a task the run has finished', async () => {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('a feature');
    await store.appendEvent(run.runId, 'task_assigned', {
      task: 'TASK-001',
      agent: 'backend',
      role: 'executor.normal',
      reason: 'team_match',
      candidates: [],
    });

    const idle = projectTeam({
      config: TEAM,
      roster: deriveAgentRoster(TEAM),
      tasks: [{ id: 'TASK-001', state: 'completed' }],
      events: await store.readEvents(run.runId),
    });
    const working = projectTeam({
      config: TEAM,
      roster: deriveAgentRoster(TEAM),
      tasks: [{ id: 'TASK-001', state: 'running' }],
      events: await store.readEvents(run.runId),
    });

    expect(idle.members.find((m) => m.id === 'backend')?.status).toBe('idle');
    expect(working.members.find((m) => m.id === 'backend')?.status).toBe('full');
  });
});

/* ─── Kill point 3 ──────────────────────────────────────────────────────────── */

describe('killed after a handoff was accepted and before it was acted on', () => {
  const accepted = projectHandoffs([
    message({
      id: 'MSG-0001',
      type: 'handoff_request',
      from: 'backend',
      to: { kind: 'agent', id: 'frontend' },
      taskId: 'TASK-001',
    }),
    message({
      id: 'MSG-0002',
      type: 'handoff_accepted',
      from: 'frontend',
      to: { kind: 'agent', id: 'backend' },
      taskId: 'TASK-001',
    }),
  ]);

  it('honours the same handoff on the other side of the crash', () => {
    // **The acceptance is in the message log, which survives.** There is no second record
    // of "this handoff has been applied" that a crash between two writes could leave
    // disagreeing with the log — the handoff is a fold over the log, and applying it is
    // a decision taken fresh every time the task is assigned.
    const before = assign({ handoffs: accepted });
    const after = assign({ handoffs: accepted, now: LATER });

    expect(before.agentId).toBe('frontend');
    expect(before.reason).toBe('handoff_admitted');
    expect(after.agentId).toBe(before.agentId);
    expect(after.reason).toBe(before.reason);
    expect(after.previousAgentId).toBe('backend');
  });

  it('does not spend the budget twice for one acceptance', () => {
    // Re-deriving must not look like a second hop. The count comes from the accepted
    // handoffs in the log, and a resume adds none.
    const first = assign({ handoffs: accepted });
    const second = assign({ handoffs: accepted, now: LATER });

    expect(second.reason).toBe(first.reason);
  });

  it('re-applies a refusal identically rather than admitting it the second time', () => {
    // The other direction, and the one that would be a security hole: a handoff refused
    // for capacity before the crash must still be refused after it, given the same state.
    const refused = assign({ handoffs: accepted, inFlight: new Map([['frontend', 1]]) });
    const again = assign({ handoffs: accepted, inFlight: new Map([['frontend', 1]]), now: LATER });

    expect(refused.reason).toBe('handoff_refused_capability');
    expect(again.reason).toBe(refused.reason);
    expect(again.agentId).toBe(refused.agentId);
  });
});

/* ─── The property behind all three ─────────────────────────────────────────── */

describe('there is no assignment store to be half-written', () => {
  it('writes the answer to the audit log and nowhere else', async () => {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
    const run = await store.createRun('a feature');

    await store.appendEvent(run.runId, 'task_assigned', {
      task: 'TASK-001',
      agent: 'backend',
      role: 'executor.normal',
      reason: 'team_match',
      candidates: [],
    });

    // The run's own state carries tasks and their states. It carries no assignment: a
    // second copy is a second thing a crash between two writes can leave disagreeing.
    const state = await store.loadRun(run.runId);
    expect(JSON.stringify(state)).not.toContain('backend');
    expect(JSON.stringify(state)).not.toContain('team_match');
  });

  it('gives the same answer from an empty log as from a written one', () => {
    // The log records what was decided; it is not consulted to decide. A run whose
    // events were lost entirely still assigns the same agent.
    expect(assign({}).agentId).toBe('backend');
  });
});
