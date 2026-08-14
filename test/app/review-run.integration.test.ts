import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { review, type RunActionDeps } from '../../src/app/run-actions.js';
import { buildDag } from '../../src/core/dag.js';
import type { ProcessResult, ProcessRunner, ProcessSpawnOptions } from '../../src/ports/index.js';
import { makeWorktreeRun, type WorktreeRun } from '../fixtures/worktree-run.js';

/**
 * `agent-flow review`, driven through the real use case, over a real repository.
 *
 * The claim §19.2 makes is an *identity*, and identities are only testable at the
 * point where the three consumers actually run:
 *
 * ```text
 * runVerification   ─┐
 * the review agents  ├─ all three describe state.integrationHead
 * the reviewer's diff┘
 * ```
 *
 * So this drives `review()` itself: the real execution context, the real
 * `StageRunner`, the real runner adapter and real Git. Only the CLI at the very
 * bottom is scripted — a `ProcessRunner` that answers the agent invocations with
 * a canned envelope and hands everything else (Git, the validation commands) to
 * the real one, recording the working directory of every spawn on the way past.
 *
 * That recording is the assertion. A review pointed at `globals.cwd` would show
 * the project directory here, and the user's working tree holds none of the run's
 * work — which is exactly the "verified tree A, reviewed tree B" split that makes
 * a green verdict meaningless.
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

const REVIEW_RESPONSE = { verdict: 'PASS', summary: 'Looks right.', findings: [] };

/**
 * Real for Git and for the shell, scripted for the coding CLI.
 *
 * One runner is used for everything below `buildExecutionContext`, so a wholly
 * fake one would break Git and a wholly real one would try to spawn `claude`.
 */
class RecordingProcessRunner implements ProcessRunner {
  readonly agentCwds: string[] = [];
  readonly shellCwds: string[] = [];
  private readonly real = new NodeProcessRunner();

  async run(options: ProcessSpawnOptions): Promise<ProcessResult> {
    if (options.command === 'git') return this.real.run(options);

    if (options.command === '/bin/sh') {
      this.shellCwds.push(options.cwd);
      return this.real.run(options);
    }

    this.agentCwds.push(options.cwd);
    return {
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        is_error: false,
        subtype: 'success',
        result: JSON.stringify(REVIEW_RESPONSE),
        structured_output: REVIEW_RESPONSE,
      }),
      stderr: '',
      durationMs: 1,
      timedOut: false,
      spawnFailed: false,
      truncated: false,
    };
  }
}

const PLAN = {
  feature: 'a feature',
  tasks: [
    {
      id: 'TASK-001',
      title: 'One',
      description: 'Do one.',
      complexity: 'trivial',
      risk: 'low',
      dependencies: [],
      requirements: ['FR-001'],
      acceptanceCriteria: ['One is done.'],
      validation: ['test'],
    },
  ],
};

/** A run with one task integrated, its plan and SDD on disk, ready to review. */
async function reviewable(): Promise<{
  current: WorktreeRun;
  deps: RunActionDeps;
  runner: RecordingProcessRunner;
  integrationPath: string;
  head: string;
}> {
  const current = await makeWorktreeRun();

  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') throw new Error('the namespace could not be prepared');

  await current.seed(['TASK-001']);
  await current.plant('TASK-001', 1, { write: { 'one.txt': 'one\n' } });
  await current.integrator.integrate({
    runId: current.runId,
    workspace: prepared.workspace,
    dag: buildDag([{ id: 'TASK-001', dependencies: [] }]),
    attempts: [{ task: 'TASK-001', attempt: 1, result: current.resultFor('TASK-001') }],
  });

  await current.store.writeArtifact(current.runId, 'sdd', '# SDD\n\nIt should do one thing.\n');
  await current.store.writeArtifact(current.runId, 'plan', JSON.stringify(PLAN));
  await current.store.updateRun(current.runId, (state) => ({
    ...state,
    approved: true,
    approvedAt: '2026-08-09T20:00:00.000Z',
  }));

  // A validation command that only passes inside a tree holding the integrated
  // work. In the user's working tree `one.txt` does not exist.
  current.repo.write(
    '.agent-flow/config.yaml',
    'project:\n  name: demo\n  type: node\ncommands:\n  test: cat one.txt\n',
  );

  const runner = new RecordingProcessRunner();
  const deps: RunActionDeps = {
    fs: new NodeFileSystem(),
    clock: current.clock,
    processRunner: runner,
    host: current.host,
    projectDir: current.repo.dir,
    globalConfigPath: join(current.repo.home, 'no-such-config.yaml'),
    promptsDir: join(import.meta.dirname, '../../prompts'),
    owner: 'cli',
  };

  const head = current.repo
    .userGit(['rev-parse', `refs/heads/${current.integrationBranch}`])
    .trim();

  return { current, deps, runner, integrationPath: prepared.workspace.path, head };
}

describe('review runs over the integration tree (§19.1, §19.2)', () => {
  it('verifies and reviews the same commit, in the same checkout', async () => {
    const { current, deps, runner, integrationPath, head } = await reviewable();
    run = current;

    const outcome = await review(deps, current.runId);

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    // The verification commands ran in the integration worktree — and passed,
    // which they could only do over a tree that holds the integrated file.
    expect(runner.shellCwds).not.toEqual([]);
    expect(new Set(runner.shellCwds)).toEqual(new Set([integrationPath]));
    expect(outcome.value.verification.passed).toBe(true);

    // Both review agents ran there too. Left to default they would have run in
    // the project directory, which is the user's working tree.
    expect(runner.agentCwds).toHaveLength(2);
    expect(new Set(runner.agentCwds)).toEqual(new Set([integrationPath]));
    expect(integrationPath).not.toBe(current.repo.dir);

    // And all of it describes one commit, which is the one the run recorded.
    expect(outcome.value.integration).toEqual({
      branch: current.integrationBranch,
      head,
    });
    expect((await current.store.loadRun(current.runId)).integrationHead).toBe(head);
  });

  it('judges the Definition of Done over that tree, and completes the run', async () => {
    const { current, deps } = await reviewable();
    run = current;

    const outcome = await review(deps, current.runId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.done.done).toBe(true);
    expect(outcome.value.finalReview.verdict).toBe('PASS');
    expect((await current.store.loadRun(current.runId)).status).toBe('completed');
    expect(await current.store.readArtifact(current.runId, 'finalReview')).not.toBeNull();
  });

  it('still reads the project directory for a sequential run (§25.1)', async () => {
    // The compatibility promise, stated as the same measurement: a run created
    // sequential reaches no integration branch, no worktree and no Git
    // integration path, and everything runs where it always did.
    const { current, deps, runner } = await reviewable();
    run = current;

    const sequential = await current.store.createRun('another feature', () => ({
      isolationMode: 'none' as const,
    }));
    await current.store.writeArtifact(sequential.runId, 'sdd', '# SDD\n');
    await current.store.writeArtifact(sequential.runId, 'plan', JSON.stringify(PLAN));

    const outcome = await review(deps, sequential.runId);

    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.integration).toBeUndefined();
    expect(new Set(runner.agentCwds)).toEqual(new Set([current.repo.dir]));
    expect(new Set(runner.shellCwds)).toEqual(new Set([current.repo.dir]));
    // No branch was cut for it, and no checkout was made.
    expect(
      current.repo.userGit([
        'for-each-ref',
        '--format=%(refname)',
        `refs/heads/agent-flow/${sequential.runId}-`,
      ]),
    ).toBe('');
  });

  it('leaves the user’s working tree untouched while it does (§19.3)', async () => {
    const { current, deps } = await reviewable();
    run = current;

    const before = {
      head: current.repo.userGit(['rev-parse', 'HEAD']).trim(),
      branch: current.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      status: current.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all']),
    };

    await review(deps, current.runId);

    expect(current.repo.userGit(['rev-parse', 'HEAD']).trim()).toBe(before.head);
    expect(current.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(before.branch);
    expect(current.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
      before.status,
    );
  });
});
