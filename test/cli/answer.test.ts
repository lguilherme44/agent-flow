import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { StateStore } from '../../src/app/state-store.js';
import { planHash } from '../../src/app/approval.js';
import { approve, type RunActionDeps } from '../../src/app/run-actions.js';
import { runAnswerCommand, type AnswerCommandDeps } from '../../src/cli/run.js';
import { main } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { GlobalOptions } from '../../src/cli/index.js';
import { PlanSchema } from '../../src/contracts/index.js';

/**
 * P7.1 at the command line — `agent-flow answer <task> [text]` (FR-001, FR-021).
 *
 * Through the real `answerTask` over an in-memory project, so "recorded" means an amendment
 * in `state.json` and "queued" means the task's persisted state, not a mock that was called.
 * The refusals are held to the stronger claim FR-001 makes: they happen before anything about
 * the run is read, which the seam proves by never being asked for the run's ports.
 */

const globals: GlobalOptions = {
  cwd: '/repo',
  globalConfigPath: '/install/config.yaml',
  verbose: false,
  dryRun: false,
  json: false,
  strict: false,
};

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const planTask = (id: string) => ({
  id,
  title: `${id} title`,
  description: `${id} description.`,
  complexity: 'trivial',
  risk: 'low',
  dependencies: [],
  requirements: ['FR-001'],
  acceptanceCriteria: ['It works.'],
  validation: ['test'],
});

const PLAN = { feature: 'weekly-recurrence', tasks: [planTask('TASK-001'), planTask('TASK-002')] };

// What a shell argument cannot carry: paragraphs, a fenced block, a lone apostrophe.
const LONG_ANSWER = [
  "Use the v2 endpoint; the v1 one doesn't return the end date.",
  '',
  '```ts',
  'const url = `/v2/series/${id}`;',
  '```',
].join('\n');

/** A project whose TASK-002 stopped with BLOCKED under an approved plan. */
async function project() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const name of ['discovery', 'architecture-impact', 'sdd', 'planning', 'plan-review']) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: []\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\noutputFormat: json\nrequiredVars: [task, sdd]\n---\n\n# implementation\n',
  );

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('weekly recurrence');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n\nFR-001 — recurrence.\n');
  await store.writeArtifact(
    run.runId,
    'planReview',
    JSON.stringify({
      verdict: 'PASS',
      independence: 'cross-provider',
      reviewer: { runner: 'codex', reasoning: 'high' },
      planHash: planHash(PlanSchema.parse(PLAN)),
      findings: [],
    }),
  );
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'waiting_for_approval',
    tasks: [
      { id: 'TASK-001', state: 'queued', attempts: 0, infrastructureFailures: 0 },
      { id: 'TASK-002', state: 'queued', attempts: 0, infrastructureFailures: 0 },
    ],
  }));

  const deps: RunActionDeps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host: new FakeHost(),
    owner: 'cli',
  });

  const approved = await approve(deps, run.runId);
  if (!approved.ok) throw new Error(`approve refused: ${approved.error.code}`);

  await store.updateRun(run.runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === 'TASK-002'
        ? { ...task, state: 'blocked' as const, attempts: 1, blockReason: 'agent' as const }
        : task,
    ),
  }));

  return { fs, store, deps, runId: run.runId };
}

function seams(
  deps: RunActionDeps,
  io: Partial<AnswerCommandDeps['io']> = {},
): AnswerCommandDeps & { readonly actionDeps: ReturnType<typeof vi.fn> } {
  return {
    io: {
      readFile: (path) => (path === 'answer.md' ? `${LONG_ANSWER}\n` : undefined),
      readStdin: async () => `${LONG_ANSWER}\n`,
      openEditor: async () => `${LONG_ANSWER}\n`,
      ...io,
    },
    actionDeps: vi.fn(() => deps),
  } as AnswerCommandDeps & { readonly actionDeps: ReturnType<typeof vi.fn> };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent-flow answer records the answer and queues the task (FR-001, FR-021)', () => {
  it.each([
    ['a positional argument', { argument: 'use the v2 endpoint' }, 'use the v2 endpoint'],
    ['--file', { file: 'answer.md' }, LONG_ANSWER],
    ['- for stdin', { argument: '-' }, LONG_ANSWER],
    ['--edit', { edit: true }, LONG_ANSWER],
  ] as const)('through %s', async (_label, flags, expected) => {
    const { store, deps, runId } = await project();
    const output = capture();

    const code = await runAnswerCommand('TASK-002', flags, globals, seams(deps));

    expect(code).toBe(ExitCode.OK);
    const state = await store.loadRun(runId);
    expect(state.amendments).toHaveLength(1);
    expect(state.amendments?.[0]).toMatchObject({ kind: 'answer', task: 'TASK-002', text: expected });
    expect(state.tasks.find((task) => task.id === 'TASK-002')?.state).toBe('queued');

    // FR-021: what happened, and the command that continues it.
    expect(output.stdout()).toContain('TASK-002 answered and queued; continue with `agent-flow run`');
    expect(output.stdout()).toContain('AMD-001');
  });

  it("renders the use case's refusal, and records nothing, for a task that asked nothing", async () => {
    const { store, deps, runId } = await project();
    const before = await store.loadRun(runId);
    const output = capture();

    // TASK-001 is queued: there is no question outstanding to answer.
    const code = await runAnswerCommand('TASK-001', { argument: 'x' }, globals, seams(deps));

    expect(code).toBe(ExitCode.GATE_NOT_SATISFIED);
    expect(output.stderr()).not.toBe('');
    expect(output.stdout()).not.toContain('answered and queued');
    expect(await store.loadRun(runId)).toEqual(before);
  });
});

describe('agent-flow answer refuses a bad invocation before reading any state (FR-001)', () => {
  it('refuses a positional text together with --file, and names the answer', async () => {
    const { fs, deps } = await project();
    const read = vi.spyOn(fs, 'readFile');
    const output = capture();
    const s = seams(deps);

    const code = await runAnswerCommand('TASK-002', { argument: 'x', file: 'answer.md' }, globals, s);

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(output.stderr()).toContain('answer');
    // The run's ports were never asked for, so no state could have been read — and the
    // filesystem agrees.
    expect(s.actionDeps).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty argument', { argument: '   ' }],
    ['an empty file', { file: 'empty.md' }],
    ['an empty pipe', { argument: '-' }],
  ] as const)('refuses %s', async (_label, flags) => {
    const { fs, deps } = await project();
    const read = vi.spyOn(fs, 'readFile');
    const output = capture();
    const s = seams(deps, { readFile: () => '\n', readStdin: async () => ' \n' });

    const code = await runAnswerCommand('TASK-002', flags, globals, s);

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(output.stderr()).toContain('The answer is empty');
    expect(s.actionDeps).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('positive control: the same seam is asked for the run once the text is good', async () => {
    const { deps } = await project();
    capture();
    const s = seams(deps);

    await runAnswerCommand('TASK-002', { argument: 'x' }, globals, s);

    // Without this, "never called" above would also pass for a command that never reads state.
    expect(s.actionDeps).toHaveBeenCalledTimes(1);
  });
});

describe('the answer command is registered', () => {
  it('appears in the help beside retry', async () => {
    const output = capture();
    await main(['node', 'agent-flow', '--help']);
    expect(output.stdout()).toMatch(/answer \[options\] <taskId> \[text\]/);
  });
});
