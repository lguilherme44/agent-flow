import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { projectThreads, threadsFor } from '../../../src/core/collaboration/threads.js';
import { projectHandoffs } from '../../../src/core/collaboration/handoffs.js';
import { entriesFor, projectBlackboard } from '../../../src/core/collaboration/blackboard.js';
import {
  AgentMessageSchema,
  BlackboardEntrySchema,
  type AgentMessage,
  type BlackboardEntry,
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

/**
 * Typed by the schema's *input*, so a legacy `affects: ['planner']` is what it always was:
 * a valid thing to write, normalised on the way in. Typing it by the output would make
 * every pre-M7 fixture a compile error and hide that the reading still works.
 */
function entry(overrides: Partial<z.input<typeof BlackboardEntrySchema>> = {}): BlackboardEntry {
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

  it('shows a thread addressed to this agent that names no task', () => {
    // A thread with no task is general: the recipient branches are exactly what it is
    // for, and nothing narrower can apply to it.
    const threads = projectThreads([
      message({ from: 'executor.normal', to: { kind: 'agent', id: 'architect' }, taskId: undefined }),
    ]);

    expect(threadsFor(threads, audience)).toHaveLength(1);
  });

  it('shows a general thread addressed to this agent’s role, and to everyone', () => {
    const byRole = projectThreads([
      message({ from: 'executor.normal', to: { kind: 'role', role: 'architect' }, taskId: undefined }),
    ]);
    const toAll = projectThreads([
      message({ from: 'executor.normal', to: { kind: 'everyone' }, taskId: undefined }),
    ]);

    expect(threadsFor(byRole, audience)).toHaveLength(1);
    expect(threadsFor(toAll, audience)).toHaveLength(1);
  });

  it('hides a thread addressed to this agent about a different task', () => {
    // **The rule the cost measurement forced.** These branches used to stand alone, so a
    // question addressed to `executor.normal` about TASK-009 reached every
    // `executor.normal` task — which, with one agent per role, is every task in the run.
    // A question about somebody else's task belongs to whoever gets that task.
    const threads = projectThreads([
      message({ from: 'executor.normal', to: { kind: 'agent', id: 'architect' }, taskId: 'TASK-009' }),
    ]);

    expect(threadsFor(threads, audience)).toEqual([]);
  });

  it('shows a thread about this task, whoever it was addressed to', () => {
    const threads = projectThreads([
      message({ from: 'executor.complex', to: { kind: 'agent', id: 'planner' }, taskId: 'TASK-003' }),
    ]);

    expect(threadsFor(threads, audience)).toHaveLength(1);
  });

  it('shows a general thread this agent opened and nobody closed', () => {
    const threads = projectThreads([
      message({ from: 'architect', to: { kind: 'agent', id: 'planner' }, taskId: undefined }),
    ]);

    expect(threadsFor(threads, audience)).toHaveLength(1);
  });

  it('hides a thread this agent opened about another task', () => {
    // Waiting on an answer about TASK-009 is not a reason to carry it into TASK-003's
    // prompt. It reaches this agent again when it is doing TASK-009.
    const threads = projectThreads([
      message({ from: 'architect', to: { kind: 'agent', id: 'planner' }, taskId: 'TASK-009' }),
    ]);

    expect(threadsFor(threads, audience)).toEqual([]);
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
      message({ from: 'architect', to: { kind: 'everyone' }, taskId: undefined }),
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

/**
 * `resolveTaskAgent` moved to `core/team/policy.ts` in M5 and is covered by
 * `test/core/team/assignment.test.ts`. It kept its position in the call graph and lost
 * its home here, which is the point: one answer to "who executes this task", and the
 * handoff projection is an input to it rather than the place it is decided.
 */

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

/**
 * The half that makes the contract change worth making: an entry addressed to a member
 * reaches that member.
 *
 * `entriesFor` matched `affects` against the audience's *role* only, and the call site in
 * `context.ts` built an `agentId` one line above and then passed three of its four fields.
 * Harmless while `affects` held roles; the reason an entry addressed to a teammate reached
 * nobody once it could hold members.
 */
describe('an entry addressed to a member reaches that member (M7 §2)', () => {
  const named = () =>
    projectBlackboard([entry({ affects: [{ kind: 'agent', id: 'qa' }] })]);

  it('reaches the agent it names', () => {
    expect(entriesFor(named(), { role: 'executor.normal', agentId: 'qa' })).toHaveLength(1);
  });

  it('does not reach a different member of the same role', () => {
    expect(entriesFor(named(), { role: 'executor.normal', agentId: 'dev' })).toEqual([]);
  });

  it('reaches nobody in a run with no team, rather than everybody', () => {
    // No `agentId` at all. Widening here would deliver the one entry that tried to be
    // specific to every agent in the run.
    expect(entriesFor(named(), { role: 'executor.normal' })).toEqual([]);
  });

  it('reaches everyone when the author said so explicitly', () => {
    const all = projectBlackboard([entry({ affects: [{ kind: 'everyone' }] })]);

    expect(entriesFor(all, { role: 'planner' })).toHaveLength(1);
    expect(entriesFor(all, { role: 'executor.trivial', agentId: 'dev' })).toHaveLength(1);
  });

  it('still matches a legacy role, which is most of the history on disk', () => {
    const legacy = projectBlackboard([entry({ affects: ['planner'] })]);

    expect(entriesFor(legacy, { role: 'planner', agentId: 'anyone' })).toHaveLength(1);
    expect(entriesFor(legacy, { role: 'executor.normal', agentId: 'anyone' })).toEqual([]);
  });
});
