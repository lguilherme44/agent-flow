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
import { RunHeader, RunPanel, StagePipeline, countTasks } from './run-overview';

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
    render(withTooltips(<RunHeader run={run()} projectId="demo" asGraph={false} onToggleGraph={() => undefined} />));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AF-2026-001');
    expect(screen.getByText('Add weekly recurrence')).toBeInTheDocument();
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText('7 / 14')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('uses the duration the server computed', () => {
    // Recomputing from `createdAt` in the browser would tick upward forever on
    // a run that finished hours ago — a stopped run has no clock.
    render(
      withTooltips(
        <RunHeader run={run({ status: 'completed', durationMs: 2_482_000 })} projectId="demo" asGraph={false} onToggleGraph={() => undefined} />,
      ),
    );

    expect(screen.getByText('41m22s')).toBeInTheDocument();
  });

  it('offers the actions the run is actually at, and disables only what is absent', () => {
    // An approved run mid-execution: it can be resumed and it can be revised. It
    // cannot be approved again, and it is not offered a Reject button, because a
    // control whose only outcome is a refusal teaches people to ignore refusals.
    render(withTooltips(<RunHeader run={run({ approved: true })} projectId="demo" asGraph={false} onToggleGraph={() => undefined} />));

    expect(screen.getByRole('button', { name: 'Resume run' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Revise' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();

    // Real as of UI-28, and a toggle rather than a link: the graph is another
    // rendering of the task list on this page, not a place to go.
    const graph = screen.getByRole('button', { name: 'View as DAG' });
    expect(graph).toBeEnabled();
    expect(graph).toHaveAttribute('aria-pressed', 'false');

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
          run={run({ status: 'approved', approved: true, progress: 100 })}
          projectId="demo"
          asGraph={false}
          onToggleGraph={() => undefined}
        />,
      ),
    );

    expect(screen.queryByRole('button', { name: 'Review & approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: /run$/ })).toBeNull();
    // Revising is still legitimate: a new plan reopens the gate.
    expect(screen.getByRole('button', { name: 'Revise' })).toBeEnabled();
  });

  it('asks for approval before it offers to start', () => {
    render(withTooltips(<RunHeader run={run({ approved: false, progress: 0 })} projectId="demo" asGraph={false} onToggleGraph={() => undefined} />));

    expect(screen.getByRole('button', { name: 'Review & approve' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /run$/ })).toBeNull();
    // Rejecting is offered while the plan is still up for judgement, and not after.
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('offers nothing to change on a finished run', () => {
    render(
      withTooltips(
        <RunHeader run={run({ status: 'completed', approved: true, progress: 100 })} projectId="demo" asGraph={false} onToggleGraph={() => undefined} />,
      ),
    );

    for (const name of ['Review & approve', 'Resume run', 'Start run', 'Revise', 'Reject']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('puts a degradation where the verdict is read, not in a log', () => {
    render(
      withTooltips(
        <RunHeader
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
          asGraph={false}
          onToggleGraph={() => undefined}
        />,
      ),
    );

    expect(screen.getByText('the plan was approved with --force')).toBeInTheDocument();
    expect(screen.getByText('the review gate did not hold for this run')).toBeInTheDocument();
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

describe('RunPanel', () => {
  it('is one surface holding the run and its pipeline', () => {
    // The composition change that matters: header and pipeline answer one
    // question together, and two bordered cards read as two unrelated widgets.
    const { container } = render(withTooltips(<RunPanel run={run()} stages={STAGES} projectId="demo" asGraph={false} onToggleGraph={() => undefined} />));

    const panel = container.querySelector('section');
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByRole('heading', { level: 1 })).toHaveTextContent(
      'AF-2026-001',
    );
    expect(within(panel as HTMLElement).getByRole('list', { name: 'Pipeline' })).toBeInTheDocument();
  });

  it('renders without a pipeline the server has not produced yet', () => {
    render(withTooltips(<RunPanel run={run()} stages={undefined} projectId="demo" asGraph={false} onToggleGraph={() => undefined} />));

    expect(screen.queryByRole('list', { name: 'Pipeline' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});

/**
 * M2-10 — §21.2's facts, and §21.3's silences.
 *
 * These are behaviour tests rather than snapshots on purpose: what matters is
 * *which* runs get told about isolation and which are left alone, and a snapshot
 * would pass whichever of those it happened to record.
 */
describe('the isolation strip', () => {
  const panel = (overrides: Partial<RunDetailView>): void => {
    render(
      withTooltips(
        <RunPanel
          run={run(overrides)}
          stages={undefined}
          projectId="demo"
          asGraph={false}
          onToggleGraph={() => undefined}
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
