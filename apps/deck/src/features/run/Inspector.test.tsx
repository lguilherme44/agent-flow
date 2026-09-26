import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttemptHistoryView, AttentionItem, TaskDetailView } from '@contracts/index.js';
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

/**
 * P7.1, FR-020 — a task that stopped with BLOCKED can be answered from the browser.
 *
 * Before this, the attention item's only move was to select the task: the agent's question
 * was on screen and there was nowhere to type the answer, so the one way forward was the
 * terminal. The form shows the question (the task's notes), sends the typed text through
 * `api.answer`, and shows a refusal in the server's own words.
 */
describe('answering a blocked task', () => {
  beforeEach(() => clearStore());
  afterEach(() => vi.unstubAllGlobals());

  const QUESTION = 'Two endpoints can serve this; which one should the client call?';

  const blockedItem: AttentionItem = {
    id: 'agent_blocked:TASK-004',
    priority: 'P1',
    kind: 'agent_blocked',
    what: 'TASK-004 stopped and asked a question',
    why: 'The agent reported BLOCKED.',
    scope: { runId: address.runId, taskId: 'TASK-004' },
    since: '2026-09-11T10:20:00.000Z',
    // The label is the server's prose; the panel draws it and never spells its own.
    action: { kind: 'answer', label: 'Answer TASK-004', destructive: false },
    focus: 'task',
  };

  function blocked(notes: readonly string[]): TaskDetailView {
    return { ...task([attempt()]), state: 'blocked', blockReason: 'agent', notes: [...notes] };
  }

  /** Answers the task read with `view`, and the answer POST with `answer`. */
  function serveWithAnswer(view: TaskDetailView, answer: { status: number; body: unknown }) {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      const body = target.includes('/answer') && init?.method === 'POST' ? answer : { status: 200, body: view };
      return Promise.resolve(
        new Response(JSON.stringify(body.body), { status: body.status, headers: { 'content-type': 'application/json' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function answerPanel(attention: AttentionItem | undefined = blockedItem, answerRequest?: { readonly taskId: string }) {
    return (
      <Inspector
        address={address}
        taskId="TASK-004"
        card={undefined}
        attention={attention}
        past={undefined}
        liveState="blocked"
        answerRequest={answerRequest}
      />
    );
  }

  function answerCalls(fetchMock: ReturnType<typeof serveWithAnswer>) {
    return fetchMock.mock.calls.filter(([input, init]) => String(input).includes('/answer') && init?.method === 'POST');
  }

  it('opens a form with the agent’s question and sends the typed answer', async () => {
    const fetchMock = serveWithAnswer(blocked([QUESTION]), { status: 200, body: { runId: address.runId, warnings: [] } });
    render(answerPanel());

    // Closed until asked: the question is not on screen before the button is pressed.
    fireEvent.click(await screen.findByRole('button', { name: 'Answer TASK-004' }));
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByText(t.inspector.agentReported)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Call the v2 endpoint.  ' } });
    fireEvent.click(screen.getByRole('button', { name: t.inspector.sendAnswer }));

    await waitFor(() => expect(answerCalls(fetchMock)).toHaveLength(1));
    const call = answerCalls(fetchMock)[0];
    expect(String(call?.[0])).toContain(`/runs/${address.runId}/tasks/TASK-004/answer`);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ text: 'Call the v2 endpoint.' });
    // Sent means closed: the form goes away once the server took the answer.
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('shows a refusal’s message and action, and keeps the form open', async () => {
    serveWithAnswer(blocked([QUESTION]), {
      status: 409,
      body: {
        error: 'task_not_answerable',
        message: 'TASK-004 is not waiting for an answer.',
        action: 'Read its state with agent-flow status.',
      },
    });
    render(answerPanel());

    fireEvent.click(await screen.findByRole('button', { name: 'Answer TASK-004' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Call the v2 endpoint.' } });
    fireEvent.click(screen.getByRole('button', { name: t.inspector.sendAnswer }));

    expect(await screen.findByText(/TASK-004 is not waiting for an answer\. Read its state with agent-flow status\./)).toBeInTheDocument();
    expect(screen.getByText('task_not_answerable')).toBeInTheDocument();
    // What was typed survives the refusal, so fixing the cause does not cost the answer.
    expect(screen.getByRole('textbox')).toHaveValue('Call the v2 endpoint.');
  });

  it('shows no question when the agent left no notes', async () => {
    serveWithAnswer(blocked([]), { status: 200, body: { runId: address.runId, warnings: [] } });
    render(answerPanel());

    fireEvent.click(await screen.findByRole('button', { name: 'Answer TASK-004' }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByText(t.inspector.agentReported)).toBeNull();
  });

  it('opens when the page asks for it, without the button being pressed', async () => {
    // The attention queue's button sits above this panel; `RunPage` asks for the form.
    serveWithAnswer(blocked([QUESTION]), { status: 200, body: { runId: address.runId, warnings: [] } });
    render(answerPanel(blockedItem, { taskId: 'TASK-004' }));

    expect(await screen.findByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('does not carry a half-typed answer to the next selected task', async () => {
    // The panel is not keyed by task, so its state survives a change of selection. A text
    // typed for TASK-004 must not be in the box when the form opens for TASK-005 — one click
    // from being sent to the wrong task.
    serveWithAnswer(blocked([QUESTION]), { status: 200, body: { runId: address.runId, warnings: [] } });
    const other: AttentionItem = {
      ...blockedItem,
      id: 'agent_blocked:TASK-005',
      scope: { runId: address.runId, taskId: 'TASK-005' },
      action: { kind: 'answer', label: 'Answer TASK-005', destructive: false },
    };
    const panelFor = (taskId: string, attention: AttentionItem) => (
      <Inspector address={address} taskId={taskId} card={undefined} attention={attention} past={undefined} liveState="blocked" />
    );
    const { rerender } = render(panelFor('TASK-004', blockedItem));

    fireEvent.click(await screen.findByRole('button', { name: 'Answer TASK-004' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Meant for TASK-004 only.' } });

    rerender(panelFor('TASK-005', other));
    fireEvent.click(await screen.findByRole('button', { name: 'Answer TASK-005' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('offers no Answer button for an item that is not an answer', async () => {
    // Positive control: keyed on `action.kind`, like retry. A button drawn for every
    // attention item would be a button whose only outcome is a refusal.
    serveWithAnswer(blocked([QUESTION]), { status: 200, body: { runId: address.runId, warnings: [] } });
    render(answerPanel({ ...blockedItem, action: { kind: 'inspect', label: 'Read what it asked', destructive: false } }));

    // Awaited on the task's title, which only the fetched detail draws, so the absence
    // below is measured after the panel could have drawn the button.
    await screen.findByText('Close the gap');
    expect(screen.queryByRole('button', { name: 'Answer TASK-004' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
