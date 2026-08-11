import { describe, it, expect, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskSummaryView } from '@contracts/index.js';
import { NO_FILTER, TaskTable, filterTasks, type TaskFilter } from './task-table';
import { countTasks } from './run-overview';

/**
 * The filter belongs to the page now, because the graph shares it (UI-28).
 *
 * This holds it so the panel can still be driven the way a person drives it —
 * type, click, see fewer rows — rather than asserted against a prop.
 */
function Table(props: {
  tasks: TaskSummaryView[];
  selectedId?: string;
  onSelect?: (taskId: string) => void;
  graph?: ReactNode;
}): JSX.Element {
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);

  return (
    <TaskTable
      tasks={props.tasks}
      selectedId={props.selectedId}
      onSelect={props.onSelect ?? (() => undefined)}
      filter={filter}
      onFilterChange={setFilter}
      {...(props.graph === undefined ? {} : { graph: props.graph })}
    />
  );
}

const task = (overrides: Partial<TaskSummaryView> = {}): TaskSummaryView => ({
  id: 'TASK-001',
  title: 'Add recurrence types',
  complexity: 'trivial',
  risk: 'low',
  state: 'completed',
  attempts: 1,
  requirements: ['FR-001'],
  dependencies: [],
  ...overrides,
});

const TASKS: TaskSummaryView[] = [
  task({ id: 'TASK-001', state: 'completed', runner: 'codex', durationMs: 62_000 }),
  task({ id: 'TASK-002', title: 'Implement generation', state: 'running', runner: 'codex' }),
  task({ id: 'TASK-003', title: 'Wire it up', state: 'blocked', requirements: ['FR-004'] }),
  task({ id: 'TASK-004', title: 'Break it', state: 'failed' }),
  task({
    id: 'FIX-001',
    title: 'Redact the token',
    state: 'queued',
    requirements: [],
    correctiveFor: { stage: 'final-review', findingType: 'security' },
  }),
];

describe('filterTasks', () => {
  it('searches id, title and requirement', () => {
    // Requirement matters more than it looks: "which task covers FR-004" is the
    // question a coverage argument turns on.
    const byId = filterTasks(TASKS, { query: 'fix-001', status: 'all' });
    const byTitle = filterTasks(TASKS, { query: 'generation', status: 'all' });
    const byRequirement = filterTasks(TASKS, { query: 'FR-004', status: 'all' });

    expect(byId.map((entry) => entry.id)).toEqual(['FIX-001']);
    expect(byTitle.map((entry) => entry.id)).toEqual(['TASK-002']);
    expect(byRequirement.map((entry) => entry.id)).toEqual(['TASK-003']);
  });

  it('groups waiting the same way the metric row counts it', () => {
    // If the filter and the number disagreed, one of them would be lying about
    // the same set of tasks.
    const waiting = filterTasks(TASKS, { query: '', status: 'waiting' });

    expect(waiting.map((entry) => entry.id)).toEqual(['TASK-003', 'FIX-001']);
    expect(waiting).toHaveLength(countTasks(TASKS).waiting);
  });

  it('keeps everything when nothing is asked', () => {
    expect(filterTasks(TASKS, { query: '   ', status: 'all' })).toHaveLength(TASKS.length);
  });
});

describe('TaskTable', () => {
  it('renders a row per task with its status in words', () => {
    render(<Table tasks={TASKS} />);

    // Status is text as well as colour (§97): a greyscale screenshot and a
    // colour-blind reader must get the same answer.
    expect(screen.getByText('TASK-001')).toBeInTheDocument();
    expect(screen.getAllByText('COMPLETED').length).toBeGreaterThan(0);
    expect(screen.getByText('BLOCKED')).toBeInTheDocument();
  });

  it('marks a corrective task as one', () => {
    render(<Table tasks={TASKS} />);

    expect(screen.getByLabelText('corrective task')).toBeInTheDocument();
  });

  it('selects on click', async () => {
    const onSelect = vi.fn();
    render(<Table tasks={TASKS} onSelect={onSelect} />);

    await userEvent.click(screen.getByText('Implement generation'));

    expect(onSelect).toHaveBeenCalledWith('TASK-002');
  });

  it('selects from the keyboard', async () => {
    // A table nobody can drive without a mouse is not navigable, whatever it
    // looks like (§97).
    const onSelect = vi.fn();
    render(<Table tasks={TASKS} onSelect={onSelect} />);

    const row = screen.getByText('Implement generation').closest('tr');
    row?.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('TASK-002');
  });

  it('filters by status from the toolbar', async () => {
    render(<Table tasks={TASKS} />);

    await userEvent.click(screen.getByRole('button', { name: 'failed' }));

    const body = screen.getAllByRole('rowgroup')[1];
    expect(within(body as HTMLElement).getAllByRole('row')).toHaveLength(1);
    expect(screen.getByText('Break it')).toBeInTheDocument();
  });

  it('searches as you type', async () => {
    render(<Table tasks={TASKS} />);

    await userEvent.type(screen.getByLabelText('Search tasks'), 'redact');

    expect(screen.getByText('Redact the token')).toBeInTheDocument();
    expect(screen.queryByText('Break it')).not.toBeInTheDocument();
  });

  it('says so when a filter matches nothing', () => {
    render(<Table tasks={[]} />);

    expect(screen.getByText('No tasks yet.')).toBeInTheDocument();
  });

  it('swaps the body for the graph and keeps the header (UI-28)', () => {
    // The graph replaces the rows, not the panel. Same search box, same status
    // filter, same counts — one surface showing the tasks two ways rather than
    // two surfaces that could disagree about which tasks they are showing.
    render(<Table tasks={TASKS} graph={<p>the graph</p>} />);

    expect(screen.getByText('Task dependencies')).toBeInTheDocument();
    expect(screen.getByText('the graph')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByLabelText('Search tasks')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Filter by status' })).toBeInTheDocument();
  });
});
