import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type {
  IsolationDetailView,
  RunDetailView,
  StageViewResponse,
  TaskSummaryView,
} from '@contracts/index.js';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../app/App';
import { RunHeader, StagePipeline, countTasks, describeStagePosition } from './run-overview';
import { RunSummary } from './run-summary';

const run = (overrides: Partial<RunDetailView> = {}): RunDetailView => ({
  projectId: 'demo',
  runId: 'AF-2026-001',
  feature: 'Add weekly recurrence',
  stage: 'implementation',
  status: 'running',
  approved: true,
  createdAt: '2026-08-10T19:34:00.000Z',
  updatedAt: '2026-08-10T20:15:22.000Z',
  taskCount: 14,
  completedTasks: 7,
  degradations: 0,
  degradationDetail: [],
  progress: 50,
  startedAt: '2026-08-10T19:34:00.000Z',
  durationMs: 2_482_000,
  // The default a run gets: sequential, one task at a time, configuration in
  // agreement. Overridable, because the isolation strip below is entirely about
  // the runs where one of those three is not true.
  isolation: SEQUENTIAL,
  integrationConflicts: [],
  runtime: {
    status: 'implementing',
    resumable: true,
    progress: { workflow: { done: 3, total: 6 }, implementation: { done: 0, total: 9 } },
    reviewFreshness: 'current',
  },
  ...overrides,
});

/** Nothing to say: no clamp, no disagreement, no branch. */
const SEQUENTIAL: IsolationDetailView = {
  mode: 'none',
  parallelism: { requested: 1, effective: 1, clamped: false },
  tasksIntegrated: 0,
};

/** A run executing in worktree mode, two tasks at a time, one already merged. */
const ISOLATED: IsolationDetailView = {
  mode: 'worktree',
  parallelism: { requested: 2, effective: 2, clamped: false },
  integrationBranch: 'agent-flow/AF-2026-001-9f2c1a/integration',
  integrationHead: 'c0ffee1234567890abcdef1234567890abcdef12',
  planningBase: 'ba5eba11ba5eba11ba5eba11ba5eba11ba5eba11',
  tasksIntegrated: 1,
};

const STAGES: StageViewResponse[] = [
  {
    stage: 'discovery',
    status: 'completed',
    runner: 'claude',
    durationMs: 149_467,
    startedAt: '2026-08-10T19:34:00.000Z',
    finishedAt: '2026-08-10T19:36:29.000Z',
  },
  { stage: 'architecture-impact', status: 'completed', runner: 'claude' },
  { stage: 'sdd', status: 'completed', runner: 'claude' },
  { stage: 'planning', status: 'completed', runner: 'codex' },
  { stage: 'plan-review', status: 'completed', runner: 'claude' },
  { stage: 'approval', status: 'completed' },
  { stage: 'implementation', status: 'running' },
  { stage: 'verification', status: 'pending' },
  { stage: 'final-review', status: 'failed', errorCode: 'timeout' },
];

/**
 * The header carries real actions now, so it needs a query client.
 *
 * Not a fixture concession: the actions read the gate and the active job from the
 * server, because what a run *is* comes from re-reading it rather than from
 * anything this component keeps. A wrapper that faked those would be testing a
 * component that does not exist.
 */
const withTooltips = (node: JSX.Element): JSX.Element => (
  <QueryClientProvider client={createQueryClient()}>
    <TooltipPrimitive.Provider>{node}</TooltipPrimitive.Provider>
  </QueryClientProvider>
);

describe('countTasks', () => {
  const of = (states: TaskSummaryView['state'][]): TaskSummaryView[] =>
    states.map((state, index) => ({
      id: `TASK-${String(index).padStart(3, '0')}`,
      title: 't',
      complexity: 'normal',
      risk: 'low',
      state,
      attempts: 0,
      requirements: [],
      dependencies: [],
    }));

  it('always sums to the total', () => {
    // The five numbers of §72 are a partition. If one state fell through, the
    // strip would silently add up to less than the number beside it.
    const counts = countTasks(
      of([
        'completed',
        'running',
        'queued',
        'ready',
        'blocked',
        'review_required',
        'failed',
        'interrupted',
      ]),
    );

    expect(counts.completed + counts.running + counts.waiting + counts.failed).toBe(counts.total);
  });

  it('counts a blocked task as waiting, because it waits for a person', () => {
    expect(countTasks(of(['blocked', 'review_required'])).waiting).toBe(2);
  });
});

describe('RunHeader', () => {
  it('leads with the run id, its status and the feature', () => {
    render(withTooltips(<RunHeader run={run()} stages={STAGES} projectId="demo" />));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AF-2026-001');
    expect(screen.getByText('Add weekly recurrence')).toBeInTheDocument();
    // From `runtime.status` (C-19, C-20), not `run.status`: the persisted status stays
    // `running` for the whole of implementation, verification and final review alike.
    expect(screen.getByText('IMPLEMENTING')).toBeInTheDocument();
    expect(screen.getByText('7/14 tasks')).toBeInTheDocument();
    // The pipeline's answer, in nine characters. `implementation` is index 6 of nine.
    expect(screen.getByText('stage 7 of 9')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('uses the duration the server computed', () => {
    // Recomputing from `createdAt` in the browser would tick upward forever on
    // a run that finished hours ago — a stopped run has no clock.
    render(
      withTooltips(
        <RunHeader
          stages={STAGES}
          run={run({ status: 'completed', durationMs: 2_482_000 })} projectId="demo" />,
      ),
    );

    expect(screen.getByText('41m22s')).toBeInTheDocument();
  });

  it('offers the actions the run is actually at, and disables only what is absent', () => {
    // An approved run mid-execution: it can be resumed and it can be revised. It
    // cannot be approved again, and it is not offered a Reject button, because a
    // control whose only outcome is a refusal teaches people to ignore refusals.
    render(withTooltips(<RunHeader
          stages={STAGES}
          run={run({ approved: true })} projectId="demo" />));

    expect(screen.getByRole('button', { name: 'Resume run' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Revise' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();

    // The view toggles left this row in M8.5: three renderings of one task list are the
    // tab strip's job, and a header that also switched views was a toolbar.
    expect(screen.queryByRole('button', { name: 'View as DAG' })).toBeNull();

    // And not offered again once the gate is open.
    expect(screen.queryByRole('button', { name: 'Review & approve' })).toBeNull();
  });

  it('offers nothing to approve on a run that is approved and has no work left', () => {
    // Found on a live run: status stays `approved` until the final review moves
    // it, so the run is not terminal, `canStart` is false at 100%, and the
    // fallthrough offered a gate whose only outcome is `already_approved`.
    render(
      withTooltips(
        <RunHeader
          stages={STAGES}
          run={run({
            status: 'approved',
            approved: true,
            progress: 100,
            runtime: {
              status: 'blocked_on_human',
              resumable: false,
              gate: {
                gate: 'final_acceptance',
                action: 'Run `agent-flow review`, then accept and merge',
                tasks: [],
              },
              progress: { workflow: { done: 6, total: 7 }, implementation: { done: 9, total: 9 } },
              reviewFreshness: 'current',
            },
          })}
          projectId="demo"
        />,
      ),
    );

    expect(screen.queryByRole('button', { name: 'Review & approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: /run$/ })).toBeNull();
    // Revising is still legitimate: a new plan reopens the gate.
    expect(screen.getByRole('button', { name: 'Revise' })).toBeEnabled();
  });

  it('does not offer approval CTA when planning is still running (§UX-02)', () => {
    render(
      withTooltips(
        <RunHeader
          stages={STAGES}
          run={run({ status: 'running', approved: false, progress: 0, stage: 'planning' })}
          projectId="demo"
        />,
      ),
    );

    expect(screen.queryByRole('button', { name: 'Review & approve' })).toBeNull();
    expect(screen.getByText(/Planning in progress/i)).toBeInTheDocument();
  });

  it('asks for approval before it offers to start', () => {
    render(
      withTooltips(
        <RunHeader
          stages={STAGES}
          run={run({ status: 'waiting_for_approval', approved: false, progress: 0 })}
          projectId="demo"
        />,
      ),
    );

    expect(screen.getByRole('button', { name: 'Review & approve' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /run$/ })).toBeNull();
    // Rejecting is offered while the plan is still up for judgement, and not after.
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('offers nothing to change on a finished run', () => {
    render(
      withTooltips(
        <RunHeader
          stages={STAGES}
          run={run({
            status: 'completed',
            approved: true,
            progress: 100,
            runtime: {
              status: 'complete',
              resumable: false,
              progress: { workflow: { done: 7, total: 7 }, implementation: { done: 9, total: 9 } },
              reviewFreshness: 'current',
            },
          })}
          projectId="demo"
        />,
      ),
    );

    for (const name of ['Review & approve', 'Resume run', 'Start run', 'Revise', 'Reject']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  /**
   * M8.5 moved it to Overview, beside the pipeline and the escalation. A degradation is
     * detail behind an attention row that already carries the headline, and the attention
     * strip is what stays on the always-visible layer.
   */
  it('puts a degradation where the verdict is read, not in a log', () => {
    render(
      withTooltips(
        <RunSummary
          stages={STAGES}
          tasks={[]}
          artifacts={[]}
          telemetry={undefined}
          onOpenArtifact={() => undefined}
          run={run({
            degradations: 1,
            degradationDetail: [
              {
                kind: 'forced_approval',
                reason: 'the plan was approved with --force',
                impact: 'the review gate did not hold for this run',
                detectedAt: '2026-08-10T19:40:00.000Z',
              },
            ],
          })}
          projectId="demo"
        />,
      ),
    );

    expect(screen.getByText('the plan was approved with --force')).toBeInTheDocument();
    expect(screen.getByText('the review gate did not hold for this run')).toBeInTheDocument();
  });

  it('does not offer View as DAG when there is no plan to graph', () => {
    render(
      withTooltips(
        <RunHeader
          stages={STAGES}
          run={run({ taskCount: 0, completedTasks: 0 })}
          projectId="demo"
        />,
      ),
    );

    expect(screen.queryByRole('button', { name: 'View as DAG' })).toBeNull();
  });

  /**
   * Same move, same reason: C-22's last line is a prohibition on 'something failed, check
     * the logs', and the run holds the class, the counters, every repair it attempted and
     * the evidence. All of it is here rather than nowhere.
   */
  it('shows the C-22 escalation the CLI has rendered since AR-08, once the dashboard has it too', () => {
    render(
      withTooltips(
        <RunSummary
          stages={STAGES}
          tasks={[]}
          artifacts={[]}
          telemetry={undefined}
          onOpenArtifact={() => undefined}
          run={run({
            runtime: {
              status: 'auto_recovery_exhausted',
              resumable: false,
              progress: { workflow: { done: 4, total: 7 }, implementation: { done: 3, total: 9 } },
              reviewFreshness: 'current',
              escalation: {
                task: 'TASK-002',
                failureClass: 'validation_unsatisfied',
                counts: { attempts: 2, infrastructureFailures: 0 },
                evidence: ['npm test -- recurrence: 1 failing'],
                attemptedRepairs: [{ step: 'work_retry', outcome: 'requeued' }],
                humanAction: 'Read the failed attempt for TASK-002 and decide what to change',
              },
            },
          })}
          projectId="demo"
        />,
      ),
    );

    expect(screen.getByText(/Automatic recovery stopped on TASK-002/)).toBeInTheDocument();
    expect(screen.getByText(/Validation Unsatisfied/)).toBeInTheDocument();
    expect(screen.getByText(/npm test -- recurrence: 1 failing/)).toBeInTheDocument();
    expect(screen.getByText(/Work Retry → requeued/)).toBeInTheDocument();
    expect(
      screen.getByText('Do this: Read the failed attempt for TASK-002 and decide what to change'),
    ).toBeInTheDocument();
  });

  it('reports overall progress from the workflow axis, never 100% with a later stage pending', () => {
    // AF-2026-002 read 100% the moment every planned task completed, with
    // verification and final-review still ahead of it. `workflow` is stage-based:
    // four of seven required stages reached is 57%, whatever the task count says.
    render(
      withTooltips(
        <RunHeader
          stages={STAGES}
          run={run({
            taskCount: 6,
            completedTasks: 6,
            runtime: {
              status: 'verifying',
              resumable: false,
              progress: {
                workflow: { done: 4, total: 7 },
                implementation: { done: 6, total: 6 },
              },
              reviewFreshness: 'current',
            },
          })}
          projectId="demo"
        />,
      ),
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '57');
  });
});

describe('StagePipeline', () => {
  it('renders all nine stages, approval included', () => {
    render(withTooltips(<StagePipeline stages={STAGES} />));

    expect(screen.getByRole('list', { name: 'Pipeline' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(screen.getByText('Approval')).toBeInTheDocument();
  });

  it('names each stage in words rather than by colour alone', () => {
    render(withTooltips(<StagePipeline stages={STAGES} />));

    expect(screen.getByText('Architecture Impact')).toBeInTheDocument();
    expect(screen.getByText('Final Review')).toBeInTheDocument();
    expect(screen.getByText('SDD')).toBeInTheDocument();
  });

  it('shows the duration a stage actually took', () => {
    render(withTooltips(<StagePipeline stages={STAGES} />));

    expect(screen.getByText('2m29s')).toBeInTheDocument();
  });

  it('says what a stage with no duration is doing instead of showing a dash', () => {
    render(withTooltips(<StagePipeline stages={STAGES} />));

    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });
});

/**
 * M8.5 split what `RunPanel` used to hold.
 *
 * The header answers "which run, what state, how far"; the pipeline, the isolation facts
 * and the run's own metadata answer "and how did it get there". The first is always on
 * screen and the second is one tab away, so the two are now separate components — and the
 * thing worth asserting is that the header does *not* carry the pipeline, because that is
 * the 90 pixels the board got back.
 */
describe('RunHeader and the pipeline are two surfaces now (M8.5 §8)', () => {
  it('leaves the nine-step pipeline off the always-visible row', () => {
    render(withTooltips(<RunHeader run={run()} stages={STAGES} projectId="demo" />));

    expect(screen.queryByRole('list', { name: 'Pipeline' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AF-2026-001');
  });

  it('renders the header without a pipeline the server has not produced yet', () => {
    render(withTooltips(<RunHeader run={run()} stages={undefined} projectId="demo" />));

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    // No stages, no position: a counter reading `stage 1 of 0` is worse than silence.
    expect(screen.queryByText(/^stage \d+ of/)).toBeNull();
  });

  it('draws the pipeline on the Overview surface', () => {
    render(
      withTooltips(
        <RunSummary
          run={run()}
          stages={STAGES}
          tasks={[]}
          artifacts={[]}
          telemetry={undefined}
          projectId="demo"
          onOpenArtifact={() => undefined}
        />,
      ),
    );

    expect(screen.getByRole('list', { name: 'Pipeline' })).toBeInTheDocument();
    // And the two facts the header dropped, which is where they went rather than what
    // happened to them.
    expect(screen.getByText('Started by')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();

    // **The task count is not one of them.** It came down with the others and landed above
    // an execution summary that already reports it with a bar, while the header says it on
    // every surface. Two of three copies of one number is still one too many.
    expect(screen.queryByText('7 / 14')).toBeNull();
  });
});

/**
 * The counter that replaced ninety pixels of pipeline.
 *
 * A position over the server's own statuses, never a decision about what any of them is.
 */
describe('describeStagePosition', () => {
  it('points at the first stage that is not settled', () => {
    expect(describeStagePosition(STAGES)).toBe('stage 7 of 9');
  });

  it('counts a cached stage as settled, because the run does not have to do it', () => {
    // The distinction `cached` exists to draw is between "reused" and "not started", and
    // a run waiting on nothing is not waiting whichever way the work got done. It still
    // reads differently in the pipeline — `info`, not `success` — because a reused
    // artifact is as old as whatever produced it.
    const stages: StageViewResponse[] = [
      { stage: 'discovery', status: 'cached' },
      { stage: 'sdd', status: 'cached' },
      { stage: 'planning', status: 'running' },
    ];

    expect(describeStagePosition(stages)).toBe('stage 3 of 3');
  });

  it('says the last position rather than one past the end when everything is settled', () => {
    const stages: StageViewResponse[] = [
      { stage: 'discovery', status: 'completed' },
      { stage: 'sdd', status: 'completed' },
    ];

    expect(describeStagePosition(stages)).toBe('stage 2 of 2');
  });

  it('says nothing at all when there are no stages', () => {
    expect(describeStagePosition(undefined)).toBeUndefined();
    expect(describeStagePosition([])).toBeUndefined();
  });
});

/**
 * M2-10 — §21.2's facts, and §21.3's silences.
 *
 * These are behaviour tests rather than snapshots on purpose: what matters is
 * *which* runs get told about isolation and which are left alone, and a snapshot
 * would pass whichever of those it happened to record.
 */
/**
 * The isolation strip, on the surface it moved to (M8.5 §15).
 *
 * Rendered through `RunSummary` rather than in isolation, because the thing worth keeping
 * true is that Overview composes it — a strip that only worked when a test rendered it
 * directly would be a strip nobody sees.
 */
describe('the isolation strip', () => {
  const panel = (overrides: Partial<RunDetailView>): void => {
    render(
      withTooltips(
        <RunSummary
          run={run(overrides)}
          stages={undefined}
          tasks={[]}
          artifacts={[]}
          telemetry={undefined}
          projectId="demo"
          onOpenArtifact={() => undefined}
        />,
      ),
    );
  };

  it('says nothing on a sequential run whose configuration agrees with it', () => {
    // The default. A line reading `isolation: none` on every run would be the
    // tool describing machinery nobody turned on, and it would push the task
    // table down a row to do it.
    panel({});

    expect(screen.queryByText('Isolation')).toBeNull();
    expect(screen.queryByText('Tasks at once')).toBeNull();
  });

  it('says nothing on a legacy run either, while its configuration is unchanged', () => {
    // §25.2: a run that predates MVP 2 did not answer `none`, it predates the
    // question. There is nothing to report and nothing to promote.
    panel({ isolation: { ...SEQUENTIAL, mode: 'legacy' } });

    expect(screen.queryByText('Isolation')).toBeNull();
  });

  it('reports the branch, the head and how many tasks are on it for an isolated run', () => {
    panel({ isolation: ISOLATED });

    expect(screen.getByText('Isolation')).toBeInTheDocument();
    expect(screen.getByText('worktree')).toBeInTheDocument();
    expect(screen.getByText('agent-flow/AF-2026-001-9f2c1a/integration')).toBeInTheDocument();
    // Abbreviated for the eye, whole in the tooltip — it is something to copy.
    expect(screen.getByText('c0ffee12')).toHaveAttribute('title', ISOLATED.integrationHead);
    // I-3 as a number: how many tasks have their work on the branch, which is a
    // different question from how many agents finished.
    expect(within(integratedFact()).getByText('1')).toBeInTheDocument();
  });

  it('reports one number when the requested concurrency was honoured', () => {
    panel({ isolation: ISOLATED });

    expect(within(concurrencyFact()).getByText('2')).toBeInTheDocument();
  });

  it('reports both numbers, and why, when the requested concurrency was not honoured', () => {
    // The answer to "why is this still running one task at a time". A reader who
    // saw only the configured 4 would plan around a number that never applied.
    panel({
      isolation: {
        ...SEQUENTIAL,
        parallelism: {
          requested: 4,
          effective: 1,
          clamped: true,
          reason: 'parallelism.maxTasks is 4, and task workspace isolation does not exist yet',
        },
      },
    });

    expect(within(concurrencyFact()).getByText('1 of 4')).toBeInTheDocument();
    expect(
      screen.getByText(/parallelism.maxTasks is 4, and task workspace isolation/),
    ).toBeInTheDocument();
  });

  it('does not repeat the clamp once the run has it on the record', () => {
    // Found by the parallel E2E, which could not address the sentence because it
    // was on screen twice: the header already renders the run's degradations, and
    // `parallelism_clamped` is one of them. Two copies of one sentence teaches a
    // reader to skip both.
    const reason = 'parallelism.maxTasks is 4, and task workspace isolation does not exist';

    panel({
      isolation: {
        ...SEQUENTIAL,
        parallelism: { requested: 4, effective: 1, clamped: true, reason },
      },
      degradations: 1,
      degradationDetail: [
        {
          kind: 'parallelism_clamped',
          reason,
          impact: 'implementation ran 1 task at a time rather than 4',
          detectedAt: '2026-08-10T19:40:00.000Z',
        },
      ],
    });

    expect(screen.getAllByText(reason)).toHaveLength(1);
    // The numbers stay, because they are the compact fact and the degradation list
    // does not carry them in the strip's form.
    expect(within(concurrencyFact()).getByText('1 of 4')).toBeInTheDocument();
  });

  it('says which of two disagreeing settings applies to this run', () => {
    // §21.4. Without this sentence the tool looks broken to the one user who did
    // exactly what the documentation said and then wondered why it had no effect.
    const note =
      'this run was created in worktree mode; your configuration now says ' +
      'useWorktrees: false — it does not apply to this run';

    panel({ isolation: { ...ISOLATED, note } });

    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('names the conflicting paths and the sibling that moved the head', () => {
    panel({
      isolation: ISOLATED,
      integrationConflicts: [
        {
          task: 'TASK-004',
          attempt: 1,
          paths: ['src/recurrence.ts', 'src/index.ts'],
          previouslyIntegrated: 'TASK-003',
        },
      ],
    });

    expect(
      screen.getByText('TASK-004 attempt 1 conflicted with the integration branch'),
    ).toBeInTheDocument();
    expect(screen.getByText('src/recurrence.ts, src/index.ts')).toBeInTheDocument();
    expect(screen.getByText(/TASK-003 integrated first and moved the head/)).toBeInTheDocument();
  });

  it('shows a conflict even on a run the server no longer calls isolated', () => {
    // A conflict is a recorded fact about what happened, and a run whose mode the
    // server could not resolve still had one. Omitting it because the mode came
    // back `legacy` would hide the only evidence of why the run halted.
    panel({
      isolation: { ...SEQUENTIAL, mode: 'legacy' },
      integrationConflicts: [{ task: 'TASK-002', attempt: 2, paths: ['src/a.ts'] }],
    });

    expect(
      screen.getByText('TASK-002 attempt 2 conflicted with the integration branch'),
    ).toBeInTheDocument();
  });

  it('renders no filesystem path, because it is handed none', () => {
    // §21.3 and §26.1 rule 4. The guarantee is structural — the read model has no
    // worktree path to give — and this is the assertion that would fail first if a
    // future field smuggled one in through `note` or a conflict path.
    panel({
      isolation: ISOLATED,
      integrationConflicts: [{ task: 'TASK-004', attempt: 1, paths: ['src/recurrence.ts'] }],
    });

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\/(Users|home|tmp|var)\//);
    expect(text).not.toMatch(/\.agent-flow\/worktrees/);
    expect(text).not.toMatch(/[A-Za-z]:\\/);
  });

  /** The `Tasks at once` pair, addressed through its own term. */
  const concurrencyFact = (): HTMLElement =>
    screen.getByText('Tasks at once').parentElement as HTMLElement;

  const integratedFact = (): HTMLElement =>
    screen.getByText('Integrated').parentElement as HTMLElement;
});
