import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { DeliveryView } from '@contracts/index.js';
import { createQueryClient } from '../app/App';
import { DeliveryPanel } from './delivery';

/**
 * Delivery, tested for the first time (M7 §57, M8.5 §18).
 *
 * **This component shipped two milestones ago and no gate has ever rendered it.** There
 * was no test file. The only delivery fixture in the repository is `DELIVERY_NONE`, whose
 * state is `disabled`, so the guard clause returned `null` in every unit test and in all
 * 296 visual baselines. Under that cover it was styled with ten class names — `card`,
 * `card__header`, `delivery__detail`, `delivery__facts`, `delivery__checks`,
 * `delivery__check--success`, `badge--delivery-published` and their neighbours — that no
 * stylesheet in the project defines and that are not Tailwind utilities either. The panel
 * rendered as raw HTML: an unstyled heading, a `<dl>` with browser default margins and a
 * bulleted list, inside an app where every other panel is a `Panel`.
 *
 * Nothing was going to catch that. A class nobody defines fails no compiler, no linter and
 * no DOM assertion — the element exists, it simply has no style. What catches it is a
 * fixture that renders the component and a person looking at the result, which is what
 * this file and the new visual baseline are.
 *
 * The assertions below are about the projection reaching the screen intact, and about the
 * one thing this panel must never do: turn a red remote check into a verdict about the
 * run.
 */

const view = (overrides: Partial<DeliveryView> = {}): DeliveryView => ({
  state: 'checks_green',
  provider: 'github',
  repository: 'lguilherme44/beahub',
  branch: 'agent-flow/AF-2026-104/integration',
  publishedCommit: 'c0ffee1234567890abcdef1234567890abcdef12',
  issue: { number: 412, url: 'https://github.com/lguilherme44/beahub/issues/412' },
  pullRequest: {
    number: 413,
    url: 'https://github.com/lguilherme44/beahub/pull/413',
    state: 'open',
  },
  checks: [
    { id: '1', name: 'build', status: 'completed', conclusion: 'success' },
    { id: '2', name: 'unit', status: 'completed', conclusion: 'success' },
  ],
  checkSummary: { total: 2, green: 2, red: 0, pending: 0 },
  syncedAt: '2026-09-03T10:02:00.000Z',
  detail: 'Every remote check has passed on pull request #413.',
  ...overrides,
});

let answer: DeliveryView;

beforeEach(() => {
  answer = view();
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const panel = (): void => {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <DeliveryPanel projectId="demo" runId="AF-2026-104" />
    </QueryClientProvider>,
  );
};

describe('the delivery panel renders the projection', () => {
  it('says where the run went, in the words the server wrote', async () => {
    panel();

    expect(await screen.findByRole('heading', { name: 'Delivery' })).toBeInTheDocument();
    expect(
      screen.getByText('Every remote check has passed on pull request #413.'),
    ).toBeInTheDocument();
    expect(screen.getByText('lguilherme44/beahub')).toBeInTheDocument();
  });

  it('states the delivery state in words as well as in colour (§97)', async () => {
    panel();

    expect(await screen.findByText('checks green')).toBeInTheDocument();
  });

  it('links the issue and the pull request out to the forge', async () => {
    panel();

    const pr = await screen.findByRole('link', { name: /#413/ });
    expect(pr).toHaveAttribute('href', 'https://github.com/lguilherme44/beahub/pull/413');
    // Every write to a forge stays behind the CLI, so these are the only outbound things
    // on the panel — and they open away from a dashboard that has no token.
    expect(pr).toHaveAttribute('target', '_blank');
    expect(pr).toHaveAttribute('rel', 'noreferrer');
  });

  it('formats the sync instant rather than printing the wire value', async () => {
    // The first photograph of this panel caught it printing `2026-08-10T20:02:00.000Z`,
    // which is the only unformatted date anywhere in the app. No assertion could have seen
    // it — the value was present and correct — and no picture existed to show it.
    panel();

    expect(await screen.findByTitle('2026-09-03T10:02:00.000Z')).not.toHaveTextContent(
      '2026-09-03T10:02:00.000Z',
    );
  });

  it('abbreviates the published commit and keeps the whole one in the title', async () => {
    panel();

    const published = await screen.findByTitle(
      'c0ffee1234567890abcdef1234567890abcdef12 → agent-flow/AF-2026-104/integration',
    );
    expect(published).toHaveTextContent('c0ffee12');
  });
});

describe('a remote check is an observation, never a verdict', () => {
  it('carries the sentence that has to be on the page', async () => {
    // A person who sees red here and nothing else concludes the run failed. It did not,
    // and the panel says so where they are looking rather than in a document.
    answer = view({
      state: 'checks_red',
      checks: [
        { id: '1', name: 'build', status: 'completed', conclusion: 'success' },
        { id: '2', name: 'e2e', status: 'completed', conclusion: 'failure' },
      ],
      checkSummary: { total: 2, green: 1, red: 1, pending: 0 },
      detail: 'One remote check failed on pull request #413.',
    });
    panel();

    expect(
      await screen.findByText(
        /These are observations\. The local quality decision is already made/,
      ),
    ).toBeInTheDocument();
  });

  it('shows each check under its own reported conclusion, and folds none of them', async () => {
    answer = view({
      state: 'checks_red',
      checks: [
        { id: '1', name: 'build', status: 'completed', conclusion: 'success' },
        { id: '2', name: 'e2e', status: 'completed', conclusion: 'failure' },
        { id: '3', name: 'lint', status: 'in_progress' },
      ],
      checkSummary: { total: 3, green: 1, red: 1, pending: 1 },
    });
    panel();

    expect(await screen.findByText('success')).toBeInTheDocument();
    expect(screen.getByText('failure')).toBeInTheDocument();
    expect(screen.getByText('in progress')).toBeInTheDocument();
    // The counts are the server's `checkSummary`, printed rather than recounted.
    expect(screen.getByText(/1\/3 passed, 1 failed, 1 pending/)).toBeInTheDocument();
  });

  it('bounds the list and says what it left out', async () => {
    answer = view({
      checks: Array.from({ length: 20 }, (_, index) => ({
        id: String(index),
        name: `check-${String(index)}`,
        status: 'completed' as const,
        conclusion: 'success' as const,
      })),
      checkSummary: { total: 20, green: 20, red: 0, pending: 0 },
    });
    panel();

    expect(await screen.findByText('Showing 12 of 20. The forge has the rest.')).toBeInTheDocument();
    expect(screen.queryByText('check-15')).toBeNull();
  });
});

describe('what the panel does when there is nothing to say', () => {
  it('renders nothing at all when no forge is configured', async () => {
    // Absent rather than empty. Most runs deliver nowhere, and this absence is also what
    // removes the Delivery tab — a run with no forge does not carry a door to an empty
    // room.
    answer = view({ state: 'disabled', detail: 'No forge is configured.' });
    const { container } = render(
      <QueryClientProvider client={createQueryClient()}>
        <DeliveryPanel projectId="demo" runId="AF-2026-104" />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(container.querySelector('h2')).toBeNull();
    });
  });

  it('shows a refusal in the domain vocabulary, which nothing rendered before', async () => {
    // `ForgeFailure` has been on the projection since M7 and neither the old panel nor
    // anything else drew it, so a run whose publication was refused for want of a token
    // showed the state and never the reason. `detail` is written for a person and carries
    // no token, header or raw response body by contract.
    answer = view({
      state: 'delivery_failed',
      checks: [],
      checkSummary: { total: 0, green: 0, red: 0, pending: 0 },
      detail: 'Publishing was refused.',
      failure: {
        code: 'forge_auth_required',
        detail: 'The configured token cannot write to lguilherme44/beahub.',
      },
    });
    panel();

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('The configured token cannot write to lguilherme44/beahub.'),
    ).toBeInTheDocument();
    expect(within(alert).getByText('forge_auth_required')).toBeInTheDocument();
  });

  it('omits a fact the projection did not carry rather than printing a dash', async () => {
    // Built by omission rather than by `undefined`, because `exactOptionalPropertyTypes`
    // draws exactly the distinction this test is about: a field the projection left out is
    // not a field carrying `undefined`.
    const { issue, pullRequest, syncedAt, ...rest } = view();
    void issue;
    void pullRequest;
    void syncedAt;
    answer = {
      ...rest,
      state: 'published',
      detail: 'Pushed, and nothing has opened a pull request yet.',
    };
    panel();

    await screen.findByRole('heading', { name: 'Delivery' });
    expect(screen.queryByText('Issue')).toBeNull();
    expect(screen.queryByText('Pull request')).toBeNull();
    expect(screen.queryByText('Last sync')).toBeNull();
    // And the two it did carry are still there.
    expect(screen.getByText('Repository')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
  });
});
