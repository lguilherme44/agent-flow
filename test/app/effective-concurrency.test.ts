import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { StateStore } from '../../src/app/state-store.js';
import { buildExecutionContext } from '../../src/app/execution-context.js';
import { start, type RunActionDeps } from '../../src/app/run-actions.js';
import { approveRun } from '../../src/app/approval.js';
import { PlanSchema } from '../../src/contracts/index.js';
import type { ProcessResult, ProcessRunner, ProcessSpawnOptions } from '../../src/ports/index.js';

/**
 * M2-00.3 — a configured `parallelism.maxTasks` above one must not become
 * concurrent execution.
 *
 * The hole this closes was reachable from a configuration file and nothing else:
 * `parallelism.maxTasks` went straight into `Scheduler.maxConcurrency`, and
 * `git.useWorktrees` — the flag that reads as though it were the safety catch —
 * was never consulted by any execution path. So `maxTasks: 4` really did run four
 * agents against one working tree, one `git status`, one `AGENTS.md`.
 *
 * These tests go through the production `start` use case rather than constructing
 * a Scheduler, because the defect was in the wiring. A test that passed the number
 * in by hand would have agreed with the bug.
 */

const PROJECT = '/repo';

const PLAN = {
  feature: 'four independent tasks',
  tasks: ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'].map((id) => ({
    id,
    title: `Independent ${id}`,
    description: 'Touches nothing the others touch.',
    complexity: 'trivial',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['Done.'],
    validation: [],
  })),
};

const IMPLEMENTED = `Done.

## RESULT

STATUS: COMPLETED

FILES CHANGED:
- src/thing.ts

DEVIATIONS:
- none

NOTES:
- none
`;

const READ_ONLY_PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'final-review',
];

/**
 * A ProcessRunner that answers like the Claude Code CLI and records how many
 * agent invocations are in flight at the same moment.
 *
 * Peak concurrency is observed at the process boundary, which is the only place
 * the answer is not a matter of interpretation: two agents at once means two
 * child processes editing one working tree at once.
 */
class ConcurrencyWatchingRunner implements ProcessRunner {
  private inFlight = 0;
  private peak = 0;
  /** Resolves once every currently-parked invocation is released. */
  private release: (() => void)[] = [];

  get peakAgentInvocations(): number {
    return this.peak;
  }

  async run(options: ProcessSpawnOptions): Promise<ProcessResult> {
    const isAgent = options.args.includes('--output-format');

    if (!isAgent) {
      return this.answer('');
    }

    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);

    // Parked deliberately. An invocation that returned immediately would never
    // overlap with the next one even under a broken limit, so the test would
    // pass for a reason that has nothing to do with the limit. Every agent waits
    // until the whole current wave has arrived, then they all go.
    await new Promise<void>((resolve) => {
      this.release.push(resolve);
      // Nothing else is coming: let whoever is here through.
      setTimeout(() => {
        for (const settle of this.release.splice(0)) settle();
      }, 0);
    });

    this.inFlight -= 1;
    return this.answer(IMPLEMENTED);
  }

  private answer(text: string): ProcessResult {
    return {
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ is_error: false, subtype: 'success', result: text }),
      stderr: '',
      durationMs: 1,
      timedOut: false,
      spawnFailed: false,
      truncated: false,
    };
  }
}

async function approvedRun(projectConfig: string) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const processRunner = new ConcurrencyWatchingRunner();

  fs.seed(`${PROJECT}/.agent-flow/config.yaml`, projectConfig);

  for (const name of READ_ONLY_PROMPTS) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: []\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\noutputFormat: markdown\n' +
      'requiredVars: [task, sdd, projectConfig, agentsMd]\n---\n\n# implementation\n' +
      '{{task}} {{sdd}} {{projectConfig}} {{agentsMd}}\n',
  );

  const store = new StateStore({ fs, clock, projectDir: PROJECT });
  const run = await store.createRun('four independent tasks');

  const plan = PlanSchema.parse(PLAN);
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n\nFR-001 — the thing.\n');
  await store.updateRun(run.runId, (state) => ({
    ...state,
    tasks: plan.tasks.map((task) => ({ id: task.id, state: 'queued' as const, attempts: 0 })),
  }));
  await approveRun(store, run.runId, plan);

  const deps: RunActionDeps = {
    fs,
    clock,
    processRunner,
    projectDir: PROJECT,
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host: new FakeHost(),
    owner: 'cli',
  };

  return { fs, clock, store, processRunner, deps, runId: run.runId };
}

const CONFIG = (overrides: string): string =>
  `project:\n  name: demo\n  type: node\n${overrides}`;

describe('a configured parallelism above one does not become concurrent execution', () => {
  it('runs one task at a time with maxTasks: 4 and no worktrees', async () => {
    const world = await approvedRun(CONFIG('parallelism:\n  maxTasks: 4\ngit:\n  useWorktrees: false\n'));

    const outcome = await start(world.deps, world.runId);

    expect(outcome.ok).toBe(true);
    expect(world.processRunner.peakAgentInvocations).toBe(1);
  });

  // This test is a guard against reading a dead flag as a live capability.
  //
  // `git.useWorktrees` is part of the MVP 2 design and is deliberately kept in
  // the schema, but nothing in the execution path creates a worktree — so
  // switching it on changes the isolation of exactly nothing. Until task
  // workspaces genuinely exist, turning it on must not raise concurrency.
  //
  // **Change this test when isolation ships, and not before.** M2-01 landed the
  // *policy* — `resolveTaskConcurrency` can now be told a run is isolated, and
  // `MAX_ISOLATED_TASK_CONCURRENCY` is 8 — and deliberately changed nothing here:
  // no caller passes the mode, and no worktree exists to pass it about. **M2-11 is
  // the milestone that edits this expectation**, once workspaces, receipts and the
  // integrator are real. The reason it may change is that there is isolation to
  // point at, never that somebody wanted the number to go up.
  it('still runs one task at a time with useWorktrees: true, because no worktree exists', async () => {
    const world = await approvedRun(CONFIG('parallelism:\n  maxTasks: 4\ngit:\n  useWorktrees: true\n'));

    const outcome = await start(world.deps, world.runId);

    expect(outcome.ok).toBe(true);
    expect(world.processRunner.peakAgentInvocations).toBe(1);
  });

  it('leaves maxTasks: 1 doing exactly what it did before', async () => {
    const world = await approvedRun(CONFIG('parallelism:\n  maxTasks: 1\n'));

    const outcome = await start(world.deps, world.runId);

    expect(outcome.ok).toBe(true);
    expect(world.processRunner.peakAgentInvocations).toBe(1);

    // And says nothing about parallelism, because nothing was reduced.
    const state = await world.store.loadRun(world.runId);
    expect(state.degradations.map((entry) => entry.kind)).not.toContain('parallelism_clamped');
  });
});

describe('the reduction is on the record', () => {
  it('records why the run executed one task at a time', async () => {
    // "Why is Agent Flow running one task at a time when maxTasks is 4" has to
    // have an answer that outlives the terminal it was printed in. The existing
    // degradation channel is that answer: it is on the run, it is shown at
    // approval time and again by `review`.
    const world = await approvedRun(CONFIG('parallelism:\n  maxTasks: 4\n'));

    await start(world.deps, world.runId);

    const state = await world.store.loadRun(world.runId);
    const clamp = state.degradations.find((entry) => entry.kind === 'parallelism_clamped');

    expect(clamp).toBeDefined();
    expect(clamp?.reason).toMatch(/4/);
    expect(clamp?.reason).toMatch(/isolat/i);
    // Both numbers, so the impact answers the question without the reader
    // having to hold the configuration in their head.
    expect(clamp?.impact).toMatch(/1 task at a time/);
    expect(clamp?.impact).toMatch(/4/);
  });

  it('records it once, however many tasks and however many invocations', async () => {
    // A per-task warning would bury the state file and teach people to ignore
    // the channel. `recordDegradation` already deduplicates by kind and reason;
    // this asserts we are using that rather than inventing a second mechanism.
    const world = await approvedRun(CONFIG('parallelism:\n  maxTasks: 4\n'));

    await start(world.deps, world.runId);
    await start(world.deps, world.runId);

    const state = await world.store.loadRun(world.runId);
    const clamps = state.degradations.filter((entry) => entry.kind === 'parallelism_clamped');

    expect(clamps).toHaveLength(1);
  });

  it('resolves the decision on the execution context, so a reader need not guess', async () => {
    const world = await approvedRun(CONFIG('parallelism:\n  maxTasks: 4\n'));

    const context = await buildExecutionContext({
      fs: world.fs,
      clock: world.clock,
      processRunner: world.processRunner,
      projectDir: PROJECT,
      globalConfigPath: '/install/config.yaml',
      promptsDir: '/install/prompts',
    });

    expect(context.config.global.parallelism.maxTasks).toBe(4);
    expect(context.concurrency.requested).toBe(4);
    expect(context.concurrency.effective).toBe(1);
    expect(context.concurrency.clamped).toBe(true);
  });
});
