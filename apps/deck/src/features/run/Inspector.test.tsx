import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptHistoryView, TaskDetailView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { Inspector } from './Inspector';
import { en, ptBR as t, ptBR } from '../../lib/i18n';

/**
 * D19 — a task a person closed must not read like one the model closed.
 *
 * The field travelled from the attempt artifact to `AttemptHistoryView` and stopped there:
 * the attempt row rendered `{runner} · {model} · {duration}`, so `runner: 'human'` was the
 * only hint, and reading intent out of a runner id is exactly the guess the contract's own
 * comment forbids — it would be wrong the day somebody names a runner `human`.
 *
 * The second test is the control. A rule that cannot tell the two apart passes forever,
 * and a marker drawn on every row would say nothing at all.
 */

const address = { projectId: 'flowcanvas', runId: 'AF-2026-001' };

function attempt(overrides: Partial<AttemptHistoryView> = {}): AttemptHistoryView {
  return {
    attempt: 1,
    outcome: 'succeeded',
    runner: 'agy',
    model: 'a-model',
    reasoning: 'high',
    reasoningClamped: false,
    startedAt: '2026-09-11T10:00:00.000Z',
    finishedAt: '2026-09-11T10:20:00.000Z',
    failedCommands: [],
    log: [],
    ...overrides,
  };
}

/**
 * The row a revalidation leaves: no model, because no model ran.
 *
 * Built by omission rather than by `model: undefined` — the contract's optional fields are
 * exact, and a key present with an undefined value is a different thing from an absent one.
 */
function humanAttempt(): AttemptHistoryView {
  const { model: _model, ...rest } = attempt({ attempt: 2, runner: 'human' });
  return { ...rest, closedBy: 'human' };
}

function task(history: readonly AttemptHistoryView[]): TaskDetailView {
  return {
    id: 'TASK-004',
    title: 'Close the gap',
    complexity: 'complex',
    risk: 'medium',
    state: 'running',
    attempts: history.length,
    requirements: ['FR-001'],
    dependencies: [],
    description: 'Work.',
    acceptanceCriteria: [],
    validation: ['test'],
    validationExpectation: 'pass',
    files: [],
    filesChanged: [],
    notes: [],
    commands: [],
    log: [],
    attemptHistory: [...history],
  };
}

function serve(view: TaskDetailView): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(view), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

/** The panel with its one fetch already stubbed — everything it draws comes from `serve`. */
function panel() {
  return (
    <Inspector
      address={address}
      taskId="TASK-004"
      card={undefined}
      attention={undefined}
      past={undefined}
      liveState="running"
    />
  );
}

describe('the attempt history says who closed each attempt (D19)', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  it('marks the attempt a person closed by hand', async () => {
    serve(task([attempt(), humanAttempt()]));
    render(panel());

    const marked = await screen.findAllByTestId('attempt-closed-by-human');
    expect(marked).toHaveLength(1);
    // The words, not only the hook: a marker nobody can read is not a marker.
    expect(marked[0]?.textContent).toBe(t.inspector.closedByHuman);
  });

  it('marks nothing on an attempt the model closed', async () => {
    // The positive control. Drawn on every row, the marker would carry no information —
    // and this is the assertion that fails if the condition is ever inverted or dropped.
    serve(task([attempt(), attempt({ attempt: 2 })]));
    render(panel());

    // Awaited on something the panel always draws, so the absence below is measured after
    // the fetch settled rather than before it started.
    await screen.findByText('TASK-004');
    expect(screen.queryByTestId('attempt-closed-by-human')).toBeNull();
  });

  it('says it in both languages', () => {
    // The dictionaries are typed, so a missing key is already a compile error — this is
    // about the phrase being a real sentence in each rather than the English one copied
    // across, which the type system cannot see.
    expect(en.inspector.closedByHuman).toBe('closed by a person');
    expect(ptBR.inspector.closedByHuman).toBe('fechada por uma pessoa');
  });
});
