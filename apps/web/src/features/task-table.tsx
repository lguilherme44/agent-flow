import { useMemo, type ReactNode } from 'react';
import { Maximize2, Minimize2, MoreVertical, Search, Wrench } from 'lucide-react';
import type { TaskSummaryView } from '@contracts/index.js';
import { Empty, Panel, SectionHeader, StatusDot, StripItem, cx } from '../components/ui';
import { formatDuration } from '../lib/format';
import { taskLabel, taskTone, TONE_BG, TONE_TEXT } from '../lib/status';
import { countTasks } from './run-overview';

export type StatusFilter = 'all' | 'completed' | 'running' | 'waiting' | 'failed';

export interface TaskFilter {
  readonly query: string;
  readonly status: StatusFilter;
}

export const NO_FILTER: TaskFilter = { query: '', status: 'all' };

export interface TaskTableProps {
  readonly tasks: TaskSummaryView[];
  readonly selectedId: string | undefined;
  readonly onSelect: (taskId: string) => void;
  readonly filter: TaskFilter;
  readonly onFilterChange: (filter: TaskFilter) => void;
  /** If true, the workspace is in expanded focus mode */
  readonly isFocusMode?: boolean;
  /** Action to toggle inline workspace focus mode */
  readonly onToggleFocusMode?: () => void;
  /**
   * Rendered in place of the table when the reader asked for the graph (§92).
   *
   * A slot rather than an import: the graph pulls in a rendering library, and the
   * panel — header, filters, counts — has no business knowing that exists.
   */
  readonly graph?: ReactNode;
}

export function TaskTable(props: TaskTableProps): JSX.Element {
  const { filter, onFilterChange } = props;
  const asGraph = props.graph !== undefined;

  const visible = useMemo(
    () => filterTasks(props.tasks, filter),
    [props.tasks, filter],
  );
  const counts = countTasks(props.tasks);

  return (
    <Panel
      // `flex-1` matters only when the inspector is not beside it — in graph
      // mode with nothing selected, where the panel is the sole flex child and
      // would otherwise size to its content and leave the rest of the row blank.
      className="min-w-0 flex-1"
      header={
        <>
          <SectionHeader title={asGraph ? 'Task dependencies' : 'Implementation tasks'}>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
              <label className="flex min-w-0 max-w-56 flex-1 items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 py-1">
                <Search className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                <span className="sr-only">Search tasks</span>
                <input
                  value={filter.query}
                  onChange={(changed) => {
                    onFilterChange({ ...filter, query: changed.target.value });
                  }}
                  placeholder="id, title or requirement"
                  className="w-full bg-transparent text-body-lg text-text placeholder:text-faint focus:outline-none"
                />
              </label>

              <div className="flex shrink-0 gap-px" role="group" aria-label="Filter by status">
                {(['all', 'running', 'waiting', 'completed', 'failed'] as const).map((option) => (
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

              {props.onToggleFocusMode ? (
                <button
                  type="button"
                  aria-label={props.isFocusMode ? 'Exit focus mode' : 'Expand workspace (Focus mode)'}
                  aria-pressed={props.isFocusMode}
                  title={props.isFocusMode ? 'Exit focus mode (Esc)' : 'Expand workspace (Focus mode)'}
                  onClick={props.onToggleFocusMode}
                  className={cx(
                    'flex h-7 items-center gap-1.5 rounded-sm border px-2 text-micro transition-colors',
                    props.isFocusMode
                      ? 'border-primary-border bg-primary-soft font-medium text-text'
                      : 'border-border bg-surface-2 text-muted hover:border-border-strong hover:text-text',
                  )}
                >
                  {props.isFocusMode ? (
                    <>
                      <Minimize2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>Restore</span>
                    </>
                  ) : (
                    <>
                      <Maximize2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>Focus</span>
                    </>
                  )}
                </button>
              ) : null}
            </div>
          </SectionHeader>

          <div className="flex items-stretch divide-x divide-border px-4 pb-3">
            <StripItem label="Total" value={counts.total} />
            <StripItem label="Completed" value={counts.completed} tone="success" />
            <StripItem label="Running" value={counts.running} tone="info" />
            <StripItem label="Waiting" value={counts.waiting} tone="warning" />
            <StripItem label="Failed" value={counts.failed} tone="danger" />
          </div>
        </>
      }
      divided
    >
      {/* The graph replaces the body, not the panel. Same header, same counts,
          same filter, same selection — one surface showing the tasks two ways,
          rather than two surfaces that could disagree about which one is open. */}
      {asGraph ? (
        props.graph
      ) : (
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
          // turned every task into "Cri…" — the one cell nobody can afford to
          // lose.
          <table className="w-full table-fixed border-collapse text-body">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border text-micro uppercase tracking-caps text-faint">
                <Th className="w-[108px] pl-4">ID</Th>
                <Th>Task</Th>
                {/* Dropped below 1280. The brief calls complexity discreet, and
                    it is the column the title can most afford to take back —
                    at 1200 the title was down to 84px, which reads "Criar en…". */}
                {/* 90, not 82. `tracking-caps` is 0.88px per character at 11px
                    against `tracking-wide`'s 0.275px, so "COMPLEXITY" grew to a
                    measured 89px of content inside a column sized for the old
                    tracking — it overflowed into "AGENT / MODEL" and the two
                    headers touched. The no-clipping guard cannot see this: a
                    `th` carries no `truncate`, so it has no `text-overflow` for
                    the guard to key on. */}
                <Th className="hidden w-[90px] xl:table-cell">Complexity</Th>
                {/* Runner, model and effort in one cell. Effort had its own
                    column and cost the title 64px it could not spare — and the
                    reference stacks all three anyway, because they are one fact
                    about how the task was executed. */}
                <Th className="w-[132px]">Agent / Model</Th>
                <Th className="w-[100px]">Status</Th>
                {/* 74, for the same reason as Complexity above: "DURATION"
                    measures 73px of content under `tracking-caps`. */}
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
                    // Keyboard reachable (§97): a table nobody can drive without
                    // a mouse is not navigable, whatever it looks like.
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
                      {/* The accent rail marks the selected row without needing
                          a border around it. */}
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
                          // The row shows a status chip further along, so this
                          // marker is decoration — a hidden label here would be
                          // read out twice.
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
                          {/* Titled, because this line genuinely may not fit:
                              a task covering five requirements, or a finding
                              type spelled out, is wider than the column at every
                              width. An ellipsis with nothing behind it reads as
                              deliberate; one with a tooltip is an abbreviation. */}
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
                      {/* Discreet on purpose: complexity drives routing, it is
                          not what anybody scans the table for. */}
                      <span className="rounded-sm border border-border px-1.5 py-px text-micro capitalize text-muted">
                        {task.complexity}
                      </span>
                    </Td>

                    <Td>
                      {/* Two lines, not three. The model is what people scan
                          for; the runner and the effort are the qualifier, and
                          a third line cost the table two visible rows. */}
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
                        <span
                          className={cx(
                            'inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-micro font-medium',
                            TONE_BG[tone],
                            TONE_TEXT[tone],
                          )}
                        >
                          {taskLabel(task.state)}
                        </span>
                        {/* §21.2's two derived facts, and the only place on this
                            screen where `running` is not the whole story.

                            "Awaiting merge" is the state `TaskState` has no name
                            for and the one a person watching a parallel run most
                            needs: the attempt is validated, its marker is not on
                            the integration branch, and `completed` would be a lie
                            until it is (I-3). It wins over the workspace note
                            because it is the later fact — the agent has already
                            exited — and because 84px of column holds one line.

                            Absent entirely in sequential mode, where the server
                            omits both: a run with no worktrees has no workspace to
                            report and nothing waiting to be merged. */}
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

                    {/* `text-label`, matching the same column in `RunsPage` and
                        for the same measured reason: `w-[64px]` was sized against
                        the longest real duration at 12px, and `formatDuration`
                        can return `12h34m`, which does not fit at 14px. No
                        fixture task runs that long, so the no-clipping guard has
                        nothing to catch here — which makes it the latent half of
                        a defect the `/runs` column exposed. */}
                    <Td className="tabular text-right text-label text-muted">
                      {formatDuration(task.durationMs)}
                    </Td>

                    <Td className="pr-2 text-right">
                      {/* A marker, not a menu. Per-task actions — retry, for now —
                          live in the inspector, where the log, the validation output
                          and the attempt count are already on screen: deciding to
                          retry without those is deciding blind. */}
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
      )}
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
