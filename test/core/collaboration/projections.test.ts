import { describe, it, expect } from 'vitest';
import { projectThreads, threadsFor } from '../../../src/core/collaboration/threads.js';
import { projectHandoffs, resolveTaskAgent } from '../../../src/core/collaboration/handoffs.js';
import { entriesFor, projectBlackboard } from '../../../src/core/collaboration/blackboard.js';
import {
  AgentMessageSchema,
  BlackboardEntrySchema,
  CollaborationConfigSchema,
  type AgentIdentity,
  type AgentMessage,
  type BlackboardEntry,
  type CollaborationConfig,
} from '../../../src/contracts/index.js';

const RUN = 'AF-2026-001';
let clock = 0;

function at(): string {
  clock += 1000;
  return new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + clock).toISOString();
}

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return AgentMessageSchema.parse({
    id: 'MSG-0001',
    runId: RUN,
    threadId: 'THR-0001',
    from: 'executor.normal',
    to: { kind: 'agent', id: 'architect' },
    type: 'question',
    taskId: 'TASK-003',
    subject: 'which key?',
    body: 'asking',
    createdAt: at(),
    ...overrides,
  });
}

function entry(overrides: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return BlackboardEntrySchema.parse({
    id: 'DEC-001',
    runId: RUN,
    kind: 'decision',
    subject: 'checkout-idempotency',
    author: 'architect',
    statement: 'the API mints the key',
    createdAt: at(),
    ...overrides,
  });
}

function config(overrides: Partial<CollaborationConfig> = {}): CollaborationConfig {
  return CollaborationConfigSchema.parse({ enabled: true, ...overrides });
}

function agent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: 'architect',
    displayName: 'Architect',
    role: 'architect',
    runner: 'runner-a',
    skills: [],
    specializations: [],
    ...overrides,
  };
}

/* ─── Threads ──────────────────────────────────────────────────────────────── */

describe('projectThreads (M4-03)', () => {
  it('groups by thread and reports the opener', () => {
    const threads = projectThreads([
      message({ id: 'MSG-0001', threadId: 'THR-0001', from: 'executor.normal' }),
      message({ id: 'MSG-0002', threadId: 'THR-0001', from: 'architect', type: 'answer' }),
      message({ id: 'MSG-0003', threadId: 'THR-0002', from: 'architect', type: 'information' }),
    ]);

    expect(threads).toHaveLength(2);
    expect(threads[0]?.opener).toBe('executor.normal');
    expect(threads[0]?.participants).toEqual(['executor.normal', 'architect']);
  });

  it('is open until somebody else answers', () => {
    expect(projectThreads([message()])[0]?.status).toBe('open');
  });

  it('does not count a follow-up from the opener as an answer', () => {
    // Excluding the opener is what stops an agent from answering itself into `answered`.
    const threads = projectThreads([
      message({ id: 'MSG-0001', from: 'executor.normal' }),
      message({ id: 'MSG-0002', from: 'executor.normal', type: 'answer' }),
    ]);

    expect(threads[0]?.status).toBe('open');
  });

  it('is answered once somebody else answers', () => {
    const threads = projectThreads([
      message({ id: 'MSG-0001', from: 'executor.normal' }),
      message({ id: 'MSG-0002', from: 'architect', type: 'answer' }),
    ]);

    expect(threads[0]?.status).toBe('answered');
  });

  it('is resolved only when the opener acknowledges', () => {
    // "This answered my question" is a statement only the asker can make. Letting the
    // answerer close its own answer would make every thread resolve itself.
    const byAnswerer = projectThreads([
      message({ id: 'MSG-0001', from: 'executor.normal' }),
      message({ id: 'MSG-0002', from: 'architect', type: 'answer' }),
      message({ id: 'MSG-0003', from: 'architect', type: 'acknowledge' }),
    ]);
    expect(byAnswerer[0]?.status).toBe('answered');

    const byOpener = projectThreads([
      message({ id: 'MSG-0001', from: 'executor.normal' }),
      message({ id: 'MSG-0002', from: 'architect', type: 'answer' }),
      message({ id: 'MSG-0003', from: 'executor.normal', type: 'acknowledge' }),
    ]);
    expect(byOpener[0]?.status).toBe('resolved');
  });

  it('is abandoned when the run ended with it unresolved', () => {
    // "Open" on a finished run invites a person to wait for an answer that is never
    // coming.
    const threads = projectThreads([message()], { runTerminated: true });
    expect(threads[0]?.status).toBe('abandoned');
  });

  it('stays resolved on a finished run', () => {
    const threads = projectThreads(
      [
        message({ id: 'MSG-0001', from: 'executor.normal' }),
        message({ id: 'MSG-0002', from: 'executor.normal', type: 'acknowledge' }),
      ],
      { runTerminated: true },
    );

    expect(threads[0]?.status).toBe('resolved');
  });

  it('is deterministic', () => {
    const log = [message({ id: 'MSG-0001' }), message({ id: 'MSG-0002', threadId: 'THR-0002' })];
    expect(projectThreads(log)).toEqual(projectThreads(log));
  });
});

describe('threadsFor — who is shown what (M4-06)', () => {
  const audience = { agentId: 'architect', role: 'architect', taskId: 'TASK-003' };

  it('shows a thread addressed to this agent', () => {
    const threads = projectThreads([
      message({ from: 'executor.normal', to: { kind: 'agent', id: 'architect' }, taskId: 'TASK-009' }),
    ]);

    expect(threadsFor(threads, audience)).toHaveLength(1);
  });

  it('shows a thread addressed to this agent’s role, and to everyone', () => {
    const byRole = projectThreads([
      message({ from: 'executor.normal', to: { kind: 'role', role: 'architect' }, taskId: 'TASK-009' }),
    ]);
    const toAll = projectThreads([
      message({ from: 'executor.normal', to: { kind: 'everyone' }, taskId: 'TASK-009' }),
    ]);

    expect(threadsFor(byRole, audience)).toHaveLength(1);
    expect(threadsFor(toAll, audience)).toHaveLength(1);
  });

  it('shows a thread about this task, whoever it was addressed to', () => {
    const threads = projectThreads([
      message({ from: 'executor.complex', to: { kind: 'agent', id: 'planner' }, taskId: 'TASK-003' }),
    ]);

    expect(threadsFor(threads, audience)).toHaveLength(1);
  });

  it('shows a thread this agent opened and nobody closed', () => {
    const threads = projectThreads([
      message({ from: 'architect', to: { kind: 'agent', id: 'planner' }, taskId: 'TASK-009' }),
    ]);

    expect(threadsFor(threads, audience)).toHaveLength(1);
  });

  it('hides a resolved thread', () => {
    // The budget is small. A settled question spends bytes an open one needs.
    const threads = projectThreads([
      message({ id: 'MSG-0001', from: 'architect', taskId: 'TASK-003' }),
      message({ id: 'MSG-0002', from: 'architect', type: 'acknowledge', taskId: 'TASK-003' }),
    ]);

    expect(threadsFor(threads, audience)).toEqual([]);
  });

  it('hides a thread that is somebody else’s conversation about somebody else’s task', () => {
    const threads = projectThreads([
      message({
        from: 'executor.normal',
        to: { kind: 'agent', id: 'planner' },
        taskId: 'TASK-009',
      }),
    ]);

    expect(threadsFor(threads, audience)).toEqual([]);
  });

  it('does not show an agent its own broadcast back to itself', () => {
    const threads = projectThreads([
      message({ from: 'architect', to: { kind: 'everyone' }, taskId: 'TASK-009' }),
    ]);

    // Reached only because this agent opened it, not because it was "addressed" to it.
    expect(threadsFor(threads, audience)[0]?.opener).toBe('architect');
  });
});

/* ─── Handoffs ─────────────────────────────────────────────────────────────── */

describe('projectHandoffs (M4-04)', () => {
  const request = message({
    id: 'MSG-0001',
    threadId: 'THR-0001',
    type: 'handoff_request',
    from: 'executor.normal',
    to: { kind: 'agent', id: 'executor.complex' },
    taskId: 'TASK-003',
    subject: 'this needs the strong executor',
    body: 'it turned out to touch the scheduler',
  });

  it('reports a request nobody answered as requested', () => {
    const [handoff] = projectHandoffs([request]);

    expect(handoff?.status).toBe('requested');
    expect(handoff?.from).toBe('executor.normal');
    expect(handoff?.to).toBe('executor.complex');
    expect(handoff?.reason).toBe('it turned out to touch the scheduler');
  });

  it('reports acceptance and rejection from the target', () => {
    const accepted = projectHandoffs([
      request,
      message({ id: 'MSG-0002', type: 'handoff_accepted', from: 'executor.complex', to: { kind: 'agent', id: 'executor.normal' } }),
    ]);
    const rejected = projectHandoffs([
      request,
      message({ id: 'MSG-0002', type: 'handoff_rejected', from: 'executor.complex', to: { kind: 'agent', id: 'executor.normal' } }),
    ]);

    expect(accepted[0]?.status).toBe('accepted');
    expect(accepted[0]?.settledAt).toBeDefined();
    expect(rejected[0]?.status).toBe('rejected');
  });

  it('ignores an acceptance from anyone but the target', () => {
    // There is no state in which a third party takes a task off the agent it was
    // offered to. The message stays in the thread, where a reader sees the attempt.
    const handoffs = projectHandoffs([
      request,
      message({ id: 'MSG-0002', type: 'handoff_accepted', from: 'planner', to: { kind: 'agent', id: 'executor.normal' } }),
    ]);

    expect(handoffs[0]?.status).toBe('requested');
  });

  it('expires a request the run ended without settling', () => {
    expect(projectHandoffs([request], { runTerminated: true })[0]?.status).toBe('expired');
  });

  it('does not expire one that was settled', () => {
    const handoffs = projectHandoffs(
      [
        request,
        message({ id: 'MSG-0002', type: 'handoff_accepted', from: 'executor.complex', to: { kind: 'agent', id: 'executor.normal' } }),
      ],
      { runTerminated: true },
    );

    expect(handoffs[0]?.status).toBe('accepted');
  });
});

describe('resolveTaskAgent — who executes (M4-04)', () => {
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

  const base = {
    taskId: 'TASK-003',
    routedRole: 'executor.normal' as const,
    agentOf: () => agent(),
    canImplement: () => true,
  };

  it('answers the router with no handoff at all', () => {
    const assignment = resolveTaskAgent({ ...base, handoffs: [], config: config() });

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('routed');
  });

  it('records the handoff but keeps the router’s answer while re-routing is off', () => {
    // The default, and the reason for it: re-routing execution from model output is an
    // ownership transfer, and ownership is not a model's to decide.
    const assignment = resolveTaskAgent({
      ...base,
      handoffs: projectHandoffs(accepted),
      config: config({ handoffsReassignExecution: false }),
    });

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_not_enabled');
    expect(assignment.handoff?.to).toBe('architect');
  });

  it('honours an accepted handoff when the operator turned it on', () => {
    const assignment = resolveTaskAgent({
      ...base,
      handoffs: projectHandoffs(accepted),
      config: config({ handoffsReassignExecution: true }),
    });

    expect(assignment.agentId).toBe('architect');
    expect(assignment.reason).toBe('handoff');
  });

  it('refuses a target that cannot implement, and says why', () => {
    // A handoff to an agent whose runner has no working directory produces an attempt
    // that cannot begin. Refused before it is spent, not discovered afterwards.
    const assignment = resolveTaskAgent({
      ...base,
      handoffs: projectHandoffs(accepted),
      config: config({ handoffsReassignExecution: true }),
      canImplement: () => false,
    });

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_refused_capability');
    expect(assignment.refusal).toContain('architect');
  });

  it('refuses a target nobody configured', () => {
    const assignment = resolveTaskAgent({
      ...base,
      handoffs: projectHandoffs(accepted),
      config: config({ handoffsReassignExecution: true }),
      agentOf: () => undefined,
    });

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

    const assignment = resolveTaskAgent({
      ...base,
      handoffs: projectHandoffs(twice),
      config: config({ handoffsReassignExecution: true, maxHandoffsPerTask: 1 }),
    });

    expect(assignment.agentId).toBe('executor.normal');
    expect(assignment.reason).toBe('handoff_budget_exhausted');
  });

  it('ignores a handoff belonging to another task', () => {
    const assignment = resolveTaskAgent({
      ...base,
      taskId: 'TASK-009',
      handoffs: projectHandoffs(accepted),
      config: config({ handoffsReassignExecution: true }),
    });

    expect(assignment.reason).toBe('routed');
  });
});

/* ─── Blackboard ───────────────────────────────────────────────────────────── */

describe('projectBlackboard (M4-05, I-30)', () => {
  it('leaves an unsuperseded entry active', () => {
    expect(projectBlackboard([entry()])[0]?.status).toBe('active');
  });

  it('treats a supersession by the same author as a correction', () => {
    const projected = projectBlackboard([
      entry({ id: 'DSC-001', kind: 'discovery', author: 'executor.normal' }),
      entry({ id: 'DSC-002', kind: 'discovery', author: 'executor.normal', supersedes: 'DSC-001' }),
    ]);

    expect(projected[0]?.status).toBe('superseded');
    expect(projected[0]?.supersededBy).toBe('DSC-002');
    expect(projected[1]?.status).toBe('active');
  });

  it('treats a supersession by another author as contested, on both sides', () => {
    // Marking only the older one would show a reader one entry labelled "disputed" and
    // its replacement labelled "active", which reads as a settled argument.
    const projected = projectBlackboard([
      entry({ id: 'CTR-001', kind: 'contract', author: 'architect' }),
      entry({ id: 'CTR-002', kind: 'contract', author: 'executor.normal', supersedes: 'CTR-001' }),
    ]);

    expect(projected[0]?.status).toBe('contested');
    expect(projected[1]?.status).toBe('contested');
  });

  it('never removes an entry, whatever happened to it', () => {
    const log = [
      entry({ id: 'CTR-001', kind: 'contract', author: 'architect' }),
      entry({ id: 'CTR-002', kind: 'contract', author: 'planner', supersedes: 'CTR-001' }),
    ];

    expect(projectBlackboard(log)).toHaveLength(2);
  });

  it('ignores a supersession of something not in the log', () => {
    const projected = projectBlackboard([entry({ id: 'DEC-002', supersedes: 'DEC-099' })]);
    expect(projected[0]?.status).toBe('active');
  });
});

describe('entriesFor — who is shown what (M4-06)', () => {
  it('shows an entry addressed to nobody in particular', () => {
    const projected = projectBlackboard([entry({ affects: [] })]);
    expect(entriesFor(projected, { role: 'executor.normal' })).toHaveLength(1);
  });

  it('shows an entry that names this role', () => {
    const projected = projectBlackboard([entry({ affects: ['executor.normal'] })]);

    expect(entriesFor(projected, { role: 'executor.normal' })).toHaveLength(1);
    expect(entriesFor(projected, { role: 'planner' })).toEqual([]);
  });

  it('shows an entry that references this task or one of its files', () => {
    const byTask = projectBlackboard([
      entry({ affects: ['planner'], references: [{ kind: 'task', id: 'TASK-003' }] }),
    ]);
    const byFile = projectBlackboard([
      entry({ affects: ['planner'], references: [{ kind: 'file', id: 'src/core/dag.ts' }] }),
    ]);

    expect(entriesFor(byTask, { role: 'executor.normal', taskId: 'TASK-003' })).toHaveLength(1);
    expect(
      entriesFor(byFile, { role: 'executor.normal', files: ['src/core/dag.ts'] }),
    ).toHaveLength(1);
  });

  it('hides a superseded entry and keeps a contested one', () => {
    // The whole reason there are three statuses instead of two. A correction has a right
    // answer; a disagreement does not, and hiding half of it would hand the next agent a
    // decision somebody else is still arguing about.
    const corrected = projectBlackboard([
      entry({ id: 'DSC-001', kind: 'discovery', author: 'a', affects: [] }),
      entry({ id: 'DSC-002', kind: 'discovery', author: 'a', supersedes: 'DSC-001', affects: [] }),
    ]);
    const disputed = projectBlackboard([
      entry({ id: 'CTR-001', kind: 'contract', author: 'a', affects: [] }),
      entry({ id: 'CTR-002', kind: 'contract', author: 'b', supersedes: 'CTR-001', affects: [] }),
    ]);

    expect(entriesFor(corrected, { role: 'executor.normal' }).map((p) => p.entry.id)).toEqual([
      'DSC-002',
    ]);
    expect(entriesFor(disputed, { role: 'executor.normal' })).toHaveLength(2);
  });
});
