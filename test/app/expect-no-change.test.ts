import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { retryTask, type RunActionDeps } from '../../src/app/run-actions.js';
import { assertObservableChange } from '../../src/core/acceptance.js';

/**
 * The net for a plan that forgot `expectsNoChange` (PRI-20).
 *
 * The planner *can* reach the field — a live run set it unprompted on exactly the task
 * that warranted it — so what was missing was never the mechanism. It was a way to make
 * the same declaration after the plan was written. Without one, two runs in the evidence
 * set died on `acceptance_evidence_missing`: a verification task correctly changed
 * nothing, every attempt reproduced the identical tree, and the operator's only remaining
 * option was to cancel the run.
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
      title: 'Verify the gates',
      description: 'Confirm the constraints hold. Changes nothing by design.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['The gates pass.'],
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
  const run = await store.createRun('weekly recurrence');
  await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN, null, 2));
  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'approved',
    approved: true,
    tasks: [
      {
        id: 'TASK-001',
        state: 'review_required',
        attempts: 2,
        infrastructureFailures: 0,
        failureClass: 'acceptance_evidence_missing',
      },
    ],
  }));

  const deps: RunActionDeps = {
    fs,
    clock,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: '1.0.0' }),
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host: new FakeHost(),
    owner: 'cli',
  };

  return { fs, store, deps, runId: run.runId };
}

describe('the acceptance assertion accepts a declaration from either author', () => {
  const identical = { baseTree: 'abc123def456', validatedTree: 'abc123def456' };

  it('refuses an empty diff nobody declared', () => {
    const result = assertObservableChange(identical);
    expect(result.satisfied).toBe(false);
  });

  it('accepts one the plan declared', () => {
    expect(assertObservableChange({ ...identical, expectsNoChange: true }).satisfied).toBe(true);
  });

  it('accepts one a person declared afterwards', () => {
    expect(
      assertObservableChange({ ...identical, declaredUnchangedByOperator: true }).satisfied,
    ).toBe(true);
  });

  it('still refuses when the operator flag is present and false', () => {
    // The two inputs are kept separate rather than pre-combined by the caller, so this is
    // the case that proves the second one is read as a value and not merely as presence.
    const result = assertObservableChange({ ...identical, declaredUnchangedByOperator: false });
    expect(result.satisfied).toBe(false);
  });

  it('names the surface that makes the declaration', () => {
    const result = assertObservableChange(identical);
    // "Declare it in the plan" was the only advice, and the plan is what approval is bound
    // to — so the sentence sent people to the one door that was shut.
    expect(result.satisfied === false && result.detail).toContain('--expect-no-change');
  });
});

describe('agent-flow retry --expect-no-change', () => {
  it('records when a person declared it, on the state and in the log', async () => {
    const { store, deps, runId } = await project();

    const outcome = await retryTask(deps, runId, 'TASK-001', { expectNoChange: true });
    expect(outcome.ok).toBe(true);

    const state = await store.loadRun(runId);
    expect(state.tasks[0]?.noChangeDeclaredAt).toBeTypeOf('string');

    const events = await store.readEvents(runId);
    const declared = events.find((event) => event.type === 'task_no_change_declared');
    expect(declared?.detail['task']).toBe('TASK-001');
  });

  it('leaves an ordinary retry exactly as it was', async () => {
    const { store, deps, runId } = await project();

    await retryTask(deps, runId, 'TASK-001');

    const state = await store.loadRun(runId);
    expect(state.tasks[0]?.noChangeDeclaredAt).toBeUndefined();
    expect(state.tasks[0]?.state).toBe('queued');
    const events = await store.readEvents(runId);
    expect(events.some((event) => event.type === 'task_no_change_declared')).toBe(false);
  });

  it('keeps the declaration through a later plain retry', async () => {
    // Sticky on purpose. A declaration of intent does not expire because the task ran
    // again, and clearing it each time would make somebody repeat it per attempt — which
    // is how a safeguard turns into a phrase people type without reading.
    const { store, deps, runId } = await project();

    await retryTask(deps, runId, 'TASK-001', { expectNoChange: true });
    const first = (await store.loadRun(runId)).tasks[0]?.noChangeDeclaredAt;

    await retryTask(deps, runId, 'TASK-001');

    expect(first).toBeTypeOf('string');
    expect((await store.loadRun(runId)).tasks[0]?.noChangeDeclaredAt).toBe(first);
  });

  it('does not touch the plan, so an approval survives it', async () => {
    // The whole reason this lives on the state. Approval is granted to a specific plan and
    // `approvedPlanHash` holds it to that, so adding one field to `plan.json` would
    // invalidate a gate somebody had already passed — and would rewrite what they read.
    const { store, deps, runId } = await project();
    const before = await store.readArtifact(runId, 'plan');

    await retryTask(deps, runId, 'TASK-001', { expectNoChange: true });

    expect(await store.readArtifact(runId, 'plan')).toBe(before);
  });
});
