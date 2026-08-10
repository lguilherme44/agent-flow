import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskSummaryView } from '@contracts/index.js';
import { TaskTable, filterTasks } from './task-table';
import { countTasks } from './run-overview';

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
    render(<TaskTable tasks={TASKS} selectedId={undefined} onSelect={() => undefined} />);

    // Status is text as well as colour (§97): a greyscale screenshot and a
    // colour-blind reader must get the same answer.
    expect(screen.getByText('TASK-001')).toBeInTheDocument();
    expect(screen.getAllByText('COMPLETED').length).toBeGreaterThan(0);
    expect(screen.getByText('BLOCKED')).toBeInTheDocument();
  });

  it('marks a corrective task as one', () => {
    render(<TaskTable tasks={TASKS} selectedId={undefined} onSelect={() => undefined} />);

    expect(screen.getByLabelText('corrective task')).toBeInTheDocument();
  });

  it('selects on click', async () => {
    const onSelect = vi.fn();
    render(<TaskTable tasks={TASKS} selectedId={undefined} onSelect={onSelect} />);

    await userEvent.click(screen.getByText('Implement generation'));

    expect(onSelect).toHaveBeenCalledWith('TASK-002');
  });

  it('selects from the keyboard', async () => {
    // A table nobody can drive without a mouse is not navigable, whatever it
    // looks like (§97).
    const onSelect = vi.fn();
    render(<TaskTable tasks={TASKS} selectedId={undefined} onSelect={onSelect} />);

    const row = screen.getByText('Implement generation').closest('tr');
    row?.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('TASK-002');
  });

  it('filters by status from the toolbar', async () => {
    render(<TaskTable tasks={TASKS} selectedId={undefined} onSelect={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'failed' }));

    const body = screen.getAllByRole('rowgroup')[1];
    expect(within(body as HTMLElement).getAllByRole('row')).toHaveLength(1);
    expect(screen.getByText('Break it')).toBeInTheDocument();
  });

  it('searches as you type', async () => {
    render(<TaskTable tasks={TASKS} selectedId={undefined} onSelect={() => undefined} />);

    await userEvent.type(screen.getByLabelText('Search tasks'), 'redact');

    expect(screen.getByText('Redact the token')).toBeInTheDocument();
    expect(screen.queryByText('Break it')).not.toBeInTheDocument();
  });

  it('says so when a filter matches nothing', () => {
    render(<TaskTable tasks={[]} selectedId={undefined} onSelect={() => undefined} />);

    expect(screen.getByText('No tasks yet.')).toBeInTheDocument();
  });
});
