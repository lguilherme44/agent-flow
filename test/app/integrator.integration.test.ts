import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Integrator } from '../../src/app/integrator.js';
import { StateStore } from '../../src/app/state-store.js';
import { runPaths } from '../../src/app/paths.js';
import { TaskResultSchema } from '../../src/contracts/index.js';
import { makeWorktreeRun, type PlantedAttempt, type WorktreeRun } from '../fixtures/worktree-run.js';
import { delegating } from '../fixtures/crash.js';

/**
 * Deterministic integration, against real Git (§26.3, §26.4).
 *
 * **Nothing here is mocked**, and the reason is not thoroughness: every claim
 * below is a claim about Git rather than about this code. That `--no-ff` produces
 * a merge commit where a fast-forward was possible, that a conflicted merge exits
 * 1 with an unmerged index, that `merge --abort` returns the worktree to exactly
 * where it was, that a locked worktree whose directory is gone is not pruned —
 * each was probed, and a fake would only ever confirm what the fake was told.
 */

let run: WorktreeRun | undefined;

afterEach(() => {
  run?.cleanup();
  run = undefined;
});

/** The wave request shape, for a plan of independent tasks unless told otherwise. */
function waveOf(
  current: WorktreeRun,
  workspace: { path: string; branch: string; head: string },
  planted: readonly PlantedAttempt[],
  dependencies: Readonly<Record<string, readonly string[]>> = {},
) {
  return {
    runId: current.runId,
    workspace,
    dag: current.dag(
      planted.map((entry) => ({ id: entry.task, dependencies: dependencies[entry.task] ?? [] })),
    ),
    attempts: planted.map((entry) => ({
      task: entry.task,
      attempt: entry.attempt,
      result: current.resultFor(entry.task),
    })),
  };
}

/**
 * Leaves the integration worktree mid-merge, the way a dead process leaves it.
 *
 * The real adapter issues the merge and the conflict stops it with `MERGE_HEAD`
 * on disk and an unmerged index. Nothing aborts it, which is the state §17.3
 * window 6 is about.
 */
async function leaveMidMerge(
  current: WorktreeRun,
  workspace: { path: string },
  marker: string,
): Promise<void> {
  const merged = await current.repo.workspaces.merge({
    cwd: workspace.path,
    commit: marker,
    message: 'agent-flow: an interrupted integration',
    identity: { name: 'Agent Flow', email: 'agent-flow@local' },
    dates: { author: current.clock.now(), committer: current.clock.now() },
  });
  if (!merged.ok) throw new Error(merged.failure.message);
  if (merged.value.kind !== 'conflict') {
    throw new Error('expected the planted merge to conflict, so a merge is left in progress');
  }
}

async function readyWorkspace(current: WorktreeRun) {
  const prepared = await current.integrator.prepare(current.runId);
  if (prepared.kind !== 'ready') {
    throw new Error(
      `expected a prepared integration workspace, got ${prepared.kind}: ${
        prepared.kind === 'refused' ? prepared.refusal.detail : ''
      }`,
    );
  }
  return prepared.workspace;
}

// ---------------------------------------------------------------------------
// §5.3, §14.1 — the branch and its checkout
// ---------------------------------------------------------------------------

describe('the integration branch and its worktree (§5.3, §14.1)', () => {
  it('cuts the branch from planningBase and checks it out', async () => {
    run = await makeWorktreeRun();

    const before = {
      head: run.repo.userGit(['rev-parse', 'HEAD']).trim(),
      branch: run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      status: run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all']),
      index: run.repo.userGit(['ls-files', '--stage']),
    };

    const workspace = await readyWorkspace(run);

    // Initialisation touches the user's working tree not at all: no checkout, no
    // HEAD move, no index change (§19.3, I-10). The branch is created by a single
    // reference transaction and the checkout happens somewhere else entirely.
    expect(run.repo.userGit(['rev-parse', 'HEAD']).trim()).toBe(before.head);
    expect(run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(before.branch);
    expect(run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
      before.status,
    );
    expect(run.repo.userGit(['ls-files', '--stage'])).toBe(before.index);

    expect(workspace.branch).toBe(run.integrationBranch);
    expect(workspace.head).toBe(run.planningBase);
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(
      run.planningBase,
    );

    // A checkout of the branch, under Agent Flow's own root, locked so a
    // `git worktree prune` in another terminal cannot reclaim it mid-run.
    expect(existsSync(workspace.path)).toBe(true);
    expect(workspace.path.startsWith(run.repo.worktreeRoot)).toBe(true);
    expect(
      run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.path).trim(),
    ).toBe(run.integrationBranch);

    const registered = run.repo
      .userGit(['worktree', 'list', '--porcelain'])
      .split('\n\n')
      .find((block) => block.includes('integration'));
    expect(registered).toContain('locked agent-flow');

    // And the run recorded it. `integrationHead` is the discriminator §5.3 uses
    // to tell "my own namespace, resumed" from "somebody else's wreckage".
    expect((await run.store.loadRun(run.runId)).integrationHead).toBe(run.planningBase);

    const created = (await run.store.readEvents(run.runId)).find(
      (event) => event.type === 'integration_branch_created',
    );
    expect(created?.detail).toEqual({
      branch: run.integrationBranch,
      base: run.planningBase,
      adopted: false,
    });
  });

  it('re-creates the checkout from the branch when the directory is gone', async () => {
    // §14.1's asymmetry: the branch is the work and the worktree is a checkout.
    // A locked registration whose directory has been removed is *not* pruned by
    // Git — probed: `worktree add` then refuses with "missing but locked
    // worktree" — so recreation has to clear it first.
    run = await makeWorktreeRun();
    const first = await readyWorkspace(run);

    const planted = await run.plant('TASK-001', 1, { write: { 'one.txt': 'one\n' } });
    await run.seed(['TASK-001']);
    await run.integrator.integrate(waveOf(run, first, [planted]));
    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();

    rmSync(first.path, { recursive: true, force: true });

    const again = await readyWorkspace(run);

    expect(again.path).toBe(first.path);
    expect(existsSync(join(again.path, 'one.txt'))).toBe(true);
    // Nothing was lost: the branch still holds the merge, and the checkout is at it.
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(head);
    expect(run.repo.userGit(['rev-parse', 'HEAD'], again.path).trim()).toBe(head);
  });

  it('adopts its own branch after a crash during initialisation (case B)', async () => {
    run = await makeWorktreeRun();

    // The window §5.3 case B describes: the branch was created and the state
    // write never landed. Nothing else in the namespace, and the branch is at
    // exactly `planningBase`.
    run.repo.userGit([
      'update-ref',
      `refs/heads/${run.integrationBranch}`,
      run.planningBase,
    ]);

    const workspace = await readyWorkspace(run);

    expect(workspace.head).toBe(run.planningBase);
    expect((await run.store.loadRun(run.runId)).integrationHead).toBe(run.planningBase);

    const created = (await run.store.readEvents(run.runId)).find(
      (event) => event.type === 'integration_branch_created',
    );
    expect(created?.detail['adopted']).toBe(true);
  });

  it('adopts a branch that already holds integrated work, never resetting it', async () => {
    // Case D. The branch *is* the product (§19.3), so a resume that re-cut it
    // from `planningBase` would silently discard every merge the run had already
    // made — and the run would carry on looking healthy.
    run = await makeWorktreeRun();
    const first = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'one.txt': 'one\n' } });
    await run.integrator.integrate(waveOf(run, first, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    expect(head).not.toBe(run.planningBase);

    const again = await readyWorkspace(run);

    expect(again.head).toBe(head);
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(head);
    expect((await run.store.loadRun(run.runId)).integrationHead).toBe(head);
    // The merge is still there, and the checkout still holds its work.
    expect(
      run.repo
        .userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`])
        .trim(),
    ).toBe('1');
    expect(existsSync(join(again.path, 'one.txt'))).toBe(true);

    // A resume announces nothing: the branch was not created, so there is no
    // `integration_branch_created` for it (Appendix B).
    const created = (await run.store.readEvents(run.runId)).filter(
      (event) => event.type === 'integration_branch_created',
    );
    expect(created).toHaveLength(1);
  });

  it('refuses a namespace holding refs this run did not create (case C)', async () => {
    run = await makeWorktreeRun();

    run.repo.userGit([
      'update-ref',
      `refs/heads/agent-flow/${run.gitRunKey}/TASK-009/attempt-1`,
      run.planningBase,
    ]);

    const prepared = await run.integrator.prepare(run.runId);

    expect(prepared.kind).toBe('refused');
    expect(prepared.kind === 'refused' && prepared.refusal.code).toBe('git_run_key_collision');
    // Nothing was created to get past it: a 64-bit collision is evidence of
    // broken state, not a random event.
    expect((await run.store.loadRun(run.runId)).integrationHead).toBeUndefined();
  });

  it('refuses a resume whose branch was rewound underneath it (case D)', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);

    const planted = await run.plant('TASK-001', 1, { write: { 'one.txt': 'one\n' } });
    await run.seed(['TASK-001']);
    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    // A person, or another tool, resets the branch back to where it started.
    run.repo.userGit([
      'update-ref',
      `refs/heads/${run.integrationBranch}`,
      run.planningBase,
    ]);

    const prepared = await run.integrator.prepare(run.runId);

    expect(prepared.kind).toBe('refused');
    expect(prepared.kind === 'refused' && prepared.refusal.code).toBe('integration_head_diverged');
  });

  it('answers sequential for a run that is not isolated', async () => {
    // §25.1: no integration branch, no worktree, no Git integration path reached.
    run = await makeWorktreeRun();
    const sequential = await run.store.createRun('another', () => ({ isolationMode: 'none' }));

    const prepared = await run.integrator.prepare(sequential.runId);

    expect(prepared.kind).toBe('sequential');
    expect(run.repo.userGit(['for-each-ref', '--format=%(refname)', 'refs/heads/agent-flow'])).toBe(
      '',
    );
  });
});

// ---------------------------------------------------------------------------
// §14.2 — order
// ---------------------------------------------------------------------------

describe('integration order is the plan’s, never completion order (§14.2)', () => {
  it('merges in topological order whatever order the attempts arrive in', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002', 'TASK-003']);

    const third = await run.plant('TASK-003', 1, { write: { 'c.txt': 'c\n' } });
    const first = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const second = await run.plant('TASK-002', 1, { write: { 'b.txt': 'b\n' } });

    // Offered newest-finished-first, which is what a wave of concurrent workers
    // produces. The Integrator must ignore it entirely.
    const outcome = await run.integrator.integrate(
      waveOf(run, workspace, [third, second, first], {
        'TASK-002': ['TASK-001'],
        'TASK-003': ['TASK-002'],
      }),
    );

    expect(outcome.outcomes.map((entry) => entry.task)).toEqual([
      'TASK-001',
      'TASK-002',
      'TASK-003',
    ]);

    // And the branch says the same thing, oldest merge first.
    const merges = run.repo
      .userGit(['log', '--merges', '--format=%s', `refs/heads/${run.integrationBranch}`])
      .trim()
      .split('\n')
      .reverse();
    expect(merges).toEqual([
      'agent-flow: integrate TASK-001 (attempt 1)',
      'agent-flow: integrate TASK-002 (attempt 1)',
      'agent-flow: integrate TASK-003 (attempt 1)',
    ]);
  });

  it('gives four independent tasks four merge commits, in the plan’s order', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    const ids = ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'];
    await run.seed(ids);

    const planted: PlantedAttempt[] = [];
    for (const id of ids) {
      planted.push(await run.plant(id, 1, { write: { [`${id}.txt`]: `${id}\n` } }));
    }

    await run.integrator.integrate(waveOf(run, workspace, [...planted].reverse()));

    expect(
      run.repo
        .userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`])
        .trim(),
    ).toBe('4');
    const merges = run.repo
      .userGit(['log', '--merges', '--format=%s', `refs/heads/${run.integrationBranch}`])
      .trim()
      .split('\n')
      .reverse();
    expect(merges).toEqual(ids.map((id) => `agent-flow: integrate ${id} (attempt 1)`));
  });
});

// ---------------------------------------------------------------------------
// §14.3 — per-attempt trust
// ---------------------------------------------------------------------------

describe('what integration refuses to merge (§14.3, I-5, I-6, S-9)', () => {
  /**
   * A run whose namespace is initialised and whose task is dispatched, in that
   * order — which is the order §9.1 fixes. Preparing *after* an attempt ref
   * exists would look like §5.3 case C, and correctly so: an attempt ref under a
   * namespace with no recorded head is work the run did not do.
   */
  async function dispatched() {
    const current = await makeWorktreeRun();
    const workspace = await readyWorkspace(current);
    await current.seed(['TASK-001']);
    return { current, workspace };
  }

  async function refusalOf(
    current: WorktreeRun,
    workspace: { path: string; branch: string; head: string },
    planted: PlantedAttempt,
  ): Promise<{ code: string; detail: string }> {
    const outcome = await current.integrator.integrate(waveOf(current, workspace, [planted]));
    const first = outcome.outcomes[0];
    if (first === undefined || first.kind !== 'refused') {
      throw new Error(`expected a refusal, got ${first?.kind ?? 'nothing'}`);
    }
    return { code: first.refusal.code, detail: first.refusal.detail };
  }

  function headOf(current: WorktreeRun): string {
    return current.repo.userGit(['rev-parse', `refs/heads/${current.integrationBranch}`]).trim();
  }

  /** The marker's message, so a forgery keeps its trailers word for word. */
  function bodyOf(current: WorktreeRun, marker: string): string {
    const object = current.repo.userGit(['cat-file', 'commit', marker]);
    return object.slice(object.indexOf('\n\n') + 2);
  }

  it('refuses an attempt with no artifact', async () => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    rmSync(runPaths(current.repo.dir, current.runId).taskAttempt('TASK-001', 1));

    expect((await refusalOf(current, workspace, planted)).code).toBe('attempt_evidence_missing');
    expect(headOf(current)).toBe(current.planningBase);
  });

  it('refuses an artifact that does not parse', async () => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    writeFileSync(
      runPaths(current.repo.dir, current.runId).taskAttempt('TASK-001', 1),
      '{ not json',
    );

    expect((await refusalOf(current, workspace, planted)).code).toBe('attempt_evidence_missing');
    expect(headOf(current)).toBe(current.planningBase);
  });

  it('refuses an unsatisfied attempt, which has no receipt and no marker', async () => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, {
      write: { 'a.txt': 'a\n' },
      judgement: 'unsatisfied',
    });

    expect((await refusalOf(current, workspace, planted)).code).toBe(
      'attempt_evidence_unsatisfied',
    );
    expect(headOf(current)).toBe(current.planningBase);
  });

  it('refuses when the attempt branch is gone', async () => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    // The worktree holds the branch checked out, so it has to go first.
    current.repo.userGit(['worktree', 'unlock', planted.workspacePath]);
    current.repo.userGit(['worktree', 'remove', '--force', planted.workspacePath]);
    current.repo.userGit(['update-ref', '-d', `refs/heads/${planted.branch}`]);

    expect((await refusalOf(current, workspace, planted)).code).toBe('attempt_marker_missing');
    expect(headOf(current)).toBe(current.planningBase);
  });

  it('refuses a marker with more than one parent, however good its trailers are', async () => {
    // §14.7: the parent count is the structural discriminator, and "the first
    // parent is the base" is deliberately not the check. A forged merge commit
    // whose first parent is correct passes that weaker test and is refused here.
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    const decoy = current.repo
      .userGit(['commit-tree', planted.validatedTree, '-p', planted.base, '-m', 'a decoy'])
      .trim();
    const forged = current.repo
      .userGit([
        'commit-tree',
        planted.validatedTree,
        '-p',
        planted.base,
        '-p',
        decoy,
        '-m',
        bodyOf(current, planted.marker),
      ])
      .trim();
    current.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, forged]);

    const refusal = await refusalOf(current, workspace, planted);
    expect(refusal.code).toBe('attempt_marker_mismatch');
    expect(refusal.detail).toContain('2 parent(s)');
    expect(headOf(current)).toBe(current.planningBase);
  });

  it('refuses a marker whose parent is not the attempt’s base', async () => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    current.repo.write('drift.txt', 'drift\n');
    const elsewhere = current.repo.commitAll('a commit the run was not planned against');
    const forged = current.repo
      .userGit([
        'commit-tree',
        planted.validatedTree,
        '-p',
        elsewhere,
        '-m',
        bodyOf(current, planted.marker),
      ])
      .trim();
    current.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, forged]);

    expect((await refusalOf(current, workspace, planted)).code).toBe('attempt_marker_mismatch');
  });

  /**
   * §12.4's ten trailers, as the marker's own message composes them.
   *
   * The forgeries below change one line at a time, so each assertion is about
   * exactly the trailer it names.
   */
  const TRAILERS = (current: WorktreeRun, planted: PlantedAttempt) => ({
    'Agent-Flow-Run': current.runId,
    'Agent-Flow-Run-Key': current.gitRunKey,
    'Agent-Flow-Task': planted.task,
    'Agent-Flow-Attempt': String(planted.attempt),
    'Agent-Flow-Base': planted.base,
    'Agent-Flow-Tree': planted.validatedTree,
    'Agent-Flow-Receipt': planted.nonce,
    'Agent-Flow-Validation': 'satisfied',
    'Agent-Flow-Validation-Expectation': 'pass',
    'Agent-Flow-Validation-Ids': 'test',
  });

  function forgeMarker(
    current: WorktreeRun,
    planted: PlantedAttempt,
    trailers: Record<string, string>,
    extraLines: readonly string[] = [],
  ): string {
    const forged = current.repo
      .userGit([
        'commit-tree',
        planted.validatedTree,
        '-p',
        planted.base,
        '-m',
        [
          `agent-flow: ${planted.task} attempt ${String(planted.attempt)}`,
          '',
          ...Object.entries(trailers).map(([name, value]) => `${name}: ${value}`),
          ...extraLines,
        ].join('\n'),
      ])
      .trim();
    current.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, forged]);
    return forged;
  }

  it.each([
    ['Agent-Flow-Receipt', 'f'.repeat(32)],
    ['Agent-Flow-Run', 'AF-2026-999'],
    ['Agent-Flow-Task', 'TASK-002'],
    ['Agent-Flow-Attempt', '2'],
    ['Agent-Flow-Tree', 'c'.repeat(40)],
    ['Agent-Flow-Validation', 'unsatisfied'],
    // The two §12.4 names an earlier pass left unchecked. They say what was
    // *asked* of the validation, and a marker that disagrees about that
    // describes a different task than the one that ran.
    ['Agent-Flow-Validation-Expectation', 'fail'],
    ['Agent-Flow-Validation-Ids', 'lint,test'],
  ])('refuses a marker whose %s disagrees with the artifact', async (name, value) => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    forgeMarker(current, planted, { ...TRAILERS(current, planted), [name]: value });

    const refusal = await refusalOf(current, workspace, planted);
    expect(refusal.code).toBe('attempt_marker_mismatch');
    expect(refusal.detail).toContain(name);
  });

  it('refuses a marker that carries a trailer twice', async () => {
    // The message is the one part of a marker a coding agent influences. Picking
    // the first or the last occurrence would let a forgery decide which value the
    // check reads, so a repeat is a refusal rather than a resolution.
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    forgeMarker(current, planted, TRAILERS(current, planted), [
      `Agent-Flow-Receipt: ${'f'.repeat(32)}`,
    ]);

    const refusal = await refusalOf(current, workspace, planted);
    expect(refusal.code).toBe('attempt_marker_mismatch');
    expect(refusal.detail).toContain('Agent-Flow-Receipt');
  });

  it('refuses a marker missing a trailer §12.4 specifies', async () => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    const { 'Agent-Flow-Validation-Ids': _dropped, ...withoutIds } = TRAILERS(current, planted);
    forgeMarker(current, planted, withoutIds);

    const refusal = await refusalOf(current, workspace, planted);
    expect(refusal.code).toBe('attempt_marker_mismatch');
    expect(refusal.detail).toContain('Agent-Flow-Validation-Ids');
  });

  it('accepts the empty validation-ids trailer a `none` task produces', async () => {
    // The regression the ten-trailer check could have introduced. A task with no
    // validation ids composes `Agent-Flow-Validation-Ids: ` — a name, a colon and
    // nothing — and a parser that required a value after the separator would read
    // it as absent and refuse a marker Agent Flow itself had just written.
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, {
      write: { 'a.txt': 'a\n' },
      ids: [],
      expectation: 'none',
    });

    expect(current.repo.userGit(['cat-file', 'commit', planted.marker])).toContain(
      'Agent-Flow-Validation-Ids:',
    );

    const outcome = await current.integrator.integrate(waveOf(current, workspace, [planted]));
    expect(outcome.outcomes[0]?.kind).toBe('integrated');
  });

  it('refuses a marker whose tree is not the receipt’s, with perfect trailers', async () => {
    // S-9, and the honest form of it: the trailers are text an agent can write,
    // so the tree binding is what the decision rests on (I-6). The forgery keeps
    // the marker's whole message — every trailer, byte for byte — and swaps the
    // tree for one that really exists in this repository.
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    const baseTree = current.repo
      .userGit(['rev-parse', `${current.planningBase}^{tree}`])
      .trim();
    expect(baseTree).not.toBe(planted.validatedTree);

    const forged = current.repo
      .userGit([
        'commit-tree',
        baseTree,
        '-p',
        planted.base,
        '-m',
        bodyOf(current, planted.marker),
      ])
      .trim();
    current.repo.userGit(['update-ref', `refs/heads/${planted.branch}`, forged]);

    const refusal = await refusalOf(current, workspace, planted);
    expect(refusal.code).toBe('attempt_marker_mismatch');
    expect(refusal.detail).toContain('receipt');
    // Nothing was repaired and nothing was merged.
    expect(headOf(current)).toBe(current.planningBase);
    expect(await current.store.readTaskResult(current.runId, 'TASK-001')).toBeNull();

    // The trailers were left byte-identical, so this refusal is the tree binding
    // and nothing else. Trailers confirm; the receipt and the tree are what a
    // marker is believed on (I-5, I-6).
    const object = current.repo.userGit(['cat-file', 'commit', forged]);
    expect(object).toContain(`Agent-Flow-Receipt: ${planted.nonce}`);
    expect(object).toContain(`Agent-Flow-Tree: ${planted.validatedTree}`);
    expect(object).toContain('Agent-Flow-Validation-Ids: test');
  });

  it('leaves a refused task in review_required and halts the wave', async () => {
    const { current, workspace } = await dispatched();
    run = current;
    const planted = await current.plant('TASK-001', 1, {
      write: { 'a.txt': 'a\n' },
      judgement: 'unsatisfied',
    });

    const outcome = await current.integrator.integrate(waveOf(current, workspace, [planted]));

    expect(outcome.haltedBy).toContain('TASK-001');
    expect(outcome.outcomes[0]?.state).toBe('review_required');
  });
});

// ---------------------------------------------------------------------------
// §14.5, §14.6 — the merge itself
// ---------------------------------------------------------------------------

describe('the merge (§14.5, §14.6, §14.7)', () => {
  it('is always --no-ff, even where a fast-forward was possible', async () => {
    // The first merge of a wave: the marker's parent *is* the integration head,
    // so Git would fast-forward given the chance. One task, one merge commit,
    // always — otherwise "was this integrated" is answered by a merge commit
    // sometimes and by ancestry alone at other times.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    expect(planted.base).toBe(workspace.head);

    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    expect(head).not.toBe(planted.marker);

    const parents = run.repo.userGit(['rev-list', '--parents', '-n', '1', head]).trim().split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[1]).toBe(run.planningBase);
    expect(parents[2]).toBe(planted.marker);
  });

  it('carries §14.6’s message, and is distinguishable from a marker', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-002']);

    const planted = await run.plant('TASK-002', 2, { write: { 'b.txt': 'b\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    const object = run.repo.userGit(['cat-file', 'commit', head]);

    expect(object).toContain('agent-flow: integrate TASK-002 (attempt 2)');
    expect(object).toContain(`Agent-Flow-Run: ${run.runId}`);
    expect(object).toContain(`Agent-Flow-Run-Key: ${run.gitRunKey}`);
    expect(object).toContain('Agent-Flow-Task: TASK-002');
    expect(object).toContain('Agent-Flow-Attempt: 2');
    expect(object).toContain(`Agent-Flow-Marker: ${planted.marker}`);
    expect(object).toContain(`Agent-Flow-Receipt: ${planted.nonce}`);
    expect(object).toContain(`Agent-Flow-Wave-Base: ${planted.base}`);

    // §14.7's table, both ways round: the merge names the marker and not a tree;
    // the marker names a tree and not a marker.
    expect(object).not.toContain('Agent-Flow-Tree:');
    const marker = run.repo.userGit(['cat-file', 'commit', planted.marker]);
    expect(marker).toContain('Agent-Flow-Tree:');
    expect(marker).not.toContain('Agent-Flow-Marker:');
  });

  it('is authored by Agent Flow, at the injected clock', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    run.clock.advance(60_000);
    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    const object = run.repo.userGit(['cat-file', 'commit', head]);

    expect(object).toContain('author Agent Flow <agent-flow@local>');
    expect(object).toContain('committer Agent Flow <agent-flow@local>');
    // The repository's own `user.name` is `Temp`, so the identity really was
    // overridden rather than inherited.
    expect(object).not.toContain('Temp');

    const authored = run.repo.userGit(['log', '-1', '--format=%aI', head]).trim();
    expect(Date.parse(authored)).toBe(Date.parse(run.clock.now()));
  });

  it('fires no Git hook', async () => {
    // S-12. `--no-verify` covers none of this: it does not exist for
    // `worktree add`, and `pre-merge-commit` / `post-merge` are only partly
    // covered for some merge invocations. `core.hooksPath` covers all of it.
    run = await makeWorktreeRun();
    const sentinels = {
      preMergeCommit: run.repo.installSentinelHook('pre-merge-commit'),
      postMerge: run.repo.installSentinelHook('post-merge'),
      postCheckout: run.repo.installSentinelHook('post-checkout'),
      referenceTransaction: run.repo.installSentinelHook('reference-transaction'),
    };

    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);
    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    for (const [name, sentinel] of Object.entries(sentinels)) {
      expect(existsSync(sentinel), `${name} fired during integration`).toBe(false);
    }

    // The positive control: the same hooks, the same repository, a merge the
    // *user* issues. Without it, "the sentinel was not written" is green when the
    // hook is broken and when isolation works — two very different things.
    run.repo.userGit(['merge', '--no-ff', '--no-edit', '-m', 'the user merges', planted.marker]);
    expect(existsSync(sentinels.postMerge)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §14.3 step 5 — already integrated
// ---------------------------------------------------------------------------

describe('a marker already on the branch is not merged twice (§14.3 step 5)', () => {
  it('reconciles the task from the merge that already exists', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    const merges = run.repo
      .userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`])
      .trim();

    // §17.3 window 7, forced: the merge landed and the state write did not. The
    // file is rewritten directly rather than through `updateRun`, because
    // `completed → running` is a transition the state machine refuses — which is
    // exactly why the window is a crash and not something a caller can produce.
    rmSync(runPaths(run.repo.dir, run.runId).taskResult('TASK-001'));
    const statePath = runPaths(run.repo.dir, run.runId).state;
    const crashed = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          ...crashed,
          integrationHead: run.planningBase,
          tasks: [{ id: 'TASK-001', state: 'running', attempts: 1 }],
        },
        null,
        2,
      ),
    );

    const again = await run.integrator.integrate(waveOf(run, workspace, [planted]));

    expect(again.outcomes[0]?.kind).toBe('integrated');
    // No second merge, and the branch did not move.
    expect(
      run.repo
        .userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`])
        .trim(),
    ).toBe(merges);
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(head);

    // And the record was reconstructed from what Git already held.
    const state = await run.store.loadRun(run.runId);
    expect(state.integrationHead).toBe(head);
    expect(state.tasks[0]?.state).toBe('completed');

    const result = await run.store.readTaskResult(run.runId, 'TASK-001');
    expect(result?.integration?.mergeCommit).toBe(head);
    expect(result?.integration?.marker).toBe(planted.marker);

    // The reconstruction is structural, not "the marker turns up somewhere in
    // the ancestry" (§14.7): the commit it named has exactly two parents and the
    // second one is the marker.
    const parents = run.repo
      .userGit(['rev-list', '--parents', '-n', '1', result?.integration?.mergeCommit ?? ''])
      .trim()
      .split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(planted.marker);
  });

  it('refuses when the marker reached the branch without a merge', async () => {
    // Ancestry alone is not integration. A branch rebuilt linearly on top of a
    // marker contains it, and there is no merge commit to name — so §14.3 step 5
    // has nothing to reconcile from, and writing a `TaskResult` naming a merge
    // that does not exist would be the artifact lying about the repository.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    const linear = run.repo
      .userGit(['commit-tree', planted.validatedTree, '-p', planted.marker, '-m', 'rebuilt'])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${run.integrationBranch}`, linear]);

    const outcome = await run.integrator.integrate(waveOf(run, workspace, [planted]));
    const refused = outcome.outcomes[0];

    expect(refused?.kind).toBe('refused');
    expect(refused?.kind === 'refused' && refused.refusal.code).toBe(
      'integration_history_unrecognised',
    );
    expect(outcome.haltedBy).toContain('TASK-001');
    // Halted, not repaired: the branch is where it was and no result was written.
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(
      linear,
    );
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
    expect((await run.store.loadRun(run.runId)).tasks[0]?.state).not.toBe('completed');
  });

  it('refuses a commit that names the marker second among more than two parents', async () => {
    // "Two or more parents, one of which is second" is not the shape
    // `merge --no-ff <marker>` produces, and accepting it would give up the
    // property the whole branch is legible by: one task, one merge commit.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const decoy = run.repo
      .userGit(['commit-tree', planted.validatedTree, '-p', run.planningBase, '-m', 'a decoy'])
      .trim();
    const octopus = run.repo
      .userGit([
        'commit-tree',
        planted.validatedTree,
        '-p',
        run.planningBase,
        '-p',
        planted.marker,
        '-p',
        decoy,
        '-m',
        'agent-flow: integrate TASK-001 (attempt 1)',
      ])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${run.integrationBranch}`, octopus]);

    const outcome = await run.integrator.integrate(waveOf(run, workspace, [planted]));
    const refused = outcome.outcomes[0];

    expect(refused?.kind === 'refused' && refused.refusal.code).toBe(
      'integration_history_unrecognised',
    );
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
  });

  it('refuses a two-parent merge that carries the marker as its first parent', async () => {
    // The case the other two do not reach, and the one §14.7 is actually about.
    // Parent *count* is right, the marker is genuinely in the merge, and it is
    // still not the merge `merge --no-ff <marker>` produces: that command puts
    // the branch on the first parent and the thing being merged on the second.
    //
    // Order is the whole discriminator here. `merge --no-ff` run the other way
    // round — from the marker, merging the branch — produces exactly this shape,
    // and reconciling from it would record a `TaskResult` whose `mergeCommit`
    // merged the integration branch *into the task*, which is the opposite
    // direction of the one the branch is supposed to accumulate in.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const sibling = run.repo
      .userGit(['commit-tree', planted.validatedTree, '-p', run.planningBase, '-m', 'a sibling'])
      .trim();
    const inverted = run.repo
      .userGit([
        'commit-tree',
        planted.validatedTree,
        '-p',
        planted.marker,
        '-p',
        sibling,
        '-m',
        'agent-flow: integrate TASK-001 (attempt 1)',
      ])
      .trim();
    run.repo.userGit(['update-ref', `refs/heads/${run.integrationBranch}`, inverted]);

    const outcome = await run.integrator.integrate(waveOf(run, workspace, [planted]));
    const refused = outcome.outcomes[0];

    expect(refused?.kind).toBe('refused');
    expect(refused?.kind === 'refused' && refused.refusal.code).toBe(
      'integration_history_unrecognised',
    );
    // Which of the two paths that share this code fired, asserted rather than
    // assumed: `mergeIntroducing` filters on second-parent equality, so it finds
    // no candidate at all and never reaches the re-assertion behind it. Pinning
    // the sentence is what stops this test passing later for the wrong reason —
    // a loosened filter would still refuse, with the other detail.
    expect(refused?.kind === 'refused' && refused.refusal.detail).toContain(
      'no merge commit on that branch introduced it',
    );
    // Halted and untouched: no second merge was attempted over it, and nothing
    // was written that would make a later resume believe the task was integrated.
    expect(outcome.haltedBy).toContain('TASK-001');
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(
      inverted,
    );
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
    expect((await run.store.loadRun(run.runId)).tasks[0]?.state).not.toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// §15 — conflict
// ---------------------------------------------------------------------------

describe('a conflict halts the run and records why (§15)', () => {
  it('captures the paths, aborts, and leaves the branch where it was', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    // Two tasks writing different content to the same file, both cut from the
    // same base. Not a bug in the merge: a plan whose independence analysis was
    // wrong, and the run must say so rather than guess.
    const first = await run.plant('TASK-001', 1, { write: { 'README.md': 'from one\n' } });
    const second = await run.plant('TASK-002', 1, { write: { 'README.md': 'from two\n' } });

    const outcome = await run.integrator.integrate(waveOf(run, workspace, [first, second]));

    expect(outcome.outcomes[0]?.kind).toBe('integrated');
    const refused = outcome.outcomes[1];
    expect(refused?.kind).toBe('refused');
    expect(refused?.kind === 'refused' && refused.refusal.code).toBe('integration_conflict');
    expect(refused?.kind === 'refused' && refused.refusal.paths).toEqual(['README.md']);
    expect(refused?.state).toBe('review_required');
    expect(outcome.haltedBy).toContain('TASK-002');

    // The merge was aborted: the worktree is clean and mid-nothing.
    expect(run.repo.userGit(['status', '--porcelain=v1'], workspace.path).trim()).toBe('');
    expect(existsSync(join(workspace.path, '.git'))).toBe(true);
    expect(
      run.repo
        .userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`])
        .trim(),
    ).toBe('1');

    // §15's record, both halves.
    const event = (await run.store.readEvents(run.runId)).find(
      (entry) => entry.type === 'integration_conflict',
    );
    expect(event?.detail).toEqual({
      task: 'TASK-002',
      attempt: 1,
      paths: ['README.md'],
      previouslyIntegrated: 'TASK-001',
    });

    const result = await run.store.readTaskResult(run.runId, 'TASK-002');
    expect(result?.status).toBe('review_required');
    expect(result?.integration).toBeUndefined();
    const notes = (result?.notes ?? []).join('\n');
    expect(notes).toContain('README.md');
    expect(notes).toContain(second.base);
    expect(notes).toContain(second.marker);
    expect(notes).toContain('TASK-001');
  });

  it('resolves nothing by itself', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    const first = await run.plant('TASK-001', 1, { write: { 'README.md': 'from one\n' } });
    const second = await run.plant('TASK-002', 1, { write: { 'README.md': 'from two\n' } });

    await run.integrator.integrate(waveOf(run, workspace, [first, second]));

    // The integration tree holds the first task's content, untouched. No merged
    // hybrid, no conflict markers, no second attempt at another model.
    expect(readFileSync(join(workspace.path, 'README.md'), 'utf8')).toBe('from one\n');
    const state = await run.store.loadRun(run.runId);
    expect(state.tasks.find((task) => task.id === 'TASK-002')?.state).not.toBe('completed');
  });

  it('reports integration_worktree_unavailable when the abort fails', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    const current = run;
    const first = await current.plant('TASK-001', 1, { write: { 'README.md': 'from one\n' } });
    const second = await current.plant('TASK-002', 1, { write: { 'README.md': 'from two\n' } });

    // A real abort failure rather than a stubbed one: the merge conflicts for
    // real, and by the time `merge --abort` runs there is no worktree left to
    // run it in. Git's own refusal is what the Integrator sees.
    const sabotaging = new Integrator({
      workspaces: delegating(current.repo.workspaces, {
        abortMerge: async (options: { cwd: string }) => {
          rmSync(workspace.path, { recursive: true, force: true });
          return current.repo.workspaces.abortMerge(options);
        },
      }),
      fs: current.fs,
      host: current.host,
      projectDir: current.repo.dir,
      store: current.store,
      clock: current.clock,
    });

    const outcome = await sabotaging.integrate(waveOf(run, workspace, [first, second]));
    const refused = outcome.outcomes[1];

    expect(refused?.kind === 'refused' && refused.refusal.code).toBe(
      'integration_worktree_unavailable',
    );
    // Never forced: nothing pressed on after the worktree stopped being usable.
    expect(outcome.outcomes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §14.3 step 7, §14.4 — completion authority
// ---------------------------------------------------------------------------

describe('completion is the merge, recorded once (§14.3 step 7, §14.4, I-3)', () => {
  it('writes result.json only after the merge, with the integration block', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    // The attempt is validated, marked and on disk — and there is still no
    // `result.json`, because the task is not complete (§10.1).
    expect(existsSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1))).toBe(true);
    expect(await run.store.readTaskResult(run.runId, 'TASK-001')).toBeNull();
    expect((await run.store.loadRun(run.runId)).tasks[0]?.state).toBe('running');

    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    const result = await run.store.readTaskResult(run.runId, 'TASK-001');

    expect(result?.status).toBe('completed');
    expect(result?.integration).toEqual({
      attempt: 1,
      branch: run.integrationBranch,
      marker: planted.marker,
      mergeCommit: head,
      base: planted.base,
      validatedTree: planted.validatedTree,
      integratedAt: run.clock.now(),
    });
  });

  it('makes the merge, then the result, then completion — in that durable order', async () => {
    // §14.3 step 7 as an ordering over what is *on disk*:
    //
    //   git merge lands → result.json is durable → one state write completes the
    //                                              task and advances the head
    //
    // Every version of `state.json` is captured as it is written, together with
    // what the repository and the artifact directory held at that instant. Three
    // claims fall out of one recording, and each names a state that must never be
    // observable by a process that starts up afterwards:
    //
    //   - `completed` with the merge not in Git — the state asserting something
    //     the repository has not done;
    //   - `completed` with no `result.json` — a task recorded as done whose only
    //     record of what it produced does not exist;
    //   - `completed` without the head, or the head without `completed` — §17.3
    //     window 7 recreated on every merge.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });

    const current = run;
    const statePath = runPaths(current.repo.dir, current.runId).state;
    const resultPath = runPaths(current.repo.dir, current.runId).taskResult('TASK-001');

    const snapshots: {
      completed: boolean;
      head: string | undefined;
      resultOnDisk: boolean;
      mergeInGit: boolean;
    }[] = [];

    const watched = delegating(current.fs, {
      writeFileAtomic: async (target: string, contents: string) => {
        await current.fs.writeFileAtomic(target, contents);
        if (target !== statePath) return;
        const state = JSON.parse(contents) as {
          integrationHead?: string;
          tasks: { id: string; state: string }[];
        };
        snapshots.push({
          completed: state.tasks.some(
            (task) => task.id === 'TASK-001' && task.state === 'completed',
          ),
          head: state.integrationHead,
          resultOnDisk: existsSync(resultPath),
          mergeInGit:
            current.repo
              .userGit([
                'rev-list',
                '--count',
                '--merges',
                `refs/heads/${current.integrationBranch}`,
              ])
              .trim() === '1',
        });
      },
    });

    const watching = new Integrator({
      workspaces: run.repo.workspaces,
      fs: watched,
      host: run.host,
      projectDir: run.repo.dir,
      store: new StateStore({ fs: watched, clock: run.clock, projectDir: run.repo.dir }),
      clock: run.clock,
    });

    await watching.integrate(waveOf(run, workspace, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();

    // **One state write for the whole integration**, which is the atomicity claim
    // stated as a count: there is no intermediate version to observe, because
    // there is no intermediate version.
    expect(snapshots).toHaveLength(1);

    const [landing] = snapshots;
    expect(landing?.completed).toBe(true);
    expect(landing?.mergeInGit, 'the state completed a task Git had not merged').toBe(true);
    expect(landing?.resultOnDisk, 'the state completed a task with no result.json').toBe(true);
    expect(landing?.head, 'the state completed a task without advancing the head').toBe(head);

    // And the recording is real: the same watcher saw `result.json` written, so
    // "it was already there" is a fact about ordering rather than about a file
    // this test never looked for.
    expect(existsSync(resultPath)).toBe(true);
    expect((await run.store.readTaskResult(run.runId, 'TASK-001'))?.integration?.mergeCommit).toBe(
      head,
    );
  });

  it('records task_integrated with the marker and the merge', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [planted]));

    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();
    const event = (await run.store.readEvents(run.runId)).find(
      (entry) => entry.type === 'task_integrated',
    );

    expect(event?.detail).toEqual({
      task: 'TASK-001',
      attempt: 1,
      marker: planted.marker,
      mergeCommit: head,
    });
  });

  it('leaves the user’s working tree byte-for-byte unchanged (§19.3, I-10)', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    const before = {
      head: run.repo.userGit(['rev-parse', 'HEAD']).trim(),
      branch: run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      status: run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all']),
      index: run.repo.userGit(['ls-files', '--stage']),
      readme: readFileSync(join(run.repo.dir, 'README.md'), 'utf8'),
    };

    const first = await run.plant('TASK-001', 1, { write: { 'README.md': 'rewritten\n' } });
    const second = await run.plant('TASK-002', 1, { write: { 'new.txt': 'new\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [first, second]));

    expect(run.repo.userGit(['rev-parse', 'HEAD']).trim()).toBe(before.head);
    expect(run.repo.userGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(before.branch);
    expect(run.repo.userGit(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
      before.status,
    );
    expect(run.repo.userGit(['ls-files', '--stage'])).toBe(before.index);
    expect(readFileSync(join(run.repo.dir, 'README.md'), 'utf8')).toBe(before.readme);
    // The work is on the branch, which is the product — and nowhere else.
    expect(existsSync(join(run.repo.dir, 'new.txt'))).toBe(false);
    expect(
      run.repo.userGit(['show', `refs/heads/${run.integrationBranch}:new.txt`]).trim(),
    ).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// M2-07 seams — §17.3 windows 6 and 7
// ---------------------------------------------------------------------------

describe('an attempt offered without a TaskResult (§17.3 window 7)', () => {
  it('produces the same result.json the executor’s own would have', async () => {
    // The equivalence the recovery path rests on: a recovered attempt has no
    // `TaskResult` in memory, so the Integrator reconstructs one from the
    // artifact. If the two disagreed, a crash would change what a task's record
    // says about what ran — which is exactly the fiction §26.1 keeps out of that
    // file.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001']);

    const planted = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [planted]));
    const withExecutorResult = await run.store.readTaskResult(run.runId, 'TASK-001');

    // Now the same attempt, reconciled from the artifact alone. The merge is
    // already on the branch, so this exercises the reconstruction rather than a
    // second merge.
    rmSync(runPaths(run.repo.dir, run.runId).taskResult('TASK-001'));
    const statePath = runPaths(run.repo.dir, run.runId).state;
    const crashed = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      statePath,
      JSON.stringify(
        { ...crashed, tasks: [{ id: 'TASK-001', state: 'running', attempts: 1 }] },
        null,
        2,
      ),
    );

    const again = await run.integrator.integrate({
      runId: run.runId,
      workspace,
      dag: run.dag([{ id: 'TASK-001' }]),
      // No `result`: this is what recovery offers.
      attempts: [{ task: 'TASK-001', attempt: 1 }],
    });

    expect(again.outcomes[0]?.kind).toBe('integrated');
    const reconstructed = await run.store.readTaskResult(run.runId, 'TASK-001');

    // Every field the executor recorded, read back out of the artifact.
    expect(reconstructed?.status).toBe('completed');
    // Asserted against the artifact rather than against the pre-crash file: where
    // the two differ, the artifact is the better source, because it records what
    // the agent actually changed. The fixture's synthetic `TaskResult` carries no
    // `filesChanged`, and pinning to it would pin to the fixture's omission.
    const evidence = JSON.parse(
      readFileSync(runPaths(run.repo.dir, run.runId).taskAttempt('TASK-001', 1), 'utf8'),
    ) as { filesChanged: string[]; validation: { expectation: string } };
    expect(reconstructed?.filesChanged).toEqual(evidence.filesChanged);
    expect(reconstructed?.validation.expectation).toBe(evidence.validation.expectation);
    expect(reconstructed?.runner).toBe(withExecutorResult?.runner);
    expect(reconstructed?.reasoning).toBe(withExecutorResult?.reasoning);
    expect(reconstructed?.startedAt).toBe(withExecutorResult?.startedAt);
    expect(reconstructed?.finishedAt).toBe(withExecutorResult?.finishedAt);
    expect(reconstructed?.validation).toEqual(withExecutorResult?.validation);
    expect(reconstructed?.integration).toEqual(withExecutorResult?.integration);
  });

  it('does not accumulate conflict notes across repeated attempts', async () => {
    // Reconstructing rather than reading `result.json` back is what makes a
    // repeated conflict idempotent. `abortConflict` appends to `notes`, so a path
    // that fed the previous file in would grow the same sentences every pass —
    // and a person reading the task would see five copies of one conflict.
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    const first = await run.plant('TASK-001', 1, { write: { 'shared.txt': 'from one\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [first]));

    await run.plant('TASK-002', 1, { write: { 'shared.txt': 'from two\n' } });
    const conflicting = {
      runId: run.runId,
      workspace,
      dag: run.dag([{ id: 'TASK-002' }]),
      attempts: [{ task: 'TASK-002', attempt: 1 }],
    };

    await run.integrator.integrate(conflicting);
    const once = await run.store.readTaskResult(run.runId, 'TASK-002');

    await run.integrator.integrate(conflicting);
    const twice = await run.store.readTaskResult(run.runId, 'TASK-002');

    expect(once?.status).toBe('review_required');
    expect(twice?.notes).toEqual(once?.notes);
  });
});

describe('clearing an interrupted merge (§17.3 window 6)', () => {
  it('reports that there was nothing to abort, which is not a failure', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);

    const cleared = await run.integrator.clearInterruptedMerge(workspace);

    expect(cleared.ok).toBe(true);
    expect(cleared.ok && cleared.aborted).toBe(false);
  });

  it('aborts a merge a dead process left behind, and leaves the branch where it was', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    const first = await run.plant('TASK-001', 1, { write: { 'shared.txt': 'from one\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [first]));
    const head = run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim();

    const second = await run.plant('TASK-002', 1, { write: { 'shared.txt': 'from two\n' } });
    // A genuinely interrupted merge, left exactly as a dead process leaves one:
    // the real adapter issues the merge, it conflicts, and nothing aborts it. The
    // adapter is used rather than `userGit` because a conflicted merge exits 1 and
    // `execFileSync` would throw on it — the adapter is the layer that knows exit
    // 1 here is an outcome rather than an error.
    await leaveMidMerge(run, workspace, second.marker);
    const before = await run.repo.workspaces.mergeHead({ cwd: workspace.path });
    expect(before.ok && before.value).toBe(second.marker);

    const cleared = await run.integrator.clearInterruptedMerge(workspace);

    expect(cleared.ok).toBe(true);
    expect(cleared.ok && cleared.aborted).toBe(true);
    // Back to the last consistent state: the branch did not move and the
    // worktree is clean, so the next integration starts from a known tree.
    expect(run.repo.userGit(['rev-parse', `refs/heads/${run.integrationBranch}`]).trim()).toBe(head);
    expect(run.repo.userGit(['status', '--porcelain=v1'], workspace.path).trim()).toBe('');
  });

  it('refuses rather than forcing when the abort itself fails', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    const first = await run.plant('TASK-001', 1, { write: { 'shared.txt': 'from one\n' } });
    await run.integrator.integrate(waveOf(run, workspace, [first]));
    const second = await run.plant('TASK-002', 1, { write: { 'shared.txt': 'from two\n' } });
    await leaveMidMerge(run, workspace, second.marker);

    const failing = new Integrator({
      workspaces: delegating(run.repo.workspaces, {
        abortMerge: async () => ({
          ok: false as const,
          failure: { code: 'git_command_failed' as const, message: 'refused' },
        }),
      }),
      fs: run.fs,
      host: run.host,
      projectDir: run.repo.dir,
      store: run.store,
      clock: run.clock,
    });

    const cleared = await failing.clearInterruptedMerge(workspace);

    expect(cleared.ok).toBe(false);
    if (cleared.ok) return;
    expect(cleared.refusal.code).toBe('integration_worktree_unavailable');
    // Nothing was reset over: the merge is still there for a person to look at.
    const still = await run.repo.workspaces.mergeHead({ cwd: workspace.path });
    expect(still.ok && still.value).toBe(second.marker);
  });

  it('reports unreadable rather than aborting when MERGE_HEAD cannot be asked about', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);

    const aborts: number[] = [];
    const blind = new Integrator({
      workspaces: delegating(run.repo.workspaces, {
        mergeHead: async () => ({
          ok: false as const,
          failure: { code: 'git_command_failed' as const, message: 'unreadable' },
        }),
        abortMerge: async () => {
          aborts.push(1);
          return { ok: true as const, value: undefined };
        },
      }),
      fs: run.fs,
      host: run.host,
      projectDir: run.repo.dir,
      store: run.store,
      clock: run.clock,
    });

    const cleared = await blind.clearInterruptedMerge(workspace);

    expect(cleared.ok).toBe(false);
    if (cleared.ok) return;
    expect(cleared.refusal.code).toBe('integration_unreadable');
    // And it did not abort on the strength of an answer it never got.
    expect(aborts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §18.2 — the in-process mutex
// ---------------------------------------------------------------------------

describe('integration is serial within the process (§18.2)', () => {
  it('never interleaves two waves', async () => {
    run = await makeWorktreeRun();
    const workspace = await readyWorkspace(run);
    await run.seed(['TASK-001', 'TASK-002']);

    const first = await run.plant('TASK-001', 1, { write: { 'a.txt': 'a\n' } });
    const second = await run.plant('TASK-002', 1, { write: { 'b.txt': 'b\n' } });

    const [left, right] = await Promise.all([
      run.integrator.integrate(waveOf(run, workspace, [first])),
      run.integrator.integrate(waveOf(run, workspace, [second])),
    ]);

    expect(left.outcomes[0]?.kind).toBe('integrated');
    expect(right.outcomes[0]?.kind).toBe('integrated');

    // Two merges, in sequence, on one branch — not one overwriting the other and
    // not a merge attempted while the worktree was mid-merge.
    expect(
      run.repo
        .userGit(['rev-list', '--count', '--merges', `refs/heads/${run.integrationBranch}`])
        .trim(),
    ).toBe('2');
    expect(run.repo.userGit(['status', '--porcelain=v1'], workspace.path).trim()).toBe('');
    expect(existsSync(join(workspace.path, 'a.txt'))).toBe(true);
    expect(existsSync(join(workspace.path, 'b.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('TaskResult.integration (§10.3)', () => {
  it('is optional, so a sequential result parses without it', () => {
    const result = TaskResultSchema.parse({
      task: 'TASK-001',
      status: 'completed',
      runner: 'fake',
      reasoning: 'medium',
      startedAt: '2026-08-09T19:59:00.000Z',
      finishedAt: '2026-08-09T20:00:00.000Z',
      validation: { passed: true, commands: [] },
    });

    expect(result.integration).toBeUndefined();
  });

  it('refuses an abbreviated object id', () => {
    const parsed = TaskResultSchema.safeParse({
      task: 'TASK-001',
      status: 'completed',
      runner: 'fake',
      reasoning: 'medium',
      startedAt: '2026-08-09T19:59:00.000Z',
      finishedAt: '2026-08-09T20:00:00.000Z',
      validation: { passed: true, commands: [] },
      integration: {
        attempt: 1,
        branch: 'agent-flow/AF-2026-001-0f3a91c4bd27e615/integration',
        marker: '3c8f1a2',
        mergeCommit: 'a'.repeat(40),
        base: 'b'.repeat(40),
        validatedTree: 'c'.repeat(40),
        integratedAt: '2026-08-09T20:00:00.000Z',
      },
    });

    expect(parsed.success).toBe(false);
  });
});
