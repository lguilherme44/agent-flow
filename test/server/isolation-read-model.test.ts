import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { RunReader } from '../../src/server/run-reader.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import type { RegisteredProject } from '../../src/server/project-registry.js';

/**
 * What an isolated run looks like to a reader (§21.2, §21.3, M2-10).
 *
 * §29 puts observability *before* parallelism on purpose — "a parallel run whose
 * state cannot be read is a parallel run nobody can debug" — so these are the
 * facts M2-11 will be watched through.
 *
 * Half of this suite is about what must **not** be there. §21.3 draws an
 * asymmetric line: ref names and object ids may cross it, because they are
 * provenance a person needs and the server never accepts one back; filesystem
 * paths may not, because a worktree path is a machine fact the attempt artifact
 * deliberately does not even store (§7.2).
 */

const PROJECT: RegisteredProject = {
  id: 'demo',
  name: 'demo',
  path: '/repo',
} as RegisteredProject;

const CONFIG = `project:
  name: demo
  type: node
parallelism:
  maxTasks: 4
`;

async function world(options: { readonly config?: string } = {}) {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', options.config ?? CONFIG);
  fs.seed('/home/.agent-flow/config.yaml', '');

  const store = new StateStore({ fs, clock: new FixedClock(), projectDir: '/repo' });
  const reader = new RunReader({
    fs,
    clock: new FixedClock(),
    globalConfigPath: '/home/.agent-flow/config.yaml',
  });

  return { fs, store, reader };
}

/** A plan, so the task views have something to describe. */
const PLAN = {
  feature: 'f',
  tasks: [
    {
      id: 'TASK-001',
      title: 'One',
      description: 'Work.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Done.'],
      validation: [],
    },
    {
      id: 'TASK-002',
      title: 'Two',
      description: 'Work.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['Done.'],
      validation: [],
    },
  ],
};

describe('the isolation view (§21.2)', () => {
  it('reports the mode the run was born in, never the current configuration', async () => {
    // I-13, as the read model sees it. A run created sequential under
    // `useWorktrees: true` still reads `none`, and the note says which one applies —
    // without it the tool looks broken to the one user who did exactly what the
    // documentation told them to (§21.4).
    const { store, reader } = await world({
      config: `${CONFIG}git:\n  useWorktrees: true\n`,
    });
    const run = await store.createRun('f', () => ({
      isolationMode: 'none' as const,
      planningBase: 'a'.repeat(40),
    }));

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.isolation.mode).toBe('none');
    expect(detail?.isolation.note).toContain('does not apply to this run');
  });

  it('projects legacy for a run that predates the question (§25.2)', async () => {
    // Three values where the stored field has two. A run created before MVP 2 did
    // not answer `none`; it never met the question, and `legacy` is the only honest
    // way to say so. Projected here, never a stored value.
    const { store, reader } = await world();
    const run = await store.createRun('f');

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.isolation.mode).toBe('legacy');
  });

  it('reports what parallelism the run got, not what it asked for', async () => {
    // **The trap this test exists for.** `maxTasks: 4` is intent; the scheduler
    // resolves it, and until M2-11 that resolution is 1 whatever mode a run records.
    // A view reporting `effective: 4` for an isolated run would be describing a run
    // that does not exist — aspirational rather than observed.
    const { store, reader } = await world();
    const run = await store.createRun('f', (runId) => ({
      isolationMode: 'worktree' as const,
      planningBase: 'a'.repeat(40),
      gitRunKey: `${runId}-0f3a91c4bd27e615`,
    }));

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.isolation.parallelism.requested).toBe(4);
    expect(detail?.isolation.parallelism.effective).toBe(1);
    expect(detail?.isolation.parallelism.clamped).toBe(true);
    expect(detail?.isolation.parallelism.reason).toBeDefined();
  });

  it('derives the integration branch from the run key rather than storing it', async () => {
    const { store, reader } = await world();
    const run = await store.createRun('f', (runId) => ({
      isolationMode: 'worktree' as const,
      planningBase: 'a'.repeat(40),
      gitRunKey: `${runId}-0f3a91c4bd27e615`,
    }));
    await store.updateRun(run.runId, (state) => ({
      ...state,
      integrationHead: 'b'.repeat(40),
      tasks: [
        { id: 'TASK-001', state: 'completed' as const, attempts: 1 },
        { id: 'TASK-002', state: 'running' as const, attempts: 2 },
      ],
    }));

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail?.isolation.integrationBranch).toBe(
      `agent-flow/${run.runId}-0f3a91c4bd27e615/integration`,
    );
    expect(detail?.isolation.integrationHead).toBe('b'.repeat(40));
    expect(detail?.isolation.planningBase).toBe('a'.repeat(40));
    // I-3 as a number: how many tasks have their work on the branch, which is not
    // the same question as how many agents finished.
    expect(detail?.isolation.tasksIntegrated).toBe(1);
  });

  it('omits a fact it cannot resolve rather than inventing one', async () => {
    // §21.2 failure semantics. A project whose configuration will not load still
    // renders its runs; it just does not claim to know what parallelism was asked for.
    const { store, reader } = await world({ config: 'project:\n  name: [broken\n' });
    const run = await store.createRun('f', () => ({
      isolationMode: 'none' as const,
      planningBase: 'a'.repeat(40),
    }));

    const detail = await reader.runDetail(PROJECT, run.runId);

    expect(detail).not.toBeNull();
    expect(detail?.isolation.mode).toBe('none');
    expect(detail?.isolation.parallelism.effective).toBe(1);
    expect(detail?.isolation.note).toBeUndefined();
  });
});

describe('the per-task isolation facts (§21.2)', () => {
  async function isolatedRun() {
    const { fs, store, reader } = await world();
    const run = await store.createRun('f', (runId) => ({
      isolationMode: 'worktree' as const,
      planningBase: 'a'.repeat(40),
      gitRunKey: `${runId}-0f3a91c4bd27e615`,
    }));
    await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN));
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [
        { id: 'TASK-001', state: 'running' as const, attempts: 1 },
        { id: 'TASK-002', state: 'running' as const, attempts: 1 },
      ],
    }));
    return { fs, store, reader, runId: run.runId };
  }

  it('marks a live workspace, derived from the task’s own state', async () => {
    const { reader, runId } = await isolatedRun();

    const tasks = (await reader.tasks(PROJECT, runId)) ?? [];

    expect(tasks.find((task) => task.id === 'TASK-001')?.workspaceActive).toBe(true);
  });

  it('marks an attempt that is validated and not yet merged', async () => {
    // The state `TaskState` has no name for, and the one a person watching a
    // parallel run most needs: the work is done, the merge has not happened, and
    // `completed` would be a lie until it does (I-3).
    const { fs, reader, runId } = await isolatedRun();

    fs.seed(
      runPaths('/repo', runId).taskAttempt('TASK-001', 1),
      JSON.stringify({ validationJudgement: 'satisfied' }),
    );
    fs.seed(
      runPaths('/repo', runId).taskAttempt('TASK-002', 1),
      JSON.stringify({ validationJudgement: 'unsatisfied' }),
    );

    const tasks = (await reader.tasks(PROJECT, runId)) ?? [];

    expect(tasks.find((task) => task.id === 'TASK-001')?.awaitingIntegration).toBe(true);
    // An unsatisfied attempt is not awaiting anything — nothing will merge it.
    expect(tasks.find((task) => task.id === 'TASK-002')?.awaitingIntegration).toBeUndefined();
  });

  it('stops calling it awaiting once the result exists', async () => {
    const { fs, reader, runId } = await isolatedRun();

    fs.seed(
      runPaths('/repo', runId).taskAttempt('TASK-001', 1),
      JSON.stringify({ validationJudgement: 'satisfied' }),
    );
    fs.seed(
      runPaths('/repo', runId).taskResult('TASK-001'),
      JSON.stringify({
        task: 'TASK-001',
        status: 'completed',
        runner: 'fake',
        reasoning: 'medium',
        startedAt: '2026-08-09T19:59:00.000Z',
        finishedAt: '2026-08-09T20:00:00.000Z',
        validation: { passed: true, commands: [] },
        integration: {
          attempt: 1,
          branch: `agent-flow/${runId}-0f3a91c4bd27e615/integration`,
          marker: 'c'.repeat(40),
          mergeCommit: 'd'.repeat(40),
          base: 'a'.repeat(40),
          validatedTree: 'e'.repeat(40),
          integratedAt: '2026-08-09T20:00:00.000Z',
        },
      }),
    );

    const tasks = (await reader.tasks(PROJECT, runId)) ?? [];
    const one = tasks.find((task) => task.id === 'TASK-001');

    expect(one?.awaitingIntegration).toBeUndefined();
    // The provenance is exposed instead, which is the on-disk statement of I-3.
    expect(one?.integration?.marker).toBe('c'.repeat(40));
    expect(one?.integration?.mergeCommit).toBe('d'.repeat(40));
  });

  it('says nothing about workspaces for a sequential run', async () => {
    const { store, reader } = await world();
    const run = await store.createRun('f', () => ({
      isolationMode: 'none' as const,
      planningBase: 'a'.repeat(40),
    }));
    await store.writeArtifact(run.runId, 'plan', JSON.stringify(PLAN));
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: [{ id: 'TASK-001', state: 'running' as const, attempts: 1 }],
    }));

    const tasks = (await reader.tasks(PROJECT, run.runId)) ?? [];

    expect(tasks[0]?.workspaceActive).toBeUndefined();
    expect(tasks[0]?.awaitingIntegration).toBeUndefined();
  });
});

describe('the trust boundary the read model must not cross (§21.3)', () => {
  it('exposes no filesystem path anywhere in a run detail', async () => {
    const { store, reader } = await world();
    const run = await store.createRun('f', (runId) => ({
      isolationMode: 'worktree' as const,
      planningBase: 'a'.repeat(40),
      gitRunKey: `${runId}-0f3a91c4bd27e615`,
    }));
    await store.appendEvent(run.runId, 'integration_conflict', {
      task: 'TASK-002',
      attempt: 1,
      paths: ['src/shared.ts'],
      previouslyIntegrated: 'TASK-001',
    });

    const detail = await reader.runDetail(PROJECT, run.runId);
    const rendered = JSON.stringify(detail);

    // Ref names and oids are provenance and may cross; an absolute path may not.
    expect(rendered).toContain('agent-flow/');
    expect(rendered).not.toContain('/.agent-flow/worktrees');
    expect(rendered).not.toContain('/repo/');
    expect(rendered).not.toContain('/home/');

    // §15's record is a *projection* of the audit trail, not a decision taken from
    // it (I-1). The paths in it are repository-relative, which is why they are shown.
    expect(detail?.integrationConflicts).toEqual([
      { task: 'TASK-002', attempt: 1, paths: ['src/shared.ts'], previouslyIntegrated: 'TASK-001' },
    ]);
  });

  it('survives an audit trail it cannot parse', async () => {
    const { fs, store, reader } = await world();
    const run = await store.createRun('f', () => ({
      isolationMode: 'none' as const,
      planningBase: 'a'.repeat(40),
    }));

    fs.seed(runPaths('/repo', run.runId).events, '{ not json\n');

    const detail = await reader.runDetail(PROJECT, run.runId);

    // Omitted rather than fatal: one broken line must not take the run's page down.
    expect(detail).not.toBeNull();
    expect(detail?.integrationConflicts).toEqual([]);
  });
});
