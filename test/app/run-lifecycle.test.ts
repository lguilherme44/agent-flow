import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { StateStore } from '../../src/app/state-store.js';
import { LOCK_VERSION } from '../../src/app/run-execution-lock.js';
import {
  cancel,
  pause,
  resume,
  start,
  type ActionError,
  type ActionOutcome,
  type RunActionDeps,
} from '../../src/app/run-actions.js';
import { watchLifecycle } from '../../src/app/run-lifecycle.js';
import { PlanSchema } from '../../src/contracts/index.js';
import { planHash } from '../../src/app/approval.js';

/**
 * PRI-14 and PRI-15 — the two things an operator can do to a run in flight.
 *
 * The property every case here is really about is that **the operator and the run are not
 * the same process**. A run executes under `agent-flow run` in one terminal or inside a
 * server job; `pause` is typed in another. So neither command may take the execution
 * lease — a pause that waited for the run to finish is a no-op with extra steps — and the
 * intent has to survive on disk for the executing process to find.
 */

const PROJECT_CONFIG = `project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\n`;

const PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'final-review',
];

const PLAN = {
  feature: 'weekly-recurrence',
  tasks: [
    {
      id: 'TASK-001',
      title: 'Add recurrence types',
      description: 'Domain types.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Types compile.'],
      validation: ['test'],
    },
    {
      id: 'TASK-002',
      title: 'Wire them up',
      description: 'Use the types.',
      complexity: 'normal',
      risk: 'low',
      dependencies: ['TASK-001'],
      requirements: ['FR-001'],
      acceptanceCriteria: ['It compiles.'],
      validation: ['test'],
    },
  ],
};

async function project() {
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
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n');
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
    status: 'approved',
    approved: true,
    tasks: [
      { id: 'TASK-001', state: 'queued', attempts: 0, infrastructureFailures: 0 },
      { id: 'TASK-002', state: 'queued', attempts: 0, infrastructureFailures: 0 },
    ],
  }));

  const deps: RunActionDeps = {
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  };

  return { fs, clock, host, store, deps, runId: run.runId };
}

/** A claim on disk, as a holder in another process would have left one. */
function holdLock(fs: InMemoryFileSystem, runId: string, pid: number): void {
  fs.seed(
    `/repo/.agent-flow/runs/${runId}/execution.lock.1`,
    JSON.stringify({
      version: LOCK_VERSION,
      generation: 1,
      runId,
      hostname: 'test-host',
      createdAt: '2026-08-10T19:00:00.000Z',
      pid,
      owner: 'cli',
      operation: 'run',
    }),
  );
}

/** The error of a refused outcome, having first asserted that it *is* one. */
function refusal(outcome: ActionOutcome<unknown>): ActionError {
  expect(outcome.ok, 'expected a refusal and got a success').toBe(false);
  if (outcome.ok) throw new Error('unreachable: the assertion above has already failed');
  return outcome.error;
}

describe('pause (PRI-15)', () => {
  it('records the request without taking the execution lease', async () => {
    // The property that makes pause useful at all. If it took the lease it would block
    // until the run it is pausing had finished, which is the moment a pause stops
    // mattering.
    const { deps, store, fs, host, runId } = await project();
    host.spawn(31_337);
    holdLock(fs, runId, 31_337);

    const outcome = await pause(deps, runId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.executing, 'a held lease was not observed').toBe(true);
    expect((await store.loadRun(runId)).pauseRequestedAt).toBeDefined();
  });

  it('says the task in flight will finish, rather than claiming to be immediate', async () => {
    const { deps, fs, host, runId } = await project();
    host.spawn(31_337);
    holdLock(fs, runId, 31_337);

    const outcome = await pause(deps, runId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.warnings.join(' ')).toMatch(/in flight/i);
  });

  it('is idempotent, and does not move the timestamp', async () => {
    // "When did somebody ask this to stop" must not change because they asked twice.
    const { deps, store, runId } = await project();

    const first = await pause(deps, runId);
    expect(first.ok).toBe(true);
    const at = (await store.loadRun(runId)).pauseRequestedAt;

    const second = await pause(deps, runId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.alreadyPaused).toBe(true);
    expect((await store.loadRun(runId)).pauseRequestedAt).toBe(at);
  });

  it('writes one event, not one per request', async () => {
    const { deps, store, runId } = await project();

    await pause(deps, runId);
    await pause(deps, runId);

    const events = await store.readEvents(runId);
    expect(events.filter((event) => event.type === 'run_paused')).toHaveLength(1);
  });

  it('refuses a finished run rather than recording an intent nobody can act on', async () => {
    const { deps, store, runId } = await project();
    await store.updateRun(runId, (state) => ({ ...state, status: 'completed' }));

    expect(refusal(await pause(deps, runId)).code).toBe('run_completed');
  });

  it('does not change any task state', async () => {
    // Pause interrupts nothing, so nothing about the tasks may move. A pause that wrote
    // `interrupted` would be a cancel wearing the wrong name.
    const { deps, store, runId } = await project();
    const before = (await store.loadRun(runId)).tasks;

    await pause(deps, runId);

    expect((await store.loadRun(runId)).tasks).toEqual(before);
  });
});

describe('start, once a pause is on disk (PRI-15)', () => {
  it('refuses, and names resume rather than a force', async () => {
    // Both entry points, or neither. The request is on disk precisely so that
    // `agent-flow run`, typed after a pause, meets it — a pause only the dashboard
    // honoured would be one the terminal silently overrode.
    const { deps, runId } = await project();
    await pause(deps, runId);

    const error = refusal(await start(deps, runId));

    expect(error.code).toBe('run_paused');
    expect(error.action).toMatch(/resume/i);
    // Not "nothing to run", which is true of the projection and useless to a person
    // holding the one command that fixes it.
    expect(error.message).not.toMatch(/nothing to run/i);
  });
});

describe('resume (PRI-15)', () => {
  it('refuses a run nobody paused, because resume and run are not aliases', async () => {
    const { deps, runId } = await project();

    const error = refusal(await resume(deps, runId));

    expect(error.code).toBe('not_paused');
    expect(error.action).toMatch(/agent-flow run/);
  });

  it('refuses while something still holds the lease, and leaves the pause in place', async () => {
    // Resume must not mean "start a second scheduler", which is what the lease exists to
    // prevent. Asked before the request is cleared, so a refusal leaves the run paused
    // rather than half-resumed.
    const { deps, store, fs, host, runId } = await project();
    await pause(deps, runId);
    host.spawn(31_337);
    holdLock(fs, runId, 31_337);

    const error = refusal(await resume(deps, runId));

    expect(error.code).toBe('run_busy');
    expect((await store.loadRun(runId)).pauseRequestedAt, 'the pause was cleared anyway').toBeDefined();
  });

  it('refuses a cancelled run: there is no un-cancel', async () => {
    const { deps, runId } = await project();
    await cancel(deps, runId);

    expect(refusal(await resume(deps, runId)).code).toBe('run_cancelled');
  });
});

describe('cancel (PRI-14)', () => {
  it('reaches a terminal state that is neither completed nor failed', async () => {
    // Reporting an operator's decision as a failure would make every surface that reads
    // this — the dashboard, the Definition of Done, `status --json` — describe a choice as
    // a defect.
    const { deps, store, runId } = await project();

    const outcome = await cancel(deps, runId);

    expect(outcome.ok).toBe(true);
    const after = await store.loadRun(runId);
    expect(after.status).toBe('cancelled');
    expect(after.cancelledAt).toBeDefined();
  });

  it('moves running tasks to interrupted and leaves queued ones alone', async () => {
    // `interrupted` already means "was running and nothing is executing it". Queued tasks
    // never started; moving them to a terminal state would erase the plan's remaining work
    // from a run somebody may want to read.
    const { deps, store, runId } = await project();
    await store.updateRun(runId, (state) => ({
      ...state,
      tasks: [
        { id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 },
        { id: 'TASK-002', state: 'queued', attempts: 0, infrastructureFailures: 0 },
      ],
    }));

    const outcome = await cancel(deps, runId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.interrupted).toEqual(['TASK-001']);

    const after = await store.loadRun(runId);
    expect(after.tasks.map((task) => task.state)).toEqual(['interrupted', 'queued']);
  });

  it('keeps every attempt artifact, because a cancelled run is the one people read', async () => {
    const { deps, store, fs, runId } = await project();
    const artifact = `/repo/.agent-flow/runs/${runId}/tasks/TASK-001/attempt-1.json`;
    fs.seed(artifact, JSON.stringify({ task: 'TASK-001', attempt: 1 }));

    await cancel(deps, runId);

    expect(await fs.readFile(artifact)).toContain('TASK-001');
    // And the plan, and everything else the run wrote.
    expect(await store.readArtifact(runId, 'plan')).not.toBeNull();
  });

  it('records who was executing, so a cancellation is not mistaken for a crash', async () => {
    const { deps, store, fs, host, runId } = await project();
    host.spawn(31_337);
    holdLock(fs, runId, 31_337);

    await cancel(deps, runId);

    const event = (await store.readEvents(runId)).find((entry) => entry.type === 'run_cancelled');
    expect(event?.detail).toMatchObject({ pid: 31_337, hostname: 'test-host' });
  });

  it('is idempotent, and the second call does not move the timestamp', async () => {
    const { deps, store, runId } = await project();

    await cancel(deps, runId);
    const at = (await store.loadRun(runId)).cancelledAt;

    const second = await cancel(deps, runId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.alreadyCancelled).toBe(true);
    expect((await store.loadRun(runId)).cancelledAt).toBe(at);
    expect(
      (await store.readEvents(runId)).filter((event) => event.type === 'run_cancelled'),
    ).toHaveLength(1);
  });

  it('clears a pause request rather than leaving two intents on one run', async () => {
    const { deps, store, runId } = await project();
    await pause(deps, runId);

    await cancel(deps, runId);

    const after = await store.loadRun(runId);
    expect(after.status).toBe('cancelled');
    expect(after.pauseRequestedAt).toBeUndefined();
  });

  it('refuses a finished run', async () => {
    const { deps, store, runId } = await project();
    await store.updateRun(runId, (state) => ({ ...state, status: 'failed' }));

    expect(refusal(await cancel(deps, runId)).code).toBe('run_completed');
  });
});

describe('start, once a run is cancelled (PRI-14)', () => {
  it('refuses and says what survived', async () => {
    const { deps, runId } = await project();
    await cancel(deps, runId);

    const error = refusal(await start(deps, runId));

    expect(error.code).toBe('run_cancelled');
    expect(error.action).toMatch(/still on disk/i);
  });
});

describe('the lifecycle watch, which is how an executing process learns', () => {
  /** Resolves immediately, so the poll loop turns as fast as the test drives it. */
  const immediate = async (): Promise<void> => {
    await Promise.resolve();
  };

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  }

  it('aborts dispatch on a pause, and leaves the running attempt alone', async () => {
    // The separation that is the entire difference between the two operations. One signal
    // serving both would make a pause terminate the task in flight.
    const { deps, store, runId } = await project();
    const watch = watchLifecycle({ store, runId, intervalMs: 0, sleep: immediate });

    await pause(deps, runId);
    await settle();

    expect(watch.observed()).toBe('paused');
    expect(watch.signal.aborted, 'dispatch was not stopped').toBe(true);
    expect(watch.terminateSignal.aborted, 'a pause killed the task in flight').toBe(false);

    watch.stop();
  });

  it('aborts both on a cancel', async () => {
    const { deps, store, runId } = await project();
    const watch = watchLifecycle({ store, runId, intervalMs: 0, sleep: immediate });

    await cancel(deps, runId);
    await settle();

    expect(watch.observed()).toBe('cancelled');
    expect(watch.signal.aborted).toBe(true);
    expect(watch.terminateSignal.aborted, 'the agents were left running').toBe(true);

    watch.stop();
  });

  it('prefers cancel over a pause that is also present', async () => {
    // A run paused and then cancelled must terminate. The reverse order would settle on
    // `paused` and leave the agent running.
    const { store, runId } = await project();
    await store.updateRun(runId, (state) => ({
      ...state,
      status: 'cancelled',
      pauseRequestedAt: '2026-08-10T19:00:00.000Z',
    }));

    const watch = watchLifecycle({ store, runId, intervalMs: 0, sleep: immediate });
    await settle();

    expect(watch.observed()).toBe('cancelled');
    expect(watch.terminateSignal.aborted).toBe(true);

    watch.stop();
  });

  it('does not abort a healthy run', async () => {
    const { store, runId } = await project();
    const watch = watchLifecycle({ store, runId, intervalMs: 0, sleep: immediate });

    await settle();

    expect(watch.observed()).toBeUndefined();
    expect(watch.signal.aborted).toBe(false);

    watch.stop();
  });

  it('treats a read it could not complete as no intent at all', async () => {
    // A state file being replaced by an atomic rename at the moment of a poll must not
    // cancel a healthy run. "The orchestrator stopped because it briefly could not read a
    // file" is a far worse outcome than a pause arriving one poll later.
    const { store, runId } = await project();
    let calls = 0;
    const failing = {
      loadRun: async (id: string) => {
        calls += 1;
        if (calls < 3) throw new Error('ENOENT: the file was mid-rename');
        return store.loadRun(id);
      },
    } as unknown as StateStore;

    const watch = watchLifecycle({ store: failing, runId, intervalMs: 0, sleep: immediate });
    await settle();

    expect(calls, 'the watch gave up after the first failure').toBeGreaterThan(2);
    expect(watch.signal.aborted).toBe(false);

    watch.stop();
  });

  it('stops polling when told to', async () => {
    const { store, runId } = await project();
    let calls = 0;
    const counting = {
      loadRun: async (id: string) => {
        calls += 1;
        return store.loadRun(id);
      },
    } as unknown as StateStore;

    const watch = watchLifecycle({ store: counting, runId, intervalMs: 0, sleep: immediate });
    await settle();
    watch.stop();

    const after = calls;
    await settle();

    expect(calls, 'the watch kept polling after stop()').toBe(after);
  });
});
