import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { Integrator } from '../../src/app/integrator.js';
import { StateStore } from '../../src/app/state-store.js';
import { recordAttempt, type AttemptDraft } from '../../src/app/attempt-receipt.js';
import { deriveRepoKey } from '../../src/app/run-git-identity.js';
import { attemptRef, attemptWorkspace } from '../../src/core/worktree-policy.js';
import { buildDag, type Dag } from '../../src/core/dag.js';
import { TaskResultSchema, type TaskResult, type TaskState } from '../../src/contracts/index.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { makeTempRepoWithCommit, type TempRepo } from './temp-repo.js';

/**
 * A worktree-mode run against real Git, ready to have attempts integrated.
 *
 * Everything about M2-06 is a claim about Git's behaviour — that `--no-ff` always
 * produces a merge commit, that a conflicted merge leaves an unmerged index a
 * `merge --abort` undoes, that a marker with two parents is a different object
 * from one with one — so nothing here is mocked. The repository, the worktrees
 * and the home directory all live under one temporary tree that `cleanup()`
 * removes, so a failing assertion cannot leave a registered worktree anywhere
 * that matters.
 *
 * The one thing this fixture does *not* do is run an agent. An attempt is planted
 * by writing files into a real attempt worktree and putting them through the real
 * §11.2 sequence — `add -A`, `write-tree`, the nonce, the artifact, the marker —
 * which is exactly what `TaskExecutor` does with the agent's output. What is
 * being tested is what integration makes of that evidence.
 */

export interface PlantedAttempt {
  readonly task: string;
  readonly attempt: number;
  readonly base: string;
  readonly branch: string;
  readonly marker: string;
  readonly validatedTree: string;
  readonly nonce: string;
  /** Absolute path of the attempt's worktree. Never persisted (§7.2). */
  readonly workspacePath: string;
}

export interface PlantOptions {
  /** The wave base. Defaults to `planningBase`. */
  readonly base?: string;
  /** Files the "agent" left behind, relative to its worktree. */
  readonly write?: Readonly<Record<string, string>>;
  /** Defaults to `satisfied`, which is the only judgement that gets a marker. */
  readonly judgement?: 'satisfied' | 'unsatisfied' | 'not_reached';
  /**
   * What the agent's own report said. Defaults to `COMPLETED`.
   *
   * The one field that tells `not_reached`'s two provenances apart: the agent
   * reported BLOCKED, or the plan named a validation id the configuration no
   * longer resolves. Recovery reads it structurally rather than parsing a note.
   */
  readonly reported?: 'COMPLETED' | 'BLOCKED';
  /**
   * The validation ids the plan named. Defaults to one.
   *
   * An empty list is a real case — a `validationExpectation: 'none'` task — and
   * it produces an `Agent-Flow-Validation-Ids` trailer with nothing after the
   * colon, which is the shape a trailer parser gets wrong.
   */
  readonly ids?: readonly string[];
  /** The plan's expectation of those ids. Defaults to `pass`. */
  readonly expectation?: 'pass' | 'fail' | 'none';
}

export interface WorktreeRun {
  readonly repo: TempRepo;
  readonly fs: NodeFileSystem;
  readonly clock: FixedClock;
  readonly host: FakeHost;
  readonly store: StateStore;
  readonly integrator: Integrator;
  readonly runId: string;
  readonly gitRunKey: string;
  readonly integrationBranch: string;
  readonly planningBase: string;

  /** Puts the tasks on the run, in the state a dispatched wave leaves them. */
  seed(tasks: readonly string[], state?: TaskState): Promise<void>;
  plant(task: string, attempt: number, options?: PlantOptions): Promise<PlantedAttempt>;
  /** A `TaskResult` shaped like the one the executor hands the scheduler. */
  resultFor(task: string): TaskResult;
  dag(nodes: readonly { id: string; dependencies?: readonly string[] }[]): Dag;
  cleanup(): void;
}

export async function makeWorktreeRun(): Promise<WorktreeRun> {
  const repo = await makeTempRepoWithCommit();
  const fs = new NodeFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost(1000, 'test-host', [1000], repo.home);
  const store = new StateStore({ fs, clock, projectDir: repo.dir });

  // What `init` writes, and what precondition check 8 refuses a run without: a
  // repository that tracks `.agent-flow/` dirties itself the moment a run starts,
  // and the "your working tree was not modified" claim of §19.3 would then be
  // untestable — the run's own state files would be the modification.
  repo.write('.gitignore', '.agent-flow/\n');
  repo.commitAll('ignore agent-flow state');

  const planningBase = repo.head();
  const run = await store.createRun('a feature', (runId) => ({
    isolationMode: 'worktree' as const,
    planningBase,
    gitRunKey: `${runId}-0f3a91c4bd27e615`,
  }));

  const gitRunKey = `${run.runId}-0f3a91c4bd27e615`;
  const deps = { workspaces: repo.workspaces, fs, host, projectDir: repo.dir };
  const integrator = new Integrator({ ...deps, store, clock });

  const repoKey = await deriveRepoKey(deps);
  if (repoKey === null) throw new Error('the temporary repository has no derivable key');

  return {
    repo,
    fs,
    clock,
    host,
    store,
    integrator,
    runId: run.runId,
    gitRunKey,
    integrationBranch: `agent-flow/${gitRunKey}/integration`,
    planningBase,

    async seed(tasks, state: TaskState = 'running'): Promise<void> {
      await store.updateRun(run.runId, (current) => ({
        ...current,
        tasks: tasks.map((id) => ({ id, state, attempts: 1 })),
      }));
    },

    async plant(task, attempt, options = {}): Promise<PlantedAttempt> {
      const base = options.base ?? planningBase;

      const location = attemptWorkspace(repoKey, gitRunKey, task, attempt);
      if (!location.ok) throw new Error(location.refusal.reason);
      const branch = attemptRef(gitRunKey, task, attempt);
      if (!branch.ok) throw new Error(branch.refusal.reason);

      const added = await repo.workspaces.addWorktree({
        cwd: repo.dir,
        location: location.value,
        branch: branch.value,
        base,
        reason: `agent-flow ${gitRunKey} ${task} attempt-${String(attempt)}`,
      });
      if (!added.ok) throw new Error(added.failure.message);

      for (const [name, contents] of Object.entries(options.write ?? {})) {
        writeFileSync(join(added.value, name), contents);
      }

      const judgement = options.judgement ?? 'satisfied';
      const draft: AttemptDraft = {
        run: run.runId,
        task,
        attempt,
        base,
        branch: branch.value,
        workspace: location.value.relativePath,
        runner: 'fake',
        reasoning: 'medium',
        reasoningClamped: false,
        startedAt: '2026-08-09T19:59:00.000Z',
        finishedAt: '2026-08-09T20:00:00.000Z',
        filesChanged: Object.keys(options.write ?? {}),
        agentReport: { status: options.reported ?? 'COMPLETED', notes: [], deviations: [] },
        validation: {
          expectation: options.expectation ?? 'pass',
          passed: judgement === 'satisfied',
          ids: [...(options.ids ?? ['test'])],
          commands: [],
        },
        validationJudgement: judgement,
      };

      const recorded = await recordAttempt(
        { workspaces: repo.workspaces, fs, clock, host, projectDir: repo.dir },
        { draft, workspacePath: added.value, gitRunKey },
      );
      if (!recorded.ok) throw new Error(recorded.failure.detail);

      return {
        task,
        attempt,
        base,
        branch: branch.value,
        marker: recorded.value.marker?.oid ?? '',
        validatedTree: recorded.value.attempt.receipt?.validatedTree ?? '',
        nonce: recorded.value.attempt.receipt?.nonce ?? '',
        workspacePath: added.value,
      };
    },

    resultFor(task): TaskResult {
      return TaskResultSchema.parse({
        task,
        status: 'completed',
        runner: 'fake',
        reasoning: 'medium',
        startedAt: '2026-08-09T19:59:00.000Z',
        finishedAt: '2026-08-09T20:00:00.000Z',
        validation: { passed: true, expectation: 'pass', commands: [] },
      });
    },

    dag(nodes): Dag {
      return buildDag(nodes.map((node) => ({ id: node.id, dependencies: node.dependencies ?? [] })));
    },

    cleanup(): void {
      repo.cleanup();
    },
  };
}
