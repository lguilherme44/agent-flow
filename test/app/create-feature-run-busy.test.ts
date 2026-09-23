import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { createFeatureRun } from '../../src/app/run-actions.js';
import { RunExecutionLock } from '../../src/app/run-execution-lock.js';
import { StateStore } from '../../src/app/state-store.js';

/**
 * A second `feature` in the same checkout while the current run is being executed.
 *
 * `createRun` points `current-run` at the new run unconditionally, and `approve`/`run`
 * without an id act on `current-run`. So a second chat typing `agent-flow feature` in a
 * checkout another process is executing silently re-aimed every later command of the
 * first — found reading the store against the "several chat windows" way of using this.
 * Refused now while a live process holds the current run's execution lock; a separate
 * worktree is the way to work in parallel.
 */

const PROJECT_CONFIG = 'project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\n';

function world() {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  const host = new FakeHost();
  const clock = new FixedClock();
  const deps = fakeRunActionDeps({ fs, host, clock });
  const lock = new RunExecutionLock({ fs, clock, host, projectDir: '/repo' });
  return { fs, host, deps, lock, store: new StateStore({ fs, clock, projectDir: '/repo' }) };
}

describe('createFeatureRun while the current run is being executed', () => {
  it('refuses, naming the run and the process, instead of re-aiming current-run', async () => {
    const { deps, lock, store } = world();
    const first = await createFeatureRun(deps, 'first feature');
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.value.runId : '';

    const held = await lock.acquire({ runId: firstId, owner: 'cli', operation: 'run' });
    expect(held.ok).toBe(true);

    const second = await createFeatureRun(deps, 'second feature');

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('run_busy');
      expect(second.error.message).toContain(firstId);
    }
    expect((await store.loadCurrentRun())?.runId).toBe(firstId);
  });

  it('positive control: once the execution ends, a new feature is created as before', async () => {
    const { deps, lock } = world();
    const first = await createFeatureRun(deps, 'first feature');
    const firstId = first.ok ? first.value.runId : '';
    const held = await lock.acquire({ runId: firstId, owner: 'cli', operation: 'run' });
    if (held.ok) await held.lease.release();

    const second = await createFeatureRun(deps, 'second feature');
    expect(second.ok).toBe(true);
  });
});
