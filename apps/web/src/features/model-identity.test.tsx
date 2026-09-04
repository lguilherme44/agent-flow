import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type {
  BoardCardView,
  TaskDetailView,
  TaskSummaryView,
  TeamView,
} from '@contracts/index.js';
import { createQueryClient } from '../app/App';
import { TaskCard } from './board';
import { TaskInspector } from './task-inspector';
import { TaskTable } from './task-table';
import { NO_FILTER } from './task-table';
import { MODEL_NOT_REPORTED } from '../lib/model-label';

/**
 * Issue #21 — the model is the identity, and an absence says so.
 *
 * **Written because nothing asserted any of it.** Before this file, `rg` over the whole
 * web suite for `'no model'`, `'not reported'` and `'no model yet'` returned nothing: the
 * dashboard had three different spellings for one fact and a green suite either way. And
 * every one of the 39 `runner:` entries in the visual fixtures carried a `model:` beside
 * it, so no baseline had ever photographed a task whose model was absent — the darkest
 * branch of the whole vocabulary was unobservable by every instrument in the repository.
 *
 * The matrix here is the one Issue #21's acceptance asks for: a known model, an absent
 * one, a local model id, a long id, and the four concepts staying four.
 */

const summary = (overrides: Partial<TaskSummaryView> = {}): TaskSummaryView => ({
  id: 'TASK-001',
  title: 'Add recurrence types',
  complexity: 'normal',
  risk: 'low',
  state: 'running',
  attempts: 1,
  requirements: [],
  dependencies: [],
  ...overrides,
});

const cardOf = (overrides: Partial<BoardCardView> = {}): BoardCardView => ({
  task: summary(),
  lane: 'in_progress',
  reason: { text: 'running now', cause: 'none' },
  blockingFindings: 0,
  ...overrides,
});

const detail = (overrides: Partial<TaskDetailView> = {}): TaskDetailView => ({
  id: 'TASK-001',
  title: 'Add recurrence types',
  complexity: 'normal',
  risk: 'low',
  state: 'completed',
  attempts: 1,
  requirements: [],
  dependencies: [],
  description: 'Domain types for recurrence.',
  acceptanceCriteria: [],
  validation: [],
  validationExpectation: 'pass',
  files: [],
  filesChanged: [],
  notes: [],
  commands: [],
  log: [],
  ...overrides,
});

/** A team whose assignment names a role and an agent, so both can be told apart. */
const TEAM = {
  configured: true,
  members: [],
  assignments: [
    {
      taskId: 'TASK-001',
      agentId: 'backend-1',
      agentName: 'Backend One',
      role: 'executor.normal',
      reason: 'skill_match',
      assignedAt: '2026-09-01T10:00:00.000Z',
      candidates: [],
    },
  ],
  deferrals: [],
  totals: {
    members: 1,
    assignments: 1,
    reassignments: 0,
    deferrals: 0,
    tasksOwned: 1,
  },
} as unknown as TeamView;

function inspector(task: TaskDetailView, team?: TeamView): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TaskInspector
        task={task}
        projectId="demo"
        runId="AF-2026-001"
        {...(team === undefined ? {} : { team })}
      />
    </QueryClientProvider>,
  );
}

describe('the board card leads with the model', () => {
  it('shows the model a record named', () => {
    render(<TaskCard card={cardOf({ task: summary({ model: 'claude-opus-5' }) })} selected={false} onSelect={vi.fn()} />);

    expect(screen.getByText('claude-opus-5')).toBeInTheDocument();
  });

  it('shows a local model id exactly as configured, with no live server anywhere near it', () => {
    // §19's case: `type: openai-compatible`, `baseUrl: http://127.0.0.1:8080/v1`,
    // `model: qwen3.6-35b-a3b`. The card's job is to print the id the record carries —
    // there is nothing to reach out to, which is why this is a fixture and not a probe.
    render(
      <TaskCard
        card={cardOf({ task: summary({ runner: 'openai-compatible', model: 'qwen3.6-35b-a3b' }) })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('qwen3.6-35b-a3b')).toBeInTheDocument();
  });

  it('says nothing was reported rather than naming the runner', () => {
    // §20's mandatory case, and the substitution §12 forbids: a coding CLI whose model
    // nothing recorded must not have its runner id printed where the model goes.
    render(
      <TaskCard
        card={cardOf({ task: summary({ runner: 'claude' }) })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(MODEL_NOT_REPORTED)).toBeInTheDocument();
    expect(screen.queryByText('claude')).toBeNull();
  });

  it('keeps the agent name, and keeps it second', () => {
    // The role explains why the work was routed here and stays available in the inspector;
    // on the card the model leads and the agent qualifies it.
    render(
      <TaskCard
        card={cardOf({ task: summary({ model: 'claude-opus-5' }), agentName: 'Backend One' })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    const model = screen.getByText('claude-opus-5');
    const agent = screen.getByText('Backend One');
    expect(model).toBeInTheDocument();
    expect(agent).toBeInTheDocument();

    // Document order, which is what a screen reader walks and what the eye reads first.
    expect(model.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('never widens the lane for a long model id', () => {
    // §25: truncation and a tooltip rather than a wider board. 244px of lane is the
    // constraint, and a card that grew one would push BLOCKED off the screen.
    const long = 'a-very-long-model-identifier-that-nobody-would-type-by-hand-but-a-registry-might';
    render(
      <TaskCard
        card={cardOf({ task: summary({ model: long }) })}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    const rendered = screen.getByTitle(long);
    expect(rendered.className).toContain('truncate');
  });
});

describe('the inspector keeps model, role, runner and agent apart', () => {
  it('labels all four when an assignment named a role and an agent', () => {
    inspector(detail({ runner: 'claude', model: 'claude-opus-5' }), TEAM);

    const label = (text: string) => screen.getAllByText(text)[0]?.parentElement;

    expect(within(label('Model') as HTMLElement).getByText('claude-opus-5')).toBeInTheDocument();
    expect(within(label('Runner') as HTMLElement).getByText('claude')).toBeInTheDocument();
    expect(within(label('Role') as HTMLElement).getByText('executor.normal')).toBeInTheDocument();
    expect(within(label('Agent') as HTMLElement).getByText('Backend One')).toBeInTheDocument();
  });

  it('no longer labels the runner as the agent', () => {
    // **The defect, asserted as fixed.** The metadata row read `Agent | Model | Effort`
    // with `Agent` holding `task.runner`, so two of the four concepts shared one label and
    // it belonged to neither. Without a team there is no agent to name, and the honest
    // screen has no `Agent` cell at all rather than one containing a runner id.
    inspector(detail({ runner: 'claude', model: 'claude-opus-5' }));

    expect(screen.queryByText('Agent')).toBeNull();
    expect(screen.queryByText('Role')).toBeNull();
    expect(screen.getAllByText('Runner').length).toBeGreaterThan(0);
  });

  it('reports an absent model explicitly, in the cell labelled Model', () => {
    inspector(detail({ runner: 'claude' }));

    // Scoped to the cell rather than counted over the panel. A count would have to know
    // which tab is open — the `Execution` block lives behind one and says the same thing —
    // and a number is the kind of assertion that keeps passing while the cell it was
    // about stops rendering.
    const cell = screen.getAllByText('Model')[0]?.parentElement as HTMLElement;
    expect(within(cell).getByText(MODEL_NOT_REPORTED)).toBeInTheDocument();

    // And the runner is still named, in its own cell, under its own label.
    const runner = screen.getAllByText('Runner')[0]?.parentElement as HTMLElement;
    expect(within(runner).getByText('claude')).toBeInTheDocument();
  });
});

describe('the tasks table and the card agree on the words', () => {
  it('spells an absent model the same way the card does', () => {
    // Three spellings existed: `no model` here, `not reported` in the inspector,
    // `no model yet` on the graph. This is the assertion that keeps them one.
    render(
      <TaskTable
        tasks={[summary({ runner: 'claude' })]}
        onSelect={vi.fn()}
        selectedId={undefined}
        filter={NO_FILTER}
      />,
    );

    expect(screen.getByText(MODEL_NOT_REPORTED)).toBeInTheDocument();
    expect(screen.queryByText('no model')).toBeNull();
    expect(screen.queryByText('no model yet')).toBeNull();
  });

  it('prints the model when one was recorded', () => {
    render(
      <TaskTable
        tasks={[summary({ runner: 'claude', model: 'claude-opus-5' })]}
        onSelect={vi.fn()}
        selectedId={undefined}
        filter={NO_FILTER}
      />,
    );

    expect(screen.getByText('claude-opus-5')).toBeInTheDocument();
  });
});
