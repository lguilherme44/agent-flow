import { describe, it, expect } from 'vitest';
import {
  BOARD_LANES,
  type AttentionItem,
  type BoardLane,
  type ReviewThreadView,
  type RunProjection,
  type TaskState,
  type TaskSummaryView,
  type WaveDeferralView,
} from '../../src/contracts/index.js';
import { boardLane, boardReason, laneCounts, projectBoard, type BoardContext } from '../../src/core/board.js';

/**
 * The board, and the two claims it has to make (M8 §5, §6).
 *
 *   every visible task is in exactly one lane
 *   every card that is not done says why it is where it is
 *
 * The second is the one worth testing hardest. A lane that is merely correct produces a
 * task table with rounded corners; the sentence is what an operator came for, and every
 * sentence here has to be traceable to a fact some other projection already recorded.
 */

const TASK_STATES: readonly TaskState[] = [
  'queued',
  'ready',
  'running',
  'interrupted',
  'completed',
  'failed',
  'blocked',
  'review_required',
];

const task = (
  id: string,
  state: TaskState,
  extra: Partial<TaskSummaryView> = {},
): TaskSummaryView => ({
  id,
  title: `${id} title`,
  complexity: 'medium',
  risk: 'low',
  state,
  attempts: 1,
  requirements: [],
  dependencies: [],
  ...extra,
});

const runtime = (status: RunProjection['status'] = 'implementing'): RunProjection => ({
  status,
  resumable: true,
  progress: { workflow: { done: 5, total: 7 }, implementation: { done: 1, total: 3 } },
  reviewFreshness: 'absent',
});

const context = (overrides: Partial<BoardContext> = {}): BoardContext => ({
  runtime: runtime(),
  waitingOn: new Map<string, readonly string[]>(),
  deferrals: [],
  threads: [],
  assignments: new Map(),
  ...overrides,
});

const thread = (overrides: Partial<ReviewThreadView> = {}): ReviewThreadView => ({
  taskId: 'TASK-001',
  status: 'in_review',
  freshness: 'current',
  rounds: 1,
  reviewer: 'reviewer',
  reviewerName: 'Reviewer',
  author: 'author',
  independence: 2,
  findings: [],
  openBlocking: 0,
  decision: { approved: false, conditions: [], blockedBy: [] },
  ...overrides,
});

describe('M8-ACC-04 — every visible task is in exactly one lane', () => {
  it('places every task state somewhere, and never twice', () => {
    const tasks = TASK_STATES.map((state, index) => task(`TASK-00${index + 1}`, state));
    const cards = projectBoard(tasks, context());

    expect(cards).toHaveLength(tasks.length);
    // One card per task, and every card's lane is a lane the contract declares. A lane the
    // board cannot render is the same defect as a task with no lane at all.
    expect(new Set(cards.map((card) => card.task.id)).size).toBe(tasks.length);
    for (const card of cards) expect(BOARD_LANES).toContain(card.lane);

    const counts = laneCounts(cards);
    expect(counts.reduce((sum, lane) => sum + lane.count, 0)).toBe(tasks.length);
  });

  it('returns every lane in the counts, including the empty ones', () => {
    // A board that hides BLOCKED while nothing is blocked changes width as a run
    // progresses, and a column that appears is a column somebody has to notice appearing.
    const counts = laneCounts(projectBoard([task('TASK-001', 'completed')], context()));

    expect(counts.map((lane) => lane.lane)).toEqual([...BOARD_LANES]);
  });

  it('never silently defaults an unrecognised state to backlog', () => {
    // A run written by a build that knew a state this one does not. `backlog` would hide
    // it among tasks that have simply not started; `unknown` is a lane a person can see.
    const alien = task('TASK-009', 'not_a_real_state' as TaskState);

    expect(boardLane(alien, context())).toBe('unknown');
    expect(boardReason(alien, 'unknown', context()).cause).toBe('unknown');
  });
});

describe('M8-ACC-05 — the lane comes from the effective state and the run', () => {
  const lanes: [string, TaskSummaryView, BoardContext, BoardLane][] = [
    ['completed is done', task('T', 'completed'), context(), 'done'],
    ['running is in progress', task('T', 'running'), context(), 'in_progress'],
    ['review_required is review', task('T', 'review_required'), context(), 'review'],
    ['blocked is blocked', task('T', 'blocked'), context(), 'blocked'],
    ['failed is blocked', task('T', 'failed'), context(), 'blocked'],
    ['the effective state `ready` is the ready lane', task('T', 'ready'), context(), 'ready'],
    ['queued is backlog', task('T', 'queued'), context(), 'backlog'],
    [
      'validated and unmerged is in progress',
      task('T', 'ready', { awaitingIntegration: true }),
      context(),
      'in_progress',
    ],
  ];

  for (const [name, subject, ctx, expected] of lanes) {
    it(name, () => {
      expect(boardLane(subject, ctx)).toBe(expected);
    });
  }

  it('reads `interrupted` differently depending on whether the run is executing', () => {
    // The non-local rule §19.4 of the spec names explicitly, because it is the kind people
    // forget. A stopped run with an interrupted task is not making progress, and showing
    // it as `in_progress` is motion where there is none.
    const subject = task('T', 'interrupted');

    expect(boardLane(subject, context({ runtime: runtime('implementing') }))).toBe('in_progress');
    expect(boardLane(subject, context({ runtime: runtime('blocked_on_human') }))).toBe('blocked');
    expect(boardLane(subject, context({ runtime: runtime('failed') }))).toBe('blocked');
  });
});

describe('M8-ACC-06 — a blocked card says why, mechanically', () => {
  it('distinguishes the agent answering BLOCKED from an upstream failure', () => {
    // Only the second is ever released by recovery, which is the difference between
    // waiting and acting — so the two must not produce the same sentence.
    const agent = boardReason(task('T', 'blocked'), 'blocked', context());
    expect(agent.cause).toBe('human');
    expect(agent.text).toContain('SDD');

    const upstream = boardReason(
      task('T', 'blocked', { blockReason: 'dependency' }),
      'blocked',
      context({ waitingOn: new Map([['T', ['TASK-004']]]) }),
    );
    expect(upstream.cause).toBe('dependency');
    expect(upstream.text).toContain('TASK-004');
    expect(upstream.waitsFor).toEqual(['TASK-004']);
  });

  it('does not blame the agent for a block the graph derived', () => {
    // `blocked` is two things — a record the executor wrote and a condition
    // `blockedByFailure` derives downstream of a failure — and only the first carries a
    // reason. Reading absence as "the agent asked for help" put that sentence on the card
    // of every task the agent never touched. Found by the acceptance suite against the
    // real server, on a run where one failure poisoned two dependents.
    const derived = boardReason(
      task('T', 'blocked'),
      'blocked',
      context({ waitingOn: new Map([['T', ['TASK-001']]]) }),
    );

    expect(derived.cause).toBe('dependency');
    expect(derived.text).toContain('TASK-001');

    // An explicit record from the executor still outranks the graph: the agent said so.
    const stated = boardReason(
      task('T', 'blocked', { blockReason: 'agent' }),
      'blocked',
      context({ waitingOn: new Map([['T', ['TASK-001']]]) }),
    );
    expect(stated.cause).toBe('human');
  });

  it('names the attempt count on a failure', () => {
    const reason = boardReason(task('T', 'failed', { attempts: 3 }), 'blocked', context());

    expect(reason.cause).toBe('failure');
    expect(reason.text).toContain('3 attempts');
  });

  it('names the dependencies a backlog card waits on', () => {
    const reason = boardReason(
      task('T', 'queued'),
      'backlog',
      context({ waitingOn: new Map([['T', ['TASK-001', 'TASK-004']]]) }),
    );

    expect(reason.text).toBe('waiting on TASK-001, TASK-004');
    expect(reason.waitsFor).toEqual(['TASK-001', 'TASK-004']);
  });
});

describe('M8-ACC-07 — a deferred ready card says which constraint held it', () => {
  const deferral = (overrides: Partial<WaveDeferralView>): WaveDeferralView => ({
    taskId: 'T',
    reason: 'capacity',
    detail: '',
    patterns: [],
    agents: [],
    ...overrides,
  });

  it('reports capacity, and who is full', () => {
    const reason = boardReason(
      task('T', 'queued'),
      'ready',
      context({ deferrals: [deferral({ reason: 'capacity', agents: ['backend'] })] }),
    );

    expect(reason.cause).toBe('capacity');
    expect(reason.text).toContain('backend');
  });

  it('reports ownership, the area and who holds it', () => {
    const reason = boardReason(
      task('T', 'queued'),
      'ready',
      context({
        deferrals: [
          deferral({ reason: 'ownership', patterns: ['src/db/**'], waitsFor: 'TASK-002' }),
        ],
      }),
    );

    expect(reason.cause).toBe('ownership');
    expect(reason.text).toContain('src/db/**');
    expect(reason.text).toContain('TASK-002');
  });

  it('takes the most recent deferral when a task was held twice', () => {
    // Deferred for capacity in one wave and for ownership in the next: the second is what
    // it is waiting on now, and reporting the first sends somebody to fix a full agent.
    const reason = boardReason(
      task('T', 'queued'),
      'ready',
      context({
        deferrals: [
          deferral({ reason: 'capacity', agents: ['backend'] }),
          deferral({ reason: 'ownership', patterns: ['src/db/**'] }),
        ],
      }),
    );

    expect(reason.cause).toBe('ownership');
  });

  it('says "ready to start" when nothing held it', () => {
    expect(boardReason(task('T', 'queued'), 'ready', context()).cause).toBe('none');
  });
});

describe('the card carries what the run already decided', () => {
  it('takes the blocking count from the review thread rather than recounting findings', () => {
    const cards = projectBoard(
      [task('TASK-001', 'review_required')],
      context({ threads: [thread({ openBlocking: 2 })] }),
    );

    expect(cards[0]?.blockingFindings).toBe(2);
    expect(cards[0]?.reason.text).toContain('2 blocking findings');
  });

  it('names the agent holding a task', () => {
    const cards = projectBoard(
      [task('TASK-001', 'running')],
      context({ assignments: new Map([['TASK-001', { agentId: 'be', agentName: 'Backend' }]]) }),
    );

    expect(cards[0]?.agentName).toBe('Backend');
  });

  it('marks a card with the most urgent attention item scoped to it', () => {
    const items: AttentionItem[] = [
      {
        id: 'task_failed:TASK-001',
        priority: 'P2',
        kind: 'task_failed',
        what: 'x',
        why: 'y',
        scope: { runId: 'R', taskId: 'TASK-001' },
        since: '2026-09-03T00:00:00.000Z',
        action: { kind: 'retry', label: 'Requeue', destructive: false },
        focus: 'task',
      },
      {
        id: 'agent_blocked:TASK-001',
        priority: 'P1',
        kind: 'agent_blocked',
        what: 'x',
        why: 'y',
        scope: { runId: 'R', taskId: 'TASK-001' },
        since: '2026-09-03T00:00:00.000Z',
        action: { kind: 'inspect', label: 'Read', destructive: false },
        focus: 'task',
      },
    ];

    const cards = projectBoard([task('TASK-001', 'failed')], context(), items);

    // P1 outranks P2, and the card carries the join so no component has to scan a second
    // list — the join that goes wrong the first time one of the two is a frame behind.
    expect(cards[0]?.attention).toBe('P1');
  });

  it('leaves a card unmarked when nothing scopes to it', () => {
    expect(projectBoard([task('TASK-001', 'running')], context(), []).at(0)?.attention).toBeUndefined();
  });
});
