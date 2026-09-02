import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { StageRunner } from '../../src/app/stage-runner.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { CollaborationStore } from '../../src/app/collaboration-store.js';
import { CollaborationService } from '../../src/app/collaboration-service.js';
import { deriveAgentRoster } from '../../src/core/collaboration/roster.js';
import {
  CollaborationConfigSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
  TaskSchema,
  type AgentMessage,
  type Task,
} from '../../src/contracts/index.js';

/**
 * What the channel costs, measured (M5, §35–§36).
 *
 * **The number M4 could not produce.** Its live run reported one figure — 1 373 bytes of
 * `collaboration` on every implementation prompt — and could not say how much of that was
 * *availability* and how much was *relevance*. It turned out to be almost all
 * availability: five agents received it and one had anything to read.
 *
 * This is that scenario as a test: ten tasks, two of which something concerns. Every
 * assertion is a byte count, because "the payload is smaller now" is a claim and a
 * measurement is not.
 */

const PROJECT = '/repo';
const PROMPTS = '/install/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '..', '..', 'prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

const COMPLETED = `## RESULT

STATUS: COMPLETED

FILES_CHANGED:
- src/a.ts

VALIDATION:
- npm test: passed

DEVIATIONS:
- none

NOTES:
- none
`;

/** Ten tasks, and only two of them are ones anybody talked about. */
const TASKS: readonly Task[] = Array.from({ length: 10 }, (_, index) =>
  TaskSchema.parse({
    id: `TASK-${String(index + 1).padStart(3, '0')}`,
    title: `Task ${String(index + 1)}`,
    description: 'Some work.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    files: { likely: [`src/a${String(index + 1)}.ts`] },
    acceptanceCriteria: ['It compiles.'],
    validation: ['test'],
  }),
);

const RELEVANT_TO = new Set(['TASK-003', 'TASK-007']);

async function harness() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);
  const config = GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
    collaboration: CollaborationConfigSchema.parse({ enabled: true }),
  });

  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('a feature');
  const collaborationStore = new CollaborationStore({ fs, projectDir: PROJECT });

  // Two tasks somebody asked about. Everything else is ordinary work.
  const messages: AgentMessage[] = [...RELEVANT_TO].map((taskId, index) => ({
    id: `MSG-000${String(index + 1)}`,
    runId: run.runId,
    threadId: `THR-000${String(index + 1)}`,
    from: 'architect',
    to: { kind: 'agent' as const, id: 'executor.normal' },
    type: 'question' as const,
    taskId,
    subject: `about ${taskId}`,
    body: 'the SDD does not say which side mints the key',
    references: [],
    truncated: false,
    createdAt: '2026-08-09T20:00:00.000Z',
  }));
  await collaborationStore.appendMessages(run.runId, messages);

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner: new StageRunner({
      fs,
      clock,
      store,
      config,
      capabilities: { claude: CAPS },
      promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
      getRunner: () => runner,
      projectDir: PROJECT,
    }),
    processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
    config: {
      global: config,
      project: ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    projectDir: PROJECT,
    collaboration: new CollaborationService({
      fs,
      clock,
      store,
      collaboration: collaborationStore,
      roster: deriveAgentRoster(config),
      globalConfig: config,
      config: config.collaboration,
    }),
    capabilities: { claude: CAPS },
  });

  runner.always({ ok: true, text: COMPLETED, durationMs: 1 });

  return { store, run, runner, executor };
}

interface Cost {
  readonly taskId: string;
  readonly bootstrap: number;
  readonly context: number;
}

async function costs(): Promise<Cost[]> {
  const h = await harness();
  for (const task of TASKS) await h.executor.execute(task, h.run.runId, '# SDD');

  return (await h.store.readEvents(h.run.runId))
    .filter((event) => event.type === 'stage_context_measured')
    .map((event) => {
      const parts = (event.detail['parts'] ?? []) as { source: string; bytes: number }[];
      const by = Object.fromEntries(parts.map((part) => [part.source, part.bytes]));
      return {
        taskId: String(event.detail['task']),
        bootstrap: by['collaborationBootstrap'] ?? 0,
        context: by['collaboration'] ?? 0,
      };
    });
}

describe('what the channel costs across ten tasks (M5-ACC-19 … 22)', () => {
  it('advertises the channel on every one of them', async () => {
    // I-40 at the scale the saving is measured on. If this ever reports 0 for a task,
    // the M4 deadlock is back for that task.
    const measured = await costs();

    expect(measured).toHaveLength(10);
    for (const task of measured) {
      expect(task.bootstrap, task.taskId).toBeGreaterThan(0);
    }
  });

  it('sends a payload to exactly the two tasks it concerns', async () => {
    const measured = await costs();
    const withContext = measured.filter((task) => task.context > 0).map((task) => task.taskId);

    expect(new Set(withContext)).toEqual(RELEVANT_TO);
  });

  it('keeps availability under 900 bytes a task', async () => {
    const measured = await costs();

    for (const task of measured) {
      // Raised from 900 with the M6 dogfood's reason: the `affects` enum. A QA agent
      // wrote two well-formed blackboard entries and the only invalid thing in the file
      // was that one field, so the whole outbox was discarded — twice, in one task. The
      // enum is now named in the bootstrap, at ~120 bytes against a 32–50 KB prompt.
      expect(task.bootstrap, task.taskId).toBeLessThan(1_040);
    }
  });

  it('costs less across the ten than M4 did, and says by how much', async () => {
    // **The comparison the milestone is judged on.** M4 put its whole block on every
    // task; the live run measured that block at 1 373 bytes.
    const M4_PER_TASK = 1373;
    const measured = await costs();

    const m5Total = measured.reduce((sum, task) => sum + task.bootstrap + task.context, 0);
    const m4Total = M4_PER_TASK * measured.length;

    console.log(
      `collaboration cost over ${String(measured.length)} tasks — ` +
        `M4: ${String(m4Total)} B · M5: ${String(m5Total)} B · ` +
        `saved ${String(Math.round((1 - m5Total / m4Total) * 100))}%`,
    );

    expect(m5Total).toBeLessThan(m4Total);
  });

  it('is deterministic — the same ten tasks cost the same twice', async () => {
    expect(await costs()).toEqual(await costs());
  });
});
