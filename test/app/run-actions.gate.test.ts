import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PlanSchema } from '../../src/contracts/index.js';
import { planHash } from '../../src/app/approval.js';
import { LOCK_VERSION } from '../../src/app/run-execution-lock.js';
import {
  approve,
  reject,
  retryTask,
  revise,
  start,
  type ActionOutcome,
  type RunActionDeps,
} from '../../src/app/run-actions.js';
import type { ProcessResult, ProcessRunner, ProcessSpawnOptions } from '../../src/ports/index.js';

/**
 * AF-L01.2 — moving the gate versus executing the plan.
 *
 * AF-L01 made the three operations that *execute* a run mutually exclusive. It left
 * `approve` and `reject` outside, and the gap that opens is not a corrupted file — it
 * is a run that says something untrue about itself. `reject` writes `plan_rejected`
 * while the scheduler keeps spawning agents against that very plan, so the run records
 * that its plan was turned down while the work it describes is being done.
 *
 * The first block holds the lease with a *real* in-flight `revise`, paused inside its
 * planning pipeline, and asks the real `reject` and `approve` what they do about it.
 * The second block uses a claim on disk with a live pid, which is exactly what a run
 * held by another process looks like from here. Neither replaces the race suite: mutual
 * exclusion across processes is proved there, and what is proved here is the ordering
 * these two operations must obey once they share that lease.
 */

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const PLAN = {
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
};

const PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'final-review',
];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A ProcessRunner that stops inside the first agent invocation and waits.
 *
 * This is what makes the in-flight tests real rather than staged. `revise` holds the
 * lease for as long as its planning pipeline runs, and the pipeline runs for as long as
 * the agent it invoked has not answered — so pausing the agent freezes a genuine
 * `withExecutionLock` body open, and the `reject` racing it is the production one
 * meeting the production lock.
 */
class PausingProcessRunner implements ProcessRunner {
  readonly entered = deferred<void>();
  private readonly gate = deferred<void>();
  private paused = false;

  constructor(private readonly inner = new FakeProcessRunner().always({ exitCode: 0 })) {}

  /** Lets the paused invocation finish. */
  release(): void {
    this.gate.resolve();
  }

  async run(options: ProcessSpawnOptions): Promise<ProcessResult> {
    // Version probes run normally; the first real agent invocation is the one worth
    // freezing.
    if (!this.paused && !options.args.includes('--version')) {
      this.paused = true;
      this.entered.resolve();
      await this.gate.promise;
    }
    return this.inner.run(options);
  }
}

async function project(options: { runner?: ProcessRunner } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const name of PROMPTS) {
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
      // Hashed after parsing, as `loadPlan` does. The schema fills defaults, so the
      // hash of the literal above is not the hash of the plan the gate will see.
      planHash: planHash(PlanSchema.parse(PLAN)),
      findings: [],
    }),
  );
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'waiting_for_approval',
    tasks: [{ id: 'TASK-001', state: 'queued', attempts: 0, infrastructureFailures: 0 }],
  }));

  const deps: RunActionDeps = {
    fs,
    clock,
    processRunner: options.runner ?? new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  };

  return { fs, host, store, deps, runId: run.runId };
}

/** A claim on disk, as a holder in another process would have left one. */
function holdLock(
  fs: InMemoryFileSystem,
  runId: string,
  holder: { pid: number; owner: string; operation: string },
): void {
  fs.seed(
    `/repo/.agent-flow/runs/${runId}/execution.lock.1`,
    JSON.stringify({
      version: LOCK_VERSION,
      generation: 1,
      runId,
      hostname: 'test-host',
      createdAt: '2026-08-10T19:00:00.000Z',
      ...holder,
    }),
  );
}

function refusal(outcome: ActionOutcome<unknown>): { code: string; detail?: unknown } {
  if (outcome.ok) throw new Error('expected a refusal');
  return { code: outcome.error.code, detail: outcome.error.detail };
}

describe('a rejection racing a real in-flight operation', () => {
  it('is refused while revise holds the lease, and the plan is not marked rejected', async () => {
    const runner = new PausingProcessRunner();
    const { store, deps, runId } = await project({ runner });

    // A genuine `revise`, stopped inside its planning pipeline. It is holding the lease
    // right now, in the same way `start` holds it while the scheduler runs.
    const revising = revise(deps, runId, 'split TASK-001');
    await runner.entered.promise;

    const rejected = await reject(deps, runId, 'not what I asked for');

    expect(refusal(rejected).code).toBe('run_busy');
    // The refusal names what is actually happening. Calling a revise a "run" to avoid
    // touching the enum would send the reader looking for a scheduler.
    expect(refusal(rejected).detail).toMatchObject({
      wanted: 'reject',
      holder: { operation: 'revise' },
    });

    // The whole point: the run did not record that its plan was turned down while a new
    // one was being written for it.
    expect((await store.loadRun(runId)).status).not.toBe('plan_rejected');

    runner.release();
    await revising.catch(() => undefined);
  });

  it('is refused while revise holds the lease, and approve is too', async () => {
    const runner = new PausingProcessRunner();
    const { store, deps, runId } = await project({ runner });

    const revising = revise(deps, runId, 'split TASK-001');
    await runner.entered.promise;

    // `replan` clears the approval and then rewrites `plan.json` through the pipeline.
    // An approval racing that hashes whichever version happened to be on disk — the old
    // one, or a new one no human has read. The plan hash catches most of it and stops
    // catching it the moment somebody passes `--force`, which is safe by accident.
    const approved = await approve(deps, runId, { force: true });

    expect(refusal(approved).code).toBe('run_busy');
    expect(refusal(approved).detail).toMatchObject({
      wanted: 'approve',
      holder: { operation: 'revise' },
    });
    expect((await store.loadRun(runId)).approved).toBe(false);

    runner.release();
    await revising.catch(() => undefined);
  });

  it('lets go of the lease afterwards, so the next gate move goes through', async () => {
    const runner = new PausingProcessRunner();
    const { fs, store, deps, runId } = await project({ runner });

    const revising = revise(deps, runId, 'split TASK-001');
    await runner.entered.promise;
    runner.release();
    await revising.catch(() => undefined);

    const rejected = await reject(deps, runId, 'still not right');

    expect(rejected.ok).toBe(true);
    expect((await store.loadRun(runId)).status).toBe('plan_rejected');
    // A gate move is a short request, not a job: it takes the lease and gives it back.
    const entries = await fs.readDir(`/repo/.agent-flow/runs/${runId}`);
    expect(entries.filter((entry) => entry.startsWith('execution.lock'))).toEqual([]);
  });
});

describe('a rejection racing an execution in another process', () => {
  it('is refused while a run holds the claim, and changes nothing', async () => {
    const { fs, host, store, deps, runId } = await project();

    // A `agent-flow run` in a terminal: the claim on disk names a pid this machine
    // reports as alive. This is the exact input the lock sees in production.
    host.spawn(31_337);
    holdLock(fs, runId, { pid: 31_337, owner: 'cli', operation: 'run' });

    const rejected = await reject(deps, runId, 'stop');

    expect(refusal(rejected).code).toBe('run_busy');
    expect(refusal(rejected).detail).toMatchObject({
      wanted: 'reject',
      holder: { operation: 'run', pid: 31_337 },
    });
    expect((await store.loadRun(runId)).status).toBe('waiting_for_approval');
  });

  it('refuses approve the same way, and records no approval', async () => {
    const { fs, host, store, deps, runId } = await project();

    host.spawn(31_337);
    holdLock(fs, runId, { pid: 31_337, owner: 'cli', operation: 'run' });

    const approved = await approve(deps, runId);

    expect(refusal(approved).code).toBe('run_busy');
    const state = await store.loadRun(runId);
    expect(state.approved).toBe(false);
    expect(state.approvedPlanHash).toBeUndefined();
  });

  it('refuses a retry while a gate move holds the claim', async () => {
    // The exclusion runs both ways, which is what makes it an ordering rather than a
    // privilege. A `reject` in flight is as much a reason to refuse a retry as a run is.
    const { fs, host, deps, runId } = await project();

    host.spawn(31_337);
    holdLock(fs, runId, { pid: 31_337, owner: 'server', operation: 'reject' });

    const retried = await retryTask(deps, runId, 'TASK-001');

    expect(refusal(retried).code).toBe('run_busy');
    expect(refusal(retried).detail).toMatchObject({ holder: { operation: 'reject' } });
  });
});

describe('a plan that was rejected', () => {
  it('is not executed by a later start, even though it had been approved', async () => {
    const { store, deps, runId } = await project();

    // Approval first, then rejection: the ordering the lease permits, and the one that
    // used to leave a hole. `reject` writes `status` and nothing else, so every gate in
    // `execute` was still satisfied and the run executed a plan a person had refused.
    expect((await approve(deps, runId)).ok).toBe(true);
    expect((await reject(deps, runId, 'on reflection, no')).ok).toBe(true);

    const started = await start(deps, runId);

    expect(refusal(started).code).toBe('already_rejected');
    // Nothing ran: the task is where it was.
    expect((await store.loadRun(runId)).tasks[0]?.state).toBe('queued');
  });
});

describe('a run executes in the mode it was born in (M2-03, I-13)', () => {
  // The defect this milestone exists to prevent: a run whose execution strategy
  // changed because a YAML file did. Both directions are asserted, because §6.4
  // requires both to be stated rather than left to inference — and the second is
  // the one that surprises people.

  /** Rewrites the project config a *later* command would read. */
  function flipWorktrees(fs: InMemoryFileSystem, useWorktrees: boolean): void {
    fs.seed('/repo/.agent-flow/config.yaml', `${PROJECT_CONFIG}\ngit:\n  useWorktrees: ${String(useWorktrees)}\n`);
  }

  it('stays sequential through approve when the flag is switched on afterwards', async () => {
    const world = await project();

    // Created sequential — the harness supplies no identity, which is the
    // legacy shape, so this also covers "a legacy run is never promoted".
    expect((await world.store.loadRun(world.runId)).isolationMode).toBeUndefined();

    flipWorktrees(world.fs, true);

    const outcome = await approve(world.deps, world.runId);

    // Approve succeeded: no worktree precondition was evaluated, because the run
    // is not in worktree mode. Had the gate read the configuration instead of
    // the run, this would have failed on a project that is not a repository.
    expect(outcome.ok).toBe(true);
    expect((await world.store.loadRun(world.runId)).isolationMode).toBeUndefined();
  });

  it('stays sequential through start when the flag is switched on afterwards', async () => {
    const world = await project();
    await approve(world.deps, world.runId);

    flipWorktrees(world.fs, true);

    const outcome = await start(world.deps, world.runId);

    // Whatever the run's outcome, the mode did not move and no Git precondition
    // refused it. `/repo` is an in-memory directory and not a repository at all:
    // a config-keyed gate would have refused here with `not_a_git_repository`.
    expect(outcome.ok || outcome.error.code !== 'not_a_git_repository').toBe(true);
    expect((await world.store.loadRun(world.runId)).isolationMode).toBeUndefined();
  });

  it('refuses an isolated run whose repository is not ready, and changes nothing', async () => {
    const world = await project();
    // A run born isolated. `/repo` is in-memory and not a repository, so the
    // preconditions cannot be satisfied — which is the point: the refusal must
    // report the repository, not reclassify the run.
    await world.store.updateRun(world.runId, (state) => ({ ...state }));
    const isolated = new StateStore({
      fs: world.fs,
      clock: new FixedClock(),
      projectDir: '/repo',
    });
    const born = await isolated.createRun('an isolated feature', (runId) => ({
      isolationMode: 'worktree' as const,
      planningBase: 'a'.repeat(40),
      gitRunKey: `${runId}-a93f085c23dd9321`,
    }));

    const before = await isolated.loadRun(born.runId);
    const outcome = await approve(world.deps, born.runId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // A refusal is not a downgrade, not a degradation and not permanent (§6.4).
    const after = await isolated.loadRun(born.runId);
    expect(after.isolationMode).toBe('worktree');
    expect(after.planningBase).toBe(before.planningBase);
    expect(after.gitRunKey).toBe(before.gitRunKey);
    expect(after.degradations).toEqual(before.degradations);
    expect(after.approved).toBe(false);
  });
});


/**
 * Puts a task in a state, by the route §22 actually provides.
 *
 * Every interesting state is reached *through* `running` — a task cannot go from
 * `queued` to `completed` any more than a real one can. Walking the legal path
 * rather than writing the file directly is what keeps this helper from setting up
 * a state the product could never produce.
 */
async function putTaskIn(
  store: StateStore,
  runId: string,
  state: 'running' | 'completed' | 'interrupted' | 'review_required' | 'failed' | 'blocked',
  attempts: number,
): Promise<void> {
  const walk = state === 'running' ? ['running' as const] : ['running' as const, state];
  for (const step of walk) {
    await store.updateRun(runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: step, attempts, infrastructureFailures: 0 }],
    }));
  }
}

// ---------------------------------------------------------------------------
// §16 — the two states a retry must not touch (M2-08)
// ---------------------------------------------------------------------------

describe('a retry names the states it cannot act on (§16, M2-08)', () => {
  it('refuses a completed task, and does not open it with --force', async () => {
    // `completed` is terminal (§22), and in worktree mode it means *integrated*
    // (I-3). A second attempt over work the integration branch already holds is a
    // contradiction rather than a gate, so `--force` deliberately does not open it.
    const { store, deps, runId } = await project();
    await putTaskIn(store, runId, 'completed', 1);
    const before = await store.loadRun(runId);

    for (const force of [false, true]) {
      const retried = await retryTask(deps, runId, 'TASK-001', { force });

      expect(refusal(retried).code, `force: ${String(force)}`).toBe('task_completed');
      // The refusal is a *value*, not the raw illegal-transition error the store
      // would have thrown — and nothing was written on the way to producing it.
      expect(await store.loadRun(runId)).toEqual(before);
    }
  });

  it('refuses a running task and points at the command that reconciles it', async () => {
    // What a killed process leaves. The attempt may have left a validated tree, a
    // receipt, a marker — even a merge — and requeuing would throw all of it away
    // and pay for the agent again (§17.3 windows 3–7). Recovery decides first.
    const { store, deps, runId } = await project();
    await putTaskIn(store, runId, 'running', 1);
    const before = await store.loadRun(runId);

    const retried = await retryTask(deps, runId, 'TASK-001');

    expect(refusal(retried).code).toBe('task_in_flight');
    expect(await store.loadRun(runId)).toEqual(before);
    // The action has to name the command that resolves it, or the refusal is a
    // dead end: `agent-flow run` reconciles durable evidence before requeuing.
    if (retried.ok) return;
    expect(retried.error.action).toContain('agent-flow run');
  });

  it('still requeues an interrupted task, because recovery already judged it', async () => {
    // `interrupted` is what recovery leaves for a task whose work was *not*
    // observed — no artifact, nothing durable. That one is a person's to retry, and
    // `interrupted → queued` is exactly the transition §22 provides for it.
    const { store, deps, runId } = await project();
    await putTaskIn(store, runId, 'interrupted', 1);

    const retried = await retryTask(deps, runId, 'TASK-001');

    expect(retried.ok).toBe(true);
    expect((await store.loadRun(runId)).tasks[0]?.state).toBe('queued');
    // The requeue spends nothing: the next dispatch is what moves the counter
    // (M2-00.2), which is what keeps `retry.maxAttempts` meaning dispatches.
    expect((await store.loadRun(runId)).tasks[0]?.attempts).toBe(1);
  });

  it('requeues a task an integration conflict left for review', async () => {
    // §15's path: the run halted, a person resolved the overlap, and the retry is
    // how the resolved plan gets another attempt — against the moved head.
    const { store, deps, runId } = await project();
    await putTaskIn(store, runId, 'review_required', 1);

    const retried = await retryTask(deps, runId, 'TASK-001');

    expect(retried.ok).toBe(true);
    expect((await store.loadRun(runId)).tasks[0]?.state).toBe('queued');
  });
});

describe('blocked retries split by provenance (dependency vs agent)', () => {
  it('retries a dependency-blocked task without --force', async () => {
    // A dependency block means the task *never ran* (§20) — it was held back by
    // an upstream failure. Requiring `--force` for it granted the force the same
    // gravity as overriding an agent's own BLOCKED answer, and with the reason
    // persisted the two no longer need the same gravity.
    const { store, deps, runId } = await project();
    await store.updateRun(runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'blocked', attempts: 0, infrastructureFailures: 0, blockReason: 'dependency' }],
    }));

    const retried = await retryTask(deps, runId, 'TASK-001');

    expect(retried.ok).toBe(true);
    const after = await store.loadRun(runId);
    expect(after.tasks[0]?.state).toBe('queued');
    // The reason is pinned to the blocked state; a queued task carries none.
    expect(after.tasks[0]?.blockReason).toBeUndefined();
  });

  it('refuses an agent-blocked task without --force, and still opens it with it', async () => {
    // The other half of the split: a task whose *own* agent answered BLOCKED is
    // exactly what §23's force gate protects — the retry would repeat the answer
    // the SDD is missing, or manufacture a guess. Force stays the deliberate act.
    const { store, deps, runId } = await project();
    await store.updateRun(runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'blocked', attempts: 1, infrastructureFailures: 0, blockReason: 'agent' }],
    }));

    const refused = await retryTask(deps, runId, 'TASK-001');
    expect(refusal(refused).code).toBe('task_blocked');

    const forced = await retryTask(deps, runId, 'TASK-001', { force: true });
    expect(forced.ok).toBe(true);
    expect((await store.loadRun(runId)).tasks[0]?.state).toBe('queued');
  });

  it('treats a blocked task with no recorded reason as agent-blocked (fail-closed)', async () => {
    // State written before this provenance existed has no `blockReason` on disk,
    // and absence is evidence of nothing — so the retry gate holds it closed,
    // matching the scheduler's conservative default.
    const { store, deps, runId } = await project();
    await store.updateRun(runId, (current) => ({
      ...current,
      tasks: [{ id: 'TASK-001', state: 'blocked', attempts: 1, infrastructureFailures: 0 }],
    }));

    const refused = await retryTask(deps, runId, 'TASK-001');
    expect(refusal(refused).code).toBe('task_blocked');
  });
});

/**
 * C-19 (AR-07) — the lock is not taken for a run with nothing to run.
 *
 * The evidence run acquired and released the execution lease three times with nothing
 * runnable: every gate below `start` lives *inside* the lock, so a refusal still cost a
 * full acquire/refuse/release cycle and wrote two events describing work that never
 * happened. Whether a run has anything to do is answerable from persisted state.
 */
describe('run refuses before it takes the lock (C-19)', () => {
  const lockPath = (runId: string) => `/repo/.agent-flow/runs/${runId}/execution.lock`;

  it('does not take the lock for a run whose only task is at a gate', async () => {
    const world = await project();
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      approved: true,
      status: 'approved',
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    }));
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'review_required', attempts: 1, infrastructureFailures: 0 }],
    }));

    const outcome = await start(world.deps, world.runId);

    expect(outcome.ok).toBe(false);
    // The whole point: no lease file was ever written.
    expect(await world.fs.exists(lockPath(world.runId))).toBe(false);

    const types = (await world.store.readEvents(world.runId)).map((event) => event.type);
    expect(types).not.toContain('execution_lock_acquired');
  });

  it('names the gate and the one action that clears it', async () => {
    const world = await project();
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      approved: true,
      status: 'approved',
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    }));
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'review_required', attempts: 1, infrastructureFailures: 0 }],
    }));

    const outcome = await start(world.deps, world.runId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect((outcome.error.action ?? '').length).toBeGreaterThan(0);
    expect(`${outcome.error.message} ${outcome.error.action ?? ''}`).toMatch(/review_required|review|TASK-001/i);
  });

  it('does not take the lock for a run that is already finished', async () => {
    const world = await project();
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      status: 'completed',
      tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    }));
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      status: 'completed',
      tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
    }));

    const outcome = await start(world.deps, world.runId);

    expect(outcome.ok).toBe(false);
    expect(await world.fs.exists(lockPath(world.runId))).toBe(false);
  });

  it('still takes the lock when there is genuinely something to run', async () => {
    // The control. A guard that refused everything would pass every test above and make
    // the product useless.
    const world = await project();
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      approved: true,
      approvedPlanHash: planHash(PlanSchema.parse(PLAN)),
      status: 'approved',
      tasks: [{ id: 'TASK-001', state: 'queued', attempts: 0, infrastructureFailures: 0 }],
    }));

    await start(world.deps, world.runId);

    const types = (await world.store.readEvents(world.runId)).map((event) => event.type);
    expect(types).toContain('execution_lock_acquired');
  });

  it('leaves a run with no plan to the gate inside, which has the better message', async () => {
    // Not every refusal belongs out here. `isResumable` answers "is there work"; a run
    // with no plan at all has a different answer and its own sentence, and duplicating
    // that judgement in two places is how the two start to disagree.
    const world = await project();
    await world.fs.remove(`/repo/.agent-flow/runs/${world.runId}/plan.json`);
    await world.store.updateRun(world.runId, (state) => ({
      ...state,
      approved: true,
      status: 'approved',
      tasks: [],
    }));

    const outcome = await start(world.deps, world.runId);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('no_plan');
  });
});
