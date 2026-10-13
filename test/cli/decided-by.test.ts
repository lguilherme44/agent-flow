import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { SECOND_PERSON_OBSERVING } from '../fakes/second-person.js';
import { StateStore } from '../../src/app/state-store.js';
import { planHash } from '../../src/app/approval.js';
import type { ActionOutcome, ReviseResult, RunActionDeps } from '../../src/app/run-actions.js';
import { readDecidedBy } from '../../src/cli/decided-by.js';
import { runReviseCommand, type ReviseCommandDeps } from '../../src/cli/feature.js';
import { runApproveCommand, runRejectCommand } from '../../src/cli/approve.js';
import type { InstructionIO } from '../../src/cli/instruction-source.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { GlobalOptions } from '../../src/cli/index.js';
import { PlanSchema } from '../../src/contracts/index.js';

/**
 * `--decided-by` and `--words` on `approve`, `reject` and `revise`.
 *
 * This terminal records as `keyboard`, and so does an AI driving it. The flags are how the
 * run says which human decided and what they said — so they are required, and nothing fills
 * them in: not git's `user.name`, not the OS user, both of which would make an AI's approval
 * look like a person's.
 */

const globals: GlobalOptions = {
  cwd: '/repo',
  globalConfigPath: '/install/config.yaml',
  verbose: false,
  dryRun: false,
  json: false,
  strict: false,
};

const PLAN = PlanSchema.parse({
  feature: 'weekly-recurrence',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types for recurrence.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile.'],
      validation: ['test'],
    },
  ],
});

async function project() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  fs.seed('/repo/.agent-flow/config.yaml', 'project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\n');
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
      planHash: planHash(PLAN),
      findings: [],
    }),
  );
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'waiting_for_approval',
    tasks: [{ id: 'TASK-001', state: 'queued', attempts: 0, infrastructureFailures: 0 }],
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

  return { store, deps, runId: run.runId };
}

function io(files: Record<string, string> = {}, stdin = ''): InstructionIO {
  return {
    readFile: (path) => files[path],
    readStdin: async () => stdin,
    openEditor: async () => {
      throw new Error('a decision never opens an editor');
    },
  };
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

/** Deps that fail the test if a refused command reaches them. */
const unreachable = (): RunActionDeps => {
  throw new Error('a command missing --decided-by must not reach the run');
};

async function decisionsOf(store: StateStore, runId: string) {
  return (await store.readEvents(runId))
    .filter((event) => event.type === 'operator_action')
    .map((event) => event.detail['decidedBy']);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('readDecidedBy', () => {
  it('reads the name and the words, trimmed, as a CLI decision', async () => {
    expect(await readDecidedBy({ decidedBy: ' Luis ', words: ' Ship it. ' }, io())).toEqual({
      ok: true,
      decision: { by: 'Luis', words: 'Ship it.', channel: 'cli' },
    });
  });

  it('reads the words from a file, or from stdin with -', async () => {
    expect(
      await readDecidedBy({ decidedBy: 'Luis', wordsFile: 'w.md' }, io({ 'w.md': 'From a file.\n' })),
    ).toEqual({ ok: true, decision: { by: 'Luis', words: 'From a file.', channel: 'cli' } });
    expect(await readDecidedBy({ decidedBy: 'Luis', words: '-' }, io({}, 'From stdin.\n'))).toEqual({
      ok: true,
      decision: { by: 'Luis', words: 'From stdin.', channel: 'cli' },
    });
  });

  it('refuses a missing or blank name, says the AI must not invent it, and asks for the human', async () => {
    // Set where a fallback would look, so a refusal here cannot be luck.
    vi.stubEnv('USER', 'luis');
    vi.stubEnv('USERNAME', 'luis');
    for (const flags of [{ words: 'Ship it.' }, { decidedBy: '   ', words: 'Ship it.' }]) {
      const read = await readDecidedBy(flags, io());
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.reason).toContain('--decided-by');
      expect(read.reason).toMatch(/must not invent/i);
      expect(read.reason).toMatch(/ask the human/i);
      expect(read.reason).not.toMatch(SECOND_PERSON_OBSERVING);
    }
  });

  it('refuses missing or empty words', async () => {
    for (const [flags, given] of [
      [{ decidedBy: 'Luis' }, io()],
      [{ decidedBy: 'Luis', words: '  ' }, io()],
      [{ decidedBy: 'Luis', words: '-' }, io({}, '\n')],
    ] as const) {
      const read = await readDecidedBy(flags, given);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.reason).toMatch(/--words|words are empty/);
    }
  });

  it('refuses the words given two ways, and a file that is not there', async () => {
    const both = await readDecidedBy({ decidedBy: 'Luis', words: 'a', wordsFile: 'w.md' }, io({ 'w.md': 'b' }));
    expect(both.ok).toBe(false);
    const missing = await readDecidedBy({ decidedBy: 'Luis', wordsFile: 'nope.md' }, io());
    expect(missing).toEqual({ ok: false, reason: 'No such file: nope.md' });
  });

  it('refuses stdin for the words when the command already reads its text from stdin', async () => {
    const read = await readDecidedBy({ decidedBy: 'Luis', words: '-' }, io({}, 'x'), { stdinTaken: true });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain('stdin');
  });
});

describe('approve, reject and revise require the human at the command line', () => {
  it('approve without --decided-by is a CONFIG_ERROR and touches nothing', async () => {
    const output = capture();

    const code = await runApproveCommand({ words: 'Ship it.' }, globals, unreachable, io());

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(output.stderr()).toContain('--decided-by');
    expect(output.stderr()).toMatch(/must not invent/i);
  });

  it('approve with both records them, with the cli channel', async () => {
    const { store, deps, runId } = await project();
    const output = capture();

    const code = await runApproveCommand({ decidedBy: 'Luis', words: 'Ship it.' }, globals, () => deps, io());

    expect(code).toBe(ExitCode.OK);
    expect(output.stdout()).toContain('Approved');
    expect(await decisionsOf(store, runId)).toEqual([{ by: 'Luis', words: 'Ship it.', channel: 'cli' }]);
  });

  it('reject without --words is a CONFIG_ERROR and touches nothing', async () => {
    const output = capture();

    const code = await runRejectCommand('wrong scope', { decidedBy: 'Luis' }, globals, {
      actionDeps: unreachable,
      io: io(),
    });

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(output.stderr()).toContain('--words');
  });

  it('reject with both records them', async () => {
    const { store, deps, runId } = await project();
    capture();

    const code = await runRejectCommand(
      'wrong scope',
      { decidedBy: 'Luis', words: 'No, wrong scope.' },
      globals,
      { actionDeps: () => deps, io: io() },
    );

    expect(code).toBe(ExitCode.OK);
    expect(await decisionsOf(store, runId)).toEqual([
      { by: 'Luis', words: 'No, wrong scope.', channel: 'cli' },
    ]);
  });

  function reviseSeams(deps: RunActionDeps, stdin = '') {
    const revise = vi.fn(
      async (): Promise<ActionOutcome<ReviseResult>> => ({
        ok: true,
        value: { runId: 'r', taskCount: 1, approvalCleared: false },
        warnings: [],
      }),
    );
    const seams: ReviseCommandDeps = {
      io: io({}, stdin),
      revise: revise as unknown as ReviseCommandDeps['revise'],
      actionDeps: () => deps,
    };
    return { seams, revise };
  }

  it('revise without --decided-by is a CONFIG_ERROR, before the use case', async () => {
    const { deps } = await project();
    const output = capture();
    const { seams, revise } = reviseSeams(deps);

    const code = await runReviseCommand({ argument: 'Split TASK-001.', words: 'Split it.' }, globals, seams);

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(revise).not.toHaveBeenCalled();
    expect(output.stderr()).toContain('--decided-by');
  });

  it('revise hands the decision to the use case beside the instruction', async () => {
    const { deps, runId } = await project();
    capture();
    const { seams, revise } = reviseSeams(deps);

    const code = await runReviseCommand(
      { argument: 'Split TASK-001.', decidedBy: 'Luis', words: 'Split it in two.' },
      globals,
      seams,
    );

    expect(code).toBe(ExitCode.OK);
    expect(revise).toHaveBeenCalledWith(
      deps,
      runId,
      'Split TASK-001.',
      { by: 'Luis', words: 'Split it in two.', channel: 'cli' },
      'planning',
      'revision',
    );
  });

  it('revise refuses --edit with --words -: the editor would open on a stdin already read', async () => {
    const { deps } = await project();
    const output = capture();
    const { seams, revise } = reviseSeams(deps, 'text');
    const openEditor = vi.fn(async () => 'Split TASK-001.');
    const guarded: ReviseCommandDeps = { ...seams, io: { ...seams.io, openEditor } };

    const code = await runReviseCommand({ edit: true, decidedBy: 'Luis', words: '-' }, globals, guarded);

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(openEditor).not.toHaveBeenCalled();
    expect(revise).not.toHaveBeenCalled();
    expect(output.stderr()).toContain('--edit');
  });

  it('revise refuses stdin twice: the instruction and the words cannot both read it', async () => {
    const { deps } = await project();
    const output = capture();
    const { seams, revise } = reviseSeams(deps, 'text');

    const code = await runReviseCommand({ argument: '-', decidedBy: 'Luis', words: '-' }, globals, seams);

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(revise).not.toHaveBeenCalled();
    expect(output.stderr()).toContain('stdin');
  });
});
