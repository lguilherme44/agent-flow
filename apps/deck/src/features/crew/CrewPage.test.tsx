import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigEditorView, ProjectView, RoleRouteView, RunnerTypeView } from '@contracts/index.js';
import { clearStore } from '../../lib/store';
import { CrewPage } from './CrewPage';

const revision = `sha256:${'a'.repeat(64)}`;
const projects: ProjectView[] = [
  { id: 'flowcanvas', name: 'Flow Canvas', path: '/wk/flowcanvas', currentRunId: 'AF-1', status: 'running', runCount: 1 },
  { id: 'agent-flow', name: 'Agent Flow', path: '/wk/agent-flow', currentRunId: null, status: null, runCount: 0 },
];
const editor = (scope: 'global' | 'project', projectId?: string): ConfigEditorView => ({
  target: { scope, ...(projectId === undefined ? {} : { projectId }) }, revision, exists: true, unknownKeys: [],
  fields: [
    { path: ['runners', 'moe', 'type'], explicitValue: 'codex-cli', effectiveValue: 'codex-cli', origin: scope, editable: true, effect: 'next_execution_context', valueType: 'string' },
    { path: ['runners', 'moe', 'enabled'], explicitValue: true, effectiveValue: true, origin: scope, editable: true, effect: 'next_execution_context', valueType: 'boolean' },
    { path: ['runners', 'endpoint', 'type'], explicitValue: 'openai-compatible', effectiveValue: 'openai-compatible', origin: scope, editable: true, effect: 'next_execution_context', valueType: 'string' },
    { path: ['runners', 'gem', 'type'], explicitValue: 'agy-cli', effectiveValue: 'agy-cli', origin: scope, editable: true, effect: 'next_execution_context', valueType: 'string' },
    { path: ['runners', 'gem', 'enabled'], explicitValue: true, effectiveValue: true, origin: scope, editable: true, effect: 'next_execution_context', valueType: 'boolean' },
    { path: ['roles', 'architect', 'runner'], explicitValue: 'moe', effectiveValue: 'moe', origin: scope, editable: true, effect: 'next_execution_context', valueType: 'string' },
    { path: ['roles', 'architect', 'model'], explicitValue: undefined, effectiveValue: undefined, origin: 'default', editable: true, effect: 'next_execution_context', valueType: 'string' },
    { path: ['roles', 'architect', 'effort'], explicitValue: 'high', effectiveValue: 'high', origin: scope, editable: true, effect: 'next_execution_context', valueType: 'reasoning_level', options: ['low', 'medium', 'high', 'very_high'] },
    { path: ['roles', 'executors', 'trivial', 'runner'], explicitValue: 'ghost', effectiveValue: 'ghost', origin: scope, editable: true, effect: 'next_execution_context', valueType: 'string' },
    { path: ['parallelism', 'maxTasks'], explicitValue: scope === 'global' ? 2 : undefined, effectiveValue: 2, origin: 'global', editable: true, effect: 'next_execution_context', valueType: 'integer' },
    { path: ['git', 'useWorktrees'], explicitValue: true, effectiveValue: true, origin: 'global', editable: scope === 'global', ...(scope === 'project' ? { reason: 'global_only' as const } : {}), effect: 'next_run', valueType: 'boolean' },
    { path: ['ui', 'allowedHosts'], explicitValue: ['localhost'], effectiveValue: ['localhost'], origin: 'global', editable: scope === 'global', ...(scope === 'project' ? { reason: 'global_only' as const } : {}), effect: 'server_restart', valueType: 'string_list' },
    { path: ['teams', 'reviewers', 'name'], explicitValue: 'Reviewers', effectiveValue: 'Reviewers', origin: scope, editable: true, effect: 'next_execution_context', valueType: 'string' },
  ],
  dynamicFields: [
    { path: ['runners', '*', 'type'], editable: true, effect: 'next_execution_context', valueType: 'string' },
    { path: ['teams', '*', 'name'], editable: scope === 'global', ...(scope === 'project' ? { reason: 'global_only' as const } : {}), effect: 'next_execution_context', valueType: 'string' },
  ],
});

const routes: RoleRouteView[] = [
  {
    role: 'architect', configKeys: ['roles', 'architect'], prompts: ['discovery'],
    requiresReadOnly: true, requiresWorkingDirectory: false, requiresNativeStructuredOutput: false,
    configured: { runner: 'moe', reasoning: 'high', timeoutSeconds: 900 },
    resolved: { runner: 'moe', reasoning: 'medium', reasoningClamped: true, structuredOutput: 'native' },
  },
  {
    role: 'executor.trivial', configKeys: ['roles', 'executors', 'trivial'], prompts: ['implementation'],
    requiresReadOnly: false, requiresWorkingDirectory: true, requiresNativeStructuredOutput: false,
    configured: { runner: 'ghost', reasoning: 'low', timeoutSeconds: 900 },
    error: { kind: 'unknown_runner', message: "Runner 'ghost' is not configured." },
  },
];

const runnerTypes: RunnerTypeView[] = [
  {
    type: 'codex-cli',
    fields: [{ name: 'command', required: false }, { name: 'model', required: false }],
    capabilities: { supportedReasoningLevels: ['low', 'medium', 'high'], supportsReadOnly: true, supportsWorkingDirectory: true, structuredOutputStrategy: 'prompted' },
  },
  {
    type: 'openai-compatible',
    fields: [{ name: 'baseUrl', required: true }, { name: 'apiKeyEnv', required: false, secretEnv: true }],
    capabilities: { supportedReasoningLevels: ['low', 'high'], supportsReadOnly: true, supportsWorkingDirectory: false, structuredOutputStrategy: 'native' },
  },
  {
    // The other half of the matrix, and its absence is why the bulk bar shipped a sentence
    // that named the wrong reason for a year: every fixture here could read-only, so the
    // read-only refusal had no test and the hard-coded text was never contradicted.
    type: 'agy-cli',
    fields: [{ name: 'command', required: false }, { name: 'model', required: false }],
    capabilities: { supportedReasoningLevels: ['low', 'medium', 'high'], supportsReadOnly: false, supportsWorkingDirectory: true, structuredOutputStrategy: 'prompted' },
  },
];

const sources = {
  sources: { globalPath: '/home/dev/.agent-flow/config.yaml', globalPresent: true, projectPath: '/wk/flowcanvas/.agent-flow/config.yaml', projectPresent: true },
  sections: [],
};

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('CrewPage configuration workflow', () => {
  beforeEach(() => {
    clearStore();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target.endsWith('/projects')) return response(projects);
      if (target.includes('/config/editor') && (init?.method === undefined || init.method === 'GET')) {
        const url = new URL(target, 'http://deck');
        const scope = url.searchParams.get('scope') as 'global' | 'project';
        return response(editor(scope, url.searchParams.get('projectId') ?? undefined));
      }
      if (target.includes('/config/editor/validate')) return response({ valid: true, revision, diagnostics: [], changes: [{ path: ['parallelism', 'maxTasks'], before: 2, after: 1, effect: 'next_execution_context' }] });
      if (target.includes('/agents')) return response(routes);
      if (target.includes('/runner-types')) return response(runnerTypes);
      if (target.includes('/runners/models')) return response([{ id: 'moe', models: ['gpt-5-codex', 'gpt-5-codex-mini'] }]);
      if (target.includes('/config?') || target.endsWith('/config')) return response(sources);
      if (target.includes('/runners/health')) return response([{ id: 'moe', installed: true, executable: true, auth: 'configured' }]);
      return response({ status: 'applied', view: editor('project', 'flowcanvas'), changes: [] });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('names the file each scope writes, and folds inherited values away until asked', async () => {
    render(<CrewPage projectId="flowcanvas" />);
    expect(await screen.findByLabelText('Project')).toHaveValue('flowcanvas');
    // A scope is a file, and one of the two gets committed with the repository.
    expect(await screen.findByText('/home/dev/.agent-flow/config.yaml')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /This project/ }));
    expect(await screen.findByText('/wk/flowcanvas/.agent-flow/config.yaml')).toBeInTheDocument();

    // The runner a role points at cannot be removed while that reference stands.
    expect(await screen.findByRole('button', { name: 'Remove runner moe' })).toBeDisabled();
    // The count is what the card shows; the paths themselves are its title.
    expect(screen.getByText(/Referenced by 1 route/)).toHaveAttribute('title', 'roles.architect.runner');

    fireEvent.click(await screen.findByRole('tab', { name: /Advanced/ }));
    // Runners and the three routed leaves belong to the Crew tab, so they are not counted
    // among the machine settings this half is about.
    expect(await screen.findByText(/3 of 4 fields are set in this source/)).toBeInTheDocument();
    expect(screen.queryByLabelText('parallelism.maxTasks')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show inherited'));
    expect(await screen.findByText(/Inherited from global/)).toBeInTheDocument();
    expect(screen.getByLabelText('parallelism.maxTasks')).toHaveAttribute('placeholder', '2');
    expect(screen.getAllByText(/Global only/)).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Teams' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'agent-flow' } });
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('agent-flow'));
  });

  it('gives each value the control its declared type deserves, and writes the typed value', async () => {
    render(<CrewPage />);
    await screen.findByLabelText('Project');

    const enabled = await screen.findByLabelText('runners.moe.enabled');
    expect(enabled).toHaveAttribute('role', 'switch');
    expect(enabled).toBeChecked();

    const effort = screen.getByLabelText('roles.architect.effort');
    expect([...effort.querySelectorAll('option')].map((option) => option.value)).toEqual(['', 'low', 'medium', 'high', 'very_high']);

    fireEvent.click(enabled);
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/config/editor/validate'));
      const body = JSON.parse(String(call?.[1]?.body)) as { operations: unknown[] };
      // `false`, not the word "false": the type reached the operation, not just the widget.
      expect(body.operations).toContainEqual({ kind: 'set', path: ['runners', 'moe', 'enabled'], value: false });
    });
  });

  it('edits a role route in place and writes it to the path the server published', async () => {
    render(<CrewPage />);
    const runner = await screen.findByLabelText('roles.executors.trivial.runner');
    // `executor.trivial` lives at `roles.executors.trivial`. The browser is told, never
    // asked to reconstruct it from the role name.
    expect(runner.tagName).toBe('SELECT');
    fireEvent.change(runner, { target: { value: 'moe' } });
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/config/editor/validate'));
      const body = JSON.parse(String(call?.[1]?.body)) as { operations: unknown[] };
      expect(body.operations).toContainEqual({ kind: 'set', path: ['roles', 'executors', 'trivial', 'runner'], value: 'moe' });
    });
  });

  it('shows a route pointing at an undeclared runner as broken instead of as inherited', async () => {
    render(<CrewPage />);
    const runner = await screen.findByLabelText('roles.executors.trivial.runner');
    // The value stays selected and is marked: falling back to the empty option would
    // render `ghost` as "inherit" and the next save would delete the line.
    expect(runner).toHaveValue('ghost');
    expect(screen.getByRole('option', { name: 'ghost — not declared' })).toBeInTheDocument();
    expect(screen.getByText("Runner 'ghost' is not configured.")).toBeInTheDocument();
  });

  it('keeps runner, model and effort in the role table only, never twice', async () => {
    render(<CrewPage />);
    await screen.findByLabelText('roles.architect.runner');
    expect(screen.getAllByLabelText('roles.architect.runner')).toHaveLength(1);
    expect(screen.getByLabelText('roles.architect.runner').closest('.crew-roles')).not.toBeNull();
    expect(screen.getByText(/effort high ran as medium/)).toBeInTheDocument();
  });

  it('offers the models the routed runner reported, without closing the field', async () => {
    render(<CrewPage />);
    const model = await screen.findByLabelText('roles.architect.model');

    // `architect` is routed to `moe`, so the ids offered are the ones `moe` reported.
    expect(model).toHaveAttribute('list');
    const list = document.getElementById(model.getAttribute('list') ?? '');
    expect([...(list?.querySelectorAll('option') ?? [])].map((option) => option.getAttribute('value')))
      .toEqual(['gpt-5-codex', 'gpt-5-codex-mini']);

    // A suggestion, not a constraint: a model released this morning is still typeable.
    expect(model.tagName).toBe('INPUT');
    fireEvent.change(model, { target: { value: 'a-model-released-this-morning' } });
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/config/editor/validate'));
      const body = JSON.parse(String(call?.[1]?.body)) as { operations: unknown[] };
      expect(body.operations).toContainEqual({ kind: 'set', path: ['roles', 'architect', 'model'], value: 'a-model-released-this-morning' });
    });
  });

  /**
   * The refusal names the check that actually failed (PRI-26).
   *
   * The sentence under the bulk bar hard-coded one of the two reasons — "has no working
   * directory, so it cannot serve a role that writes" — whichever check had failed. Against
   * a runner with no read-only mode that is wrong twice over: the failing check is the
   * other one, and this is precisely the runner that *can* write. An operator pointed the
   * whole crew at `agy`, watched six posts get skipped, and read the opposite of the truth.
   */
  it('names the read-only refusal as a read-only refusal', async () => {
    render(<CrewPage />);
    const pick = await screen.findByLabelText('Assign every role to');

    fireEvent.change(pick, { target: { value: 'gem' } });

    // `architect` needs read-only, which this runner has not; `executor.trivial` writes.
    expect(screen.getByRole('button', { name: 'Apply to 1 role' })).toBeEnabled();
    // The whole sentence, because `no read-only mode` also appears as a tag on the runner
    // card — and a query that matched either would pass on the card alone, which is the
    // element that was already right.
    expect(
      screen.getByText(/gem has no read-only mode, so it cannot serve a role that must not write/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no working directory/)).not.toBeInTheDocument();
  });

  /**
   * A runner turned off with roles still on it says so (PRI-27).
   *
   * `Remove` is refused while any route references a runner; the switch beside it was not,
   * for the same consequence — every role pointing there resolves to `runner_disabled`.
   * A live project had three lines of YAML turning `claude` off, six roles still on it, and
   * six red rows underneath. The card printed the route count and said nothing about what
   * the switch had done.
   */
  it('warns when a runner is switched off with routes still pointing at it', async () => {
    render(<CrewPage />);
    await screen.findByLabelText('Assign every role to');

    // `moe` is enabled and `architect` points at it: a plain reference, stated quietly.
    expect(screen.getByText(/Referenced by 1 route/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /runners\.moe\.enabled/ }));

    expect(screen.getByText(/1 route still points here/)).toBeInTheDocument();
    expect(screen.getByText(/cannot run until/)).toBeInTheDocument();
  });

  it('assigns every role at once, and leaves out the ones the runner cannot serve', async () => {
    render(<CrewPage />);
    const pick = await screen.findByLabelText('Assign every role to');

    // `moe` is codex-cli: a working directory, so it can take the executor too.
    fireEvent.change(pick, { target: { value: 'moe' } });
    expect(screen.getByRole('button', { name: 'Apply to 2 roles' })).toBeEnabled();

    // An endpoint has no working directory. The resolver refuses it for a role that
    // opens files, so the button offers the roles it can actually take and says why.
    fireEvent.change(pick, { target: { value: 'endpoint' } });
    expect(screen.getByRole('button', { name: 'Apply to 1 role' })).toBeEnabled();
    expect(screen.getByText(/no working directory/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 role' }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/config/editor/validate'));
      const body = JSON.parse(String(call?.[1]?.body)) as { operations: unknown[] };
      expect(body.operations).toEqual([{ kind: 'set', path: ['roles', 'architect', 'runner'], value: 'endpoint' }]);
    });
  });

  it('restores inheritance by submitting an unset operation for the local node', async () => {
    render(<CrewPage projectId="flowcanvas" />);
    await screen.findByLabelText('Project');
    fireEvent.click(screen.getByRole('button', { name: /This project/ }));
    fireEvent.click(await screen.findByRole('tab', { name: /Advanced/ }));
    const teamInput = await screen.findByLabelText('teams.reviewers.name');
    const inherit = teamInput.closest('.crew-field')?.querySelector('button');
    expect(inherit).toHaveTextContent('Inherit');
    fireEvent.click(inherit!);
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/config/editor/validate'));
      const body = JSON.parse(String(call?.[1]?.body)) as { operations: unknown[] };
      expect(body.operations).toContainEqual({ kind: 'unset', path: ['teams', 'reviewers', 'name'] });
    });
  });

  it('declares a runner from the types the server supports, type first', async () => {
    render(<CrewPage projectId="flowcanvas" />);
    await screen.findByLabelText('Project');
    fireEvent.click(await screen.findByRole('button', { name: /Add runner/ }));

    // Nothing is offered until the type is known: the type decides which keys exist.
    fireEvent.change(screen.getByLabelText('id'), { target: { value: 'local' } });
    expect(screen.queryByLabelText(/baseUrl/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('type'), { target: { value: 'openai-compatible' } });

    const add = screen.getByRole('button', { name: 'Add runner' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('baseUrl *'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByLabelText('apiKeyEnv'), { target: { value: 'LOCAL_LLM_API_KEY' } });
    fireEvent.click(add);

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/config/editor/validate'));
      const body = JSON.parse(String(call?.[1]?.body)) as { operations: unknown[] };
      expect(body.operations).toContainEqual({ kind: 'set', path: ['runners', 'local', 'type'], value: 'openai-compatible' });
      expect(body.operations).toContainEqual({ kind: 'set', path: ['runners', 'local', 'baseUrl'], value: 'http://127.0.0.1:8080/v1' });
      // The variable's name, never its value (§7.1).
      expect(body.operations).toContainEqual({ kind: 'set', path: ['runners', 'local', 'apiKeyEnv'], value: 'LOCAL_LLM_API_KEY' });
    });
  });

  it('shows a runner as a card carrying its health and the roles that depend on it', async () => {
    render(<CrewPage projectId="flowcanvas" />);
    const card = (await screen.findByText('moe', { selector: '.runner-card__id' })).closest('.runner-card');
    expect(card).not.toBeNull();
    // Health used to live in a separate card at the foot of the page, unconnected to the
    // configuration it describes.
    expect(card).toHaveTextContent(/configured/i);
    // `codex-cli` is a type the server declares; the card can therefore say what it does.
    expect(card).toHaveTextContent('works in the repo');
    expect(screen.getByRole('button', { name: 'Remove runner moe' })).toBeDisabled();
  });

  it('creates a generic nested dynamic entry from the server catalog', async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const target = String(input);
      if (target.endsWith('/projects')) return response(projects);
      if (target.includes('/config/editor') && init?.method === undefined) {
        const view = editor('global');
        return response({ ...view, dynamicFields: [{ path: ['teams', '*', 'members', '*', 'runner'], editable: true, effect: 'next_execution_context', valueType: 'string' }] });
      }
      if (target.includes('/config/editor/validate')) return response({ valid: true, revision, diagnostics: [], changes: [] });
      if (target.includes('/runner-types')) return response(runnerTypes);
      if (target.includes('/runners/models')) return response([{ id: 'moe', models: ['gpt-5-codex', 'gpt-5-codex-mini'] }]);
      if (target.includes('/config?') || target.endsWith('/config')) return response(sources);
      if (target.includes('/agents') || target.includes('/runners/health')) return response([]);
      return response({});
    });
    render(<CrewPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Advanced/ }));
    fireEvent.click(await screen.findByText('Dynamic configuration'));
    fireEvent.change(screen.getByLabelText('Known field'), { target: { value: 'teams.*.members.*.runner' } });
    fireEvent.change(screen.getByLabelText('Identifier teams'), { target: { value: 'delivery' } });
    fireEvent.change(screen.getByLabelText('Identifier members'), { target: { value: 'builder' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add configuration field' }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/config/editor/validate'));
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ operations: [{ kind: 'set', path: ['teams', 'delivery', 'members', 'builder', 'runner'], value: 'local' }] });
    });
  });

  it('shows validation errors and blocks save', async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const target = String(input);
      if (target.endsWith('/projects')) return response(projects);
      if (target.includes('/config/editor') && init?.method === undefined) return response(editor('global'));
      if (target.includes('/config/editor/validate')) return response({ valid: false, revision, diagnostics: [{ severity: 'error', code: 'bad', path: ['parallelism', 'maxTasks'], message: 'Must be positive.' }], changes: [] }, 422);
      if (target.includes('/runner-types')) return response(runnerTypes);
      if (target.includes('/runners/models')) return response([{ id: 'moe', models: ['gpt-5-codex', 'gpt-5-codex-mini'] }]);
      if (target.includes('/config?') || target.endsWith('/config')) return response(sources);
      if (target.includes('/config?') || target.endsWith('/config')) return response(sources);
      if (target.includes('/agents') || target.includes('/runners/health')) return response([]);
      return response({});
    });
    render(<CrewPage />);
    await screen.findByLabelText('Project');
    fireEvent.click(screen.getByRole('tab', { name: /Advanced/ }));
    fireEvent.change(await screen.findByLabelText('parallelism.maxTasks'), { target: { value: '0' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Must be positive.');
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  });

  it('keeps fresh server state visible after a stale 409 instead of overwriting it', async () => {
    const fresh = { ...editor('global'), revision: `sha256:${'b'.repeat(64)}` };
    vi.mocked(fetch).mockImplementation((input, init) => {
      const target = String(input);
      if (target.endsWith('/projects')) return response(projects);
      if (target.includes('/config/editor') && init?.method === undefined) return response(editor('global'));
      if (target.includes('/config/editor/validate')) return response({ valid: true, revision, diagnostics: [], changes: [{ path: ['parallelism', 'maxTasks'], before: 2, after: 3, effect: 'next_execution_context' }] });
      if (target.includes('/config/editor') && init?.method === 'PATCH') return response({ error: 'revision_conflict', message: 'The configuration changed after it was loaded.', view: fresh }, 409);
      if (target.includes('/runner-types')) return response(runnerTypes);
      if (target.includes('/runners/models')) return response([{ id: 'moe', models: ['gpt-5-codex', 'gpt-5-codex-mini'] }]);
      if (target.includes('/config?') || target.endsWith('/config')) return response(sources);
      if (target.includes('/config?') || target.endsWith('/config')) return response(sources);
      if (target.includes('/agents') || target.includes('/runners/health')) return response([]);
      return response({});
    });
    render(<CrewPage />);
    await screen.findByLabelText('Project');
    fireEvent.click(screen.getByRole('tab', { name: /Advanced/ }));
    fireEvent.change(await screen.findByLabelText('parallelism.maxTasks'), { target: { value: '3' } });
    await screen.findByText(/takes effect/);
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed after it was loaded/i);
    expect(screen.getByText(/fresh server state/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(vi.mocked(fetch).mock.calls.filter(([input, request]) => String(input).includes('/config/editor') && request?.method === 'PATCH')).toHaveLength(1);
  });

  it('reports loading and read errors accessibly', async () => {
    vi.mocked(fetch).mockImplementation((input) => String(input).endsWith('/projects') ? Promise.reject(new Error('offline')) : response([]));
    render(<CrewPage />);
    expect(screen.getByLabelText('loading')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/projects could not be read/i);
  });
});
