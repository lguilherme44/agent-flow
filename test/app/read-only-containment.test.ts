import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../fixtures/temp-repo.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { StageRunner, type StageDefinition } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { openReadOnlyTree } from '../../src/app/read-only-workspace.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';

/**
 * §6.1b's acceptance, as a sentence: **a read-only stage writes a file and the repository
 * under judgement stays identical.**
 *
 * The unit tests beside this one prove the twin is faithful and disposable. This one
 * proves the *wiring* — that a stage asked for read-only permission is actually sent
 * there, that the variable telling it where it is follows, and that a write-permission
 * stage is not quietly redirected along with it.
 *
 * The runner is a fake, and that is the honest choice rather than a compromise: what is
 * under test is Agent Flow's containment, not `agy`'s obedience. §6.1 already measured
 * the disobedience — a read-only invocation reaching its edit tool when asked — so the
 * fake reproduces the *measured* behaviour instead of paying for it again in quota. The
 * write-permission control below is what makes the containment claim falsifiable.
 */

const READ_ONLY_PROMPT =
  '---\nrole: sdd\npermissions: read-only\nworkingDirectory: true\nrequiredVars: [projectDir]\n---\nDescribe {{projectDir}}.\n';

const WRITE_PROMPT =
  '---\nrole: sdd\npermissions: write\nworkingDirectory: true\nrequiredVars: [projectDir]\n---\nChange {{projectDir}}.\n';

const STAGE: StageDefinition = { name: 'sdd', role: 'sdd', prompt: 'sdd', artifact: 'sdd' };

const config = GlobalConfigSchema.parse({
  runners: { fake: { type: 'claude-code-cli' } },
  roles: {
    architect: { runner: 'fake', effort: 'high' },
    sdd: { runner: 'fake', effort: 'high' },
    planner: { runner: 'fake', effort: 'high' },
    planReviewer: { runner: 'fake', effort: 'high' },
    executors: {
      trivial: { runner: 'fake', effort: 'low' },
      normal: { runner: 'fake', effort: 'medium' },
      complex: { runner: 'fake', effort: 'high' },
    },
    verification: { runner: 'fake', effort: 'medium' },
    finalReviewer: { runner: 'fake', effort: 'very_high' },
  },
});

const CAPABILITIES = {
  fake: {
    supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
    supportsReadOnly: true,
    supportsNonInteractive: true,
    supportsWorkingDirectory: true,
    structuredOutputStrategy: 'native',
    nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
  },
} as const;

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

/** The measured behaviour: a stage that writes where it was told only to read. */
const disobedient = (runner: FakeAgentRunner): FakeAgentRunner =>
  runner.push((input) => {
    writeFileSync(join(input.workingDirectory, 'STOWAWAY.md'), 'written by the stage\n');
    writeFileSync(join(input.workingDirectory, 'src/a.ts'), 'export const a = 999;\n');
    return { ok: true, text: '# a document', durationMs: 1 };
  });

async function harness(options: { readonly prompt: string; readonly contain?: boolean }) {
  const source = await makeTempRepo();
  repo = source;
  mkdirSync(join(source.dir, 'src'), { recursive: true });
  source.write('src/a.ts', 'export const a = 1;\n');
  source.write('README.md', '# demo\n');
  // What `agent-flow init` writes, because the acceptance compares the *tree*: the run's
  // own state lands under `.agent-flow/` and moves constantly, and a repository where it
  // is not ignored is one `checkWorktreePreconditions` refuses anyway (§6.3, check 8).
  source.write('.gitignore', '.agent-flow/\n');
  source.commitAll('first');

  const fs = new NodeFileSystem();
  const clock = new FixedClock();
  const runner = disobedient(new FakeAgentRunner('fake'));

  const promptsDir = join(source.home, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'sdd.md'), options.prompt);

  const store = new StateStore({ fs, clock, projectDir: source.dir });
  const run = await store.createRun('recurring-bookings');

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config,
    capabilities: CAPABILITIES,
    promptLoader: new PromptLoader({ fs, promptsDir }),
    getRunner: () => runner,
    projectDir: source.dir,
    host: new FakeHost(4242, 'test-host', [4242], source.home),
    ...(options.contain === false
      ? {}
      : {
          openReadOnlyTree: (input) =>
            openReadOnlyTree({ fs, workspaces: source.workspaces, host: new FakeHost(4242) }, input),
        }),
  });

  return { source, store, run, runner, stageRunner };
}

/** Everything Git can see about the working tree, including what is not tracked. */
const dirt = (source: TempRepo): string =>
  source.userGit(['status', '--porcelain=v1', '--untracked-files=all']);

describe('§6.1b — a read-only stage cannot touch the repository under judgement', () => {
  it('leaves the repository identical after a read-only stage writes two files', async () => {
    const { source, run, stageRunner } = await harness({ prompt: READ_ONLY_PROMPT });

    // The run's own state lives under `.agent-flow/`, which `init` gitignores; the
    // comparison is of the tree, and the run is not part of the tree.
    const before = dirt(source);

    await stageRunner.run(STAGE, run.runId, { projectDir: source.dir });

    expect(dirt(source)).toBe(before);
    expect(existsSync(join(source.dir, 'STOWAWAY.md'))).toBe(false);
    expect(readFileSync(join(source.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('tells the stage where it actually is', async () => {
    const { source, run, runner, stageRunner } = await harness({ prompt: READ_ONLY_PROMPT });

    await stageRunner.run(STAGE, run.runId, { projectDir: source.dir });

    // Both halves, because either alone is a bug. The process runs in the twin…
    expect(runner.lastCall?.workingDirectory).not.toBe(source.dir);
    expect(runner.lastCall?.workingDirectory).toContain('read-only-sdd');
    // …and the prompt names the twin, so an agent that follows the "Working directory"
    // heading does not walk straight back into the repository it is describing.
    expect(runner.lastCall?.prompt).toContain(runner.lastCall?.workingDirectory ?? 'unreachable');
    expect(runner.lastCall?.prompt).not.toContain(`Describe ${source.dir}.`);
  });

  it('records nothing when the containment held', async () => {
    const { source, store, run, stageRunner } = await harness({ prompt: READ_ONLY_PROMPT });

    await stageRunner.run(STAGE, run.runId, { projectDir: source.dir });

    const state = await store.loadRun(run.runId);
    expect(state?.degradations.map((entry) => entry.kind)).not.toContain('read_only_uncontained');
  });

  it('says so on the run when a twin could not be cut', async () => {
    const { source, store, run, stageRunner } = await harness({ prompt: READ_ONLY_PROMPT });

    // A source that is not a repository: the fallback path, reached the way it would be
    // reached in the wild rather than by stubbing the module under test.
    const elsewhere = join(source.home, 'not-a-repo');
    mkdirSync(join(elsewhere, 'src'), { recursive: true });
    writeFileSync(join(elsewhere, 'src/a.ts'), 'export const a = 1;\n');

    await stageRunner.run(STAGE, run.runId, { projectDir: elsewhere }, { workingDirectory: elsewhere });

    const state = await store.loadRun(run.runId);
    const degradation = state?.degradations.find((entry) => entry.kind === 'read_only_uncontained');

    // The stage still ran — a defence that becomes an outage is a worse trade — and the
    // run says where it ran and what was missing while it did (R-16).
    expect(degradation).toBeDefined();
    expect(degradation?.impact).toContain(elsewhere);
    expect(existsSync(join(elsewhere, 'STOWAWAY.md'))).toBe(true);
  });

  it('control: a write-permission stage still writes into the repository', async () => {
    const { source, run, runner, stageRunner } = await harness({ prompt: WRITE_PROMPT });

    await stageRunner.run(STAGE, run.runId, { projectDir: source.dir });

    // Without this the containment claim is unfalsifiable: every assertion above would
    // also pass if the fake runner had simply stopped writing anything.
    expect(runner.lastCall?.workingDirectory).toBe(source.dir);
    expect(existsSync(join(source.dir, 'STOWAWAY.md'))).toBe(true);
    expect(readFileSync(join(source.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 999;\n');
  });
});
