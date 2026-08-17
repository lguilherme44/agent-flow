import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { TaskWorkspaces } from '../../src/app/task-workspaces.js';
import type { EffectiveConfig, RunState } from '../../src/contracts/index.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * M2-04 §8: an attempt gets a prepared, verified-clean worktree, or it does not
 * run.
 *
 * Real Git and a real filesystem throughout. The failures this guards against —
 * a checkout born dirty, an install that rewrites a lockfile — are properties of
 * Git and of the project's own tooling, and a fake would agree with whatever the
 * implementation believed.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const RUN_KEY = 'AF-2026-001-0f3a91c4bd27e615';

function isolatedRun(base: string): RunState {
  return {
    runId: 'AF-2026-001',
    feature: 'f',
    stage: 'implementation',
    status: 'running',
    approved: true,
    degradations: [],
    tasks: [{ id: 'TASK-001', state: 'running', attempts: 1, infrastructureFailures: 0 }],
    isolationMode: 'worktree',
    planningBase: base,
    gitRunKey: RUN_KEY,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as RunState;
}

function sequentialRun(): RunState {
  return { ...isolatedRun('a'.repeat(40)), isolationMode: 'none' } as RunState;
}

function workspacesFor(temp: TempRepo, install?: string): TaskWorkspaces {
  const config = {
    global: {},
    ...(install === undefined ? {} : { project: { commands: { install } } }),
  } as unknown as EffectiveConfig;

  return new TaskWorkspaces({
    workspaces: temp.workspaces,
    fs: new NodeFileSystem(),
    host: new FakeHost(1000, 'test-host', [1000], temp.home),
    projectDir: temp.dir,
    processRunner: new NodeProcessRunner(),
    config,
    clock: new FixedClock(),
  });
}

describe('a fresh worktree (§8.1, §8.2)', () => {
  it('is created, locked, on its own branch, at the wave base', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo).prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const workspace = outcome.workspace;
    expect(existsSync(join(workspace.path, 'README.md'))).toBe(true);
    expect(workspace.isolation?.branch).toBe(`agent-flow/${RUN_KEY}/TASK-001/attempt-1`);
    expect(workspace.isolation?.base).toBe(base);

    // Locked according to **Git**, not according to an object we built.
    const listed = repo.userGit(['worktree', 'list', '--porcelain']);
    expect(listed).toContain(workspace.path);
    const record = listed.split('\n\n').find((block) => block.includes(workspace.path)) ?? '';
    expect(record).toContain('locked agent-flow');
    expect(record).toContain(`refs/heads/agent-flow/${RUN_KEY}/TASK-001/attempt-1`);

    // The branch really is at the base it was asked for.
    expect(repo.userGit(['rev-parse', String(workspace.isolation?.branch)]).trim()).toBe(base);
  });

  it('is clean, so the agent may run', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo).prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const status = await repo.workspaces.status({ cwd: outcome.workspace.path });
    expect(status.ok && status.value.clean).toBe(true);
  });

  it('records only a workspace-relative path, never an absolute one (§7.2)', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo).prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 2,
      base,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.isolation?.relativePath).toBe(
      `${outcome.workspace.path.split('/worktrees/')[1] ?? ''}`,
    );
    expect(outcome.workspace.isolation?.relativePath.startsWith('/')).toBe(false);
    expect(outcome.workspace.isolation?.relativePath).toContain(`${RUN_KEY}/TASK-001/attempt-2`);
  });

  it('puts the workspace under the owned root and nowhere else (S-3)', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo).prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.path.startsWith(`${repo.worktreeRoot}/`)).toBe(true);
    // And Git agrees it is ours, judged on the resolved location (S-4).
    const owned = await repo.workspaces.ownWorktrees({ cwd: repo.dir });
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value.map((entry) => entry.path)).toContain(outcome.workspace.path);
  });
});

describe('the install, and what it may leave behind (§8.2, §8.3)', () => {
  it('passes when the install produces only ignored artifacts', async () => {
    // The whole reason ignored files do not count: `node_modules/` is exactly
    // what setup is supposed to produce.
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', 'node_modules/\n');
    repo.commitAll('ignore install output');
    const base = repo.head();

    const outcome = await workspacesFor(
      repo,
      'mkdir -p node_modules && echo installed > node_modules/marker',
    ).prepare({ state: isolatedRun(base), taskId: 'TASK-001', attempt: 1, base });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(existsSync(join(outcome.workspace.path, 'node_modules', 'marker'))).toBe(true);
  });

  it('refuses with phase "setup" when the install rewrites a tracked file', async () => {
    // The §8.4 wall, reproduced: an install that edits a lockfile.
    repo = await makeTempRepoWithCommit();
    repo.write('package-lock.json', '{"lockfileVersion":3}\n');
    repo.commitAll('a lockfile');
    const base = repo.head();

    const outcome = await workspacesFor(
      repo,
      'echo "{\\"lockfileVersion\\":3,\\"rewritten\\":true}" > package-lock.json',
    ).prepare({ state: isolatedRun(base), taskId: 'TASK-001', attempt: 1, base });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('task_workspace_preparation_failed');
    expect(outcome.failure.phase).toBe('setup');
    expect(outcome.failure.changes).toContain('package-lock.json');
  });

  it('refuses when the install produces an untracked, non-ignored file', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo, 'echo generated > generated.ts').prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.phase).toBe('setup');
    expect(outcome.failure.changes).toContain('generated.ts');
  });

  it('refuses when the install command itself fails', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo, 'exit 7').prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.phase).toBe('setup');
  });

  it('runs the install in the workspace, not in the project directory', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', 'where-am-i\n');
    repo.commitAll('ignore the probe output');
    const base = repo.head();

    const outcome = await workspacesFor(repo, 'pwd > where-am-i').prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The marker exists in the worktree and not in the project.
    expect(existsSync(join(outcome.workspace.path, 'where-am-i'))).toBe(true);
    expect(existsSync(join(repo.dir, 'where-am-i'))).toBe(false);
  });

  it('skips the install entirely when none is configured', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo).prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(true);
  });
});

describe('a checkout born dirty (§8.3, phase "checkout")', () => {
  it('refuses before the install runs', async () => {
    // `.gitattributes` with a filter that rewrites content on checkout: the file
    // in the working tree no longer matches the index, so a *fresh* checkout is
    // dirty. This is the case the two assertions exist separately for.
    repo = await makeTempRepoWithCommit();
    repo.write('.gitattributes', '*.txt filter=dirtier\n');
    repo.write('content.txt', 'original\n');
    repo.commitAll('a filtered file');
    // Configured after the commit so the index holds the unfiltered content.
    repo.userGit(['config', 'filter.dirtier.smudge', 'sed s/original/smudged/']);
    repo.userGit(['config', 'filter.dirtier.clean', 'cat']);
    const base = repo.head();

    const marker = join(repo.home, 'install-ran');
    const outcome = await workspacesFor(repo, `touch ${marker}`).prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.phase).toBe('checkout');
    expect(outcome.failure.changes).toContain('content.txt');
    // The install never ran: `checkout` refuses before it is reached.
    expect(existsSync(marker)).toBe(false);
  });
});

describe('a refusal names no absolute path, in any field (§7.2, §21.3)', () => {
  // The reason this is its own block rather than an assertion inside the cases
  // above: every one of these refusals is persisted to `events.jsonl` and reaches
  // an HTTP response, and the natural implementation of each one leaks. Git's
  // text for a failed `worktree add` names the path it tried to create; `git
  // status`'s failure names the directory it could not read; and `npm` prints its
  // working directory on almost every error. So the guarantee is asserted per
  // failure path, not once.

  /** Every field a refusal carries, flattened the way the event serialises it. */
  function serialise(failure: {
    phase: string;
    changes: readonly string[];
    detail: string;
  }): string {
    return JSON.stringify(failure);
  }

  it('says the install exited non-zero without quoting its output', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    // `pwd` puts the absolute worktree path on stdout, which is the shortest
    // route from a failing install to a path in `events.jsonl`.
    const outcome = await workspacesFor(repo, 'pwd && exit 3').prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(serialise(outcome.failure)).not.toContain(repo.worktreeRoot);
    expect(serialise(outcome.failure)).not.toContain(repo.home);
    // Still useful: the exit status is what points a person at `doctor`.
    expect(outcome.failure.detail).toContain('3');
  });

  it('reports a dirty setup by path relative to the repository, and bounded', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(
      repo,
      'for i in $(seq 1 25); do echo x > generated-$i.ts; done',
    ).prepare({ state: isolatedRun(base), taskId: 'TASK-001', attempt: 1, base });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(serialise(outcome.failure)).not.toContain(repo.worktreeRoot);
    for (const change of outcome.failure.changes) expect(change.startsWith('/')).toBe(false);
    // Bounded, so one bad install cannot write an unbounded event.
    expect(outcome.failure.changes.length).toBeLessThanOrEqual(10);
    expect(outcome.failure.changes.length).toBeGreaterThan(0);
  });

  it('says the workspace could not be created without naming where', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const service = workspacesFor(repo);
    const request = { state: isolatedRun(base), taskId: 'TASK-001', attempt: 1, base } as const;

    expect((await service.prepare(request)).ok).toBe(true);
    // The same attempt twice: the branch and the directory both already exist, so
    // Git refuses — and its refusal names the path.
    const again = await service.prepare(request);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(serialise(again.failure)).not.toContain(repo.worktreeRoot);
    expect(again.failure.phase).toBe('checkout');
  });

  it('says the workspace could not be inspected without naming it', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const root = repo.worktreeRoot;
    const blind = new Proxy(repo.workspaces, {
      get(target, property, receiver) {
        if (property === 'status') {
          return async () => ({
            ok: false as const,
            // A message shaped like the real one: Git names the directory.
            failure: { code: 'git_failed' as const, message: `fatal: cannot read ${root}/x` },
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const outcome = await new TaskWorkspaces({
      workspaces: blind,
      fs: new NodeFileSystem(),
      host: new FakeHost(1000, 'test-host', [1000], repo.home),
      projectDir: repo.dir,
      processRunner: new NodeProcessRunner(),
      config: { global: {} } as unknown as EffectiveConfig,
      clock: new FixedClock(),
    }).prepare({ state: isolatedRun(base), taskId: 'TASK-001', attempt: 1, base });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(serialise(outcome.failure)).not.toContain(root);
    expect(outcome.failure.detail).toContain('git_failed');
  });
});

describe('the wave base is re-validated before it reaches argv (S-2)', () => {
  // The base is composed into a `git worktree add` argv, so "the caller passed a
  // commit" is not a property this module can see. Every one of these would
  // otherwise be handed to Git, and Git's answer would be reported as though the
  // repository were at fault.
  for (const [label, base] of [
    ['absent', undefined],
    ['empty', ''],
    ['a branch name', 'main'],
    ['a short id', 'abc1234'],
    ['uppercase hex', 'A'.repeat(40)],
    ['an option', '--upload-pack=touch /tmp/pwned'],
    ['a range', 'HEAD~1..HEAD'],
  ] as const) {
    it(`refuses ${label}`, async () => {
      repo = await makeTempRepoWithCommit();

      const outcome = await workspacesFor(repo).prepare({
        state: isolatedRun(repo.head()),
        taskId: 'TASK-001',
        attempt: 1,
        base,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure.phase).toBe('checkout');
      expect(outcome.failure.detail).toContain('not a Git commit id');
      // Nothing was created on the way to the refusal.
      expect(repo.userGit(['worktree', 'list', '--porcelain'])).not.toContain('TASK-001');
    });
  }
});

describe('a failed preparation retains its evidence (§7.4)', () => {
  it('leaves the worktree registered and still locked', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();

    const outcome = await workspacesFor(repo, 'echo generated > generated.ts').prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(false);

    // A retained worktree is the only remaining copy of what preparation
    // produced; deleting it to save disk would delete the evidence.
    const listed = repo.userGit(['worktree', 'list', '--porcelain']);
    const record = listed.split('\n\n').find((block) => block.includes('TASK-001')) ?? '';
    expect(record).not.toBe('');
    expect(record).toContain('locked agent-flow');
    // And the branch survives too.
    expect(
      repo.userGit(['rev-parse', `agent-flow/${RUN_KEY}/TASK-001/attempt-1`]).trim(),
    ).toBe(base);
  });
});

describe('sequential mode is unchanged (§25)', () => {
  it('hands back the project directory and asks Git nothing', async () => {
    repo = await makeTempRepoWithCommit();
    let touched = false;
    const watching = new Proxy(repo.workspaces, {
      get(target, property, receiver) {
        touched = true;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const service = new TaskWorkspaces({
      workspaces: watching,
      fs: new NodeFileSystem(),
      host: new FakeHost(1000, 'test-host', [1000], repo.home),
      projectDir: repo.dir,
      processRunner: new NodeProcessRunner(),
      config: { global: {} } as unknown as EffectiveConfig,
      clock: new FixedClock(),
    });

    const outcome = await service.prepare({
      state: sequentialRun(),
      taskId: 'TASK-001',
      attempt: 1,
      base: repo.head(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.path).toBe(repo.dir);
    expect(outcome.workspace.isolation).toBeUndefined();
    expect(touched).toBe(false);
    // No worktree was created for it.
    expect(repo.userGit(['worktree', 'list', '--porcelain']).split('worktree ').length - 1).toBe(1);
  });

  it('does the same for a legacy run, whose mode is absent rather than none', async () => {
    repo = await makeTempRepoWithCommit();
    const legacy = { ...sequentialRun(), isolationMode: undefined } as RunState;

    const outcome = await workspacesFor(repo).prepare({
      state: legacy,
      taskId: 'TASK-001',
      attempt: 1,
      base: repo.head(),
    });

    expect(outcome.ok && outcome.workspace.path).toBe(repo.dir);
  });

  it('runs no install in sequential mode, even when one is configured', async () => {
    // The install belongs to workspace preparation, and a sequential run has no
    // workspace to prepare. Running it in the user's tree would be a behaviour
    // change §25 forbids.
    repo = await makeTempRepoWithCommit();
    const marker = join(repo.home, 'sequential-install-ran');

    await workspacesFor(repo, `touch ${marker}`).prepare({
      state: sequentialRun(),
      taskId: 'TASK-001',
      attempt: 1,
      base: repo.head(),
    });

    expect(existsSync(marker)).toBe(false);
  });
});

describe('what cannot be measured is not clean', () => {
  it('refuses when the status cannot be read', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    const blind = new Proxy(repo.workspaces, {
      get(target, property, receiver) {
        if (property === 'status') {
          return async () => ({
            ok: false as const,
            failure: { code: 'git_timed_out' as const, message: 'git status exceeded its timeout' },
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const service = new TaskWorkspaces({
      workspaces: blind,
      fs: new NodeFileSystem(),
      host: new FakeHost(1000, 'test-host', [1000], repo.home),
      projectDir: repo.dir,
      processRunner: new NodeProcessRunner(),
      config: { global: {} } as unknown as EffectiveConfig,
      clock: new FixedClock(),
    });

    const outcome = await service.prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    // "I could not measure it" is not "it is clean". Failing open here would
    // invoke an agent in a workspace nobody verified.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.phase).toBe('checkout');
  });
});

describe('nothing here creates a marker or a commit (M2-05 boundary)', () => {
  it('leaves the attempt branch exactly at its base', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', 'node_modules/\n');
    repo.commitAll('ignore install output');
    const base = repo.head();

    const outcome = await workspacesFor(repo, 'mkdir -p node_modules').prepare({
      state: isolatedRun(base),
      taskId: 'TASK-001',
      attempt: 1,
      base,
    });

    expect(outcome.ok).toBe(true);
    // No commit-tree, no marker, no ref moved: the branch is still the base.
    expect(
      repo.userGit(['rev-parse', `agent-flow/${RUN_KEY}/TASK-001/attempt-1`]).trim(),
    ).toBe(base);
    expect(repo.userGit(['rev-list', '--count', base]).trim()).toBe(
      repo.userGit(['rev-list', '--count', `agent-flow/${RUN_KEY}/TASK-001/attempt-1`]).trim(),
    );
  });
});

describe('the run directory is untouched by preparation', () => {
  it('writes nothing into the project working tree', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', 'node_modules/\n');
    repo.commitAll('ignore install output');
    const base = repo.head();
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    writeFileSync(join(repo.dir, 'src', 'app.ts'), 'export {};\n');
    repo.commitAll('some source');
    const before = repo.userGit(['status', '--porcelain=v1']).trim();

    await workspacesFor(repo, 'mkdir -p node_modules').prepare({
      state: isolatedRun(repo.head()),
      taskId: 'TASK-001',
      attempt: 1,
      base: repo.head(),
    });

    // I-10: the tree Agent Flow was started from is unchanged.
    expect(repo.userGit(['status', '--porcelain=v1']).trim()).toBe(before);
    expect(base).not.toBe('');
  });
});
