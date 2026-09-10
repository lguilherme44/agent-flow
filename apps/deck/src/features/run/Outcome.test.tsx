import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactContentView, ArtifactView, AttentionFocus, DeliveryView, ReviewView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { Outcome, tabForFocus, type OutcomeTab } from './Outcome';
import { ptBR as t } from '../../lib/i18n';

/**
 * The three answers a person wants after a run, on the surface `ui` opens.
 *
 * Every assertion here reads the DOM rather than the code, because the defects this panel
 * replaces were all of that kind: a `?panel=` nobody read, a delivery card wearing a CSS
 * class nobody defined, a count folded in a header. A rule about the source text would
 * have passed through every one of them.
 */

const address = { projectId: 'flowcanvas', runId: 'AF-2026-001' };

const review: ReviewView = {
  reviewed: true,
  threads: [
    {
      taskId: 'TASK-004',
      status: 'changes_requested',
      freshness: 'current',
      rounds: 2,
      reviewer: 'reviewer-a',
      reviewerName: 'Reviewer A',
      author: 'executor-normal',
      independence: 2,
      reviewedTree: 'abcdef1234567890',
      integratedTree: 'abcdef1234567890',
      openBlocking: 1,
      findings: [
        {
          finding: {
            id: 'FND-001',
            severity: 'high',
            type: 'correctness',
            description: 'The recurrence generator drops the last occurrence of a bounded rule.',
            suggestedAction: 'Include the endpoint when the rule declares COUNT.',
            file: 'src/core/recurrence.ts',
            evidence: [],
          },
          reviewId: 'REV-1',
          taskId: 'TASK-004',
          round: 2,
          status: 'open',
        },
      ],
      decision: {
        approved: false,
        conditions: [{ name: 'no_open_blocking', met: false, detail: 'one finding is open' }],
        blockedBy: ['FND-001'],
      },
    },
  ],
  gates: [
    { gateId: 'test', category: 'unit', required: true, status: 'passed', exitCode: 0, durationMs: 4200 },
    { gateId: 'lint', category: 'lint', required: false, status: 'not_run', detail: 'no lint command is configured' },
  ],
  unsatisfiedGates: [],
  totals: {
    reviews: 2,
    tasksReviewed: 1,
    findings: 1,
    openFindings: 1,
    verifiedFindings: 0,
    staleReviews: 0,
    disputes: 0,
    bySeverity: { high: 1 },
    byCategory: { correctness: 1 },
    byIndependence: { '2': 1 },
  },
};

const delivery: DeliveryView = {
  state: 'checks_red',
  provider: 'github',
  repository: 'lguilherme44/flowcanvas',
  branch: 'agent-flow/AF-2026-001',
  publishedCommit: 'fedcba0987654321',
  pullRequest: { number: 31, url: 'https://forge.test/pr/31', state: 'open' },
  checks: [
    { id: 'c1', name: 'build', status: 'completed', conclusion: 'success' },
    { id: 'c2', name: 'e2e', status: 'completed', conclusion: 'failure', url: 'https://forge.test/checks/c2' },
  ],
  checkSummary: { total: 2, green: 1, red: 1, pending: 0 },
  syncedAt: '2026-09-08T12:00:00Z',
  detail: 'The remote reported a failing check on the published commit.',
};

const artifacts: ArtifactView[] = [
  { name: 'sdd', label: 'SDD', available: true, sizeBytes: 4096, updatedAt: '2026-09-08T11:00:00Z' },
  { name: 'plan', label: 'Plan', available: true, sizeBytes: 2048 },
  { name: 'finalReview', label: 'Final review', available: false },
];

const sdd: ArtifactContentView = {
  name: 'sdd',
  label: 'SDD',
  available: true,
  content: '# FR-001\nRecurring bookings generate occurrences from a rule.',
  truncated: false,
};

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

function stub(overrides: { review?: unknown; reviewStatus?: number } = {}): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const target = String(input);
    if (target.includes('/review')) return response(overrides.review ?? review, overrides.reviewStatus ?? 200);
    if (target.includes('/delivery')) return response(delivery);
    if (target.includes('/artifacts/sdd')) return response(sdd);
    if (target.includes('/artifacts')) return response(artifacts);
    return response({}, 404);
  }));
}

function panel(tab: OutcomeTab, freshness?: string) {
  return render(
    <Outcome address={address} tab={tab} onTab={() => undefined} reviewFreshness={freshness} />,
  );
}

describe('the review a person reads after the run', () => {
  beforeEach(() => {
    clearStore();
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the finding, its severity and what the reviewer suggested', async () => {
    panel('review');

    // Folded until asked — a run with nine reviewed tasks is nine headers, not nine essays.
    const head = await screen.findByRole('button', { name: /TASK-004/ });
    expect(screen.queryByText(/drops the last occurrence/)).not.toBeInTheDocument();

    fireEvent.click(head);

    expect(await screen.findByText(/drops the last occurrence/)).toBeInTheDocument();
    expect(screen.getByText(t.words.high)).toBeInTheDocument();
    expect(screen.getByText(/Include the endpoint when the rule declares COUNT/)).toBeInTheDocument();
    // The file the reviewer pointed at, which is what makes a finding actionable.
    expect(screen.getByText('src/core/recurrence.ts')).toBeInTheDocument();
  });

  it('says which gate did not run, and never draws it as a pass (I-24)', async () => {
    panel('review');

    expect(await screen.findByText('lint')).toBeInTheDocument();
    const notRun = screen.getByText(t.words.not_run);
    expect(notRun).toBeInTheDocument();
    // The tone is the whole claim: `not_run` shown in the passing colour is the defect
    // I-24 exists to forbid, and it is a `data-tone`, not a word.
    expect(notRun.closest('.gate')).toHaveAttribute('data-tone', 'idle');
    expect(screen.getByText('no lint command is configured')).toBeInTheDocument();
    expect(screen.getByText(t.words.passed).closest('.gate')).toHaveAttribute('data-tone', 'ok');
  });

  it('warns when the newest review no longer describes the run (C-20)', async () => {
    panel('review', 'superseded');

    expect(await screen.findByText(t.outcome.supersededReview)).toBeInTheDocument();
  });

  it('does not warn when the review is current', async () => {
    panel('review', 'current');

    await screen.findByRole('button', { name: /TASK-004/ });
    expect(screen.queryByText(t.outcome.supersededReview)).not.toBeInTheDocument();
  });

  it('separates a run that reviewed nothing from a reviewer that found nothing', async () => {
    // The distinction the whole panel turns on. "No findings" for a run with no reviewer
    // routed is the sentence that makes an unreviewed change look approved.
    stub({ review: { ...review, reviewed: false, threads: [], gates: [], totals: { ...review.totals, reviews: 0 } } });
    panel('review');

    expect(await screen.findByText(t.outcome.reviewedNothing)).toBeInTheDocument();
    expect(screen.queryByText(t.gate.noFindings)).not.toBeInTheDocument();
  });

  it('says the review could not be read rather than showing an empty one', async () => {
    stub({ review: { message: 'no such run' }, reviewStatus: 404 });
    panel('review');

    expect(await screen.findByText(t.outcome.reviewCouldNotRead)).toBeInTheDocument();
  });
});

describe('where the run went', () => {
  beforeEach(() => {
    clearStore();
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('names the pull request, the branch and the check that went red', async () => {
    panel('delivery');

    const pr = await screen.findByRole('link', { name: new RegExp(t.outcome.pullRequest(31)) });
    expect(pr).toHaveAttribute('href', 'https://forge.test/pr/31');
    expect(screen.getByText('agent-flow/AF-2026-001')).toBeInTheDocument();
    expect(screen.getByText('e2e')).toBeInTheDocument();
    expect(screen.getByText('failure').closest('.check')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByText('success').closest('.check')).toHaveAttribute('data-tone', 'ok');
    // Those two are the forge's own words, round-tripped: `word()` renders a token it has
    // not learned unchanged, which is what keeps a provider's vocabulary readable.
    // The sentence, not the state name. `checks_red` alone sends a person to the source.
    expect(screen.getByText(/failing check on the published commit/)).toBeInTheDocument();
  });

  it('treats no forge as the ordinary case rather than a fault', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const target = String(input);
      if (target.includes('/delivery')) {
        return response({
          state: 'disabled', provider: 'none', checks: [],
          checkSummary: { total: 0, green: 0, red: 0, pending: 0 },
          detail: 'No forge is configured for this project.',
        });
      }
      return response({}, 404);
    }));
    panel('delivery');

    expect(await screen.findByText('No forge is configured for this project.')).toBeInTheDocument();
    expect(screen.queryByText(t.outcome.deliveryCouldNotRead)).not.toBeInTheDocument();
  });
});

describe('what the run wrote down', () => {
  beforeEach(() => {
    clearStore();
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers only the artifacts that exist, and reads one as text', async () => {
    panel('artifacts');

    expect(await screen.findByRole('tab', { name: /SDD/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Plan/ })).toBeInTheDocument();
    // `available: false` is a stage that has not run. A disabled button that answers 404
    // is worse than no button.
    expect(screen.queryByRole('tab', { name: /Final review/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /SDD/ }));

    expect(await screen.findByText(/Recurring bookings generate occurrences/)).toBeInTheDocument();
  });

  it('renders an artifact as text, never as markup', async () => {
    // A runner's output is data. A bundle that turned `# FR-001` into a heading would be
    // handing a model's words the page's own authority.
    panel('artifacts');
    fireEvent.click(await screen.findByRole('tab', { name: /SDD/ }));

    const body = await screen.findByText(/Recurring bookings generate occurrences/);
    expect(body.tagName).toBe('PRE');
    expect(body.querySelector('h1')).toBeNull();
  });
});

describe('where an attention item lands', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The projection emits a *surface*, and this is the browser turning it into a tab.
   *
   * Written when `team` got one. It had been emitted since M8 and fell through a
   * `default: return undefined`, so the row said "no member could take this task", moved
   * the task selection, and showed nothing that answered it — a field nobody reads fails
   * no compiler and no assertion.
   */
  const LANDS: Record<AttentionFocus, OutcomeTab | undefined> = {
    review: 'review',
    quality: 'review',
    delivery: 'delivery',
    team: 'team',
    run: undefined,
    plan: undefined,
    task: undefined,
  };

  for (const [focus, tab] of Object.entries(LANDS) as [AttentionFocus, OutcomeTab | undefined][]) {
    it(`${focus} opens ${tab ?? 'nothing — the answer is above this panel'}`, () => {
      expect(tabForFocus(focus)).toBe(tab);
    });
  }

  it('offers a tab for every surface that has one, and each name is a real tab', async () => {
    // The other half: a mapping may not point at a tab the panel does not render. Read
    // off the DOM rather than the type, because the type is what the panel *claims*.
    stub();
    render(<Outcome address={address} tab="review" onTab={() => undefined} reviewFreshness={undefined} />);

    const shown = await screen.findAllByRole('tab');
    /*
      Read off the DOM in the language the panel is in: the tab *names* are translated and
      the tab *ids* are not, so the two are matched through the dictionary rather than by
      hoping they still spell the same.
    */
    const named: Record<OutcomeTab, string> = {
      review: t.outcome.review,
      delivery: t.outcome.delivery,
      artifacts: t.outcome.artifacts,
      telemetry: t.outcome.telemetryTab,
      team: t.outcome.team,
      collaboration: t.outcome.collaboration,
    };
    const labels = shown.map((element) => element.textContent);
    for (const tab of Object.values(LANDS)) {
      if (tab !== undefined) expect(labels).toContain(named[tab]);
    }
  });
});
