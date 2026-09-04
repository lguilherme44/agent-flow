import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskSummaryView } from '@contracts/index.js';
import { NO_FILTER, TaskTable, TaskToolbar, filterTasks, type TaskFilter } from './task-table';
import { countTasks } from './run-overview';

/**
 * The filter belongs to the page, because three surfaces share it (UI-28, M8.5 §20).
 *
 * The toolbar and the table are now two components — the toolbar lives in the tab strip,
 * where the board and the graph can see it, and the table lives on its own tab. This
 * mounts them the way the page does, so the panel can still be driven the way a person
 * drives it: type, click, see fewer rows — rather than asserted against a prop.
 */
function Table(props: {
  tasks: TaskSummaryView[];
  selectedId?: string;
  onSelect?: (taskId: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);

  return (
    <>
      <TaskToolbar filter={filter} onFilterChange={setFilter} />
      <TaskTable
        tasks={props.tasks}
        selectedId={props.selectedId}
        onSelect={props.onSelect ?? (() => undefined)}
        filter={filter}
      />
    </>
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

  it('carries no header of its own, so the surfaces do not each grow one (M8.5 §10)', () => {
    // The panel used to announce itself and hold the controls, and the board inherited all
    // of it by sharing the panel: a title, a search box, five chips and a five-count strip
    // — about 100px of chrome above six lanes. The tab strip names the surface and holds
    // the filter now, and what is left here is the strip and the rows.
    render(<Table tasks={TASKS} />);

    expect(screen.queryByText('Implementation tasks')).toBeNull();
    expect(screen.queryByText('Task board')).toBeNull();
    expect(screen.queryByText('Task dependencies')).toBeNull();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('keeps the five counts, on the one surface where nothing else counts the tasks', () => {
    // On the board this strip was the *second* statement of the same numbers, sitting
    // directly above lane badges that partition the same run a different way. Here it is
    // the only one.
    render(<Table tasks={TASKS} />);

    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});

/**
 * M2-10 — the two derived facts of §21.2 that the status chip cannot carry.
 *
 * `running` is the whole story in sequential mode and is not in worktree mode: a
 * task can be running with a live workspace, or finished-and-validated with
 * nothing merged. Only the second of those is a lie waiting to happen, because
 * `completed` means integrated (I-3).
 */
describe('isolated task states in the table', () => {
  it('says nothing extra in sequential mode, where the server sends neither fact', () => {
    render(<Table tasks={TASKS} />);

    expect(screen.queryByText('awaiting merge')).toBeNull();
    expect(screen.queryByText('in worktree')).toBeNull();
  });

  it('marks a running task that owns a live workspace', () => {
    render(<Table tasks={[task({ id: 'TASK-002', state: 'running', workspaceActive: true })]} />);

    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText('in worktree')).toBeInTheDocument();
  });

  it('marks a validated attempt whose marker is not on the branch yet', () => {
    render(
      <Table tasks={[task({ id: 'TASK-002', state: 'running', awaitingIntegration: true })]} />,
    );

    expect(screen.getByText('awaiting merge')).toBeInTheDocument();
  });

  it('prefers awaiting-merge over the workspace note when both are true', () => {
    // Both can hold at once — the task is still `running` while its validated
    // attempt waits for the merge — and the later fact is the one that changes
    // what a person does next.
    render(
      <Table
        tasks={[
          task({
            id: 'TASK-002',
            state: 'running',
            workspaceActive: true,
            awaitingIntegration: true,
          }),
        ]}
      />,
    );

    expect(screen.getByText('awaiting merge')).toBeInTheDocument();
    expect(screen.queryByText('in worktree')).toBeNull();
  });

  it('drops both once the task is integrated', () => {
    render(
      <Table
        tasks={[
          task({
            id: 'TASK-002',
            state: 'completed',
            integration: {
              attempt: 1,
              branch: 'agent-flow/AF-2026-001-9f2c1a/integration',
              marker: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
              mergeCommit: 'ffff6666aaaa7777bbbb8888cccc9999dddd0000',
              validatedTree: '1111aaaa2222bbbb3333cccc4444dddd5555eeee',
              integratedAt: '2026-08-10T20:11:00.000Z',
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
    expect(screen.queryByText('awaiting merge')).toBeNull();
    expect(screen.queryByText('in worktree')).toBeNull();
  });

  it('renders no filesystem path for an isolated task', () => {
    // §21.3: the table receives ref names and object ids, and the workspace is a
    // boolean rather than a location. There is nothing here to leak.
    render(
      <Table
        tasks={[task({ id: 'TASK-002', state: 'running', workspaceActive: true, attempts: 2 })]}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\/(Users|home|tmp|var)\//);
    expect(text).not.toMatch(/\.agent-flow\/worktrees/);
  });

  it('offers no focus mode, because there is no longer a band for it to collapse', () => {
    // Focus mode existed to hide the four summary cards and the review, delivery, team and
    // collaboration panels so the tasks could have the screen. They are tabs now, so the
    // tasks have the screen and the mode is a control whose only outcome is the state the
    // page is already in.
    render(<Table tasks={TASKS} />);

    expect(screen.queryByRole('button', { name: /expand workspace/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /focus mode/i })).toBeNull();
  });
});
