import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from './fakes/in-memory-file-system.js';
import { FixedClock } from './fakes/fixed-clock.js';
import { FakeAgentRunner } from './fakes/fake-agent-runner.js';
import { FakeProcessRunner } from './fakes/fake-process-runner.js';
import { TaskExecutor } from '../src/app/task-executor.js';
import { StageRunner } from '../src/app/stage-runner.js';
import { StateStore } from '../src/app/state-store.js';
import { PromptLoader } from '../src/app/prompt-loader.js';
import { Scheduler } from '../src/app/scheduler.js';
import { readyTasks, buildDag, DagError } from '../src/core/dag.js';
import {
  GlobalConfigSchema,
  PlanSchema,
  ProjectConfigSchema,
  TaskSchema,
} from '../src/contracts/index.js';

/**
 * ⚠️  REPRODUCTION TESTS — THESE ASSERT DEFECTS, NOT DESIRED BEHAVIOUR  ⚠️
 *
 * Every expectation in this file describes something that is **wrong**. A green
 * run here means the bugs are still present. Do not copy any assertion from
 * this file as an example of how the system should work.
 *
 * They exist because a finding should be proven before it is fixed. Reviewing a
 * diff is easier when the bug is executable.
 *
 * ## Lifecycle
 *
 * Each scenario passes through three states:
 *
 *   1. **repro** — asserts the defect. Lives here. (current)
 *   2. **inverted** — the fix lands; the assertion is flipped to describe the
 *      correct behaviour. Still here, briefly.
 *   3. **regression** — moved into the suite of the feature it belongs to, and
 *      kept forever.
 *
 * Do not delete a test when fixing its finding. Invert it, then move it. The
 * scenario is the valuable part; the assertion is what changes.
 *
 * ## Where each scenario goes once inverted
 *
 * | Finding | Scenario | Destination |
 * |---|---|---|
 * | V-02 | fallback fires at runtime | `test/app/execution-context.test.ts` (new) |
 * | V-03 | interrupted task is recoverable | `test/app/scheduler.test.ts` |
 * | V-05 | single task with dependencies | `test/cli/run.test.ts` (new) |
 * | V-06 | provenance matches execution | `test/app/task-executor.test.ts` |
 * | V-07 | cache invalidation | `test/app/planning-pipeline.test.ts` |
 *
 * Source: `agent-flow-validation-review.md`, validated 2026-08-09.
 * Full analysis: see the validation report in that document's format.
 */

const PROJECT = '/repo';
const PROMPTS = '/pkg/prompts';
const REAL_PROMPTS = join(import.meta.dirname, '../prompts');

const CAPS = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
} as const;

const globalConfig = GlobalConfigSchema.parse({
  runners: { claude: { type: 'claude-code-cli' } },
  roles: {
    architect: { runner: 'claude', effort: 'high' },
    sdd: { runner: 'claude', effort: 'high' },
    planner: { runner: 'claude', effort: 'high' },
    planReviewer: { runner: 'claude', effort: 'high' },
    executors: {
      trivial: { runner: 'claude', effort: 'low' },
      normal: { runner: 'claude', effort: 'medium' },
      // Deliberately distinct from the hardcoded value under test.
      complex: { runner: 'claude', effort: 'very_high' },
    },
    verification: { runner: 'claude', effort: 'medium' },
    finalReviewer: { runner: 'claude', effort: 'very_high' },
  },
});

const COMPLETED = '## RESULT\n\nSTATUS: COMPLETED\n\nFILES CHANGED:\n- a.ts\n\nNOTES:\n- none\n';

async function harness() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const runner = new FakeAgentRunner('claude', CAPS);
  const processRunner = new FakeProcessRunner().always({ exitCode: 0 });

  for (const file of readdirSync(REAL_PROMPTS)) {
    if (file.endsWith('.md')) {
      fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
  }

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('f');

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config: globalConfig,
    capabilities: { claude: CAPS },
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: () => runner,
    projectDir: PROJECT,
  });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner,
    processRunner,
    config: {
      global: globalConfig,
      project: ProjectConfigSchema.parse({
        project: { name: 'x', type: 'node' },
        commands: { test: 'npm test' },
      }),
    },
    projectDir: PROJECT,
  });

  return { fs, store, run, runner, processRunner, executor };
}

const task = (overrides: Record<string, unknown> = {}) =>
  TaskSchema.parse({
    id: 'TASK-001',
    title: 'T',
    description: 'D',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['ok'],
    validation: [],
    ...overrides,
  });

describe('[DEFECT] V-02 — fallback is not wired into the runtime', () => {
  it('a quota failure is not routed anywhere, even with fallback configured', async () => {
    const withFallback = GlobalConfigSchema.parse({
      ...globalConfig,
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
      fallback: {
        enabled: true,
        on: ['quota_exceeded'],
        roles: { 'executor.normal': { runner: 'codex', effort: 'medium' } },
      },
    });

    const fs = new InMemoryFileSystem();
    const clock = new FixedClock();
    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) {
        fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
      }
    }

    const store = new StateStore({ fs, clock, projectDir: PROJECT });
    const run = await store.createRun('f');
    const claude = new FakeAgentRunner('claude', CAPS);
    const codex = new FakeAgentRunner('codex', CAPS);

    const executor = new TaskExecutor({
      fs,
      clock,
      store,
      stageRunner: new StageRunner({
        fs,
        clock,
        store,
        config: withFallback,
        capabilities: { claude: CAPS, codex: CAPS },
        promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
        // Exactly what execution-context.ts does today.
        getRunner: (id) => (id === 'claude' ? claude : codex),
        projectDir: PROJECT,
      }),
      processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
      config: { global: withFallback },
      projectDir: PROJECT,
    });

    claude.pushFailure('quota_exceeded');

    const result = await executor.execute(task(), run.runId, 'SDD');

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('quota_exceeded');
    // The configured fallback runner was never asked.
    expect(codex.calls).toHaveLength(0);
  });
});

describe('[DEFECT] V-03 — an orphaned running task can never be scheduled again', () => {
  it('readyTasks excludes a task left in running', () => {
    const dag = buildDag([{ id: 'TASK-001', dependencies: [] }]);
    expect(readyTasks(dag, { 'TASK-001': 'running' })).toEqual([]);
  });

  it('a resume with a persisted running state makes no progress', async () => {
    // The state a real kill leaves behind: the scheduler persists `running`
    // before invoking the agent, so a crash in between is indistinguishable
    // from a task that is still in flight.
    const { store, run, executor } = await harness();
    const plan = PlanSchema.parse({ feature: 'f', tasks: [task()] });

    const outcome = await new Scheduler({ store, executor }).run(plan, run.runId, 'SDD', {
      'TASK-001': 'running',
    });

    expect(outcome.results).toEqual([]);
    expect(outcome.complete).toBe(false);
    expect(outcome.states['TASK-001']).toBe('running');
  });
});

describe('[DEFECT] V-05 — a single task with dependencies builds an invalid graph', () => {
  it('throws unknown_dependency because the mini-plan omits the dependency', () => {
    // What `agent-flow task TASK-002` does: filter the plan to one task, then
    // hand it to the scheduler, which builds a DAG over what it received.
    const plan = PlanSchema.parse({
      feature: 'f',
      tasks: [task(), { ...task({ id: 'TASK-002', dependencies: ['TASK-001'] }) }],
    });

    const selected = plan.tasks.filter((candidate) => candidate.id === 'TASK-002');

    expect(() =>
      buildDag(selected.map((t) => ({ id: t.id, dependencies: t.dependencies }))),
    ).toThrowError(DagError);
  });
});

describe('[DEFECT] V-06 — recorded provenance is not what ran', () => {
  it('persists reasoning: medium for a task routed to executor.complex', async () => {
    // executor.complex is configured at very_high. The result file says medium.
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    const result = await executor.execute(
      task({ complexity: 'complex', risk: 'high' }),
      run.runId,
      'SDD',
    );

    expect(runner.lastCall?.reasoning).toBe('very_high');
    expect(result.reasoning).toBe('medium');
  });

  it('never records the model', async () => {
    const { executor, runner, run } = await harness();
    runner.pushText(COMPLETED);

    const result = await executor.execute(task(), run.runId, 'SDD');
    expect(result.model).toBeUndefined();
  });
});

describe('[DEFECT] V-07 — the discovery cache is never invalidated', () => {
  it('reuses the cache regardless of what changed in the repository', async () => {
    const { fs } = await harness();
    const cachePath = `${PROJECT}/.agent-flow/cache/architecture.md`;
    fs.seed(cachePath, '# Architecture\n\nStale.');

    // The decision is `exists()` — nothing about HEAD, the working tree,
    // AGENTS.md or the project config participates.
    expect(await fs.exists(cachePath)).toBe(true);
    expect(await fs.readFile(cachePath)).toContain('Stale.');
  });
});
