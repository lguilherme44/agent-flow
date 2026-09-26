import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { GlobalConfigSchema, ProjectConfigSchema, type ProjectConfig } from '../../src/contracts/index.js';
import type { ProcessSpawnOptions } from '../../src/ports/index.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import { attemptRef, attemptWorkspace } from '../../src/core/worktree-policy.js';
import { deriveRepoKey } from '../../src/app/run-git-identity.js';
import { recordAttempt, type AttemptDraft } from '../../src/app/attempt-receipt.js';
import {
  refuseUnrevalidatable,
  revalidateTask,
  type RevalidationDeps,
} from '../../src/app/task-revalidation.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * D19 — "I already fixed it; just validate it again."
 *
 * Measured on AF-2026-004: TASK-004 stopped `recovery_exhausted` and the whole evidence
 * was nine unused imports in nine test files. `typecheck` clean, 3972 tests passing. The
 * only path the product offered was `retry`, which knows one move — run the model again —
 * so deleting nine import lines cost twenty minutes of an executor and one of two attempts.
 *
 * **Real Git, and not for thoroughness.** Every claim below is a claim about the receipt
 * and marker machinery this path deliberately reuses rather than routes around: that a
 * human-validated tree produces the same artifact shape, the same post-hoc nonce and the
 * same `commit-tree` onto the attempt's own base that a model-validated tree does. A fake
 * `GitWorkspaces` would only ever confirm what the fake was told, and what is being
 * asserted is that the task afterwards is indistinguishable *to the Integrator* from one a
 * model produced — and perfectly distinguishable to a person.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const TASK = 'TASK-004';

/** `exit 0` / `exit 1` through whichever shell this platform actually has. */
const PASSING = 'exit 0';
const FAILING = 'exit 1';

function projectConfig(testCommand: string): ProjectConfig {
  return ProjectConfigSchema.parse({
    project: { name: 'temp-repo', type: 'node' },
    commands: { test: testCommand },
  });
}

interface World {
  readonly deps: RevalidationDeps;
  readonly store: StateStore;
  readonly runId: string;
  readonly gitRunKey: string;
  readonly workspacePath: string;
  readonly base: string;
  /** Every spawn the use case made — Git included — as the real runner received it. */
  readonly spawned: readonly ProcessSpawnOptions[];
}

/**
 * A run one task into worktree mode, stopped on a failing validation.
 *
 * The attempt worktree is cut exactly as `TaskWorkspaces` cuts one — branch and checkout
 * in a single `worktree add -b`, at the wave base — because the branch existing *before*
 * any marker does is the state every downstream check has to survive (§7.3).
 */
async function world(
  testCommand: string,
  /**
   * What the last attempt recorded about its own validation.
   *
   * Parameterised because "the task declares no check" is a real and dangerous shape, not
   * an edge case: a task whose agent answered BLOCKED is routinely `validation: []`, and it
   * is reachable from `blocked`, which this command accepts.
   */
  validation: { expectation: 'pass' | 'fail' | 'none'; ids: readonly string[] } = {
    expectation: 'pass',
    ids: ['test'],
  },
  taskState: 'failed' | 'blocked' = 'failed',
  /** `execution.commandTimeoutSeconds`; the schema's default when omitted. */
  commandTimeoutSeconds?: number,
): Promise<World> {
  const current = await makeTempRepoWithCommit();
  repo = current;
  current.initAgentFlow();

  const fs = new NodeFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();
  const store = new StateStore({ fs, clock, projectDir: current.dir });

  const base = current.head();
  // The three identity fields are frozen at creation (I-13), so they are handed over
  // here rather than written afterwards — which is the same door `createFeatureRun` uses.
  let gitRunKey = '';
  const run = await store.createRun('a feature', (runId) => {
    gitRunKey = `${runId}-0f3a91c4bd27e615`;
    return { isolationMode: 'worktree', gitRunKey, planningBase: base };
  });

  await store.updateRun(run.runId, (state) => ({
    ...state,
    status: 'approved',
    approved: true,
    stage: 'implementation',
    tasks: [{ id: TASK, state: taskState, attempts: 1, infrastructureFailures: 0 }],
  }));

  // The real runner, observed rather than replaced: the commands still run, and what each
  // spawn was asked to tolerate is kept for the assertion that reads it.
  const real = new NodeProcessRunner();
  const spawned: ProcessSpawnOptions[] = [];
  const deps: RevalidationDeps = {
    fs,
    clock,
    host,
    store,
    workspaces: current.workspaces,
    processRunner: {
      run: (options) => {
        spawned.push(options);
        return real.run(options);
      },
    },
    config: {
      project: projectConfig(testCommand),
      global: {
        execution: GlobalConfigSchema.shape.execution.parse(
          commandTimeoutSeconds === undefined ? {} : { commandTimeoutSeconds },
        ),
      },
    },
    projectDir: current.dir,
  };

  const repoKey = await deriveRepoKey({ workspaces: current.workspaces, fs, host, projectDir: current.dir });
  if (repoKey === null) throw new Error('the repository key could not be derived');

  const location = attemptWorkspace(repoKey, gitRunKey, TASK, 1);
  if (!location.ok) throw new Error(location.refusal.reason);
  const branch = attemptRef(gitRunKey, TASK, 1);
  if (!branch.ok) throw new Error(branch.refusal.reason);

  const added = await current.workspaces.addWorktree({
    cwd: current.dir,
    location: location.value,
    branch: branch.value,
    base,
    reason: `agent-flow ${gitRunKey} ${TASK} attempt-1`,
  });
  if (!added.ok) throw new Error(added.failure.message);

  // What the agent left: work that is real, and a validation that refused it. This is the
  // D19 shape — the substance is there and one mechanical check is red.
  writeFileSync(join(added.value, 'feature.txt'), 'the work the agent did\n');

  const draft: AttemptDraft = {
    run: run.runId,
    task: TASK,
    attempt: 1,
    base,
    branch: branch.value,
    workspace: location.value.relativePath,
    runner: 'claude',
    reasoning: 'high',
    reasoningClamped: false,
    startedAt: '2026-08-09T19:00:00.000Z',
    finishedAt: '2026-08-09T19:30:00.000Z',
    filesChanged: ['feature.txt'],
    agentReport: {
      // A task with no validation is the one whose agent stopped on a missing decision,
      // so the fixture says that rather than claiming a COMPLETED report it never made.
      status: validation.ids.length === 0 ? 'BLOCKED' : 'COMPLETED',
      notes: [],
      deviations: [],
      claimedFilesChanged: ['feature.txt'],
    },
    validation: {
      expectation: validation.expectation,
      passed: false,
      ids: [...validation.ids],
      commands: [
        {
          command: 'npm run lint',
          exitCode: 1,
          durationMs: 400,
          stdout: '',
          stderr: "9:30  error  'RunActionDeps' is defined but never used",
          truncated: false,
        },
      ],
    },
    // `not_reached` is what an artifact records when the agent answered BLOCKED: nothing
    // ran, so there was no expectation left to be unsatisfied by.
    validationJudgement: validation.ids.length === 0 ? 'not_reached' : 'unsatisfied',
  };

  const recorded = await recordAttempt(
    { workspaces: current.workspaces, fs, clock, host, projectDir: current.dir },
    { draft, workspacePath: added.value, gitRunKey },
  );
  if (!recorded.ok) throw new Error(recorded.failure.detail);

  return { deps, store, runId: run.runId, gitRunKey, workspacePath: added.value, base, spawned };
}

function attemptArtifact(projectDir: string, runId: string, attempt: number): unknown {
  const path = runPaths(projectDir, runId).taskAttempt(TASK, attempt);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
}

describe('revalidate records a pass as an attempt a person closed (D19)', () => {
  it('runs the validation over the tree as it stands and leaves a receipt and a marker', async () => {
    const { deps, store, runId, gitRunKey, workspacePath } = await world(PASSING);

    // The fix, made the way a person makes one: in the worktree, by hand, with no runner.
    writeFileSync(join(workspacePath, 'fixed.txt'), 'the nine imports, deleted\n');

    const outcome = await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.passed).toBe(true);
    expect(outcome.value.attempt).toBe(2);

    const artifact = attemptArtifact(deps.projectDir, runId, 2) as Record<string, unknown>;
    expect(artifact, 'attempt 2 left no evidence').toBeDefined();

    // **The positive control of the whole change.** The artifact is the only durable record
    // of who closed this task, and everything downstream — the history projection, the
    // dashboard, an audit a year later — reads it from here.
    expect(artifact['closedBy']).toBe('human');
    expect(artifact['runner']).toBe('human');
    expect(artifact['validationJudgement']).toBe('satisfied');
    expect(artifact['filesChanged']).toContain('fixed.txt');

    // And it is a real attempt, not a shape that looks like one: a receipt bound to a tree,
    // and a marker on this run's own attempt ref whose tree is that same tree.
    const receipt = artifact['receipt'] as { validatedTree: string; nonce: string };
    expect(receipt.nonce).toMatch(/^[0-9a-f]{32}$/);

    const ref = attemptRef(gitRunKey, TASK, 2);
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const marker = repo?.userGit(['rev-parse', `refs/heads/${ref.value}`]).trim() ?? '';
    expect(marker).toMatch(/^[0-9a-f]{40}$/);
    expect(repo?.userGit(['rev-parse', `${marker}^{tree}`]).trim()).toBe(receipt.validatedTree);
    // One parent, and it is the attempt's base — the squash §12.5 describes, not the
    // person's own commits (they made none).
    expect(repo?.userGit(['rev-parse', `${marker}^`]).trim()).toBe(
      (attemptArtifact(deps.projectDir, runId, 1) as Record<string, string>)['base'],
    );

    // The state a satisfied attempt leaves in worktree mode: `running`, awaiting the merge
    // that decides the outcome. Nothing here writes `completed` (I-3).
    const state = await store.loadRun(runId);
    expect(state.tasks[0]?.state).toBe('running');
  });

  it('spends no retry budget, because nobody was unattended', async () => {
    const { deps, store, runId, workspacePath } = await world(PASSING);
    writeFileSync(join(workspacePath, 'fixed.txt'), 'by hand\n');

    await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });

    const task = (await store.loadRun(runId)).tasks[0];
    // `attempts` moves because an artifact now exists under that number and recovery finds
    // it by that counter. What `retry.maxAttempts` actually bounds is the streak made with
    // nobody watching, and this is the opposite of that — so the budget is untouched.
    expect(task?.attempts).toBe(2);
    expect(task?.attemptsBeforeHumanRetry).toBe(2);
    expect((task?.attempts ?? 0) - (task?.attemptsBeforeHumanRetry ?? 0)).toBe(0);
  });

  it('names the actor in the log, so a human close never reads as a model close', async () => {
    const { deps, store, runId, workspacePath } = await world(PASSING);
    writeFileSync(join(workspacePath, 'fixed.txt'), 'by hand\n');

    await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });

    const events = await store.readEvents(runId);
    const revalidated = events.find((event) => event.type === 'task_revalidated');
    expect(revalidated?.detail['task']).toBe(TASK);
    expect(revalidated?.detail['passed']).toBe(true);
    expect(revalidated?.detail['closedBy']).toBe('human');
    expect(revalidated?.detail['actor']).toEqual({ kind: 'keyboard' });

    // The two events integration and recovery read are emitted too, because this path is
    // the same path — not a second one that happens to end in the same place.
    expect(events.some((event) => event.type === 'task_attempt_validated')).toBe(true);
    expect(events.some((event) => event.type === 'task_attempt_marker_created')).toBe(true);
  });

  it('invokes no runner: the only processes it spawns are git and the validation command', async () => {
    // The claim the whole command rests on. Asserted on what ran rather than on a comment,
    // because "it does not call a model" is exactly the kind of promise that rots.
    const { deps, store, runId, workspacePath } = await world(PASSING);
    writeFileSync(join(workspacePath, 'fixed.txt'), 'by hand\n');

    await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });

    const events = await store.readEvents(runId);
    expect(events.some((event) => event.type === 'task_started')).toBe(false);
    expect(events.some((event) => event.type === 'stage_started')).toBe(false);
  });
});

describe('revalidate leaves a task that still fails exactly where it was', () => {
  it('records the evidence and spends nothing', async () => {
    const { deps, store, runId, workspacePath } = await world(FAILING);
    writeFileSync(join(workspacePath, 'half-fixed.txt'), 'not enough\n');

    const outcome = await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.passed).toBe(false);
    expect(outcome.value.evidence.join('\n')).toContain('exit 1');

    const task = (await store.loadRun(runId)).tasks[0];
    expect(task?.state).toBe('failed');
    expect(task?.attempts).toBe(1);

    // **No `attempt-2.json`, and that is the point rather than an omission.** A failed
    // revalidation is not an execution of work — no runner ran — and §11.3 reads "no
    // `attempt-<n>.json`" as *the attempt's work was never observed*, which is literally
    // true here. It also keeps the door open: the person fixes more and revalidates again.
    expect(attemptArtifact(deps.projectDir, runId, 2)).toBeUndefined();

    const revalidated = (await store.readEvents(runId)).find(
      (event) => event.type === 'task_revalidated',
    );
    expect(revalidated?.detail['passed']).toBe(false);
    expect(revalidated?.detail['evidence']).not.toEqual([]);
  });

  it('can be asked again over the same worktree', async () => {
    // The consequence of not spending an attempt, stated as behaviour: a first fix that was
    // incomplete does not cost the person their only way back in.
    const { deps, runId, workspacePath } = await world(FAILING);

    await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });
    writeFileSync(join(workspacePath, 'more.txt'), 'the rest of it\n');

    expect(await refuseUnrevalidatable(deps, runId, TASK)).toBeUndefined();
  });
});

describe('revalidate refuses before the lock, with a reason that names itself', () => {
  it('refuses when the attempt worktree is gone', async () => {
    const { deps, runId, workspacePath } = await world(PASSING);
    // Removed the way a `git worktree prune` or a cleanup would leave it: the directory is
    // simply not there any more, and there is no tree "as it stands" to validate.
    rmSync(workspacePath, { recursive: true, force: true });

    const refusal = await refuseUnrevalidatable(deps, runId, TASK);
    expect(refusal?.code).toBe('attempt_workspace_missing');
    // Sent to the command that can still help, rather than left with a bare "no".
    expect(refusal?.action).toContain('Retry the task');
  });

  it('refuses a task the machine still intends to run', async () => {
    const { deps, store, runId } = await world(PASSING);
    await store.updateRun(runId, (state) => ({
      ...state,
      tasks: state.tasks.map((task) => ({ ...task, state: 'queued' as const })),
    }));

    expect((await refuseUnrevalidatable(deps, runId, TASK))?.code).toBe('task_not_revalidatable');
  });

  it('refuses a run that never isolated anything', async () => {
    const { deps, store } = await world(PASSING);

    // A second run in the same repository, born without a Git identity — which is what a
    // sequential run is, and what every run that predates isolation looks like (§25.2).
    // Created rather than demoted, because the three identity fields are frozen at
    // creation and the store refuses to rewrite them.
    const sequential = await store.createRun('a sequential feature');
    await store.updateRun(sequential.runId, (state) => ({
      ...state,
      tasks: [{ id: TASK, state: 'failed' as const, attempts: 1, infrastructureFailures: 0 }],
    }));

    const refusal = await refuseUnrevalidatable(deps, sequential.runId, TASK);
    expect(refusal?.code).toBe('revalidation_unsupported');
    // Sent somewhere that exists, rather than to a command that will refuse them too.
    expect(refusal?.action).toContain('agent-flow review');
  });

  it('refuses a task that declares no validation, which would check nothing', async () => {
    // **The zero-check close.** A BLOCKED task is routinely `validation: []`, and `blocked`
    // is a state this command accepts — so without this refusal one typed word would mint a
    // receipt over an untouched tree, publish a marker and hand it to the Integrator with
    // no command run, no model run and no gate crossed. `judgeValidation` answers
    // `completed` for zero commands, correctly, for a caller that is not this one.
    const { deps, runId } = await world(PASSING, { expectation: 'none', ids: [] }, 'blocked');

    const refusal = await refuseUnrevalidatable(deps, runId, TASK);
    expect(refusal?.code).toBe('nothing_to_revalidate');
    expect(refusal?.action).toContain('Retry the task');

    // And the use case refuses it too, rather than trusting the caller to have asked. A
    // future adapter reaching past the precondition must not be able to close a task by
    // running nothing.
    const outcome = await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('nothing_to_revalidate');
  });

  it('writes nothing at all when it refuses for having nothing to check', async () => {
    // The consequence that matters, measured rather than assumed: no attempt artifact, no
    // marker ref, and the task exactly where it was.
    const { deps, store, runId, gitRunKey } = await world(
      PASSING,
      { expectation: 'none', ids: [] },
      'blocked',
    );

    await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });

    expect(attemptArtifact(deps.projectDir, runId, 2)).toBeUndefined();
    const ref = attemptRef(gitRunKey, TASK, 2);
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    expect(() => repo?.userGit(['rev-parse', '--verify', `refs/heads/${ref.value}`])).toThrow();

    const task = (await store.loadRun(runId)).tasks[0];
    expect(task?.state).toBe('blocked');
    expect(task?.attempts).toBe(1);
  });

  it('still passes a task that does declare one — the control', async () => {
    // Without this the refusal above could be satisfied by a command that refuses
    // everything, which is a different product.
    const { deps, runId, workspacePath } = await world(PASSING);
    writeFileSync(join(workspacePath, 'fixed.txt'), 'by hand\n');

    expect(await refuseUnrevalidatable(deps, runId, TASK)).toBeUndefined();
    const outcome = await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });
    expect(outcome.ok && outcome.value.passed).toBe(true);
    expect(outcome.ok && outcome.value.commands).toHaveLength(1);
  });

  it('refuses a task whose validation id the project no longer defines', async () => {
    const { deps, runId, workspacePath } = await world(PASSING);
    writeFileSync(join(workspacePath, 'fixed.txt'), 'by hand\n');

    const withoutTest: RevalidationDeps = {
      ...deps,
      config: { ...deps.config, project: ProjectConfigSchema.parse({ project: { name: 'x', type: 'node' } }) },
    };

    const outcome = await revalidateTask(withoutTest, runId, TASK, { kind: 'keyboard' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe('task_not_revalidatable');
    expect(outcome.refusal.message).toContain('"test"');
  });
});

describe('revalidate runs the commands under the operator\'s budget', () => {
  it('passes execution.commandTimeoutSeconds to the validation command it spawns', async () => {
    // A suite that `run` allows 2400 seconds must not be killed at 900 when a person
    // revalidates it: the same tree, the same command, and a different verdict would be
    // decided by which verb was typed.
    const { deps, runId, workspacePath, spawned } = await world(PASSING, undefined, undefined, 2400);
    writeFileSync(join(workspacePath, 'fixed.txt'), 'by hand\n');

    const outcome = await revalidateTask(deps, runId, TASK, { kind: 'keyboard' });

    expect(outcome.ok && outcome.value.passed).toBe(true);
    const validation = spawned.filter((call) => call.command !== 'git');
    expect(validation).toHaveLength(1);
    expect(validation[0]?.timeoutSeconds).toBe(2400);
  });
});
