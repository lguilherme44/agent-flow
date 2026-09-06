import { describe, it, expect } from 'vitest';
import { render, renderIsolatedProgress, renderPlanningProgress } from '../../src/cli/status.js';
import {
  BlackboardEntrySchema,
  RunStateSchema,
  type BlackboardEntry,
  type MessageThread,
  type RunProjection,
  type RunState,
} from '../../src/contracts/index.js';
import { renderCollaboration } from '../../src/cli/render/collaboration.js';

/**
 * Found by killing a run mid-discovery, not by reading the code.
 *
 * `status` inferred progress from `state.stage`, and two things conspired.
 * `createRun` initialises `stage: 'discovery'`, so a run that had executed
 * nothing already claimed to be at the first stage; and the marker was
 *
 *   index < reached ? '✓' : index === reached ? '✓' : '·'
 *
 * a nested ternary whose first two branches are the same value — the residue of
 * a version that distinguished "done" from "in progress" and was collapsed
 * without being simplified. Together they printed `Discovery ✓` for a run whose
 * event log contained a single `stage_started` and no completion at all.
 *
 * Progress is now read from `stage_completed` events, which are written after
 * the work, not before it.
 */
describe('planning progress is read from what completed', () => {
  it('claims nothing for a run that has only started', () => {
    const lines = renderPlanningProgress([], 'discovery', 'running');

    expect(lines.find((line) => line.includes('Discovery'))).toContain('…');
    expect(lines.find((line) => line.includes('Architecture'))).toContain('·');
  });

  it('marks a stage done only once it has completed', () => {
    const lines = renderPlanningProgress(['discovery'], 'architecture-impact', 'running');

    expect(lines.find((line) => line.includes('Discovery'))).toContain('✓');
    expect(lines.find((line) => line.includes('Architecture'))).toContain('…');
    expect(lines.find((line) => line.includes('SDD'))).toContain('·');
  });

  it('does not show a stage as running when the run is not', () => {
    // A killed process leaves `status: running` behind on disk. The stage it
    // died in is neither done nor in flight, and saying "…" would be as wrong
    // as saying "✓" — it suggests something is still happening.
    const lines = renderPlanningProgress(['discovery'], 'architecture-impact', 'waiting_for_approval');

    expect(lines.find((line) => line.includes('Architecture'))).toContain('·');
  });

  it('marks every completed stage regardless of order in the log', () => {
    const lines = renderPlanningProgress(
      ['sdd', 'discovery', 'architecture-impact'],
      'planning',
      'running',
    );

    for (const label of ['Discovery', 'Architecture', 'SDD']) {
      expect(lines.find((line) => line.includes(label))).toContain('✓');
    }
  });

  it('shows the whole planning sequence, done or not', () => {
    const lines = renderPlanningProgress([], 'discovery', 'running');

    expect(lines).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The headline comes from the runtime projection, not the persisted status
// (C-19, C-20). `state.status` is a record of the last gate reached; it stays
// `plan_rejected` while a revision is already running and `approved` for the
// whole of implementation. `render` used to read it directly and reproduced
// both defects — this is the regression a code review would need file:line
// to catch, and a test does not.
// ---------------------------------------------------------------------------

describe('the headline comes from the runtime projection, not the persisted status', () => {
  const state = (patch: Partial<RunState> = {}): RunState =>
    RunStateSchema.parse({
      runId: 'AF-2026-002',
      feature: 'f',
      stage: 'plan-review',
      status: 'plan_rejected',
      createdAt: '2026-08-17T13:34:15.000Z',
      updatedAt: '2026-08-17T17:38:44.000Z',
      ...patch,
    });

  const projection = (patch: Partial<RunProjection> = {}): RunProjection => ({
    status: 'planning',
    resumable: true,
  paused: false,
    reviewFreshness: 'current',
    progress: { workflow: { done: 4, total: 7 }, implementation: { done: 0, total: 0 } },
    ...patch,
  });

  const headline = (rendered: string): string | undefined =>
    rendered.split('\n').find((line, index, lines) => lines[index - 1] === 'Status:');

  it('shows PLANNING, not PLAN_REJECTED, while a revision is running', () => {
    const rendered = render(
      state({ status: 'plan_rejected' }),
      projection({ status: 'planning' }),
      0,
      null,
      [],
      null,
      [],
      undefined,
    );

    expect(headline(rendered)).toBe('PLANNING');
    expect(rendered).not.toContain('agent-flow revise');
  });

  it('shows IMPLEMENTING, not APPROVED, once implementation has started', () => {
    const rendered = render(
      state({ status: 'approved', stage: 'implementation' }),
      projection({ status: 'implementing' }),
      3,
      null,
      [],
      null,
      [],
      undefined,
    );

    expect(headline(rendered)).toBe('IMPLEMENTING');
  });

  it('still tells a genuinely revisable rejection apart from one being revised', () => {
    const rendered = render(
      state({ status: 'plan_rejected' }),
      projection({ status: 'plan_rejected_revisable' }),
      0,
      null,
      [],
      null,
      [],
      undefined,
    );

    expect(headline(rendered)).toBe('PLAN_REJECTED_REVISABLE');
    expect(rendered).toContain('agent-flow revise "<instruction>"');
  });

  it('prints the gate\'s own action as the hint, whichever gate it is (AR §3.6)', () => {
    // `blocked_on_human` has no hint of its own in `render` — the gate names the
    // one action that clears it, and the CLI must not word a second version of it.
    const rendered = render(
      state({ status: 'running', stage: 'implementation' }),
      projection({
        status: 'blocked_on_human',
        gate: {
          gate: 'agent_blocked',
          action: 'Answer what TASK-002 reported as blocking, then requeue',
          tasks: ['TASK-002'],
        },
      }),
      2,
      null,
      [],
      null,
      [],
      undefined,
    );

    expect(rendered).toContain('Answer what TASK-002 reported as blocking, then requeue');
  });
});

// ---------------------------------------------------------------------------
// §21.4 — what an isolated run is doing (M2-10)
// ---------------------------------------------------------------------------

describe('renderIsolatedProgress (§21.4)', () => {
  const isolated = (patch: Partial<RunState> = {}): RunState =>
    RunStateSchema.parse({
      runId: 'AF-2026-001',
      feature: 'f',
      stage: 'implementation',
      status: 'running',
      isolationMode: 'worktree',
      gitRunKey: 'AF-2026-001-0f3a91c4bd27e615',
      planningBase: 'a'.repeat(40),
      createdAt: '2026-08-09T20:00:00.000Z',
      updatedAt: '2026-08-09T20:00:00.000Z',
      ...patch,
    });

  it('says nothing at all for a run that is not isolated', () => {
    // Printing empty headings for machinery a user never turned on is the tool
    // describing itself rather than their run (§25.1).
    const sequential = isolated({ isolationMode: 'none' });
    expect(renderIsolatedProgress(sequential, [])).toEqual([]);

    const legacy = RunStateSchema.parse({
      runId: 'AF-2026-002',
      feature: 'f',
      stage: 'planning',
      status: 'running',
      createdAt: '2026-08-09T20:00:00.000Z',
      updatedAt: '2026-08-09T20:00:00.000Z',
    });
    expect(renderIsolatedProgress(legacy, [])).toEqual([]);
  });

  it('names the branch, derived from the run key rather than stored', () => {
    const rendered = renderIsolatedProgress(isolated(), []).join('\n');

    expect(rendered).toContain('agent-flow/AF-2026-001-0f3a91c4bd27e615/integration');
    // No absolute path anywhere: a worktree path is a machine fact the artifact
    // deliberately does not record (§7.2, §21.3).
    expect(rendered).not.toContain('/.agent-flow/worktrees');
    expect(rendered.split('\n').some((line) => /\s\//.test(line))).toBe(false);
  });

  it('counts what is integrated, not what finished (I-3)', () => {
    const rendered = renderIsolatedProgress(
      isolated({
        tasks: [
          { id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 },
          { id: 'TASK-002', state: 'running', attempts: 1, infrastructureFailures: 0 },
          { id: 'TASK-003', state: 'review_required', attempts: 1, infrastructureFailures: 0 },
        ],
        integrationHead: 'b'.repeat(40),
      }),
      [],
    ).join('\n');

    expect(rendered).toContain('integrated      1 of 3 task(s)');
    expect(rendered).toContain('bbbbbbbb');
  });

  it('lists attempt numbers only where a task was retried', () => {
    // A column of "1" teaches nobody anything; a "3" is the whole reason to look.
    const rendered = renderIsolatedProgress(
      isolated({
        tasks: [
          { id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 },
          { id: 'TASK-002', state: 'running', attempts: 3, infrastructureFailures: 0 },
        ],
      }),
      [],
    ).join('\n');

    expect(rendered).toContain('attempts');
    expect(rendered).toContain('TASK-002');
    expect(rendered).not.toMatch(/TASK-001\s+1/);
  });

  it('names the conflicting paths and what to do about them (§15)', () => {
    const rendered = renderIsolatedProgress(isolated(), [
      { task: 'TASK-002', attempt: 1, paths: ['src/shared.ts', 'src/other.ts'] },
    ]).join('\n');

    expect(rendered).toContain('TASK-002 attempt 1 — src/shared.ts, src/other.ts');
    // A refusal with no next step is a dead end.
    expect(rendered).toContain('agent-flow retry');
  });
});

describe('the collaboration section (M4-07)', () => {
  const thread = (patch: Partial<MessageThread> = {}): MessageThread => ({
    id: 'THR-0001',
    status: 'open',
    subject: 'which idempotency key?',
    opener: 'executor.normal',
    taskId: 'TASK-003',
    messages: [],
    participants: ['executor.normal', 'architect'],
    openedAt: '2026-09-01T12:00:00.000Z',
    lastMessageAt: '2026-09-01T12:00:00.000Z',
    ...patch,
  });

  const entry = (patch: Partial<BlackboardEntry> = {}): BlackboardEntry =>
    BlackboardEntrySchema.parse({
      id: 'CTR-001',
      runId: 'AF-2026-001',
      kind: 'contract',
      subject: 'checkout-idempotency',
      author: 'architect',
      statement: 'the API mints the key',
      createdAt: '2026-09-01T12:00:00.000Z',
      ...patch,
    });

  it('renders nothing at all for a run whose agents never spoke', () => {
    // Every run on every project that has not opted in. A heading here would add a line
    // to `status` for a feature nobody turned on.
    expect(renderCollaboration({ enabled: true, threads: [], handoffs: [], entries: [] })).toBeUndefined();
  });

  it('counts what is open rather than transcribing the conversation', () => {
    // `status` is read before deciding whether a run can move forward. A transcript in
    // the middle of it would bury the gate.
    const rendered = renderCollaboration({
      enabled: true,
      threads: [thread(), thread({ id: 'THR-0002', status: 'resolved' })],
      handoffs: [],
      entries: [{ entry: entry(), status: 'active' }],
    });

    expect(rendered).toContain('2 thread(s), 1 unresolved');
    expect(rendered).toContain('1 live blackboard entry');
  });

  it('names an unanswered handoff, because it is a task waiting on a person', () => {
    const rendered = renderCollaboration({
      enabled: true,
      threads: [thread()],
      handoffs: [
        {
          threadId: 'THR-0002',
          taskId: 'TASK-005',
          from: 'executor.normal',
          to: 'executor.complex',
          reason: 'it touches the scheduler',
          status: 'requested',
          requestedAt: '2026-09-01T12:00:00.000Z',
        },
      ],
      entries: [],
    });

    expect(rendered).toContain('TASK-005: executor.normal → executor.complex, unanswered');
  });

  it('is loud about a contested entry, and says nothing decides it mechanically', () => {
    // The one piece of collaboration state with no mechanical resolution. Folding it
    // into a count would hide the thing a person actually has to settle.
    const rendered = renderCollaboration({
      enabled: true,
      threads: [],
      handoffs: [],
      entries: [
        { entry: entry({ id: 'CTR-001' }), status: 'contested', supersededBy: 'CTR-002' },
        { entry: entry({ id: 'CTR-002', author: 'executor.normal', supersedes: 'CTR-001' }), status: 'contested' },
      ],
    });

    expect(rendered).toContain('2 contested entry(ies)');
    expect(rendered).toContain('nothing decides it for you');
    expect(rendered).toContain('CTR-001');
  });

  it('does not count a superseded entry as live', () => {
    const rendered = renderCollaboration({
      enabled: true,
      threads: [],
      handoffs: [],
      entries: [
        { entry: entry({ id: 'DSC-001', kind: 'discovery' }), status: 'superseded', supersededBy: 'DSC-002' },
        { entry: entry({ id: 'DSC-002', kind: 'discovery' }), status: 'active' },
      ],
    });

    expect(rendered).toContain('1 live blackboard entry');
  });
});
