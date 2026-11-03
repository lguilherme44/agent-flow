import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner, type StageDefinition } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';

/**
 * Whether the task fits, recorded next to what the prompt cost.
 *
 * `stage_context_measured` already carried the static half — what the harness assembled.
 * It cleared a run that could not finish: ≈8 600 tokens of preamble against a 49 152
 * window is 18 %, under every warning, and the attempt still ended without editing a file
 * because one target was 76 kB and an agent reads such a file more than once.
 *
 * The sizes come from the `FileSystem` port, so these tests state a repository's shape
 * instead of writing one to disk.
 */

const PROJECT = '/repo';
/**
 * A realistic preamble, because it is part of the arithmetic.
 *
 * The run this reproduces spent ≈8 600 tokens before the task started, almost all of it
 * the repository's rule file. With a two-word prompt the same target reads merely `tight`,
 * which is the right answer to a different question.
 */
const AGENTS_MD = '# Rules\n'.repeat(3_280);
const PROMPTS = '/install/prompts';

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

// `planning` rather than `implementation`: the fit measurement is stage-agnostic, and a
// pipeline stage resolves its role without a complexity class.
const STAGE: StageDefinition = {
  name: 'planning',
  role: 'planner',
  prompt: 'planning',
};

const measure = async (options: {
  readonly window?: number;
  readonly files: Record<string, number>;
  readonly taskFiles?: readonly string[];
}) => {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock('2026-11-03T12:00:00Z');
  const store = new StateStore({ fs, clock, projectDir: PROJECT });

  await fs.mkdirp(PROMPTS);
  // Front matter is required; `requiredVars` is empty so the stage needs no variables.
  await fs.writeFileAtomic(
    `${PROMPTS}/planning.md`,
    ['---', 'permissions: write', 'workingDirectory: true', 'outputFormat: markdown', '---', 'Do the work.', ''].join(
      '\n',
    ),
  );
  // The preamble is part of the arithmetic, so the test has to carry a realistic one:
  // the run this reproduces spent ≈8 600 tokens before the task started, almost all of it
  // the repository's own rule file. With a two-word prompt the same target looks merely
  // tight, which is the correct answer to a different question.
  for (const [path, bytes] of Object.entries(options.files)) {
    fs.seed(`${PROJECT}/${path}`, 'x'.repeat(bytes));
  }

  const parsed = GlobalConfigSchema.parse(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML));
  const config = {
    ...parsed,
    runners: Object.fromEntries(
      Object.entries(parsed.runners).map(([id, runner]) => [
        id,
        options.window === undefined ? runner : { ...runner, contextWindow: options.window },
      ]),
    ),
  } as typeof parsed;

  const run = await store.createRun('resend a reminder');
  const runId = run.runId;

  const runner = new StageRunner({
    fs,
    clock,
    store,
    config,
    capabilities: Object.fromEntries(Object.keys(config.runners).map((id) => [id, CAPS])),
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: () => new FakeAgentRunner('fake', CAPS).always({ ok: true, text: 'done', durationMs: 1 }),
    projectDir: PROJECT,
  });

  await runner.run(STAGE, runId, { agentsMd: AGENTS_MD }, {
    task: 'TASK-001',
    attempt: 1,
    ...(options.taskFiles === undefined ? {} : { taskFiles: options.taskFiles }),
  });

  const events = await store.readEvents(runId);
  return events.find((event) => event.type === 'stage_context_measured')?.detail as
    | Record<string, unknown>
    | undefined;
};

describe('recording whether the task could fit', () => {
  it('refuses the shape that produced zero edits', async () => {
    const measured = await measure({
      window: 49_152,
      files: { 'src/reminders.service.ts': 75_943 },
      taskFiles: ['src/reminders.service.ts'],
    });

    expect(measured?.fitVerdict).toBe('impossible');
    expect(String(measured?.fitDetail)).toContain('src/reminders.service.ts');
  });

  it('clears the shape that finished the same work', async () => {
    const measured = await measure({
      window: 131_072,
      files: { 'src/reminders.service.ts': 75_943 },
      taskFiles: ['src/reminders.service.ts'],
    });

    expect(measured?.fitVerdict).toBe('fits');
  });

  it('skips a target that does not exist yet instead of counting it as zero', async () => {
    // A task that creates a file has nothing to read there. Counting the absence would
    // quietly make a tight task look comfortable.
    const measured = await measure({
      window: 49_152,
      files: { 'src/reminders.service.ts': 75_943 },
      taskFiles: ['src/reminders.service.ts', 'src/not-written-yet.ts'],
    });

    expect((measured?.largestTarget as { path: string } | undefined)?.path).toBe(
      'src/reminders.service.ts',
    );
  });

  it('says nothing about fit for a stage that declared no files', async () => {
    // A pipeline stage belongs to no task. The event must look exactly as it did before.
    const measured = await measure({ window: 49_152, files: {} });

    expect(measured).toBeDefined();
    expect(measured).not.toHaveProperty('fitVerdict');
  });
});
