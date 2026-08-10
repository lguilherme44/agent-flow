import { AlertTriangle } from 'lucide-react';
import type {
  RunDetailView,
  StageViewResponse,
  TaskSummaryView,
} from '@contracts/index.js';
import { Progress, StatusDot, Tooltip, cx } from '../components/ui';
import { formatDuration, formatPercent, formatWhen, humanise } from '../lib/format';
import { TONE_BG, runLabel, runTone, stageTone } from '../lib/status';

/**
 * Run Header (§70) — what this run is, and how far it got.
 *
 * Duration is the run's own elapsed time as the server computed it. Recomputing
 * it in the browser from `createdAt` would tick upward forever on a run that
 * finished hours ago, because a stopped run has no clock.
 */
export function RunHeader(props: { run: RunDetailView }): JSX.Element {
  const { run } = props;

  return (
    <header className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="tabular text-body font-medium text-muted">{run.runId}</span>
            <StatusDot tone={runTone(run.status)} label={runLabel(run.status)} />
          </div>
          <h1 className="line-clamp-2 max-w-3xl text-title font-semibold" title={run.feature}>
            {run.feature}
          </h1>
        </div>

        <dl className="flex shrink-0 gap-6">
          <Fact label="Started" value={formatWhen(run.startedAt)} />
          <Fact label="Duration" value={formatDuration(run.durationMs)} />
          <Fact label="Tasks" value={`${String(run.completedTasks)} / ${String(run.taskCount)}`} />
        </dl>
      </div>

      <div className="flex items-center gap-3">
        <Progress value={run.progress} label="Overall progress" className="flex-1" />
        <span className="tabular w-10 shrink-0 text-right text-label text-muted">
          {formatPercent(run.progress)}
        </span>
      </div>

      {/* Degradations are not a footnote. A run that reviewed itself, ran below
          its configured effort, or had its gate forced reached its verdict on
          weaker terms, and this is where somebody is reading the verdict. */}
      {run.degradationDetail.length === 0 ? null : (
        <ul className="flex flex-col gap-1 rounded-sm border border-warning/30 bg-warning-soft p-2">
          {run.degradationDetail.map((degradation) => (
            <li key={`${degradation.kind}:${degradation.reason}`} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              <div className="flex flex-col">
                <span className="text-label text-text">{degradation.reason}</span>
                <span className="text-label text-muted">{degradation.impact}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function Fact(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-label uppercase tracking-wide text-faint">{props.label}</dt>
      <dd className="tabular text-body text-text">{props.value}</dd>
    </div>
  );
}

/**
 * The horizontal pipeline (§71).
 *
 * Nine stages, including approval, which is a step in the workflow but not a
 * `RunStage` — the server decides that, from the run's own record. Nothing here
 * infers a status; a display that computed stage state would be a second state
 * machine, and it would be the wrong one.
 */
export function StagePipeline(props: { stages: StageViewResponse[] }): JSX.Element {
  return (
    <ol
      className="flex items-stretch gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-2"
      aria-label="Pipeline"
    >
      {props.stages.map((stage) => {
        const tone = stageTone(stage.status);
        const detail = [
          stage.runner === undefined ? undefined : `runner ${stage.runner}`,
          stage.model === undefined ? undefined : `model ${stage.model}`,
          stage.reasoning === undefined ? undefined : `effort ${stage.reasoning}`,
          stage.attempts === undefined || stage.attempts <= 1
            ? undefined
            : `${String(stage.attempts)} attempts`,
          stage.errorCode === undefined ? undefined : `error ${stage.errorCode}`,
        ].filter((value): value is string => value !== undefined);

        return (
          <li key={stage.stage} className="min-w-0 flex-1">
            <Tooltip
              content={
                detail.length === 0 ? (
                  <span>{humanise(stage.stage)} — {stage.status.replace(/_/g, ' ')}</span>
                ) : (
                  <span>{detail.join(' · ')}</span>
                )
              }
            >
              <div
                className={cx(
                  'flex h-full min-w-0 cursor-default flex-col gap-1 rounded-sm border px-2 py-1.5',
                  'border-transparent',
                  TONE_BG[tone],
                )}
              >
                <StatusDot
                  tone={tone}
                  label={stage.status.replace(/_/g, ' ')}
                  showLabel={false}
                  spin={stage.status === 'running'}
                />
                <span className="truncate text-label text-text" title={humanise(stage.stage)}>
                  {humanise(stage.stage)}
                </span>
                <span className="tabular text-label text-faint">
                  {stage.durationMs === undefined ? '—' : formatDuration(stage.durationMs)}
                </span>
              </div>
            </Tooltip>
          </li>
        );
      })}
    </ol>
  );
}

/** Task Metrics (§72), counted from the states the run actually holds. */
export function TaskMetrics(props: { tasks: TaskSummaryView[] }): JSX.Element {
  const counts = countTasks(props.tasks);

  const cells: { label: string; value: number; tone?: string }[] = [
    { label: 'Total', value: counts.total },
    { label: 'Completed', value: counts.completed },
    { label: 'Running', value: counts.running },
    { label: 'Waiting', value: counts.waiting },
    { label: 'Failed', value: counts.failed },
  ];

  return (
    <div className="grid grid-cols-5 gap-2">
      {cells.map((cell) => (
        <div
          key={cell.label}
          className="flex flex-col gap-0.5 rounded-md border border-border bg-surface px-3 py-2"
        >
          <span className="text-label uppercase tracking-wide text-faint">{cell.label}</span>
          <span className="tabular text-metric font-semibold">{cell.value}</span>
        </div>
      ))}
    </div>
  );
}

export interface TaskCounts {
  total: number;
  completed: number;
  running: number;
  waiting: number;
  failed: number;
}

/**
 * The five numbers of §72.
 *
 * `waiting` deliberately gathers everything that is neither done, moving, nor
 * broken — queued, ready, blocked, needing review. A run stalled on a blocked
 * task is waiting for a person, and putting that in its own column would leave
 * the top row summing to less than the total.
 */
export function countTasks(tasks: readonly TaskSummaryView[]): TaskCounts {
  const counts: TaskCounts = { total: tasks.length, completed: 0, running: 0, waiting: 0, failed: 0 };

  for (const task of tasks) {
    switch (task.state) {
      case 'completed':
        counts.completed += 1;
        break;
      case 'running':
        counts.running += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      default:
        counts.waiting += 1;
    }
  }

  return counts;
}
