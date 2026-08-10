import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type {
  RunDetailView,
  StageViewResponse,
  TaskSummaryView,
} from '@contracts/index.js';
import { RunHeader, StagePipeline, TaskMetrics, countTasks } from './run-overview';

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
  ...overrides,
});

const withTooltips = (node: JSX.Element): JSX.Element => (
  <TooltipPrimitive.Provider>{node}</TooltipPrimitive.Provider>
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
    // top row would silently add up to less than the number beside it.
    const counts = countTasks(
      of(['completed', 'running', 'queued', 'ready', 'blocked', 'review_required', 'failed', 'interrupted']),
    );

    expect(counts.completed + counts.running + counts.waiting + counts.failed).toBe(
      counts.total,
    );
  });

  it('counts a blocked task as waiting, because it waits for a person', () => {
    expect(countTasks(of(['blocked', 'review_required'])).waiting).toBe(2);
  });
});

describe('RunHeader', () => {
  it('shows the run, its status and its progress', () => {
    render(<RunHeader run={run()} />);

    expect(screen.getByText('AF-2026-001')).toBeInTheDocument();
    expect(screen.getByText('Add weekly recurrence')).toBeInTheDocument();
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText('7 / 14')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('uses the duration the server computed', () => {
    // Recomputing from `createdAt` in the browser would tick upward forever on
    // a run that finished hours ago — a stopped run has no clock.
    render(<RunHeader run={run({ status: 'completed', durationMs: 2_482_000 })} />);

    expect(screen.getByText('41m22s')).toBeInTheDocument();
  });

  it('puts a degradation where the verdict is read, not in a log', () => {
    render(
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
      />,
    );

    expect(screen.getByText('the plan was approved with --force')).toBeInTheDocument();
    expect(screen.getByText('the review gate did not hold for this run')).toBeInTheDocument();
  });
});

describe('StagePipeline', () => {
  const stages: StageViewResponse[] = [
    {
      stage: 'discovery',
      status: 'completed',
      runner: 'claude',
      durationMs: 149_467,
      startedAt: '2026-08-10T19:34:00.000Z',
      finishedAt: '2026-08-10T19:36:29.000Z',
    },
    { stage: 'architecture-impact', status: 'completed', runner: 'claude' },
    { stage: 'sdd', status: 'running' },
    { stage: 'planning', status: 'pending' },
    { stage: 'plan-review', status: 'pending' },
    { stage: 'approval', status: 'waiting_approval' },
    { stage: 'implementation', status: 'pending' },
    { stage: 'verification', status: 'pending' },
    { stage: 'final-review', status: 'failed', errorCode: 'timeout' },
  ];

  it('renders all nine stages, approval included', () => {
    render(withTooltips(<StagePipeline stages={stages} />));

    expect(screen.getByRole('list', { name: 'Pipeline' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(screen.getByText('Approval')).toBeInTheDocument();
  });

  it('names each stage in words rather than by colour alone', () => {
    render(withTooltips(<StagePipeline stages={stages} />));

    expect(screen.getByText('Architecture Impact')).toBeInTheDocument();
    expect(screen.getByText('Final Review')).toBeInTheDocument();
  });

  it('shows the duration a stage actually took', () => {
    render(withTooltips(<StagePipeline stages={stages} />));

    expect(screen.getByText('2m29s')).toBeInTheDocument();
  });
});

describe('TaskMetrics', () => {
  it('shows the five numbers of §72', () => {
    const tasks: TaskSummaryView[] = [
      { id: 'TASK-001', title: 't', complexity: 'normal', risk: 'low', state: 'completed', attempts: 1, requirements: [], dependencies: [] },
      { id: 'TASK-002', title: 't', complexity: 'normal', risk: 'low', state: 'running', attempts: 1, requirements: [], dependencies: [] },
      { id: 'TASK-003', title: 't', complexity: 'normal', risk: 'low', state: 'queued', attempts: 0, requirements: [], dependencies: [] },
    ];

    render(<TaskMetrics tasks={tasks} />);

    for (const label of ['Total', 'Completed', 'Running', 'Waiting', 'Failed']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
