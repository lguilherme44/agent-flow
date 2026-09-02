import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TaskAssignmentView, TeamMemberView, TeamView } from '@contracts/index.js';
import { TeamPanel, TaskAssignmentNote } from './team';

/**
 * The team panel and the "Why?" disclosure (§37, §38).
 *
 * Every assertion is about what a person *sees*. Nothing in either component ranks a
 * candidate or decides a status — a test that reached for a derived value would be
 * testing the server's projection through a component, and the component's only job is
 * presentation (I-33).
 */

const member = (overrides: Partial<TeamMemberView> = {}): TeamMemberView => ({
  id: 'backend',
  displayName: 'Backend',
  role: 'executor.normal',
  runner: 'claude',
  skills: ['typescript'],
  specializations: [],
  maxConcurrentTasks: 2,
  ownership: { preferred: ['src/server/**'], exclusive: [], shared: [] },
  assigned: [],
  assignedTotal: 0,
  status: 'idle',
  ...overrides,
});

const assignment = (overrides: Partial<TaskAssignmentView> = {}): TaskAssignmentView => ({
  taskId: 'TASK-003',
  agentId: 'backend',
  agentName: 'Backend',
  role: 'executor.normal',
  reason: 'team_match',
  detail: 'backend scored 0.90 — skills typescript of typescript; ownership 1.00',
  assignedAt: '2026-09-01T12:00:00.000Z',
  candidates: [
    { agentId: 'backend', agentName: 'Backend', score: 0.9, skillMatch: 1, ownership: 1, riskFit: 1, matchedSkills: ['typescript'] },
    { agentId: 'frontend', agentName: 'Frontend', score: 0.2, skillMatch: 0, ownership: 0, riskFit: 1, matchedSkills: [], excludedBy: 'capacity' },
  ],
  ...overrides,
});

const view = (overrides: Partial<TeamView> = {}): TeamView => ({
  configured: true,
  members: [member()],
  assignments: [],
  deferrals: [],
  totals: {
    assignments: 0,
    reassignments: 0,
    capacityDeferrals: 0,
    ownershipDeferrals: 0,
    candidatesConsidered: 0,
    exclusions: {},
  },
  ...overrides,
});

describe('TeamPanel', () => {
  it('invites configuration when no team exists', () => {
    render(<TeamPanel team={view({ configured: false, members: [] })} />);
    expect(screen.getByText(/No team configured/i)).toBeInTheDocument();
    expect(screen.getByText(/teams: block/i)).toBeInTheDocument();
  });

  it('renders the same empty state while the query is in flight', () => {
    // A spinner and an empty state are the same box to a reader; what must never appear
    // is a member list built from nothing.
    render(<TeamPanel team={undefined} />);
    expect(screen.getByText(/No team configured/i)).toBeInTheDocument();
  });

  it('shows who is configured, on what runner, with which skills', () => {
    render(<TeamPanel team={view()} />);

    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText(/executor\.normal · claude · typescript/)).toBeInTheDocument();
  });

  it('states the load as a fraction, so the denominator is visible', () => {
    // `2/2` says "change the capacity or wait"; a full bar says neither.
    render(
      <TeamPanel team={view({ members: [member({ assigned: ['TASK-001', 'TASK-002'], status: 'full' })] })} />,
    );

    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('says the status in words, never in colour alone (§97)', () => {
    render(<TeamPanel team={view({ members: [member({ status: 'working', assigned: ['TASK-001'] })] })} />);
    expect(screen.getByText('working')).toBeInTheDocument();
  });

  it('names the tasks a member is holding', () => {
    render(<TeamPanel team={view({ members: [member({ assigned: ['TASK-001'], status: 'working' })] })} />);
    expect(screen.getByText('TASK-001')).toBeInTheDocument();
  });

  it('raises a task no member could take, above the list', () => {
    // The one outcome that means the team was consulted and could not answer.
    render(
      <TeamPanel
        team={view({
          assignments: [assignment({ reason: 'no_eligible_member', detail: 'everyone is at capacity' })],
        })}
      />,
    );

    expect(screen.getByText(/1 task\(s\) no member could take/)).toBeInTheDocument();
    expect(screen.getByText('everyone is at capacity')).toBeInTheDocument();
  });

  it('shows what a wave would not take, and why', () => {
    render(
      <TeamPanel
        team={view({
          deferrals: [
            {
              taskId: 'TASK-004',
              reason: 'ownership',
              detail: 'TASK-004 and TASK-003 both write into src/db/**',
              waitsFor: 'TASK-003',
              patterns: ['src/db/**'],
              agents: [],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('TASK-004')).toBeInTheDocument();
    expect(screen.getByText('ownership')).toBeInTheDocument();
  });

  it('cuts the list at four and says how many are left', () => {
    // Bounded, with the totals in the footer — the pattern the row already set. The
    // first version rendered everything and the fifth member was sliced in half.
    const many = Array.from({ length: 6 }, (_, index) => member({ id: `m${String(index)}`, displayName: `M${String(index)}` }));
    render(<TeamPanel team={view({ members: many })} />);

    expect(screen.getByText('M3')).toBeInTheDocument();
    expect(screen.queryByText('M4')).not.toBeInTheDocument();
    expect(screen.getByText(/and 2 more member\(s\)/)).toBeInTheDocument();
  });

  it('carries the totals in the footer', () => {
    render(
      <TeamPanel
        team={view({
          totals: {
            assignments: 5,
            reassignments: 1,
            capacityDeferrals: 2,
            ownershipDeferrals: 0,
            candidatesConsidered: 10,
            exclusions: { capacity: 3, role_mismatch: 1 },
          },
        })}
      />,
    );

    expect(screen.getByText(/5 assignment\(s\), 10 candidate\(s\) considered/)).toBeInTheDocument();
    expect(screen.getByText(/1 reassignment\(s\)/)).toBeInTheDocument();
    // §41: which filter fired and how often, spelled out rather than pasted as an enum.
    expect(screen.getByText(/ruled out 3 capacity, 1 role mismatch/)).toBeInTheDocument();
  });
});

describe('TaskAssignmentNote', () => {
  it('renders nothing for a task no team assigned', () => {
    // A project with no team made no decision, and a "why?" over the router's answer
    // would promise an explanation there is none of.
    const { container } = render(<TaskAssignmentNote team={view()} taskId="TASK-003" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is no team at all', () => {
    const { container } = render(<TaskAssignmentNote team={undefined} taskId="TASK-003" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the holder in the closed summary', () => {
    // Scoped to the summary on purpose: the winner's name is deliberately in two places,
    // the one-line answer and its own row in the ranking, and a bare text query would
    // pass for either.
    const { container } = render(
      <TaskAssignmentNote team={view({ assignments: [assignment()] })} taskId="TASK-003" />,
    );

    expect(container.querySelector('summary')?.textContent).toContain('Backend');
    expect(screen.getByText('team match')).toBeInTheDocument();
    expect(screen.getByText('why?')).toBeInTheDocument();
  });

  it('carries the ranking, with the reason each candidate was ruled out', () => {
    // `<details>` renders its content whether or not it is open, which is what lets a
    // reader search the page for a member's name before expanding anything.
    render(<TaskAssignmentNote team={view({ assignments: [assignment()] })} taskId="TASK-003" />);

    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText(/— capacity/)).toBeInTheDocument();
    expect(screen.getByText('0.90')).toBeInTheDocument();
  });

  it('says a ranking was not recorded rather than showing an empty table', () => {
    render(
      <TaskAssignmentNote
        team={view({ assignments: [assignment({ candidates: [] })] })}
        taskId="TASK-003"
      />,
    );

    expect(screen.getByText(/No candidate ranking was recorded/)).toBeInTheDocument();
  });

  it('follows the last assignment when a task changed hands', () => {
    const { container } = render(
      <TaskAssignmentNote
        team={view({
          assignments: [
            assignment(),
            assignment({ agentId: 'frontend', agentName: 'Frontend', reason: 'handoff_admitted', previousAgentId: 'backend' }),
          ],
        })}
        taskId="TASK-003"
      />,
    );

    expect(container.querySelector('summary')?.textContent).toContain('Frontend');
    expect(screen.getByText(/from backend/)).toBeInTheDocument();
  });

  it('ignores an assignment belonging to another task', () => {
    const { container } = render(
      <TaskAssignmentNote team={view({ assignments: [assignment({ taskId: 'TASK-009' })] })} taskId="TASK-003" />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
