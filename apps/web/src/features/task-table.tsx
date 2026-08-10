import { useMemo, useState, type ReactNode } from 'react';
import { Search, Wrench } from 'lucide-react';
import type { TaskSummaryView } from '@contracts/index.js';
import { Empty, StatusDot, cx } from '../components/ui';
import { formatDuration } from '../lib/format';
import { taskLabel, taskTone } from '../lib/status';

/**
 * Task Table (§72).
 *
 * Filters and search are local state — they belong to this browser tab, and
 * nothing on the server has an opinion about them. What is *displayed* is
 * whatever the query cache last got from the server, unfiltered by anything the
 * client decided about task state.
 */

export type StatusFilter = 'all' | 'completed' | 'running' | 'waiting' | 'failed';

export interface TaskTableProps {
  readonly tasks: TaskSummaryView[];
  readonly selectedId: string | undefined;
  readonly onSelect: (taskId: string) => void;
}

export function TaskTable(props: TaskTableProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const visible = useMemo(
    () => filterTasks(props.tasks, { query, status }),
    [props.tasks, query, status],
  );

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          <span className="sr-only">Search tasks</span>
          <input
            value={query}
            onChange={(changed) => {
              setQuery(changed.target.value);
            }}
            placeholder="id, title or requirement"
            className="w-full bg-transparent text-body text-text placeholder:text-faint focus:outline-none"
          />
        </label>

        <div className="flex shrink-0 gap-0.5" role="group" aria-label="Filter by status">
          {(['all', 'running', 'waiting', 'completed', 'failed'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={status === option}
              onClick={() => {
                setStatus(option);
              }}
              className={cx(
                'rounded-sm px-1.5 py-0.5 text-label capitalize',
                status === option
                  ? 'bg-primary-soft text-text'
                  : 'text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

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
          <table className="w-full border-collapse text-body">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border text-label uppercase tracking-wide text-faint">
                <Th className="w-20">ID</Th>
                <Th>Task</Th>
                <Th className="w-24">Complexity</Th>
                <Th className="w-32">Agent</Th>
                <Th className="w-28">Status</Th>
                <Th className="w-20 text-right">Duration</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const selected = task.id === props.selectedId;
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
                      'cursor-pointer border-b border-border/60',
                      selected ? 'bg-primary-soft' : 'hover:bg-surface-2',
                    )}
                  >
                    <Td className="tabular whitespace-nowrap font-medium">
                      <span className="flex items-center gap-1">
                        {task.correctiveFor === undefined ? null : (
                          <Wrench
                            className="h-3 w-3 shrink-0 text-warning"
                            aria-label="corrective task"
                          />
                        )}
                        {task.id}
                      </span>
                    </Td>
                    <Td className="max-w-0">
                      <span className="block truncate" title={task.title}>
                        {task.title}
                      </span>
                    </Td>
                    <Td className="capitalize text-muted">{task.complexity}</Td>
                    <Td className="truncate text-muted" title={task.model ?? task.runner}>
                      {task.runner ?? '—'}
                    </Td>
                    <Td>
                      <StatusDot
                        tone={taskTone(task.state)}
                        label={taskLabel(task.state)}
                        spin={task.state === 'running'}
                      />
                    </Td>
                    <Td className="tabular text-right text-muted">
                      {formatDuration(task.durationMs)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Th(props: { children: string; className?: string }): JSX.Element {
  return (
    <th scope="col" className={cx('px-3 py-1.5 text-left font-medium', props.className)}>
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
    <td className={cx('px-3 py-1.5', props.className)} title={props.title}>
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
  filter: { query: string; status: StatusFilter },
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
      // the metric row uses, so the number and the filter agree.
      return !['completed', 'running', 'failed'].includes(task.state);
  }
}
