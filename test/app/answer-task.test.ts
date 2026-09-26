import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';
import { StateStore } from '../../src/app/state-store.js';
import { planHash } from '../../src/app/approval.js';
import { LOCK_VERSION } from '../../src/app/run-execution-lock.js';
import { runPaths } from '../../src/app/paths.js';
import {
  answerTask,
  approve,
  retryTask,
  type ActionOutcome,
} from '../../src/app/run-actions.js';
import { PlanSchema, type RunActor, type TaskProgress } from '../../src/contracts/index.js';

/**
 * P7.1 — answering what an agent-blocked task asked (FR-002, FR-003, FR-008).
 *
 * The product told the operator to "answer what the blocked task reported, then retry it"
 * and had no command for the first half, so the only road was `retry --force`. These tests
 * hold the new road to three things: it opens exactly the task the force gate guards and no
 * other, it leaves the task in exactly the shape a retry does, and every refusal leaves the
 * run byte for byte as it found it.
 */

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
  complexity: 'trivial',
  risk: 'low',
  dependencies: [],
  requirements: ['FR-001'],
  acceptanceCriteria: ['It works.'],
  validation: ['test'],
});

const PLAN = { feature: 'weekly-recurrence', tasks: [planTask('TASK-001'), planTask('TASK-002')] };

const DEVICE: RunActor = { kind: 'device', deviceId: 'device-1', label: 'Tablet' };

async function project(options: { actor?: RunActor } = {}) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  for (const name of ['discovery', 'architecture-impact', 'sdd', 'planning', 'plan-review']) {
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
      planHash: planHash(PlanSchema.parse(PLAN)),
      findings: [],
    }),
  );
  await store.updateRun(run.runId, (state) => ({
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
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });

  // Approved, so the answer has a plan hash to be bound to (FR-004).
  const approved = await approve(deps, run.runId);
  if (!approved.ok) throw new Error(`approve refused: ${approved.error.code}`);

  return { fs, clock, host, store, deps, runId: run.runId };
}

/** Sets one task's progress, leaving the other as it is. */
async function setTask(
  store: StateStore,
  runId: string,
  taskId: string,
  progress: Omit<TaskProgress, 'id' | 'infrastructureFailures'>,
): Promise<void> {
  await store.updateRun(runId, (current) => ({
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === taskId ? { id: taskId, infrastructureFailures: 0, ...progress } : task,
    ),
  }));
}

/** The two files a refusal must not touch, as bytes. */
async function snapshot(fs: InMemoryFileSystem, runId: string) {
  const paths = runPaths('/repo', runId);
  const read = async (path: string) => ((await fs.exists(path)) ? fs.readFile(path) : null);
  return { state: await read(paths.state), events: await read(paths.events) };
}

function refusal(outcome: ActionOutcome<unknown>) {
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.error;
}

describe('answering an agent-blocked task (FR-003)', () => {
  it('requeues it without --force, records one answer amendment, and says so in the log', async () => {
    const { store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 3, blockReason: 'agent' });
    const approvedPlanHash = (await store.loadRun(runId)).approvedPlanHash;
    const eventsBefore = (await store.readEvents(runId)).length;

    const answered = await answerTask(deps, runId, 'TASK-001', '  use the v2 endpoint \n');

    expect(answered).toEqual({
      ok: true,
      value: { runId, taskId: 'TASK-001', attempts: 3, amendmentId: 'AMD-001' },
      warnings: [],
    });

    const after = await store.loadRun(runId);
    const task = after.tasks.find((entry) => entry.id === 'TASK-001');
    expect(task?.state).toBe('queued');
    expect(task?.blockReason).toBeUndefined();
    expect(task?.attemptsBeforeHumanRetry).toBe(3);
    // The same bookkeeping as a retry, and nothing more: the lifetime count is evidence.
    expect(task?.attempts).toBe(3);

    expect(approvedPlanHash).toBeDefined();
    expect(after.amendments).toEqual([
      {
        id: 'AMD-001',
        kind: 'answer',
        task: 'TASK-001',
        // Trimmed: surrounding whitespace is how a text arrives, not what it says.
        text: 'use the v2 endpoint',
        planHash: approvedPlanHash,
        actor: { kind: 'keyboard' },
        at: '2026-08-09T20:00:00.000Z',
      },
    ]);

    const added = (await store.readEvents(runId)).slice(eventsBefore);
    const byType = (type: string) => added.filter((event) => event.type === type);
    expect(byType('amendment_recorded').map((event) => event.detail)).toEqual([
      { id: 'AMD-001', kind: 'answer', task: 'TASK-001', actor: { kind: 'keyboard' } },
    ]);
    expect(byType('task_requeued').map((event) => event.detail)).toEqual([
      { task: 'TASK-001', forced: false, answered: true },
    ]);
    expect(byType('operator_action').map((event) => event.detail)).toEqual([
      { action: 'answer', actor: { kind: 'keyboard' } },
    ]);

    // The decision, then what it caused, then who made it.
    const order = added
      .map((event) => event.type)
      .filter((type) => ['amendment_recorded', 'task_requeued', 'operator_action'].includes(type));
    expect(order).toEqual(['amendment_recorded', 'task_requeued', 'operator_action']);
  });

  it('attributes the answer to the actor the adapter resolved (SEC-003)', async () => {
    const { store, deps, runId } = await project({ actor: DEVICE });
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });

    await answerTask(deps, runId, 'TASK-001', 'yes');

    expect((await store.loadRun(runId)).amendments?.[0]?.actor).toEqual(DEVICE);
    const recorded = (await store.readEvents(runId)).find((event) => event.type === 'amendment_recorded');
    expect(recorded?.detail['actor']).toEqual(DEVICE);
  });

  it('numbers a second answer AMD-002 and leaves the first entry exactly as it was', async () => {
    const { clock, store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });
    await setTask(store, runId, 'TASK-002', { state: 'blocked', attempts: 2, blockReason: 'agent' });

    await answerTask(deps, runId, 'TASK-001', 'first');
    const first = (await store.loadRun(runId)).amendments?.[0];

    clock.advance(60_000);
    const second = await answerTask(deps, runId, 'TASK-002', 'second');

    expect(second.ok && second.value.amendmentId).toBe('AMD-002');
    const amendments = (await store.loadRun(runId)).amendments ?? [];
    expect(amendments).toHaveLength(2);
    expect(amendments[0]).toEqual(first);
    expect(amendments[1]).toMatchObject({
      id: 'AMD-002',
      task: 'TASK-002',
      text: 'second',
      at: '2026-08-09T20:01:00.000Z',
    });
  });

  it('omits planHash when the run has no approved plan hash', async () => {
    const { store, deps, runId } = await project();
    await store.updateRun(runId, (current) => ({ ...current, approvedPlanHash: undefined }));
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });

    await answerTask(deps, runId, 'TASK-001', 'x');

    const [amendment] = (await store.loadRun(runId)).amendments ?? [];
    expect(amendment).toBeDefined();
    expect(Object.keys(amendment ?? {})).not.toContain('planHash');
  });

  it('answers a blocked task with no recorded reason, which is legacy agent-blocked state', async () => {
    // State written before `blockReason` existed. Absence is read the way the retry gate
    // reads it — as the agent's own BLOCKED — and here that is what lets a person unstick
    // it without `--force`.
    const { store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1 });

    const answered = await answerTask(deps, runId, 'TASK-001', 'go ahead');

    expect(answered.ok).toBe(true);
    expect((await store.loadRun(runId)).tasks[0]?.state).toBe('queued');
  });
});

describe('answering refuses every task with no question outstanding (FR-002)', () => {
  const cases: readonly (readonly [string, Omit<TaskProgress, 'id' | 'infrastructureFailures'>])[] = [
    ['dependency-blocked', { state: 'blocked', attempts: 0, blockReason: 'dependency' }],
    ['queued', { state: 'queued', attempts: 0 }],
    ['running', { state: 'running', attempts: 1 }],
    ['completed', { state: 'completed', attempts: 1 }],
  ];

  for (const [name, progress] of cases) {
    it(`refuses a ${name} task with task_not_answerable, and writes nothing`, async () => {
      const { fs, store, deps, runId } = await project();
      // Through `running`, as the product gets there: `queued → completed` is not a move.
      if (progress.state === 'completed') {
        await setTask(store, runId, 'TASK-001', { state: 'running', attempts: 1 });
      }
      await setTask(store, runId, 'TASK-001', progress);
      const before = await snapshot(fs, runId);

      const refused = refusal(await answerTask(deps, runId, 'TASK-001', 'an answer'));

      expect(refused.code).toBe('task_not_answerable');
      // The message names the state the task is actually in, so the refusal says why.
      expect(refused.message).toContain(`\`${progress.state}\``);
      expect(await snapshot(fs, runId)).toEqual(before);
    });
  }

  it('says a dependency-blocked task is held back by a dependency', async () => {
    const { store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 0, blockReason: 'dependency' });

    const refused = refusal(await answerTask(deps, runId, 'TASK-001', 'x'));

    expect(refused.message).toContain('held back by a task it depends on');
  });

  it('refuses an unknown task with no_such_task, and writes nothing', async () => {
    const { fs, deps, runId } = await project();
    const before = await snapshot(fs, runId);

    expect(refusal(await answerTask(deps, runId, 'TASK-009', 'x')).code).toBe('no_such_task');
    expect(await snapshot(fs, runId)).toEqual(before);
  });

  it('refuses an unknown run with no_such_run, and writes nothing', async () => {
    const { fs, deps } = await project();
    const missing = 'AF-2026-999';

    expect(refusal(await answerTask(deps, missing, 'TASK-001', 'x')).code).toBe('no_such_run');
    expect(await snapshot(fs, missing)).toEqual({ state: null, events: null });
  });

  for (const text of ['', '   \n\t ']) {
    it(`refuses ${JSON.stringify(text)} with invalid_input before reading any state`, async () => {
      const { fs, store, deps, runId } = await project();
      await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });
      const before = await snapshot(fs, runId);

      expect(refusal(await answerTask(deps, runId, 'TASK-001', text)).code).toBe('invalid_input');
      expect(await snapshot(fs, runId)).toEqual(before);
      // Before any state is read: an empty answer to a run that does not exist is still
      // an empty answer.
      expect(refusal(await answerTask(deps, 'AF-2026-999', 'TASK-001', text)).code).toBe(
        'invalid_input',
      );
    });
  }
});

describe('answering under the execution lock (NFR-007)', () => {
  it('is refused while another process holds the lock, the same way a retry is', async () => {
    const { fs, host, store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });

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
        operation: 'run',
      }),
    );
    const before = await snapshot(fs, runId);

    const answered = refusal(await answerTask(deps, runId, 'TASK-001', 'x'));
    const retried = refusal(await retryTask(deps, runId, 'TASK-001', { force: true }));

    expect(answered.code).toBe('run_busy');
    // Same lock operation, so the same refusal — code, sentence and detail.
    expect(answered).toEqual(retried);
    expect(answered.detail).toMatchObject({ wanted: 'retry', holder: { operation: 'run' } });
    expect(await snapshot(fs, runId)).toEqual(before);
  });

  it('takes the lock as a retry, so an older build can read the claim', async () => {
    const { store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });
    const eventsBefore = (await store.readEvents(runId)).length;

    await answerTask(deps, runId, 'TASK-001', 'x');

    const acquired = (await store.readEvents(runId))
      .slice(eventsBefore)
      .filter((event) => event.type === 'execution_lock_acquired');
    expect(acquired.map((event) => event.detail['operation'])).toEqual(['retry']);
  });
});

describe('retry is unchanged by the extraction', () => {
  it('writes task_requeued with no answered key, and records retryTask', async () => {
    // Positive control for `answered: true` above: the key comes from the answer path, not
    // from the shared write.
    const { store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });
    const eventsBefore = (await store.readEvents(runId)).length;

    expect((await retryTask(deps, runId, 'TASK-001', { force: true })).ok).toBe(true);

    const added = (await store.readEvents(runId)).slice(eventsBefore);
    expect(added.find((event) => event.type === 'task_requeued')?.detail).toEqual({
      task: 'TASK-001',
      forced: true,
    });
    expect(added.find((event) => event.type === 'operator_action')?.detail).toEqual({
      action: 'retryTask',
      actor: { kind: 'keyboard' },
    });
    expect(added.map((event) => event.type)).not.toContain('amendment_recorded');
    expect((await store.loadRun(runId)).amendments).toBeUndefined();
  });

  it('keeps the no-change declaration on the retry path', async () => {
    const { store, deps, runId } = await project();
    await setTask(store, runId, 'TASK-001', { state: 'blocked', attempts: 1, blockReason: 'agent' });
    const eventsBefore = (await store.readEvents(runId)).length;

    await retryTask(deps, runId, 'TASK-001', { force: true, expectNoChange: true });

    const added = (await store.readEvents(runId)).slice(eventsBefore);
    expect(added.find((event) => event.type === 'task_requeued')?.detail).toEqual({
      task: 'TASK-001',
      forced: true,
      expectsNoChange: true,
    });
    expect(added.map((event) => event.type)).toContain('task_no_change_declared');
    expect((await store.loadRun(runId)).tasks[0]?.noChangeDeclaredAt).toBeDefined();
  });
});
