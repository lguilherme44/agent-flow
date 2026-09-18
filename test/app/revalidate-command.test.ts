import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { StateStore } from '../../src/app/state-store.js';
import { revalidate } from '../../src/app/run-actions.js';

/**
 * The use case as the two adapters reach it (D19).
 *
 * `task-revalidation.integration.test.ts` proves what the command *does*, against real
 * Git. This proves the half that lives on this side of the seam and that a Git test cannot
 * see: that the refusals arrive as a structured `ActionError` with a code the CLI and the
 * HTTP API can both render, and that they arrive **before the execution lease is taken**.
 *
 * That last one is C-19's rule and it is asserted on the audit trail rather than on a
 * comment: a refusal taken under the lease writes `execution_lock_acquired` and
 * `execution_lock_released` describing work that never happened, and the evidence run
 * recorded exactly that three times.
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
  // No Git identity: a sequential run, and what every run predating isolation looks like.
  const run = await store.createRun('a feature');
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'approved',
    approved: true,
    tasks: [{ id: 'TASK-004', state: 'failed' as const, attempts: 2, infrastructureFailures: 0 }],
  }));

  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host: new FakeHost(),
    owner: 'cli',
  });

  return { fs, store, deps, runId: run.runId };
}

describe('agent-flow revalidate, as a use case', () => {
  it('refuses a run that never isolated anything, with a code a renderer can act on', async () => {
    const { deps, runId } = await project();

    const outcome = await revalidate(deps, runId, 'TASK-004');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('revalidation_unsupported');
    // A refusal that ends in a sentence rather than a shrug: there is a command that can
    // still help a sequential run, and it is named.
    expect(outcome.error.action).toContain('agent-flow review');
  });

  it('refuses before the lease is taken (C-19)', async () => {
    const { store, deps, runId } = await project();

    await revalidate(deps, runId, 'TASK-004');

    const events = await store.readEvents(runId);
    expect(events.some((event) => event.type === 'execution_lock_acquired')).toBe(false);
    expect(events.some((event) => event.type === 'execution_lock_released')).toBe(false);
  });

  it('refuses a task this run never had', async () => {
    const { deps, runId } = await project();

    const outcome = await revalidate(deps, runId, 'TASK-404');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('task_not_revalidatable');
  });

  it('refuses a run that does not exist, rather than throwing at the reader', async () => {
    const { deps } = await project();

    const outcome = await revalidate(deps, 'AF-2026-999', 'TASK-004');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('no_such_run');
  });
});
