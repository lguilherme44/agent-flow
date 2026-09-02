import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProjectedFindingView, ReviewThreadView, ReviewView } from '@contracts/index.js';
import { ReviewPanel } from './review';

/**
 * The review panel (§60–§62).
 *
 * Every assertion is about what a person *sees*. Nothing in this component decides a
 * review's status, a finding's blocking status, a gate's verdict or a review's freshness
 * — §59 names all four — so a test that reached for a derived value would be testing the
 * server's projection through a component.
 */

const finding = (overrides: Partial<ProjectedFindingView['finding']> = {}, status: ProjectedFindingView['status'] = 'open'): ProjectedFindingView => ({
  finding: {
    id: 'FIND-0001',
    severity: 'high',
    type: 'correctness',
    description: 'the retry re-sends a consumed body',
    suggestedAction: 'buffer it first',
    file: 'src/server/routes.ts',
    location: { line: 42 },
    evidence: [],
    ...overrides,
  },
  reviewId: 'REV-0001',
  taskId: 'TASK-003',
  round: 1,
  status,
});

const thread = (overrides: Partial<ReviewThreadView> = {}): ReviewThreadView => ({
  taskId: 'TASK-003',
  status: 'changes_requested',
  freshness: 'current',
  rounds: 1,
  reviewer: 'reviewer',
  reviewerName: 'Reviewer',
  author: 'backend',
  independence: 3,
  findings: [finding()],
  openBlocking: 1,
  decision: {
    approved: false,
    conditions: [{ name: 'no blocking finding is open', met: false, detail: 'FIND-0001 high (open)' }],
    blockedBy: ['no blocking finding is open'],
  },
  ...overrides,
});

const view = (overrides: Partial<ReviewView> = {}): ReviewView => ({
  reviewed: true,
  threads: [thread()],
  gates: [{ gateId: 'test', category: 'unit', required: true, status: 'passed', exitCode: 0 }],
  unsatisfiedGates: [],
  totals: {
    reviews: 1,
    tasksReviewed: 1,
    findings: 1,
    openFindings: 1,
    verifiedFindings: 0,
    staleReviews: 0,
    disputes: 0,
    bySeverity: { high: 1 },
    byCategory: { correctness: 1 },
    byIndependence: { '3': 1 },
  },
  ...overrides,
});

describe('a run that reviewed nothing', () => {
  it('invites a reviewer rather than showing an empty review', () => {
    render(<ReviewPanel review={view({ reviewed: false, threads: [] })} />);

    expect(screen.getByText(/Nothing reviewed/i)).toBeInTheDocument();
    expect(screen.getByText(/review skill/i)).toBeInTheDocument();
  });

  it('shows the same while the query is in flight', () => {
    render(<ReviewPanel review={undefined} />);
    expect(screen.getByText(/Nothing reviewed/i)).toBeInTheDocument();
  });
});

describe('a thread says who read it and whether it still counts', () => {
  it('names the task, the reviewer and the independence achieved', () => {
    render(<ReviewPanel review={view()} />);

    expect(screen.getByText('TASK-003')).toBeInTheDocument();
    expect(screen.getByText(/Reviewer · independence 3/)).toBeInTheDocument();
  });

  it('says the status in words, never in colour alone (§97)', () => {
    render(<ReviewPanel review={view()} />);
    expect(screen.getByText('changes requested')).toBeInTheDocument();
  });

  it('marks a stale review as stale', () => {
    render(<ReviewPanel review={view({ threads: [thread({ freshness: 'stale' })] })} />);
    expect(screen.getByText('stale')).toBeInTheDocument();
  });

  it('says which finding is blocking, not that none is', () => {
    // `blockedBy` names *conditions*, and a condition is phrased as what should be true.
    // Rendering it raw put "no blocking finding is open" under a change blocked by
    // exactly that — a sentence that reads as the opposite of what it means.
    render(<ReviewPanel review={view()} />);

    expect(screen.getByText(/Blocked: FIND-0001 high \(open\)/)).toBeInTheDocument();
  });

  it('shows the round when there has been more than one', () => {
    render(<ReviewPanel review={view({ threads: [thread({ rounds: 3 })] })} />);
    expect(screen.getByText(/round 3/)).toBeInTheDocument();
  });
});

describe('a finding shows what a reader acts on (§61)', () => {
  it('carries severity, id, category, status, description and place', () => {
    render(<ReviewPanel review={view()} />);

    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('FIND-0001')).toBeInTheDocument();
    expect(screen.getByText('correctness')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText(/consumed body/)).toBeInTheDocument();
    expect(screen.getByText('src/server/routes.ts:42')).toBeInTheDocument();
  });

  it('names the corrective task once there is one, because "fixed" without one is a claim', () => {
    render(
      <ReviewPanel
        review={view({
          threads: [thread({ findings: [{ ...finding({}, 'fixed'), correctiveTask: 'FIX-001' }] })],
        })}
      />,
    );

    expect(screen.getByText('→ FIX-001')).toBeInTheDocument();
  });

  it('hides a verified finding, because history belongs in the log', () => {
    render(<ReviewPanel review={view({ threads: [thread({ findings: [finding({}, 'verified')] })] })} />);

    expect(screen.queryByText('FIND-0001')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing open.')).toBeInTheDocument();
  });
});

describe('a required gate that did not run is never a detail (§62)', () => {
  it('raises it above the threads', () => {
    render(
      <ReviewPanel
        review={view({
          gates: [
            { gateId: 'e2e', category: 'e2e', required: true, status: 'not_run', detail: 'never executed' },
          ],
          unsatisfiedGates: [
            { gateId: 'e2e', category: 'e2e', required: true, status: 'not_run', detail: 'never executed' },
          ],
        })}
      />,
    );

    expect(screen.getByText(/1 required gate\(s\) unsatisfied/)).toBeInTheDocument();
    expect(screen.getByText(/never executed/)).toBeInTheDocument();
  });

  it('does not raise an advisory gate that did not run', () => {
    render(
      <ReviewPanel
        review={view({
          gates: [{ gateId: 'e2e', category: 'e2e', required: false, status: 'not_run' }],
        })}
      />,
    );

    expect(screen.queryByText(/required gate\(s\) unsatisfied/)).not.toBeInTheDocument();
  });

  it('lists every gate as evidence, including the ones that did not run', () => {
    render(
      <ReviewPanel
        review={view({
          gates: [
            { gateId: 'test', category: 'unit', required: true, status: 'passed' },
            { gateId: 'visual', category: 'visual', required: false, status: 'not_applicable' },
          ],
        })}
      />,
    );

    expect(screen.getByText('Quality gates')).toBeInTheDocument();
    expect(screen.getByText('passed')).toBeInTheDocument();
    expect(screen.getByText('not applicable')).toBeInTheDocument();
    expect(screen.getByText(/visual \(advisory\)/)).toBeInTheDocument();
  });
});

describe('the footer carries the totals', () => {
  it('counts reviews, tasks, findings, open and verified', () => {
    render(<ReviewPanel review={view()} />);

    expect(
      screen.getByText(/1 review\(s\) over 1 task\(s\) · 1 finding\(s\), 1 open, 0 verified/),
    ).toBeInTheDocument();
  });

  it('says how many reviews went stale, when any did', () => {
    render(
      <ReviewPanel review={view({ totals: { ...view().totals, staleReviews: 2 } })} />,
    );

    expect(screen.getByText(/2 stale/)).toBeInTheDocument();
  });
});

describe('the list is bounded', () => {
  it('cuts at four threads and says how many are left', () => {
    const many = Array.from({ length: 6 }, (_, index) => thread({ taskId: `TASK-00${String(index)}` }));
    render(<ReviewPanel review={view({ threads: many })} />);

    expect(screen.getByText('TASK-003')).toBeInTheDocument();
    expect(screen.queryByText('TASK-004')).not.toBeInTheDocument();
    expect(screen.getByText(/and 2 more task\(s\)/)).toBeInTheDocument();
  });
});
