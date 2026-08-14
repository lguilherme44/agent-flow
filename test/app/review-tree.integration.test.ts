import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitClient, renderChanges } from '../../src/adapters/git/git-client.js';
import { runVerification } from '../../src/app/verification-commands.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { buildDag } from '../../src/core/dag.js';
import type { ProjectConfig } from '../../src/contracts/index.js';
import { makeWorktreeRun, type WorktreeRun } from '../fixtures/worktree-run.js';

/**
 * §19 — one tree, verified and reviewed.
 *
 * The failure this exists to prevent has a name and no symptom: *verified tree A,
 * reviewed tree B*. A run whose validation commands ran over one commit and whose
 * reviewer read another is a run whose green verdict means nothing, and nothing
 * about it looks wrong from the outside.
 *
 * So the property is stated as an identity rather than as a habit: the
 * verification cwd, the reviewer's cwd and the diff all resolve to
 * `state.integrationHead`, and the integration branch is required to still be at
 * that commit before any of them runs.
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

/** A run with two tasks integrated, which is what review is asked to judge. */
async function integrated(): Promise<{ current: WorktreeRun; head: string }> {
  const current = await makeWorktreeRun();
  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') throw new Error('the namespace could not be prepared');

  await current.seed(['TASK-001', 'TASK-002']);
  const first = await current.plant('TASK-001', 1, { write: { 'one.txt': 'one\n' } });

  await current.integrator.integrate({
    runId: current.runId,
    workspace: prepared.workspace,
    dag: buildDag([{ id: 'TASK-001', dependencies: [] }]),
    attempts: [{ task: 'TASK-001', attempt: 1, result: current.resultFor('TASK-001') }],
  });

  const waveBase = await current.integrator.waveBase(prepared.workspace);
  const second = await current.plant('TASK-002', 1, {
    base: waveBase,
    write: { 'two.txt': 'two\n' },
  });
  expect(second.base).not.toBe(first.base);

  await current.integrator.integrate({
    runId: current.runId,
    workspace: { ...prepared.workspace, head: waveBase ?? '' },
    dag: buildDag([{ id: 'TASK-002', dependencies: [] }]),
    attempts: [{ task: 'TASK-002', attempt: 1, result: current.resultFor('TASK-002') }],
  });

  const head = current.repo
    .userGit(['rev-parse', `refs/heads/${current.integrationBranch}`])
    .trim();
  return { current, head };
}

describe('the tree review reads is the one the run recorded (§19.1, §19.2)', () => {
  it('opens the integration worktree, pinned to state.integrationHead', async () => {
    const { current, head } = await integrated();
    run = current;

    const opened = await current.integrator.openForReview(current.runId);

    expect(opened.kind).toBe('ready');
    if (opened.kind !== 'ready') return;

    expect(opened.workspace.head).toBe(head);
    expect(opened.workspace.head).toBe((await current.store.loadRun(current.runId)).integrationHead);
    // Never the user's working tree (I-10). It is a checkout under Agent Flow's
    // own root, and it holds the feature the user's tree does not.
    expect(opened.workspace.path).not.toBe(current.repo.dir);
    expect(opened.workspace.path.startsWith(current.repo.worktreeRoot)).toBe(true);
    expect(existsSync(join(opened.workspace.path, 'one.txt'))).toBe(true);
    expect(existsSync(join(current.repo.dir, 'one.txt'))).toBe(false);
  });

  it('runs the verification commands inside it', async () => {
    const { current } = await integrated();
    run = current;

    const opened = await current.integrator.openForReview(current.runId);
    if (opened.kind !== 'ready') throw new Error('the integration tree did not open');

    // A command that reports where it ran and what it can see. In the user's tree
    // neither file exists, so a verification pointed at `globals.cwd` would pass
    // this test's `test` step and be describing a tree with none of the work in it.
    const project = {
      commands: { test: 'cat one.txt two.txt && pwd' },
    } as unknown as ProjectConfig;

    const verification = await runVerification({
      processRunner: new NodeProcessRunner(),
      project,
      cwd: opened.workspace.path,
    });

    expect(verification.passed).toBe(true);
    expect(verification.results[0]?.stdout).toContain('one');
    expect(verification.results[0]?.stdout).toContain('two');

    const inTheUsersTree = await runVerification({
      processRunner: new NodeProcessRunner(),
      project,
      cwd: current.repo.dir,
    });
    expect(inTheUsersTree.passed).toBe(false);
  });

  it('gives the reviewer the feature’s diff, not the state of a working tree', async () => {
    const { current, head } = await integrated();
    run = current;

    const opened = await current.integrator.openForReview(current.runId);
    if (opened.kind !== 'ready') throw new Error('the integration tree did not open');

    const git = new GitClient(current.repo.git, opened.workspace.path);
    const changes = await git.changedFilesBetween(current.planningBase, opened.workspace.head);

    expect(changes.map((change) => change.path).sort()).toEqual(['one.txt', 'two.txt']);
    expect(changes.every((change) => change.status === 'A')).toBe(true);
    expect(renderChanges(changes)).toContain('one.txt');

    const stat = await git.diffStatBetween(current.planningBase, opened.workspace.head);
    expect(stat).toContain('one.txt');
    expect(stat).toContain('two.txt');

    // The same commit, all three times — and it is the one the run recorded.
    expect(opened.workspace.head).toBe(head);
  });

  it('is unmoved by anything sitting in the integration checkout', async () => {
    // The diff names two commits, so a stray file cannot enter the reviewer's
    // picture of what was integrated. A single-argument `diff <base>` would
    // compare the base against whatever the checkout holds right now.
    const { current } = await integrated();
    run = current;

    const opened = await current.integrator.openForReview(current.runId);
    if (opened.kind !== 'ready') throw new Error('the integration tree did not open');

    writeFileSync(join(opened.workspace.path, 'stray.txt'), 'nobody integrated this\n');

    const git = new GitClient(current.repo.git, opened.workspace.path);
    const changes = await git.changedFilesBetween(current.planningBase, opened.workspace.head);

    expect(changes.map((change) => change.path).sort()).toEqual(['one.txt', 'two.txt']);
  });

  it('refuses when the branch is no longer at the commit the run recorded', async () => {
    const { current } = await integrated();
    run = current;

    // A person, or another tool, moves the branch after the run recorded its head.
    current.repo.userGit([
      'update-ref',
      `refs/heads/${current.integrationBranch}`,
      current.planningBase,
    ]);

    const opened = await current.integrator.openForReview(current.runId);

    expect(opened.kind).toBe('refused');
    expect(opened.kind === 'refused' && opened.refusal.code).toBe('integration_head_diverged');
  });

  it('re-creates a missing checkout rather than reviewing somewhere else', async () => {
    const { current, head } = await integrated();
    run = current;

    const first = await current.integrator.openForReview(current.runId);
    if (first.kind !== 'ready') throw new Error('the integration tree did not open');
    rmSync(first.workspace.path, { recursive: true, force: true });

    const again = await current.integrator.openForReview(current.runId);

    expect(again.kind).toBe('ready');
    if (again.kind !== 'ready') return;
    expect(again.workspace.path).toBe(first.workspace.path);
    expect(again.workspace.head).toBe(head);
    expect(readFileSync(join(again.workspace.path, 'one.txt'), 'utf8')).toBe('one\n');
  });

  it('answers sequential for a run that is not isolated', async () => {
    // §25.1: review continues to read the project directory, unchanged and
    // unlocked, and no Git integration path is reached.
    run = await makeWorktreeRun();
    const sequential = await run.store.createRun('another', () => ({ isolationMode: 'none' }));

    const opened = await run.integrator.openForReview(sequential.runId);

    expect(opened.kind).toBe('sequential');
  });
});
