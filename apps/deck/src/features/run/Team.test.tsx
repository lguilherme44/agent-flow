import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { Outcome } from './Outcome';
import { ptBR as t } from '../../lib/i18n';

/**
 * Who did the work, and why this task went to that agent (7.8).
 *
 * The endpoint has been served since M5 and Deck drew none of it, so every assertion here
 * is about something that was only reachable from `--classic`. They read the DOM rather
 * than the source for the reason the outcome panel's own suite does: the defects this
 * closes were a focus nobody read and a projection nobody rendered, and a rule about the
 * source text passes straight through both.
 */

const address = { projectId: 'flowcanvas', runId: 'AF-2026-001' };

const team: TeamView = {
  configured: true,
  members: [
    {
      id: 'backend',
      displayName: 'Backend',
      role: 'executor',
      runner: 'primary',
      model: 'pinned-model-id',
      skills: ['api', 'sql'],
      specializations: ['persistence'],
      maxConcurrentTasks: 2,
      ownership: { preferred: ['src/core/**'], exclusive: ['src/db/**'], shared: [] },
      assigned: ['TASK-004'],
      assignedTotal: 3,
      status: 'working',
    },
    {
      id: 'frontend',
      displayName: 'Frontend',
      role: 'executor',
      runner: 'primary',
      skills: ['react'],
      specializations: [],
      maxConcurrentTasks: 1,
      ownership: { preferred: [], exclusive: [], shared: [] },
      assigned: ['TASK-007'],
      assignedTotal: 1,
      status: 'full',
    },
  ],
  assignments: [
    {
      taskId: 'TASK-004',
      agentId: 'backend',
      agentName: 'Backend',
      role: 'executor',
      reason: 'best_match',
      detail: 'Owns src/db/** and matched two of the three skills the task declared.',
      assignedAt: '2026-09-08T10:00:00Z',
      candidates: [
        {
          agentId: 'backend',
          agentName: 'Backend',
          score: 0.82,
          skillMatch: 0.67,
          ownership: 1,
          riskFit: 1,
          matchedSkills: ['api', 'sql'],
        },
        {
          agentId: 'frontend',
          agentName: 'Frontend',
          score: 0.14,
          skillMatch: 0,
          ownership: 0,
          riskFit: 1,
          matchedSkills: [],
          excludedBy: 'capacity',
        },
      ],
    },
  ],
  deferrals: [
    {
      taskId: 'TASK-009',
      reason: 'ownership',
      detail: 'TASK-008 is running against the same exclusive pattern.',
      waitsFor: 'TASK-008',
      patterns: ['src/db/**'],
      agents: ['backend'],
    },
  ],
  totals: {
    assignments: 4,
    reassignments: 1,
    capacityDeferrals: 0,
    ownershipDeferrals: 1,
    candidatesConsidered: 8,
    // `CANDIDATE_EXCLUSIONS`, plus one token the table has not learned — the fallback
    // has to keep rendering, and this is where that is asserted.
    exclusions: { capacity: 3, owns_nothing: 1 },
  },
};

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

function stub(view: unknown = team, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const target = String(input);
      if (target.includes('/team')) return response(view, status);
      return response({}, 404);
    }),
  );
}

const panel = () =>
  render(<Outcome address={address} tab="team" onTab={() => undefined} reviewFreshness={undefined} />);

describe('who did the work', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  it('shows each member, what they hold and how close to full they are', async () => {
    stub();
    panel();

    // Scoped to the row, because `Backend` is also the name on the assignment below it —
    // and a bare `getByText` that happened to find one of the two would be asserting
    // about whichever the DOM ordered first.
    await screen.findByLabelText(t.telemetry.totals);
    const backend = within(document.querySelector('[data-member="backend"]') as HTMLElement);
    expect(backend.getByText('Backend')).toBeInTheDocument();
    // The fraction, not a bar: the denominator is the fact that decides what to do next.
    expect(backend.getByText('1/2')).toBeInTheDocument();
    expect(backend.getByText(new RegExp(t.team.holds('TASK-004')))).toBeInTheDocument();
    expect(backend.getByText(new RegExp(t.team.owns('src/db/\\*\\* src/core/\\*\\*')))).toBeInTheDocument();

    const frontend = within(document.querySelector('[data-member="frontend"]') as HTMLElement);
    expect(frontend.getByText('1/1')).toBeInTheDocument();
  });

  it('shows the status as a word and not only as a colour (§97)', async () => {
    stub();
    panel();

    const full = await screen.findByText(t.words.full);
    expect(full).toBeInTheDocument();
    // The tone is a claim of its own: a member at capacity drawn in the idle colour says
    // there is room, which is the opposite of what the server answered.
    expect(full).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText(t.words.working)).toHaveAttribute('data-tone', 'live');
  });

  it('labels a member model as configured intent, never as a record', async () => {
    // `TeamMemberView.model` is read from configuration at request time — the contract
    // calls it a view of what the run *would* resolve. Drawn like a task's persisted
    // model it would recreate the confusion Issue #21 removed.
    stub();
    panel();

    expect(await screen.findByText(t.team.modelConfigured('pinned-model-id'))).toBeInTheDocument();
    // And a member with nothing pinned says so, rather than borrowing the runner's name.
    expect(screen.getByText(t.team.noModelPinned)).toBeInTheDocument();
  });

  it('answers "why not the other one" with the ranking the run recorded (§38, I-34)', async () => {
    stub();
    panel();

    // Folded until asked: nine tasks are nine headers, not nine tables.
    const head = await screen.findByRole('button', { name: /TASK-004/ });
    expect(screen.queryByText('0.82')).not.toBeInTheDocument();

    fireEvent.click(head);

    expect(await screen.findByText('0.82')).toBeInTheDocument();
    expect(screen.getByText('0.14')).toBeInTheDocument();
    // The reason the loser is out, in the row it is out of. A greyed row says "not this
    // one" and never says why, and why is the question the table exists to answer.
    expect(screen.getByText(new RegExp(`— ${t.words.capacity}`))).toBeInTheDocument();
    expect(screen.getByText(/Owns src\/db\/\*\* and matched two/)).toBeInTheDocument();

    const rows = screen.getAllByRole('row').filter((row) => row.hasAttribute('data-agent'));
    expect(rows.map((row) => row.getAttribute('data-agent'))).toEqual(['backend', 'frontend']);
    expect(rows[0]).toHaveAttribute('data-held', 'true');
    expect(rows[1]).toHaveAttribute('data-excluded', 'true');
  });

  it('counts which filter ruled candidates out, across the run (§41)', async () => {
    stub();
    panel();

    // The aggregate a per-candidate `excludedBy` cannot give: "capacity fired three
    // times" is a configuration to change, three rows saying `capacity` is a list to count.
    const chips = await screen.findByLabelText(t.team.ruledOut);
    expect(chips).toHaveTextContent(`${t.words.capacity} 3`);
    // A token the table has not learned falls back to its own words, visibly.
    expect(chips).toHaveTextContent('owns nothing 1');
  });

  it('names the task a wave would not take, and what it waited for', async () => {
    stub();
    panel();

    expect(await screen.findByText('TASK-009')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(t.team.waitsFor('TASK-008')))).toBeInTheDocument();
  });

  it('separates "no team configured" from "configured and nobody resolved"', async () => {
    // The distinction the contract insists on: `configured` is whether a `teams:` block
    // exists, not whether anything was assigned. Sending somebody to write a block they
    // already wrote is the screen misreading its own data.
    stub({ ...team, configured: false, members: [], assignments: [], deferrals: [] });
    const view = panel();

    expect(await screen.findByText(t.team.notConfigured)).toBeInTheDocument();
    expect(screen.getByText(t.team.notConfiguredHint)).toBeInTheDocument();

    view.unmount();
    clearStore();
    stub({ ...team, members: [], assignments: [], deferrals: [] });
    panel();

    expect(await screen.findByText(t.team.configuredButEmpty)).toBeInTheDocument();
  });

  it('pins the one outcome that means the team could not answer', async () => {
    stub({
      ...team,
      assignments: [
        {
          taskId: 'TASK-004',
          agentId: 'executor',
          agentName: 'the router’s role',
          role: 'executor',
          reason: 'no_eligible_member',
          detail: 'No member declared the skills TASK-004 asked for.',
          assignedAt: '2026-09-08T10:00:00Z',
          candidates: [],
        },
      ],
    });
    panel();

    expect(await screen.findByText(new RegExp(t.team.fellBackToRole(1)))).toBeInTheDocument();
    expect(screen.getByText(/No member declared the skills/)).toBeInTheDocument();
  });

  it('says the team could not be read rather than drawing an empty one', async () => {
    stub({ message: 'no such run' }, 404);
    panel();

    expect(await screen.findByText(t.team.couldNotRead)).toBeInTheDocument();
  });
});
