import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { StateStore } from '../../src/app/state-store.js';
import { LOCK_VERSION } from '../../src/app/run-execution-lock.js';
import { complete, type ActionError, type ActionOutcome } from '../../src/app/run-actions.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { projectRun } from '../../src/core/run-projection.js';

/**
 * `complete` — the way out of a run the Definition of Done did not close (dogfood 09/10).
 *
 * Run 75716 was delivered as a hand-opened draft PR, outside `forge`. Its review ended NOT
 * DONE (e2e could not run), and nothing could close it: the status said "accept and merge"
 * and there was no `accept`. A run closes on its own when the Definition of Done holds; this
 * is the other way, and it is a human decision — named, in their words, on the record beside
 * what the review said was missing.
 */

const PROJECT_CONFIG = `project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\n`;

const DECISION = {
  by: 'Luis',
  words: 'entregue no PR draft 123; o e2e eu vi funcionando no aparelho',
  channel: 'cli' as const,
};

async function project({ reviewed = true }: { reviewed?: boolean } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();
  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('popup');
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'approved',
    approved: true,
    stage: 'final-review',
    tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
  }));
  await store.appendEvent(run.runId, 'task_finished', { task: 'TASK-001' });
  if (reviewed) {
    await store.appendEvent(run.runId, 'run_review_started', {});
    await store.appendEvent(run.runId, 'run_review_concluded', {
      done: false,
      unmet: [{ name: 'e2e exercised the change and passed', detail: 'e2e did not run' }],
    });
  }

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  });

  return { fs, host, store, deps, runId: run.runId };
}

function refusal(outcome: ActionOutcome<unknown>): ActionError {
  expect(outcome.ok, 'expected a refusal and got a success').toBe(false);
  if (outcome.ok) throw new Error('unreachable');
  return outcome.error;
}

describe('complete (dogfood 09/10)', () => {
  it('closes a reviewed run on a named human decision, and records what it overrode', async () => {
    const { store, deps, runId } = await project();

    const outcome = await complete(deps, runId, DECISION, { pr: 'https://dev.azure.com/x/pullrequest/123' });
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);

    const state = await store.loadRun(runId);
    expect(state.status).toBe('completed');
    expect(projectRun({ state }).status).toBe('complete');

    const events = await store.readEvents(runId);
    const completed = events.find((event) => event.type === 'run_completed_by_human');
    expect(completed?.detail).toMatchObject({
      overrode: ['e2e exercised the change and passed'],
      pr: 'https://dev.azure.com/x/pullrequest/123',
    });
    const action = events.find(
      (event) => event.type === 'operator_action' && event.detail['action'] === 'complete',
    );
    expect(action?.detail['decidedBy']).toEqual(DECISION);
  });

  it('refuses without the human’s name and words, and writes nothing', async () => {
    const { store, deps, runId } = await project();
    const before = (await store.readEvents(runId)).length;

    const error = refusal(await complete(deps, runId, { ...DECISION, by: '  ' }));
    expect(error.code).toBe('invalid_input');
    expect((await store.loadRun(runId)).status).toBe('approved');
    expect(await store.readEvents(runId)).toHaveLength(before);
  });

  it('refuses a run whose current work no review has concluded on', async () => {
    // Without this, `complete` would close a run mid-implementation with nothing on the
    // record saying what was skipped. Cancelling is the way to stop one.
    const { store, deps, runId } = await project({ reviewed: false });

    const error = refusal(await complete(deps, runId, DECISION));
    expect(error.code).toBe('review_required');
    expect(error.action).toContain('agent-flow review');
    expect((await store.loadRun(runId)).status).toBe('approved');
  });

  // Adversarial review: a verdict is about one tree. A revalidated task integrates without a
  // `task_finished`, so the head moves under a conclusion that no longer describes it.
  it('refuses a verdict about another head, or one a revalidation has since superseded', async () => {
    const moved = await project();
    await moved.store.appendEvent(moved.runId, 'run_review_concluded', {
      done: false,
      unmet: [{ name: 'e2e exercised the change and passed' }],
      integrationHead: 'a'.repeat(40),
    });
    await moved.store.updateRun(moved.runId, (state) => ({ ...state, integrationHead: 'b'.repeat(40) }));
    expect(refusal(await complete(moved.deps, moved.runId, DECISION)).code).toBe('review_required');

    const revalidated = await project();
    await revalidated.store.appendEvent(revalidated.runId, 'task_revalidated', { task: 'TASK-001', passed: true });
    expect(refusal(await complete(revalidated.deps, revalidated.runId, DECISION)).code).toBe('review_required');
  });

  it('refuses while a review of the run is still going', async () => {
    // Sequential mode reviews without the lease, so the lease alone cannot keep a close out.
    const { store, deps, runId } = await project();
    await store.appendEvent(runId, 'run_review_started', {});

    expect(refusal(await complete(deps, runId, DECISION)).code).toBe('run_busy');
    expect((await store.loadRun(runId)).status).toBe('approved');
  });

  it('refuses a cancelled or failed run, and is idempotent on a completed one', async () => {
    const { store, deps, runId } = await project();

    await store.updateRun(runId, (state) => ({ ...state, status: 'cancelled' }));
    expect(refusal(await complete(deps, runId, DECISION)).code).toBe('run_completed');

    await store.updateRun(runId, (state) => ({ ...state, status: 'completed' }));
    const again = await complete(deps, runId, DECISION);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.alreadyCompleted).toBe(true);
  });

  it('refuses while something is executing the run', async () => {
    const { fs, host, deps, runId } = await project();
    host.spawn(31_337);
    fs.seed(
      `/repo/.agent-flow/runs/${runId}/execution.lock.1`,
      JSON.stringify({
        version: LOCK_VERSION,
        generation: 1,
        runId,
        hostname: 'test-host',
        createdAt: '2026-08-10T19:00:00.000Z',
        pid: 31_337,
        owner: 'cli',
        operation: 'review',
      }),
    );

    expect(refusal(await complete(deps, runId, DECISION)).code).toBe('run_busy');
  });
});
