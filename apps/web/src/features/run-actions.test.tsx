import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ApprovalGateView, RunDetailView } from '@contracts/index.js';
import { createQueryClient } from '../app/App';
import { RunActions } from './run-actions';

/**
 * UI-27 — the actions, from the browser's side.
 *
 * The assertions worth having here are about what the browser does *not* do. It
 * sends no plan hash. It does not decide the gate. It does not patch a cache to make
 * the screen look like the action worked. And it re-reads the run afterwards, because
 * what a run is comes from the server and not from a mutation's return value.
 */

const RUN: RunDetailView = {
  projectId: 'demo',
  runId: 'AF-2026-001',
  feature: 'Add weekly recurrence',
  stage: 'plan-review',
  status: 'waiting_for_approval',
  approved: false,
  createdAt: '2026-08-10T19:34:00.000Z',
  updatedAt: '2026-08-10T20:15:22.000Z',
  taskCount: 9,
  completedTasks: 0,
  degradations: 0,
  degradationDetail: [],
  progress: 0,
  startedAt: '2026-08-10T19:34:00.000Z',
  durationMs: 2_482_000,
};

const PASSING_GATE: ApprovalGateView = {
  runId: RUN.runId,
  approved: false,
  canApprove: true,
  warnings: [],
  planHash: 'a1b2c3d4e5f60718',
  taskCount: 9,
  sddDigest: 'ff00aa11bb22',
  review: {
    verdict: 'PASS',
    independence: 'cross-provider',
    planHash: 'a1b2c3d4e5f60718',
    coversThisPlan: true,
    findings: [],
  },
  degradations: [],
};

const FAILING_GATE: ApprovalGateView = {
  ...PASSING_GATE,
  canApprove: false,
  refusal: { kind: 'review_failed', forcible: true },
  warnings: ['the plan review was same-provider: it does not protect against a repeated assumption'],
  review: {
    verdict: 'FAIL',
    independence: 'same-provider-fresh-context',
    planHash: 'a1b2c3d4e5f60718',
    coversThisPlan: true,
    findings: [
      {
        severity: 'high',
        type: 'missing_test',
        description: 'TASK-004 has no validation command.',
        suggestedAction: 'Add a validation id the project config declares.',
      },
    ],
  },
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

let routes: Record<string, unknown> = {};
let calls: Call[] = [];
let failWith: { status: number; body: unknown } | undefined;

beforeEach(() => {
  calls = [];
  failWith = undefined;
  routes = {
    [`/api/v1/runs/${RUN.runId}/approval`]: PASSING_GATE,
    [`/api/v1/runs/${RUN.runId}/job`]: null,
    [`/api/v1/runs/${RUN.runId}/approve`]: { runId: RUN.runId, warnings: [] },
    [`/api/v1/runs/${RUN.runId}/reject`]: { runId: RUN.runId, warnings: [] },
    [`/api/v1/runs/${RUN.runId}/revise`]: {
      id: 'job-0001',
      kind: 'revise',
      projectId: 'demo',
      runId: RUN.runId,
      startedAt: '2026-08-10T20:16:00.000Z',
      status: 'running',
    },
    [`/api/v1/runs/${RUN.runId}/start`]: {
      id: 'job-0002',
      kind: 'start',
      projectId: 'demo',
      runId: RUN.runId,
      startedAt: '2026-08-10T20:16:00.000Z',
      status: 'running',
    },
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const path = input.split('?')[0] ?? input;
      calls.push({
        method: init?.method ?? 'GET',
        url: input,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      if (failWith !== undefined && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify(failWith.body), {
            status: failWith.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      if (!(path in routes)) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'not_found', message: 'no such endpoint' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify(routes[path]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderActions(run: RunDetailView = RUN): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TooltipPrimitive.Provider>
        <RunActions projectId="demo" run={run} />
      </TooltipPrimitive.Provider>
    </QueryClientProvider>,
  );
}

function writes(): Call[] {
  return calls.filter((call) => call.method === 'POST');
}

describe('the approval gate', () => {
  it('shows the verdict, the hash and the tasks before anything is clicked', async () => {
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Review & approve' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Plan review: PASS')).toBeInTheDocument();
    expect(within(dialog).getByText('ff00aa11bb22')).toBeInTheDocument();

    // The hash appears twice, and both times matter: once as the plan on disk, once
    // as the plan the review claims to have judged. Seeing them side by side is how
    // a reader knows the verdict is about this document (§17).
    expect(within(dialog).getByText('Plan hash')).toBeInTheDocument();
    expect(within(dialog).getByText('Reviewed plan')).toBeInTheDocument();
    expect(within(dialog).getAllByText('a1b2c3d4e5f60718')).toHaveLength(2);
    // No version anywhere: neither artifact declares one.
    expect(within(dialog).queryByText(/version/i)).toBeNull();
  });

  it('sends no plan hash when approving', async () => {
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Review & approve' }));
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Approve Plan' }));

    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });

    // The property §90 turns on. The browser has the hash on screen — it was just
    // shown to the reader — and does not send it, because the server recomputing it
    // is the only thing that makes the approval about the plan on disk.
    expect(writes()[0]?.body).toEqual({ force: false });
    expect(JSON.stringify(writes()[0]?.body)).not.toContain('a1b2c3d4e5f60718');
  });

  it('re-reads the run instead of assuming the approval worked', async () => {
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Review & approve' }));
    await screen.findByRole('dialog');

    const before = calls.filter((call) => call.url.includes('/approval')).length;
    await userEvent.click(screen.getByRole('button', { name: 'Approve Plan' }));

    // The mutation's response is not the new state (§88). What the run looks like
    // afterwards comes from re-reading it, out of the files the CLI reads too.
    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes('/approval')).length).toBeGreaterThan(
        before,
      );
    });
  });

  it('will not approve over a refusal until the override is deliberate', async () => {
    routes[`/api/v1/runs/${RUN.runId}/approval`] = FAILING_GATE;
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Review & approve' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Plan review: FAIL')).toBeInTheDocument();
    // The findings are on screen. Approving without reading them is still possible;
    // approving without them being shown is not.
    expect(within(dialog).getByText('TASK-004 has no validation command.')).toBeInTheDocument();
    // And the degradation warning, before the decision rather than after it (R-16).
    expect(within(dialog).getByText(/same-provider/)).toBeInTheDocument();

    const approve = within(dialog).getByRole('button', { name: /Approve/ });
    expect(approve).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('checkbox'));

    // Only now, and the label says what forcing costs.
    expect(within(dialog).getByRole('button', { name: 'Approve over the review' })).toBeEnabled();
  });

  it('says a refusal that cannot be overridden cannot be overridden', async () => {
    routes[`/api/v1/runs/${RUN.runId}/approval`] = {
      ...PASSING_GATE,
      canApprove: false,
      refusal: { kind: 'already_approved', forcible: false },
    };
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Review & approve' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByText(/cannot be overridden/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Approve Plan' })).toBeDisabled();
  });

  it('shows a server refusal with what to do about it', async () => {
    failWith = {
      status: 409,
      body: {
        error: 'review_stale',
        message: 'The plan review on file judged a different version of this plan.',
        action: 'Request a revision, or approve deliberately.',
      },
    };
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Review & approve' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Approve Plan' }));

    // §95: what happened, and what to do. Two fields on the wire, two lines here.
    expect(
      await screen.findByText('The plan review on file judged a different version of this plan.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Request a revision, or approve deliberately.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('revision', () => {
  it('will not send an empty instruction', async () => {
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Revise' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Request revision' })).toBeDisabled();

    await userEvent.type(within(dialog).getByRole('textbox'), '   ');
    // Whitespace is not an instruction.
    expect(within(dialog).getByRole('button', { name: 'Request revision' })).toBeDisabled();
  });

  it('sends the instruction and nothing else', async () => {
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Revise' }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'split TASK-004');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Request revision' }));

    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    // A sentence a person typed. Never a command, never a path — the field does not
    // exist, so there is nothing to smuggle one through.
    expect(writes()[0]?.body).toEqual({ instruction: 'split TASK-004' });
  });

  it('warns that a revision clears an approval, before it happens', async () => {
    renderActions({ ...RUN, approved: true, status: 'approved' });
    await userEvent.click(screen.getByRole('button', { name: 'Revise' }));

    const dialog = await screen.findByRole('dialog');
    // The gate is granted to one specific plan. Somebody about to lose an approval
    // should be told while they can still not do it.
    expect(within(dialog).getByText(/clears that approval/)).toBeInTheDocument();
  });
});

describe('reject', () => {
  it('confirms before closing the run', async () => {
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/closes without being implemented/)).toBeInTheDocument();

    // Nothing has been sent yet: opening a confirmation is not performing the action.
    expect(writes()).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject run' }));
    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
  });

  it('sends no reason rather than an empty one', async () => {
    renderActions();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject run' }));
    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });

    // The field is optional, and `reason: ""` would record an empty explanation as
    // though somebody had written one.
    expect(writes()[0]?.body).toEqual({});
  });
});

describe('start', () => {
  it('starts an approved run and says it is running', async () => {
    renderActions({ ...RUN, approved: true, status: 'approved' });

    await userEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => {
      expect(writes()).toHaveLength(1);
    });
    expect(writes()[0]?.body).toEqual({});
    expect(writes()[0]?.url).toContain('/start');
  });

  it('shows the job while it is in flight, not a Start button', async () => {
    routes[`/api/v1/runs/${RUN.runId}/job`] = {
      id: 'job-0002',
      kind: 'start',
      projectId: 'demo',
      runId: RUN.runId,
      startedAt: '2026-08-10T20:16:00.000Z',
      status: 'running',
    };
    renderActions({ ...RUN, approved: true, status: 'approved' });

    // Two schedulers on one run would spawn the same agent twice, so the button
    // that could ask for that is not on screen while one is going.
    expect(await screen.findByText('Running…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start run|Resume run/ })).toBeNull();
  });
});

describe('a run another process is executing (AF-L01)', () => {
  it('shows the conflict through the existing error UX', async () => {
    failWith = {
      status: 409,
      body: {
        error: 'run_busy',
        message: 'AF-2026-001 is already being executed by the cli (pid 31337), since 2026-08-10T19:00:00.000Z.',
        action: 'Wait for the active execution to finish.',
        detail: { holder: { owner: 'cli', operation: 'run', pid: 31_337 }, sameHost: true },
      },
    };
    renderActions({ ...RUN, approved: true, status: 'approved' });

    await userEvent.click(screen.getByRole('button', { name: 'Start run' }));

    // §95 again, and nothing new was built for it: a lock conflict is a refusal like
    // any other, so it arrives with a message, an action, and a code to branch on.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/already being executed by the cli \(pid 31337\)/)).toBeInTheDocument();
    expect(screen.getByText('Wait for the active execution to finish.')).toBeInTheDocument();
    expect(screen.getByText('run_busy')).toBeInTheDocument();
  });
});

describe('what the browser never sends', () => {
  it('posts no path, command or hash on any action', async () => {
    renderActions({ ...RUN, approved: true, status: 'approved' });

    await userEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revise' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'change it');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Request revision' }));

    await waitFor(() => {
      expect(writes().length).toBeGreaterThanOrEqual(2);
    });

    for (const call of writes()) {
      const body = JSON.stringify(call.body ?? {});
      expect(body).not.toMatch(/planHash|"path"|"command"|cwd|runner/i);
      expect(call.url).toMatch(/^\/api\/v1\//);
      expect(call.url).not.toMatch(/\.\.|\/Users\/|\/etc\//);
    }
  });
});
