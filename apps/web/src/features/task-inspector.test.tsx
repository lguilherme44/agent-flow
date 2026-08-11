import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
