import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { planHash } from '../../src/app/approval.js';
import { runPaths } from '../../src/app/paths.js';
import { answerTask, approve, retryTask, type ActionOutcome } from '../../src/app/run-actions.js';
import {
  GlobalConfigSchema,
  PlanSchema,
  ProjectConfigSchema,
  TaskSchema,
} from '../../src/contracts/index.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';

/**
 * FR-004 — an answer reaches the attempt that needs it.
 *
 * **The defect this exists for.** Before `answer`, the only road past an agent's BLOCKED was
 * `retry --force`, and the next attempt got the identical prompt: the executor's one slot
 * for extra context is `failureContext`, which reads a recovery packet that exists only for
 * attempt 2 and later — and sequential mode always runs attempt 1. So a recorded answer
 * that went only where the failure context goes would be recorded and never delivered.
 *
 * Every test here goes through the real `answerTask`, the real `TaskExecutor` and the real
 * `prompts/implementation.md`, and reads what the runner was handed, as
 * `retry-prompt-context.test.ts` does for AR-03. A test that checked the amendment on disk
 * would pass on a system that stores answers and throws them away.
 */

const PROJECT = '/repo';
const PROMPTS = '/install/prompts';
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

DEVIATIONS:
- none

NOTES:
- none
`;

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
  complexity: 'normal',
  risk: 'low',
  dependencies: [],
  requirements: ['FR-001'],
  acceptanceCriteria: ['It works.'],
  validation: ['test'],
});

const PLAN = { feature: 'weekly-recurrence', tasks: [planTask('TASK-001'), planTask('TASK-002')] };
const TASK = TaskSchema.parse(planTask('TASK-001'));

/** A marker that appears once in the SDD, so a second copy of it means a substitution. */
const SDD = '# SDD\n\nFR-001 — the recurrence marker-7f3a.\n';

/** The last line of the AGENTS.md the harness seeds, so its position can be found. */
const AGENTS_TAIL = 'Every behaviour change needs a test.';
const AGENTS_MD = `# Project Instructions\n\n${AGENTS_TAIL}\n`;

/** TASK-002's sentence, pinned here as text so a change to it is a visible decision. */
const PREAMBLE =
  'Operator decisions about this task. They override the plan where they contradict it; the SDD still applies everywhere else.';

/** What automatic recovery persists before a retry, exactly as `scheduler.ts` writes it. */
const PACKET = {
  task: 'TASK-001',
  previousAttempt: 1,
  failureClass: 'validation_unsatisfied',
  correctiveObjective: 'The validation the task declares did not pass. Make it pass.',
  acceptanceCriteria: ['It works.'],
  failedChecks: [
    { command: 'npm test', exitCode: 1, tail: 'AssertionError: expected 2, got 3', truncated: false },
  ],
  successfulChecks: [],
  truncated: [],
};

/**
 * An approved run whose TASK-001 stopped with its agent's BLOCKED.
 *
 * Approved through the real `approve`, so the answer is bound to the hash the gate actually
 * recorded rather than to one this file made up.
 */
async function blockedRun() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);

  fs.seed(`${PROJECT}/.agent-flow/config.yaml`, PROJECT_CONFIG);
  fs.seed(`${PROJECT}/AGENTS.md`, AGENTS_MD);
  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
  }

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('weekly recurrence');
  const runId = run.runId;

  await store.writeArtifact(runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.writeArtifact(runId, 'sdd', SDD);
  await store.writeArtifact(
    runId,
    'planReview',
    JSON.stringify({
      verdict: 'PASS',
      independence: 'cross-provider',
      reviewer: { runner: 'codex', reasoning: 'high' },
      planHash: planHash(PlanSchema.parse(PLAN)),
      findings: [],
    }),
  );
  await store.updateRun(runId, (state) => ({
    ...state,
    status: 'waiting_for_approval',
    tasks: [
      { id: 'TASK-001', state: 'queued', attempts: 0, infrastructureFailures: 0 },
      { id: 'TASK-002', state: 'queued', attempts: 0, infrastructureFailures: 0 },
    ],
  }));

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: PROJECT,
    globalConfigPath: '/install/config.yaml',
    promptsDir: PROMPTS,
    host: new FakeHost(),
    owner: 'cli',
  });

  const approved = await approve(deps, runId);
  if (!approved.ok) throw new Error(`approve refused: ${approved.error.code}`);
  await block(store, runId);

  const globalConfig = GlobalConfigSchema.parse(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML));
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
        project: { name: 'demo', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    projectDir: PROJECT,
  });

  /**
   * The prompt TASK-001's next attempt is sent. No workspace is sequential mode, which is
   * always attempt 1; a workspace at attempt 2 is the recovery path with a packet on disk.
   */
  const nextPrompt = async (workspace?: { attempt: number }): Promise<string> => {
    runner.pushText(REPORT);
    await (workspace === undefined
      ? executor.execute(TASK, runId, SDD)
      : executor.execute(TASK, runId, SDD, { path: PROJECT, attempt: workspace.attempt }));
    const prompt = runner.calls.at(-1)?.prompt;
    if (prompt === undefined) throw new Error('the implementation stage never reached the runner');
    // `autocrlf` on a Windows checkout gives the template CRLF; nothing here is about that.
    return prompt.replace(/\r\n/g, '\n');
  };

  return { fs, clock, store, deps, runId, nextPrompt };
}

/** TASK-001 as its agent's BLOCKED leaves it. */
async function block(store: StateStore, runId: string): Promise<void> {
  await store.updateRun(runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === 'TASK-001'
        ? { id: 'TASK-001', state: 'blocked' as const, blockReason: 'agent' as const, attempts: 1, infrastructureFailures: 0 }
        : task,
    ),
  }));
}

function ok<T>(outcome: ActionOutcome<T>): T {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`);
  return outcome.value;
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('an answer reaches the next attempt (FR-004)', () => {
  it('in sequential mode at attempt 1, under its own heading after AGENTS.md', async () => {
    const world = await blockedRun();
    ok(await answerTask(world.deps, world.runId, 'TASK-001', 'Use the v2 endpoint.'));

    const prompt = await world.nextPrompt();

    expect(prompt, 'the answer was recorded and never delivered').toContain('Use the v2 endpoint.');
    // A line of its own, after an empty one, and TASK-002's sentence under it: the heading is
    // what keeps the block from reading as the tail of the repository's AGENTS.md.
    expect(prompt).toContain(`\n\n## Operator answers\n\n${PREAMBLE}\n`);

    const agents = prompt.indexOf(AGENTS_TAIL);
    const answers = prompt.indexOf('## Operator answers');
    const rules = prompt.indexOf('## Rules');
    expect(agents).toBeGreaterThan(-1);
    expect(answers).toBeGreaterThan(agents);
    expect(rules).toBeGreaterThan(answers);
  });

  it('says nothing about an answer the task never received', async () => {
    // POSITIVE CONTROL. The same run and the same render without `answerTask`: if the text
    // above came from anywhere but the amendment, it would be here too.
    const world = await blockedRun();

    const prompt = await world.nextPrompt();

    expect(prompt).not.toContain('Use the v2 endpoint.');
    expect(prompt).not.toContain('## Operator answers');
  });

  it('at attempt 2 carries the failure context and the answer, failure first', async () => {
    // The recovery path, where `readFailureContext` does have something to say. The answer
    // joins it rather than replacing it: the failure is what this attempt must fix.
    const world = await blockedRun();
    world.fs.seed(
      runPaths(PROJECT, world.runId).attemptContext('TASK-001', 2),
      JSON.stringify(PACKET),
    );
    ok(await answerTask(world.deps, world.runId, 'TASK-001', 'Use the v2 endpoint.'));

    const prompt = await world.nextPrompt({ attempt: 2 });

    const failure = prompt.indexOf('AssertionError: expected 2, got 3');
    const answer = prompt.indexOf('Use the v2 endpoint.');
    expect(failure, 'the failure context was lost').toBeGreaterThan(-1);
    expect(answer, 'the answer was lost').toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(failure);
    // Separated by a blank line, so the heading starts a section of its own.
    expect(prompt).toContain('\n\n## Operator answers\n');
    expect(prompt.indexOf('## Operator answers')).toBeGreaterThan(failure);
  });

  it('leaves out an answer recorded against another plan', async () => {
    // A replan changes `approvedPlanHash`, and the question the answer was about may no
    // longer exist. Seeded directly because no use case records against a stale hash.
    const world = await blockedRun();
    const approvedHash = (await world.store.loadRun(world.runId)).approvedPlanHash;
    await world.store.updateRun(world.runId, (current) => ({
      ...current,
      amendments: [
        {
          id: 'AMD-001',
          kind: 'answer' as const,
          actor: { kind: 'keyboard' as const },
          at: world.clock.now(),
          text: 'An answer about a plan that was replaced.',
          task: 'TASK-001',
          planHash: 'sha256:an-earlier-plan',
        },
        {
          id: 'AMD-002',
          kind: 'answer' as const,
          actor: { kind: 'keyboard' as const },
          at: world.clock.now(),
          text: 'An answer about the plan in force.',
          task: 'TASK-001',
          ...(approvedHash === undefined ? {} : { planHash: approvedHash }),
        },
      ],
    }));

    const prompt = await world.nextPrompt();

    expect(prompt).not.toContain('An answer about a plan that was replaced.');
    // The control: the filter is by hash, not a block that stopped rendering altogether.
    expect(prompt).toContain('An answer about the plan in force.');
  });

  it('delivers a placeholder in an answer literally, without substituting into it (SEC-001)', async () => {
    const world = await blockedRun();
    ok(await answerTask(world.deps, world.runId, 'TASK-001', 'Quote {{sdd}} as written.'));

    const prompt = await world.nextPrompt();

    expect(prompt).toContain('Quote {{sdd}} as written.');
    // Once in its own section and nowhere else: a second pass would have pasted it here.
    expect(occurrences(prompt, 'marker-7f3a')).toBe(1);
  });
});

describe('an answered task that blocks again (revision point 6)', () => {
  it('is gated again, and a second answer joins the first in recording order', async () => {
    const world = await blockedRun();
    ok(await answerTask(world.deps, world.runId, 'TASK-001', 'First: use the v2 endpoint.'));
    await world.nextPrompt();

    // The attempt stopped again. An answer opens one attempt, not the force gate for good.
    await block(world.store, world.runId);
    const after = (await world.store.loadRun(world.runId)).tasks.find((task) => task.id === 'TASK-001');
    expect(after).toMatchObject({ state: 'blocked', blockReason: 'agent' });

    const refused = await retryTask(world.deps, world.runId, 'TASK-001');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('task_blocked');

    ok(await answerTask(world.deps, world.runId, 'TASK-001', 'Second: paginate by cursor.'));
    const prompt = await world.nextPrompt();

    const first = prompt.indexOf('First: use the v2 endpoint.');
    const second = prompt.indexOf('Second: paginate by cursor.');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it('keeps the first answer when the operator forces the retry instead', async () => {
    // Sticky, like `noChangeDeclaredAt`: forcing is a decision about the gate, not a
    // withdrawal of what the operator already told the task.
    const world = await blockedRun();
    ok(await answerTask(world.deps, world.runId, 'TASK-001', 'First: use the v2 endpoint.'));
    await world.nextPrompt();

    await block(world.store, world.runId);
    ok(await retryTask(world.deps, world.runId, 'TASK-001', { force: true }));
    const prompt = await world.nextPrompt();

    expect(prompt).toContain('First: use the v2 endpoint.');
  });
});
