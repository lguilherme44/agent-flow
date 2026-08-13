import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from '../../src/ports/index.js';
import { StateStore } from '../../src/app/state-store.js';
import { approve, start, type RunActionDeps } from '../../src/app/run-actions.js';
import {
  composeRunIdentity,
  resolveRunGitIdentity,
} from '../../src/app/run-git-identity.js';
import { planHash } from '../../src/app/approval.js';
import { PlanSchema, type EffectiveConfig } from '../../src/contracts/index.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * §6.2's four moments, for a run that is **not** isolated.
 *
 * The other harnesses in this directory run against an in-memory filesystem and
 * a `/repo` that is not a repository, which is exactly right for what they test
 * and useless here: an observation is a statement about a real working tree and
 * a real HEAD. So this one puts the project inside a temporary Git repository on
 * disk and drives the real `approve` and `start` use cases through it.
 *
 * What is being proved is narrow and worth stating: a sequential run whose
 * repository has drifted is **observed and not refused**, and the observation
 * lands in the audit trail at the moment it was made.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

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
  'implementation',
];

/**
 * Real Git, no coding CLI.
 *
 * The observation is a statement about a real working tree, so `git` has to be
 * the real thing — a fake that answers every command with the same string makes
 * `rev-parse HEAD` return something that is not an object id, the observation
 * silently become `null`, and the test pass by proving nothing. Everything else
 * is refused immediately, so `start` cannot reach a coding CLI, spend quota, or
 * take five seconds finding out that one is not installed.
 */
class GitOnlyProcessRunner implements ProcessRunner {
  private readonly real = new NodeProcessRunner();

  async run(options: ProcessSpawnOptions): Promise<ProcessResult> {
    if (options.command === 'git') return this.real.run(options);

    return {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'no coding CLI in this test',
      durationMs: 0,
      timedOut: false,
      spawnFailed: true,
      truncated: false,
    };
  }
}

/** A project inside a real repository, with a sequential run ready to approve. */
async function sequentialProject() {
  const temp = await makeTempRepoWithCommit();

  // Gitignored before anything else, so Agent Flow's own state does not make the
  // tree dirty and turn every observation below into a false positive.
  writeFileSync(join(temp.dir, '.gitignore'), '.agent-flow/\n');
  temp.commitAll('ignore agent-flow state');

  const promptsDir = join(temp.home, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  for (const name of PROMPTS) {
    writeFileSync(
      join(promptsDir, `${name}.md`),
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: []\n---\n\n# ${name}\n`,
    );
  }

  mkdirSync(join(temp.dir, '.agent-flow'), { recursive: true });
  writeFileSync(
    join(temp.dir, '.agent-flow', 'config.yaml'),
    'project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\ngit:\n  useWorktrees: false\n',
  );

  const fs = new NodeFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir: temp.dir });

  // Created sequential, with a real base — the shape §6.2 observes.
  const identity = await resolveRunGitIdentity({
    workspaces: temp.workspaces,
    fs,
    host: new FakeHost(1000, 'test-host', [1000], temp.home),
    config: { global: { git: { useWorktrees: false } } } as unknown as EffectiveConfig,
    projectDir: temp.dir,
  });
  if (!identity.ok) throw new Error(`sequential creation refused: ${identity.refusal.code}`);

  const run = await store.createRun('weekly recurrence', (runId) =>
    composeRunIdentity(runId, identity.value),
  );

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
    stage: 'plan-review' as const,
    status: 'waiting_for_approval' as const,
    tasks: [{ id: 'TASK-001', state: 'queued' as const, attempts: 0 }],
  }));

  const deps: RunActionDeps = {
    fs,
    clock,
    processRunner: new GitOnlyProcessRunner(),
    projectDir: temp.dir,
    globalConfigPath: join(temp.home, 'global-config.yaml'),
    promptsDir,
    host: new FakeHost(1000, 'test-host', [1000], temp.home),
    owner: 'cli',
  };

  return { temp, store, deps, runId: run.runId, planningBase: run.planningBase };
}

/** The observations recorded for a run, newest last. */
async function observations(store: StateStore, runId: string) {
  return (await store.readEvents(runId)).filter(
    (event) => event.type === 'planning_base_observation',
  );
}

describe('approve, in sequential mode (§6.2 moment 3)', () => {
  it('records the observation and does not refuse a drifted repository', async () => {
    const world = await sequentialProject();
    repo = world.temp;

    // Both kinds of drift at once, which an isolated run would be refused for.
    repo.write('untracked-while-waiting.ts', 'export {};\n');
    repo.write('README.md', 'edited while waiting for approval\n');
    repo.commitAll('a commit after the run was created');
    repo.write('README.md', 'and dirty again\n');

    const outcome = await approve(world.deps, world.runId);

    expect(outcome.ok).toBe(true);
    const state = await world.store.loadRun(world.runId);
    expect(state.approved).toBe(true);
    // The mode is untouched: nothing consulted the configuration to decide it.
    expect(state.isolationMode).toBe('none');
    expect(state.planningBase).toBe(world.planningBase);

    const recorded = await observations(world.store, world.runId);
    const atApprove = recorded.find((event) => event.detail['moment'] === 'approve');
    expect(atApprove).toBeDefined();
    expect(atApprove?.detail['clean']).toBe(false);
    expect(atApprove?.detail['matches']).toBe(false);
    expect(atApprove?.detail['planningBase']).toBe(world.planningBase);
  });

  it('records a clean result too', async () => {
    const world = await sequentialProject();
    repo = world.temp;

    const outcome = await approve(world.deps, world.runId);

    expect(outcome.ok).toBe(true);
    const atApprove = (await observations(world.store, world.runId)).find(
      (event) => event.detail['moment'] === 'approve',
    );
    // §6.2 records "their result", not "their failures".
    expect(atApprove?.detail['clean']).toBe(true);
    expect(atApprove?.detail['matches']).toBe(true);
  });
});

describe('implementation start, in sequential mode (§6.2 moment 4)', () => {
  it('records the observation and is not refused by the planning-base gate', async () => {
    const world = await sequentialProject();
    repo = world.temp;
    await approve(world.deps, world.runId);

    repo.write('README.md', 'edited after approval\n');
    repo.commitAll('the repository moved on after approval');
    repo.write('README.md', 'and dirty at start\n');

    const outcome = await start(world.deps, world.runId);

    // Whatever the run does afterwards, it was not stopped by this gate: the
    // sequential codes are the ones that must never appear.
    if (!outcome.ok) {
      expect(['planning_base_moved', 'working_tree_dirty']).not.toContain(outcome.error.code);
    }

    const atStart = (await observations(world.store, world.runId)).find(
      (event) => event.detail['moment'] === 'implementation start',
    );
    expect(atStart).toBeDefined();
    expect(atStart?.detail['clean']).toBe(false);
    expect(atStart?.detail['matches']).toBe(false);

    const state = await world.store.loadRun(world.runId);
    expect(state.isolationMode).toBe('none');
    expect(state.planningBase).toBe(world.planningBase);
  });

  it('creates no branch, ref or worktree while observing', async () => {
    const world = await sequentialProject();
    repo = world.temp;
    await approve(world.deps, world.runId);

    const refsBefore = repo.userGit(['for-each-ref', '--format=%(refname)']).trim();
    const worktreesBefore = repo.userGit(['worktree', 'list', '--porcelain']).trim();

    await start(world.deps, world.runId);

    expect(repo.userGit(['for-each-ref', '--format=%(refname)']).trim()).toBe(refsBefore);
    expect(repo.userGit(['worktree', 'list', '--porcelain']).trim()).toBe(worktreesBefore);
  });
});

describe('what stays silent', () => {
  it('says nothing for a legacy run at either moment (§25.2)', async () => {
    const world = await sequentialProject();
    repo = world.temp;

    // A run predating the fields entirely. It must not be evaluated, and must
    // not be back-filled from the configuration in front of it.
    const legacy = await world.store.createRun('an older feature');
    await world.store.writeArtifact(legacy.runId, 'plan', JSON.stringify(PLAN, null, 2));
    await world.store.writeArtifact(legacy.runId, 'sdd', '# SDD\n\nFR-001.\n');
    await world.store.writeArtifact(
      legacy.runId,
      'planReview',
      JSON.stringify({
        verdict: 'PASS',
        independence: 'cross-provider',
        reviewer: { runner: 'codex', reasoning: 'high' },
        planHash: planHash(PlanSchema.parse(PLAN)),
        findings: [],
      }),
    );
    await world.store.updateRun(legacy.runId, (state) => ({
      ...state,
      stage: 'plan-review' as const,
      status: 'waiting_for_approval' as const,
    }));

    repo.write('README.md', 'dirty\n');

    const outcome = await approve(world.deps, legacy.runId);

    expect(outcome.ok).toBe(true);
    expect(await observations(world.store, legacy.runId)).toEqual([]);
    const state = await world.store.loadRun(legacy.runId);
    expect(state.isolationMode).toBeUndefined();
    expect(state.planningBase).toBeUndefined();
  });
});
