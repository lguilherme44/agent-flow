import { useMemo, type ReactNode } from 'react';
import { MoreVertical, Search, Wrench } from 'lucide-react';
import type { TaskSummaryView } from '@contracts/index.js';
import { Badge, Empty, Panel, StatusDot, StripItem, cx } from '../components/ui';
import { formatDuration } from '../lib/format';
import { taskLabel, taskTone } from '../lib/status';
import { countTasks } from './run-overview';

export type StatusFilter = 'all' | 'completed' | 'running' | 'waiting' | 'failed';

export interface TaskFilter {
  readonly query: string;
  readonly status: StatusFilter;
}

export const NO_FILTER: TaskFilter = { query: '', status: 'all' };

const STATUS_OPTIONS = ['all', 'running', 'waiting', 'completed', 'failed'] as const;

/**
 * The filter, in the tab strip (M8.5 §20).
 *
 * **One filter, three surfaces.** The board, the graph and the table are three renderings
 * of one task list, and narrowing one while the others show everything would be three
 * answers to the question the filter asks. It used to live in a panel header that only
 * one of them had; now it lives beside the tabs, which is the one place all three can see
 * it.
 *
 * Chips rather than a dropdown, and that is an interaction-cost decision rather than a
 * visual one: `failed` is one click here and two behind a select, and it is the option
 * somebody reaches for when something is wrong. §20 allows either; the lighter treatment
 * is what makes five of them acceptable — no borders, no fills except on the active one.
 */
export function TaskToolbar(props: {
  filter: TaskFilter;
  onFilterChange: (filter: TaskFilter) => void;
}): JSX.Element {
  const { filter, onFilterChange } = props;

  return (
    <>
      <label className="flex min-w-0 max-w-52 flex-1 items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 py-1">
        <Search className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        <span className="sr-only">Search tasks</span>
        <input
          value={filter.query}
          onChange={(changed) => {
            onFilterChange({ ...filter, query: changed.target.value });
          }}
          placeholder="id, title or requirement"
          className="w-full bg-transparent text-label text-text placeholder:text-faint focus:outline-none"
        />
      </label>

      {/* `shrink-0` keeps the five chips on one line, which is right at every width the
          desktop layout covers and wrong at 390: the group is 190px in a row that has
          already given its space to the search box, so `failed` was cut to `F`. A filter
          you cannot read the name of is a filter nobody uses. */}
      <div className="flex shrink-0 gap-px max-lg:shrink max-lg:flex-wrap" role="group" aria-label="Filter by status">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter.status === option}
            onClick={() => {
              onFilterChange({ ...filter, status: option });
            }}
            className={cx(
              'rounded-sm px-1.5 py-0.5 text-micro capitalize',
              filter.status === option
                ? 'bg-primary-soft font-medium text-text'
                : 'text-faint hover:bg-surface-2 hover:text-text',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </>
  );
}

export interface TaskTableProps {
  readonly tasks: TaskSummaryView[];
  readonly selectedId: string | undefined;
  readonly onSelect: (taskId: string) => void;
  readonly filter: TaskFilter;
}

/**
 * The task table (§72), now on a tab of its own.
 *
 * **The header it used to carry is gone, and so is the reason it carried one.** The panel
 * announced itself ("Implementation tasks" / "Task board" / "Task dependencies"), held the
 * search box and the five status chips, and stacked a five-count strip under all of it —
 * about 100 pixels of chrome that the board inherited by sharing the panel. On the board
 * that strip was also the *second* statement of the same numbers: `TOTAL 9 · COMPLETED 3 ·
 * RUNNING 2 · WAITING 4 · FAILED 0` sat directly above lane badges reading `BACKLOG 4 ·
 * READY 0 · IN PROGRESS 2 · REVIEW 0 · BLOCKED 0 · DONE 3` — one run, two partitions, and
 * the run header saying `3/9` a third time.
 *
 * The tab strip names the surface, the toolbar holds the filter, and the strip stays here
 * — on the one surface where nothing else counts the tasks.
 */
export function TaskTable(props: TaskTableProps): JSX.Element {
  const visible = useMemo(
    () => filterTasks(props.tasks, props.filter),
    [props.tasks, props.filter],
  );
  const counts = countTasks(props.tasks);

  return (
    <Panel
      className="min-w-0 flex-1"
      divided
      header={
        /* Five counts and four hairlines need 400px; at 390 `FAILED` fell off the end.
           Wrapping keeps every count on screen — and a count that is not on screen is the
           one an operator was looking for, since `failed` is last. */
        <div className="flex items-stretch divide-x divide-border px-4 py-2.5 max-lg:flex-wrap max-lg:gap-y-2 max-lg:divide-x-0">
          <StripItem label="Total" value={counts.total} />
          <StripItem label="Completed" value={counts.completed} tone="success" />
          <StripItem label="Running" value={counts.running} tone="info" />
          <StripItem label="Waiting" value={counts.waiting} tone="warning" />
          <StripItem label="Failed" value={counts.failed} tone="danger" />
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <Empty
            title={props.tasks.length === 0 ? 'No tasks yet.' : 'Nothing matches this filter.'}
            hint={
              props.tasks.length === 0
                ? 'A plan produces tasks once planning finishes.'
                : undefined
            }
          />
        ) : (
          // Fixed layout, and Task is the only column without a width. The auto
          // algorithm gave the title 40px and the fixed columns the rest, which
          // turned every task into "Cri…" — the one cell nobody can afford to lose.
          <table className="w-full table-fixed border-collapse text-body">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border text-micro uppercase tracking-caps text-faint">
                <Th className="w-[108px] pl-4">ID</Th>
                <Th>Task</Th>
                {/* Dropped below 1280. The brief calls complexity discreet, and it is the
                    column the title can most afford to take back — at 1200 the title was
                    down to 84px, which reads "Criar en…".

                    90, not 82: `tracking-caps` is 0.88px per character at 11px against
                    `tracking-wide`'s 0.275px, so "COMPLEXITY" grew to a measured 89px of
                    content inside a column sized for the old tracking — it overflowed into
                    "AGENT / MODEL" and the two headers touched. The no-clipping guard
                    cannot see this: a `th` carries no `truncate`, so it has no
                    `text-overflow` for the guard to key on. */}
                <Th className="hidden w-[90px] xl:table-cell">Complexity</Th>
                {/* Runner, model and effort in one cell. Effort had its own column and cost
                    the title 64px it could not spare — and the reference stacks all three
                    anyway, because they are one fact about how the task was executed. */}
                <Th className="w-[132px]">Agent / Model</Th>
                <Th className="w-[100px]">Status</Th>
                {/* 74, for the same reason as Complexity above: "DURATION" measures 73px of
                    content under `tracking-caps`. */}
                <Th className="w-[74px] text-right">Duration</Th>
                <Th className="w-7 pr-2 text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const selected = task.id === props.selectedId;
                const tone = taskTone(task.state);

                return (
                  <tr
                    key={task.id}
                    onClick={() => {
                      props.onSelect(task.id);
                    }}
                    // Keyboard reachable (§97): a table nobody can drive without a mouse is
                    // not navigable, whatever it looks like.
                    tabIndex={0}
                    onKeyDown={(pressed) => {
                      if (pressed.key === 'Enter' || pressed.key === ' ') {
                        pressed.preventDefault();
                        props.onSelect(task.id);
                      }
                    }}
                    aria-selected={selected}
                    className={cx(
                      'cursor-pointer border-b border-border/70',
                      selected ? 'bg-primary-soft' : 'hover:bg-surface-2',
                    )}
                  >
                    <Td className="pl-4">
                      {/* The accent rail marks the selected row without needing a border
                          around it. */}
                      <span className="relative flex items-center gap-2">
                        {selected ? (
                          <span
                            className="absolute -left-4 h-6 w-0.5 rounded-r bg-primary-bright"
                            aria-hidden
                          />
                        ) : null}
                        <StatusDot
                          tone={tone}
                          label={taskLabel(task.state)}
                          // The row shows a status chip further along, so this marker is
                          // decoration — a hidden label here would be read out twice.
                          decorative
                          solid={task.state === 'completed'}
                          spin={task.state === 'running'}
                        />
                        <span className="tabular whitespace-nowrap text-body-lg font-medium">
                          {task.id}
                        </span>
                      </span>
                    </Td>

                    <Td>
                      <span className="flex min-w-0 items-center gap-1.5">
                        {task.correctiveFor === undefined ? null : (
                          <Wrench
                            className="h-3 w-3 shrink-0 text-warning"
                            aria-label="corrective task"
                          />
                        )}
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-body-lg text-text" title={task.title}>
                            {task.title}
                          </span>
                          {/* Titled, because this line genuinely may not fit: a task
                              covering five requirements, or a finding type spelled out, is
                              wider than the column at every width. An ellipsis with nothing
                              behind it reads as deliberate; one with a tooltip is an
                              abbreviation. */}
                          <span
                            className="truncate text-micro text-faint"
                            title={
                              task.correctiveFor === undefined
                                ? task.requirements.join(', ') || 'no requirement'
                                : `from a ${task.correctiveFor.findingType} finding in ${task.correctiveFor.stage.replace(/-/g, ' ')}`
                            }
                          >
                            {task.correctiveFor === undefined
                              ? task.requirements.join(', ') || 'no requirement'
                              : `from a ${task.correctiveFor.findingType} finding`}
                          </span>
                        </span>
                      </span>
                    </Td>

                    <Td className="hidden xl:table-cell">
                      {/* Discreet on purpose: complexity drives routing, it is not what
                          anybody scans the table for. */}
                      <span className="rounded-sm border border-border px-1.5 py-px text-micro capitalize text-muted">
                        {task.complexity}
                      </span>
                    </Td>

                    <Td>
                      {/* Two lines, not three. The model is what people scan for; the runner
                          and the effort are the qualifier, and a third line cost the table
                          two visible rows. */}
                      <span className="flex min-w-0 flex-col">
                        <span
                          className="truncate text-body-lg text-text"
                          title={task.model ?? 'model not reported'}
                        >
                          {task.model ?? 'no model'}
                        </span>
                        <span className="truncate text-micro capitalize text-faint">
                          {task.runner ?? '—'}
                          {task.reasoning === undefined ? '' : ` · ${task.reasoning}`}
                        </span>
                      </span>
                    </Td>

                    <Td>
                      <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <Badge tone={tone}>{taskLabel(task.state)}</Badge>
                        {/* §21.2's two derived facts, and the only place on this screen
                            where `running` is not the whole story.

                            "Awaiting merge" is the state `TaskState` has no name for and
                            the one a person watching a parallel run most needs: the attempt
                            is validated, its marker is not on the integration branch, and
                            `completed` would be a lie until it is (I-3). It wins over the
                            workspace note because it is the later fact — the agent has
                            already exited — and because 84px of column holds one line.

                            Absent entirely in sequential mode, where the server omits both:
                            a run with no worktrees has no workspace to report and nothing
                            waiting to be merged. */}
                        {task.awaitingIntegration === true ? (
                          <span className="whitespace-nowrap text-micro text-warning">
                            awaiting merge
                          </span>
                        ) : task.workspaceActive === true ? (
                          <span className="whitespace-nowrap text-micro text-faint">
                            in worktree
                          </span>
                        ) : null}
                      </span>
                    </Td>

                    {/* `text-label`, matching the same column in `RunsPage` and for the same
                        measured reason: `w-[64px]` was sized against the longest real
                        duration at 12px, and `formatDuration` can return `12h34m`, which
                        does not fit at 14px. No fixture task runs that long, so the
                        no-clipping guard has nothing to catch here — which makes it the
                        latent half of a defect the `/runs` column exposed. */}
                    <Td className="tabular text-right text-label text-muted">
                      {formatDuration(task.durationMs)}
                    </Td>

                    <Td className="pr-2 text-right">
                      {/* A marker, not a menu. Per-task actions — retry, for now — live in
                          the inspector, where the log, the validation output and the attempt
                          count are already on screen: deciding to retry without those is
                          deciding blind. */}
                      <span
                        className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-faint opacity-50"
                        title="Open the task to retry it"
                        aria-hidden
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function Th(props: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <th scope="col" className={cx('px-2 py-1.5 text-left font-medium', props.className)}>
      {props.children}
    </th>
  );
}

function Td(props: {
  children: ReactNode;
  className?: string;
  title?: string | undefined;
}): JSX.Element {
  return (
    <td className={cx('px-2 py-2.5', props.className)} title={props.title}>
      {props.children}
    </td>
  );
}

/**
 * Search covers id, title and requirement (§72).
 *
 * Requirement matters more than it looks: "which task covers FR-004" is the
 * question a coverage argument turns on, and answering it by reading every row
 * is exactly what the search box is for.
 */
export function filterTasks(
  tasks: readonly TaskSummaryView[],
  filter: TaskFilter,
): TaskSummaryView[] {
  const needle = filter.query.trim().toLowerCase();

  return tasks.filter((task) => {
    if (!matchesStatus(task, filter.status)) return false;
    if (needle === '') return true;

    return (
      task.id.toLowerCase().includes(needle) ||
      task.title.toLowerCase().includes(needle) ||
      task.requirements.some((requirement) => requirement.toLowerCase().includes(needle))
    );
  });
}

function matchesStatus(task: TaskSummaryView, status: StatusFilter): boolean {
  switch (status) {
    case 'all':
      return true;
    case 'completed':
      return task.state === 'completed';
    case 'running':
      return task.state === 'running';
    case 'failed':
      return task.state === 'failed';
    case 'waiting':
      // Everything that is neither done, moving, nor broken — the same grouping
      // the strip uses, so the number and the filter agree.
      return !['completed', 'running', 'failed'].includes(task.state);
  }
}
