import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { RunReader } from '../../src/server/run-reader.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import type { RegisteredProject } from '../../src/server/project-registry.js';

/**
 * AR-07/AR-08 — the read model, actually read.
 *
 * `core/run-projection.ts` answers the four questions the evidence run's surfaces got
 * wrong: whether there is work to resume (C-19), whether the newest review still describes
 * the current state (C-20), how far along the run is on three axes that cannot go backwards
 * (C-21), and what an exhausted recovery loop owes the reader (C-22).
 *
 * All four were unreachable. `isResumable` had one caller and `projectRun` had none, so
 * every surface kept deriving its own answer from raw state — which is precisely the
 * arrangement that let `plan_rejected` stay on screen while revision 2 was running, and
 * `Resume` stay offered with nothing runnable.
 *
 * Projecting once and shipping the result is the whole fix. A surface that renders this
 * cannot disagree with a surface that renders it, because there is one answer.
 */

const PROJECT: RegisteredProject = { id: 'demo', name: 'demo', path: '/repo' } as RegisteredProject;

const CONFIG = `project:
  name: demo
  type: node
`;

async function world() {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', CONFIG);
  fs.seed('/home/.agent-flow/config.yaml', '');

  const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/repo' });
  const reader = new RunReader({
    fs,
    clock: new FixedClock(),
    globalConfigPath: '/home/.agent-flow/config.yaml',
  });

  return { fs, store, reader };
}

const plan = (ids: string[]) => ({
  feature: 'f',
  tasks: ids.map((id) => ({
    id,
    title: id,
    description: 'Work.',
    complexity: 'trivial',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['Done.'],
    validation: [],
  })),
});

describe('the runtime projection reaches a reader', () => {
  it('reports one runtime status rather than leaving each surface to derive it', async () => {
    const { fs, store, reader } = await world();
    const run = await store.createRun('f');
    fs.seed(runPaths('/repo', run.runId).plan, JSON.stringify(plan(['TASK-001'])));
    await store.updateRun(run.runId, (state) => ({
      ...state,
      stage: 'planning',
      status: 'waiting_for_approval' as const,
      tasks: [{ id: 'TASK-001', state: 'queued' as const, attempts: 0, infrastructureFailures: 0 }],
    }));

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.runtime.status).toBe('awaiting_human_approval');
  });

  it('says whether there is work to resume, from the DAG rather than from a guess', async () => {
    // C-19. `Resume` was offered on a run whose only incomplete task was held at review,
    // and the lock was taken and released three times before anybody noticed.
    const { fs, store, reader } = await world();
    const run = await store.createRun('f');
    fs.seed(runPaths('/repo', run.runId).plan, JSON.stringify(plan(['TASK-001'])));
    await store.updateRun(run.runId, (state) => ({
      ...state,
      stage: 'implementation',
      approvedAt: '2026-08-17T10:00:00.000Z',
      tasks: [
        { id: 'TASK-001', state: 'review_required' as const, attempts: 1, infrastructureFailures: 0 },
      ],
    }));

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.runtime.resumable).toBe(false);
  });

  it('carries three progress axes, so no single number can fall', async () => {
    // C-21. One collapsed percentage read 100% with verification still pending, and then
    // *fell* when corrective tasks were appended. A number that can go down is not progress.
    const { fs, store, reader } = await world();
    const run = await store.createRun('f');
    fs.seed(runPaths('/repo', run.runId).plan, JSON.stringify(plan(['TASK-001', 'TASK-002'])));
    await store.updateRun(run.runId, (state) => ({
      ...state,
      stage: 'implementation',
      approvedAt: '2026-08-17T10:00:00.000Z',
      tasks: [
        { id: 'TASK-001', state: 'completed' as const, attempts: 1, infrastructureFailures: 0 },
        { id: 'TASK-002', state: 'queued' as const, attempts: 0, infrastructureFailures: 0 },
      ],
    }));

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.runtime.progress.implementation).toEqual({ done: 1, total: 2 });
    expect(detail?.runtime.progress.workflow.total).toBeGreaterThan(0);
  });

  it('says whether the newest review still describes the current state', async () => {
    // C-20, the field that stops a superseded verdict being rendered as current.
    const { store, reader } = await world();
    const run = await store.createRun('f');

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.runtime.reviewFreshness).toBe('absent');
  });

  it('ships the whole C-22 escalation, not a status a surface has to expand', async () => {
    const { fs, store, reader } = await world();
    const run = await store.createRun('f');
    fs.seed(runPaths('/repo', run.runId).plan, JSON.stringify(plan(['TASK-001'])));
    await store.updateRun(run.runId, (state) => ({
      ...state,
      stage: 'implementation',
      approvedAt: '2026-08-17T10:00:00.000Z',
      tasks: [
        { id: 'TASK-001', state: 'review_required' as const, attempts: 2, infrastructureFailures: 0 },
      ],
    }));

    await store.appendEvent(run.runId, 'recovery_started', {
      task: 'TASK-001',
      failureClass: 'validation_unsatisfied',
      step: 'work_retry',
    });
    await store.appendEvent(run.runId, 'recovery_step_completed', {
      task: 'TASK-001',
      step: 'work_retry',
      outcome: 'requeued',
    });
    await store.appendEvent(run.runId, 'recovery_exhausted', {
      task: 'TASK-001',
      failureClass: 'validation_unsatisfied',
      humanAction: 'Read attempt-2.failed.json for TASK-001 and fix `npm test`',
      counts: { attempts: 2 },
      evidence: ['npm test → exit 1'],
    });

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.runtime.status).toBe('auto_recovery_exhausted');
    expect(detail?.runtime.escalation?.attemptedRepairs).toEqual([
      { step: 'work_retry', outcome: 'requeued' },
    ]);
    expect(detail?.runtime.escalation?.humanAction).toContain('TASK-001');
    expect(detail?.runtime.escalation?.evidence).toEqual(['npm test → exit 1']);
  });

  it('omits the escalation on a run that never exhausted anything', async () => {
    // Absent rather than empty. A surface that always receives an escalation object learns
    // to check its fields, and one that receives it only when it applies cannot render an
    // empty panel by accident.
    const { store, reader } = await world();
    const run = await store.createRun('f');

    expect((await reader.runDetail(PROJECT, run.runId))?.runtime.escalation).toBeUndefined();
  });
});
