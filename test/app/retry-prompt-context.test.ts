import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { runPaths } from '../../src/app/paths.js';
import { GlobalConfigSchema, ProjectConfigSchema, TaskSchema } from '../../src/contracts/index.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { parse as parseYaml } from 'yaml';

/**
 * AR-03 — what the retry is actually told.
 *
 * **The defect this exists for.** The Failure Context Packet was built, persisted to
 * `attempt-<n>.context.json` and recorded in the event log — and never reached the prompt.
 * `renderFailureContext` had no caller, `implementation.md` had no slot for it, and nothing
 * anywhere assigned `vars.failureContext`, which the stage runner reads in exactly one
 * place: the AR-09 measurement, where it always measured zero.
 *
 * So automatic recovery re-ran the identical prompt. That is not recovery; it is a retry
 * loop with more bookkeeping, and it would have burned the whole attempt budget rediscovering
 * the same failure — which is the behaviour AR-03 exists to replace.
 *
 * It survived because the acceptance test asserted the *packet* carried the failing command.
 * It did. Nothing asserted the runner ever saw it. A test that checks the artifact and not
 * the delivery passes on a system that builds evidence and throws it away.
 */

const PROJECT = '/repo';
const PROMPTS = '/pkg/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../../prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

const REPORT = `Done.

## RESULT

STATUS: COMPLETED

FILES CHANGED:
- src/a.ts

VALIDATION:
- npm test: passed

NOTES:
- none
`;

const TASK = TaskSchema.parse({
  id: 'TASK-001',
  title: 'Fix the thing',
  description: 'Make the failing test pass.',
  complexity: 'normal',
  risk: 'low',
  dependencies: [],
  requirements: ['FR-001'],
  acceptanceCriteria: ['The suite passes.'],
  validation: ['test'],
});

async function harness() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);

  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const globalConfig = GlobalConfigSchema.parse(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML));
  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('f');

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner: new StageRunner({
      fs,
      clock,
      store,
      config: globalConfig,
      capabilities: { claude: CAPS },
      promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
      getRunner: () => runner,
      projectDir: PROJECT,
    }),
    processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
    config: {
      global: globalConfig,
      project: ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    projectDir: PROJECT,
  });

  return { fs, store, run, runner, executor };
}

/** The packet AR-03 writes before requeuing, exactly as `scheduler.ts` persists it. */
const packet = (attempt: number) => ({
  task: 'TASK-001',
  previousAttempt: attempt - 1,
  failureClass: 'validation_unsatisfied',
  correctiveObjective: 'The validation the task declares did not pass. Make it pass.',
  acceptanceCriteria: ['The suite passes.'],
  failedChecks: [
    { command: 'npm test', exitCode: 1, tail: 'AssertionError: expected 2, got 3', truncated: false },
  ],
  successfulChecks: [],
  truncated: [],
});

describe('a retry is told what went wrong', () => {
  it('puts the previous failure in the prompt the runner receives', async () => {
    const { fs, store, run, runner, executor } = await harness();
    runner.pushText(REPORT);

    fs.seed(
      runPaths(PROJECT, run.runId).attemptContext('TASK-001', 2),
      JSON.stringify(packet(2)),
    );
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'ready' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    await executor.execute(TASK, run.runId, 'SDD', {
      path: PROJECT,
      attempt: 2,
    });

    const sent = runner.calls.at(-1)?.prompt ?? '';
    expect(sent, 'the retry never saw the failing command').toContain('npm test');
    expect(sent, 'the retry never saw why it failed').toContain('AssertionError: expected 2, got 3');
  });

  it('says nothing extra on a first attempt', async () => {
    // There is no previous failure, and a heading with nothing under it trains a reader —
    // human or model — to skip the section that matters on attempt two.
    const { store, run, runner, executor } = await harness();
    runner.pushText(REPORT);

    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'ready' as const, attempts: 0, infrastructureFailures: 0 }],
    }));

    await executor.execute(TASK, run.runId, 'SDD', { path: PROJECT, attempt: 1 });

    expect(runner.calls.at(-1)?.prompt ?? '').not.toMatch(/previous attempt/i);
  });

  it('carries no patch, only what was observed', async () => {
    // AD-40 is explicit: the packet hands over evidence, never a diff. A patch would make
    // the retry a review of somebody else's edit rather than an attempt at the task.
    const { fs, store, run, runner, executor } = await harness();
    runner.pushText(REPORT);

    fs.seed(
      runPaths(PROJECT, run.runId).attemptContext('TASK-001', 2),
      JSON.stringify(packet(2)),
    );
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'ready' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    await executor.execute(TASK, run.runId, 'SDD', { path: PROJECT, attempt: 2 });

    const sent = runner.calls.at(-1)?.prompt ?? '';
    expect(sent).not.toMatch(/^\+\+\+ /m);
    expect(sent).not.toMatch(/^@@ /m);
  });

  it('measures the packet as its own share of the prompt (AR-09)', async () => {
    // The measurement read `vars.failureContext` and always found nothing, so every retry
    // reported a context composition with no recovery cost in it at all.
    const { fs, store, run, runner, executor } = await harness();
    runner.pushText(REPORT);

    fs.seed(
      runPaths(PROJECT, run.runId).attemptContext('TASK-001', 2),
      JSON.stringify(packet(2)),
    );
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'ready' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    await executor.execute(TASK, run.runId, 'SDD', { path: PROJECT, attempt: 2 });

    const measured = (await store.readEvents(run.runId)).find(
      (event) => event.type === 'stage_context_measured',
    );
    const parts = measured?.detail?.['parts'] as { source: string; bytes: number }[];

    expect(parts.find((part) => part.source === 'failureContext')?.bytes).toBeGreaterThan(0);
  });

  it('runs the attempt anyway when the packet is missing or unreadable', async () => {
    // A crash between requeue and retry, or a half-written file. The attempt proceeding
    // uninformed is worse than being told; it is not worse than not running at all.
    const { fs, store, run, runner, executor } = await harness();
    runner.pushText(REPORT);

    fs.seed(runPaths(PROJECT, run.runId).attemptContext('TASK-001', 2), '{ not json');
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'ready' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    const result = await executor.execute(TASK, run.runId, 'SDD', { path: PROJECT, attempt: 2 });

    expect(result.status).toBe('completed');
  });
});

describe('no unfilled slot ever reaches a model', () => {
  it('sends a prompt with no template placeholder left in it', async () => {
    // A general invariant, added because this milestone put a new `{{failureContext}}` slot
    // into `implementation.md`. The loader deliberately leaves an unknown placeholder in
    // place rather than blanking it — blanking would hide a genuine mistake — which means
    // a caller that forgets a variable ships `{{...}}` to the model verbatim.
    //
    // Cheap to check and impossible to notice by reading: the prompt still looks right.
    const { store, run, runner, executor } = await harness();
    runner.pushText(REPORT);

    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'ready' as const, attempts: 0, infrastructureFailures: 0 }],
    }));

    await executor.execute(TASK, run.runId, 'SDD', { path: PROJECT, attempt: 1 });

    expect(runner.calls.at(-1)?.prompt ?? '').not.toMatch(/\{\{\w+\}\}/);
  });
});
