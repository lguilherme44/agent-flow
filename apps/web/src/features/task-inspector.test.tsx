import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { TaskDetailView } from '@contracts/index.js';
import { createQueryClient } from '../app/App';
import { TaskInspector } from './task-inspector';

/**
 * UI-30 — how a task ended, said the way §95 asks.
 *
 * The status chip says FAILED. It does not say that the run halted, which command
 * exited non-zero, or that retrying is the next move — and those are the three a
 * person actually needs when they open a failed task.
 */

const task = (overrides: Partial<TaskDetailView> = {}): TaskDetailView => ({
  id: 'TASK-004',
  title: 'Recurrence Service',
  complexity: 'complex',
  risk: 'high',
  state: 'completed',
  attempts: 1,
  requirements: ['FR-004'],
  dependencies: ['TASK-003'],
  description: 'The service that expands a recurrence.',
  acceptanceCriteria: [],
  validation: ['test'],
  validationExpectation: 'pass',
  files: [],
  filesChanged: [],
  notes: [],
  commands: [],
  log: [],
  ...overrides,
});

function show(detail: TaskDetailView): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TaskInspector task={detail} projectId="demo" runId="AF-2026-001" />
    </QueryClientProvider>,
  );
}

describe('how a task ended', () => {
  it('says what failed, where, that the run stopped, and what to do', () => {
    show(
      task({
        state: 'failed',
        commands: [
          {
            command: 'npm test -- recurrence',
            exitCode: 1,
            durationMs: 18_400,
            stdout: '1 failing',
            stderr: '',
          },
        ],
      }),
    );

    expect(screen.getByText('TASK-004 failed validation.')).toBeInTheDocument();
    expect(screen.getByText(/npm test -- recurrence/)).toBeInTheDocument();
    expect(screen.getByText(/exit 1/)).toBeInTheDocument();
    expect(screen.getByText(/The run stopped here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Command output' })).toBeEnabled();
  });

  it('names the error code when nothing ran to produce an exit code', () => {
    show(task({ state: 'failed', errorCode: 'timeout' }));

    expect(screen.getByText('TASK-004 failed: timeout.')).toBeInTheDocument();
  });

  it('says a blocked task will not retry itself (§23)', () => {
    // The distinction that matters: BLOCKED is not "waiting", it is "waiting for a
    // person", and nothing will move it until one appears.
    show(task({ state: 'blocked' }));

    expect(screen.getByText('TASK-004 is blocked.')).toBeInTheDocument();
    expect(screen.getByText(/will not be retried on its own/)).toBeInTheDocument();
  });

  it('says an interrupted task recorded nothing, rather than that it failed', () => {
    show(task({ state: 'interrupted' }));

    expect(screen.getByText('TASK-004 was interrupted.')).toBeInTheDocument();
    expect(screen.getByText(/was not recorded/)).toBeInTheDocument();
  });

  it('says nothing at all about a task that simply worked', () => {
    // A completed task needs no notice. A dashboard that annotated every success
    // teaches people to stop reading the annotations.
    show(task({ state: 'completed' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/The run stopped here/)).toBeNull();
  });

  it('reports a degradation as provenance, not as a failure', () => {
    // The run continued. Saying so is the difference §95 draws between "the
    // workflow stopped" and "the workflow continues, on weaker terms".
    show(
      task({
        state: 'completed',
        runner: 'claude',
        fallback: { from: 'codex', errorCode: 'quota_exceeded' },
        reasoningClamped: true,
      }),
    );

    expect(screen.getByText(/Ran on claude after codex returned quota_exceeded/)).toBeInTheDocument();
    expect(screen.getByText(/Ran below the configured effort/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/**
 * M2-10 — where a task's validated tree landed, and where it has not (§21.2).
 */
describe('integration provenance', () => {
  const INTEGRATION = {
    attempt: 2,
    branch: 'agent-flow/AF-2026-001-9f2c1a/integration',
    marker: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    mergeCommit: 'ffff6666aaaa7777bbbb8888cccc9999dddd0000',
    validatedTree: '1111aaaa2222bbbb3333cccc4444dddd5555eeee',
    integratedAt: '2026-08-10T20:11:00.000Z',
  } as const;

  it('says a validated attempt is not completed until it is merged', () => {
    // The state `TaskState` has no name for, and the one that matters most while a
    // parallel run is in flight: the work is done and the merge is what is
    // outstanding. Saying "completed" here would release dependents against a
    // branch their dependency's work is not on (I-3).
    show(task({ state: 'running', awaitingIntegration: true }));

    expect(screen.getByText('TASK-004 is validated and waiting to be merged.')).toBeInTheDocument();
    expect(screen.getByText(/completed means integrated/)).toBeInTheDocument();
  });

  it('shows the marker, the merge and the validated tree once it has landed', () => {
    show(task({ state: 'completed', attempts: 2, integration: INTEGRATION }));

    expect(screen.getByText('Integration')).toBeInTheDocument();
    // Abbreviated on screen, whole in the tooltip: these are object ids somebody
    // pastes into `git show`.
    expect(screen.getByText('ffff6666')).toHaveAttribute('title', INTEGRATION.mergeCommit);
    expect(screen.getByText('aaaa1111')).toHaveAttribute('title', INTEGRATION.marker);
    expect(screen.getByText('1111aaaa')).toHaveAttribute('title', INTEGRATION.validatedTree);
    expect(screen.getByText(INTEGRATION.branch)).toBeInTheDocument();
  });

  it('says nothing about integration on a sequential task', () => {
    show(task({ state: 'completed' }));

    expect(screen.queryByText('Integration')).toBeNull();
    expect(screen.queryByText(/waiting to be merged/)).toBeNull();
  });

  it('renders no filesystem path, only refs and object ids', () => {
    show(task({ state: 'completed', integration: INTEGRATION }));

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\/(Users|home|tmp|var)\//);
    expect(text).not.toMatch(/\.agent-flow\/worktrees/);
  });
});

/**
 * AR-08 — what each attempt did, not only the newest one.
 *
 * `attemptHistory` existed on the wire before this tab did: `server/run-reader.ts`
 * assembled it from `attempt-<n>.json` and nothing rendered it, so a task retried
 * twice before succeeding had two attempts nobody could see.
 */
describe('Attempts', () => {
  it('says nothing was recorded rather than showing an empty table', async () => {
    show(task({ state: 'completed' }));
    await userEvent.click(screen.getByRole('tab', { name: /Attempts/ }));

    expect(screen.getByText('No recorded attempts.')).toBeInTheDocument();
  });

  it('shows every attempt, its failure class and its own log — oldest first', async () => {
    show(
      task({
        state: 'completed',
        attempts: 2,
        attemptHistory: [
          {
            attempt: 1,
            outcome: 'failed',
            runner: 'agy',
            model: 'gemini-3.1-pro-high',
            reasoning: 'medium',
            reasoningClamped: false,
            startedAt: '2026-08-10T19:40:00.000Z',
            finishedAt: '2026-08-10T19:41:30.000Z',
            failureClass: 'validation_unsatisfied',
            failedCommands: ['npm test -- recurrence'],
            log: ['[19:41:29] 1 failing'],
          },
          {
            attempt: 2,
            outcome: 'succeeded',
            runner: 'agy',
            model: 'gemini-3.1-pro-high',
            reasoning: 'medium',
            reasoningClamped: false,
            startedAt: '2026-08-10T19:42:00.000Z',
            finishedAt: '2026-08-10T19:43:00.000Z',
            failedCommands: [],
            log: ['[19:42:59] all tests passing'],
          },
        ],
      }),
    );

    await userEvent.click(screen.getByRole('tab', { name: /Attempts/ }));

    const first = screen.getByText('Attempt 1').closest('div');
    expect(first).not.toBeNull();
    expect(first?.parentElement).toHaveTextContent('failed');
    expect(screen.getByText(/validation unsatisfied/)).toBeInTheDocument();
    expect(screen.getByText(/npm test -- recurrence/)).toBeInTheDocument();
    expect(screen.getByText(/1 failing/)).toBeInTheDocument();

    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText(/all tests passing/)).toBeInTheDocument();
  });
});
