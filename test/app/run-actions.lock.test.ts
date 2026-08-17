import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { LOCK_VERSION } from '../../src/app/run-execution-lock.js';
import { retryTask, type RunActionDeps } from '../../src/app/run-actions.js';

/**
 * AF-L01.1-A — the lease outlives nothing.
 *
 * The bug these cover is not in the lock; it is in the code that holds one. Acquisition
 * used to be followed by two `appendEvent` calls that sat *outside* the `try`, so a
 * write failure on `events.jsonl` — a full disk, a permission change, an I/O error —
 * threw out of a function that had already claimed the run. The claim left behind names
 * this process, which is alive, so stale detection can never clear it: every later
 * `start`, `revise` and `retry` on that run is refused until the process exits.
 *
 * Everything here goes through `retryTask`, which is the real use case. A hand-written
 * `try/finally` around `lease.release()` would prove a property of the test rather than
 * of production, and this file exists precisely because the shape of production was
 * wrong while the lock underneath it was right.
 */

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands:
  test: npm test
`;

const PROMPTS = [
  'discovery',
  'architecture-impact',
  'sdd',
  'planning',
  'plan-review',
  'verification',
  'final-review',
];

async function project() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const name of PROMPTS) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\noutputFormat: json\nrequiredVars: [task, sdd]\n---\n\n# implementation\n',
  );

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('a feature');

  // A task that failed, so a retry has something real to do — which is how "did the
  // work run?" becomes an observable question rather than an assumption.
  await store.updateRun(run.runId, (state) => ({
    ...state,
    tasks: [{ id: 'FIX-001', state: 'failed', attempts: 1, infrastructureFailures: 0 }],
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

  return { fs, host, store, deps, runId: run.runId };
}

/** Fails the append of one audit event, by name. */
function failEvent(fs: InMemoryFileSystem, type: string): void {
  fs.failWrite = (operation, _path, content) =>
    operation === 'append' && content.includes(`"${type}"`)
      ? Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      : undefined;
}

/** The generation files left in the run directory. Empty means the lease is gone. */
async function claims(fs: InMemoryFileSystem, runId: string): Promise<string[]> {
  const entries = await fs.readDir(`/repo/.agent-flow/runs/${runId}`);
  return entries.filter((entry) => entry.startsWith('execution.lock'));
}

async function taskState(store: StateStore, runId: string): Promise<string | undefined> {
  return (await store.loadRun(runId)).tasks.find((task) => task.id === 'FIX-001')?.state;
}

describe('an audit write that fails after the lock is taken', () => {
  it('releases the lease when execution_lock_acquired cannot be written', async () => {
    const { fs, store, deps, runId } = await project();
    failEvent(fs, 'execution_lock_acquired');

    await expect(retryTask(deps, runId, 'FIX-001')).rejects.toThrow('ENOSPC');

    // The work never ran: the task is untouched and nothing was requeued. That is the
    // correct outcome — the audit trail is part of the contract, and an execution
    // nobody could record should not proceed.
    expect(await taskState(store, runId)).toBe('failed');
    expect((await store.readEvents(runId)).map((event) => event.type)).not.toContain(
      'task_requeued',
    );

    // And the run is not locked out. Before AF-L01.1 the claim stayed on disk with a
    // live pid in it, which is the one state no recovery path can reach.
    expect(await claims(fs, runId)).toEqual([]);

    fs.failWrite = undefined;
    const second = await retryTask(deps, runId, 'FIX-001');
    expect(second.ok).toBe(true);
    expect(await taskState(store, runId)).toBe('queued');
  });

  it('releases the lease when the stale-recovery event cannot be written', async () => {
    const { fs, store, deps, runId } = await project();

    // A previous execution that died holding the lock. Recovering it is the first
    // thing `withExecutionLock` records, so it is the first append that can fail.
    fs.seed(
      `/repo/.agent-flow/runs/${runId}/execution.lock.1`,
      JSON.stringify({
        version: LOCK_VERSION,
        generation: 1,
        runId,
        pid: 999,
        hostname: 'test-host',
        owner: 'cli',
        operation: 'run',
        createdAt: '2026-08-10T19:00:00.000Z',
      }),
    );
    failEvent(fs, 'stale_execution_lock_recovered');

    await expect(retryTask(deps, runId, 'FIX-001')).rejects.toThrow('ENOSPC');

    expect(await taskState(store, runId)).toBe('failed');
    // Generation 2 was claimed, then released; generation 1 was tidied on the way in.
    expect(await claims(fs, runId)).toEqual([]);

    fs.failWrite = undefined;
    expect((await retryTask(deps, runId, 'FIX-001')).ok).toBe(true);
  });

  it('releases the lease when the work itself throws', async () => {
    const { fs, deps, runId } = await project();

    // `requeue` writes `state.json` through the StateStore. A failure there is an
    // exception out of `work`, which is the ordinary case the `finally` was always
    // meant to cover — asserted here so the restructuring above cannot lose it.
    fs.failWrite = (operation, path) =>
      operation === 'atomic' && path.endsWith('state.json')
        ? new Error('EACCES: permission denied')
        : undefined;

    await expect(retryTask(deps, runId, 'FIX-001')).rejects.toThrow('EACCES');
    expect(await claims(fs, runId)).toEqual([]);
  });
});

describe('an audit write that fails after the lock is released', () => {
  it('does not put the lock back, and does not mask the result', async () => {
    const { fs, store, deps, runId } = await project();
    failEvent(fs, 'execution_lock_released');

    // Best-effort, and deliberately so: by the time this event is written the claim is
    // already off disk. Throwing here would swap a real result for a logging error,
    // and the loss is visible anyway — an `acquired` with nothing closing it.
    const outcome = await retryTask(deps, runId, 'FIX-001');

    expect(outcome.ok).toBe(true);
    expect(await taskState(store, runId)).toBe('queued');
    expect(await claims(fs, runId)).toEqual([]);

    const types = (await store.readEvents(runId)).map((event) => event.type);
    expect(types).toContain('execution_lock_acquired');
    // The append really did fail — otherwise this test would be asserting nothing.
    expect(types).not.toContain('execution_lock_released');

    fs.failWrite = undefined;
    expect((await retryTask(deps, runId, 'FIX-001')).ok).toBe(true);
  });
});
