import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { StateStore, StateError } from '../../src/app/state-store.js';
import {
  checkWorktreePreconditions,
  composeRunIdentity,
  decideNamespace,
  projectWorstCaseWorktreePath,
  describeIsolation,
  observePlanningBaseDrift,
  resolveRunGitIdentity,
} from '../../src/app/run-git-identity.js';
import {
  MAX_SUPPORTED_ATTEMPT,
  repoKeyFromCanonicalRoot,
} from '../../src/core/worktree-policy.js';
import { createHash } from 'node:crypto';
import { PATH_LIMITS } from '../../src/adapters/host/node-host.js';
import type { EffectiveConfig } from '../../src/contracts/index.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * M2-03: a run is **born** with its Git identity, and nothing later changes it.
 *
 * The tests that matter here are behavioural and against real Git, because the
 * defect this milestone exists to prevent is not a wrong branch of an `if` — it
 * is a run whose execution strategy quietly changed because a YAML file did.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const PROJECT = '/repo';

function configWith(useWorktrees: boolean): EffectiveConfig {
  return { global: { git: { useWorktrees } } } as unknown as EffectiveConfig;
}

/** Deps pointing at a real temporary repository. */
function depsFor(temp: TempRepo, useWorktrees: boolean) {
  return {
    workspaces: temp.workspaces,
    fs: new NodeFileSystem(),
    host: new FakeHost(1000, 'test-host', [1000], temp.home),
    config: configWith(useWorktrees),
    projectDir: temp.dir,
  };
}

/**
 * The real adapter with one method replaced.
 *
 * A spread would not work: `GitWorkspaces` methods live on the prototype, so
 * `{ ...workspaces, probe }` produces an object with the override and none of
 * the rest. A proxy keeps every other answer genuinely real, which is the point
 * — the refusal under test has to be attributable to the one thing that changed.
 */
function workspacesWith(
  temp: TempRepo,
  overrides: Record<string, unknown>,
): TempRepo['workspaces'] {
  return new Proxy(temp.workspaces, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as string];
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The real filesystem with one method replaced, for the same reason
 * {@link workspacesWith} exists: `NodeFileSystem`'s methods live on the
 * prototype, so a spread produces an object with the override and none of the
 * rest.
 */
function fsWith(overrides: Record<string, unknown>): NodeFileSystem {
  return new Proxy(new NodeFileSystem(), {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as string];
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The `repoKey` the preconditions will derive for this repository.
 *
 * The boundary cases need the *exact* projection, and the repository key is the
 * one term a test cannot guess: it is a slug of the temporary directory's name
 * plus twelve hex characters of its hash. Derived the same way production does —
 * realpath of the parent of the common directory, hashed verbatim (§5.1).
 */
async function deriveRepoKeyOf(temp: TempRepo): Promise<string | null> {
  const commonDir = await temp.workspaces.commonDir(temp.dir);
  if (!commonDir.ok) return null;

  const parent = commonDir.value.replace(/[\\/][^\\/]*$/, '');
  const canonical = await new NodeFileSystem().realPath(parent);
  if (canonical === null) return null;

  const digest = createHash('sha256').update(canonical).digest('hex');
  const key = repoKeyFromCanonicalRoot(canonical, digest);
  return key.ok ? key.value : null;
}

function storeIn(fs: InMemoryFileSystem): StateStore {
  return new StateStore({ fs, clock: new FixedClock(), projectDir: PROJECT });
}

describe('what a new run is born with (§6.1)', () => {
  it('is sequential, with a base, when worktrees are off', async () => {
    repo = await makeTempRepoWithCommit();

    const resolved = await resolveRunGitIdentity(depsFor(repo, false));

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.isolationMode).toBe('none');
    // Captured in either mode: §6.2's observational gates compare against it.
    expect(resolved.value.planningBase).toBe(repo.head());
  });

  it('is isolated, with a base, when worktrees are on', async () => {
    repo = await makeTempRepoWithCommit();

    const resolved = await resolveRunGitIdentity(depsFor(repo, true));

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.isolationMode).toBe('worktree');
    expect(resolved.value.planningBase).toBe(repo.head());
  });

  it('records the full object id, never a branch name or an abbreviation', async () => {
    repo = await makeTempRepoWithCommit();

    const resolved = await resolveRunGitIdentity(depsFor(repo, true));

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // A run must guard the exact commit: a branch name moves, and an
    // abbreviation is only unique in the repository that produced it.
    expect(resolved.value.planningBase).toMatch(/^[0-9a-f]{40}$/);
    expect(resolved.value.planningBase).not.toBe('HEAD');
    expect(resolved.value.planningBase).not.toBe('main');
  });

  it('asks Git nothing that could refuse a sequential run in a plain directory', async () => {
    // §25: Agent Flow has always run where there is no repository, and a
    // milestone about worktrees must not break that.
    const fs = new InMemoryFileSystem();
    repo = await makeTempRepoWithCommit();

    // A directory that exists and is not a repository — the real case. A
    // non-existent path would fail the spawn instead, which is a different
    // answer (`git_unavailable`) and not the one under test.
    const resolved = await resolveRunGitIdentity({
      ...depsFor(repo, false),
      fs,
      projectDir: repo.home,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.isolationMode).toBe('none');
    // The honest value: absent, rather than invented.
    expect(resolved.value.planningBase).toBeUndefined();
  });

  it('refuses an isolated run in a directory that is not a repository', async () => {
    repo = await makeTempRepoWithCommit();

    const resolved = await resolveRunGitIdentity({
      ...depsFor(repo, true),
      projectDir: repo.home,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.refusal.code).toBe('not_a_git_repository');
  });

  it('refuses an isolated run in a repository with no commits, at creation', async () => {
    // §6.1: refused before discovery, planning and a plan review have been paid
    // for — the checks are facts no user action during the run would change.
    repo = await makeTempRepoWithCommit();
    const empty = await makeTempRepoWithCommit();
    empty.userGit(['checkout', '--quiet', '--orphan', 'nothing-yet']);
    empty.userGit(['rm', '-rf', '--cached', '.']);

    const resolved = await resolveRunGitIdentity({
      ...depsFor(empty, true),
      projectDir: empty.dir,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.refusal.code).toBe('repository_has_no_commits');
    empty.cleanup();
  });
});

describe('gitRunKey (§5.2)', () => {
  it('is the run id and sixteen hex characters', () => {
    const fields = composeRunIdentity('AF-2026-001', {
      isolationMode: 'worktree',
      planningBase: 'a'.repeat(40),
      entropyHex: 'a93f085c23dd9321',
    });

    expect(fields.gitRunKey).toBe('AF-2026-001-a93f085c23dd9321');
    expect(fields.gitRunKey).toMatch(/^AF-\d{4}-\d{3}-[0-9a-f]{16}$/);
  });

  it('begins with the run id, which is the invariant §5.2 names', () => {
    const fields = composeRunIdentity('AF-2026-042', {
      isolationMode: 'worktree',
      entropyHex: '0f3a91c4bd27e615',
    });

    expect(fields.gitRunKey?.startsWith('AF-2026-042-')).toBe(true);
  });

  it('refuses to make an isolated run without a namespace', () => {
    // A `worktree` run without a key is a state §6.3 check 7 exists to catch,
    // and a writer that could produce it would make that check a repair.
    expect(() =>
      composeRunIdentity('AF-2026-001', {
        isolationMode: 'worktree',
        entropyHex: 'not-hex',
      }),
    ).toThrow(/without a Git namespace/);
  });

  it('draws its entropy from the host rather than from the clock or the id', async () => {
    repo = await makeTempRepoWithCommit();
    const host = new FakeHost(1000, 'test-host', [1000], repo.home, 'deadbeefdeadbeef');

    const resolved = await resolveRunGitIdentity({ ...depsFor(repo, true), host });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.entropyHex).toBe('deadbeefdeadbeef');
  });

  it('gives two runs different namespaces', async () => {
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);
    let nth = 0;
    const entropies = ['1111111111111111', '2222222222222222'];

    const first = await store.createRun('a', (runId) =>
      composeRunIdentity(runId, {
        isolationMode: 'worktree',
        entropyHex: entropies[nth++] ?? '0',
      }),
    );
    const second = await store.createRun('b', (runId) =>
      composeRunIdentity(runId, {
        isolationMode: 'worktree',
        entropyHex: entropies[nth++] ?? '0',
      }),
    );

    expect(first.gitRunKey).not.toBe(second.gitRunKey);
  });
});

describe('Git below the floor is refused, never downgraded (§23)', () => {
  it('refuses an isolated run rather than making it sequential', async () => {
    repo = await makeTempRepoWithCommit();
    // A workspaces stand-in whose version probe reports the floor is not met.
    // Everything else answers as the real one does, so the refusal is
    // attributable to the version and to nothing else.
    const belowFloor = workspacesWith(repo, {
      requireSupportedVersion: async () => ({
        ok: false as const,
        failure: {
          code: 'git_version_unsupported' as const,
          message: 'worktree mode needs Git 2.33.0 or newer; this machine has 2.30.0',
        },
      }),
    });

    const resolved = await resolveRunGitIdentity({
      ...depsFor(repo, true),
      workspaces: belowFloor,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // The silent-fallback shape this project forbids would have been
    // `isolationMode: 'none'` with a warning. It is a refusal.
    expect(resolved.refusal.code).toBe('git_version_unsupported');
    expect(resolved.refusal.detail).toContain('2.33.0');
  });

  it('lets a sequential run proceed on the same old Git', async () => {
    repo = await makeTempRepoWithCommit();
    let versionProbes = 0;
    const counting = workspacesWith(repo, {
      requireSupportedVersion: async () => {
        versionProbes += 1;
        return { ok: false as const, failure: { code: 'git_version_unsupported' as const, message: 'old' } };
      },
    });

    const resolved = await resolveRunGitIdentity({ ...depsFor(repo, false), workspaces: counting });

    expect(resolved.ok).toBe(true);
    // Sequential mode does not need the feature, so it is not asked for.
    expect(versionProbes).toBe(0);
  });
});

describe('the identity is immutable once written (I-13)', () => {
  async function isolatedRun() {
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);
    const run = await store.createRun('f', (runId) =>
      composeRunIdentity(runId, {
        isolationMode: 'worktree',
        planningBase: 'a'.repeat(40),
        entropyHex: 'a93f085c23dd9321',
      }),
    );
    return { store, run };
  }

  it('writes all three together, in the write that creates the run', async () => {
    const { store, run } = await isolatedRun();

    expect(run.isolationMode).toBe('worktree');
    expect(run.planningBase).toBe('a'.repeat(40));
    expect(run.gitRunKey).toBe(`${run.runId}-a93f085c23dd9321`);
    // And it is on disk, not only in the returned object.
    expect((await store.loadRun(run.runId)).gitRunKey).toBe(run.gitRunKey);
  });

  it('refuses a patch that moves isolationMode', async () => {
    const { store, run } = await isolatedRun();

    await expect(
      store.updateRun(run.runId, (state) => ({ ...state, isolationMode: 'none' as const })),
    ).rejects.toThrow(StateError);

    expect((await store.loadRun(run.runId)).isolationMode).toBe('worktree');
  });

  it('refuses a patch that moves planningBase', async () => {
    const { store, run } = await isolatedRun();

    await expect(
      store.updateRun(run.runId, (state) => ({ ...state, planningBase: 'b'.repeat(40) })),
    ).rejects.toThrow(StateError);

    expect((await store.loadRun(run.runId)).planningBase).toBe('a'.repeat(40));
  });

  it('refuses a patch that moves gitRunKey', async () => {
    const { store, run } = await isolatedRun();

    await expect(
      store.updateRun(run.runId, (state) => ({
        ...state,
        gitRunKey: `${state.runId}-ffffffffffffffff` as const,
      })),
    ).rejects.toThrow(StateError);

    expect((await store.loadRun(run.runId)).gitRunKey).toBe(`${run.runId}-a93f085c23dd9321`);
  });

  it('still allows the ordinary writes a run depends on', async () => {
    const { store, run } = await isolatedRun();

    const updated = await store.updateRun(run.runId, (state) => ({
      ...state,
      stage: 'planning' as const,
    }));

    expect(updated.stage).toBe('planning');
    expect(updated.isolationMode).toBe('worktree');
  });
});

describe('legacy runs (§25.2)', () => {
  it('has none of the three fields, and that shape is what legacy means', async () => {
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);

    // No identity supplied — the shape a run created before MVP 2 has.
    const run = await store.createRun('an older feature');

    expect(run.isolationMode).toBeUndefined();
    expect(run.planningBase).toBeUndefined();
    expect(run.gitRunKey).toBeUndefined();
  });

  it('is never promoted by a later write, whatever the configuration says', async () => {
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);
    const run = await store.createRun('an older feature');

    await expect(
      store.updateRun(run.runId, (state) => ({ ...state, isolationMode: 'worktree' as const })),
    ).rejects.toThrow(StateError);

    // There is no path from absent to 'worktree', and the absence of the path
    // is the guarantee — not a check that happens to refuse.
    expect((await store.loadRun(run.runId)).isolationMode).toBeUndefined();
  });

  it('asks Git nothing during preconditions', async () => {
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);
    const run = await store.createRun('an older feature');

    let touched = false;
    const watching = new Proxy(repo.workspaces, {
      get(target, property, receiver) {
        touched = true;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const result = await checkWorktreePreconditions(
      {
        workspaces: watching,
        fs: new NodeFileSystem(),
        host: new FakeHost(1000, 'test-host', [1000], repo.home),
        projectDir: repo.dir,
      },
      run,
    );

    expect(result.satisfied).toBe(true);
    expect(touched).toBe(false);
  });

  it('says so on the status screen when the configuration offers worktrees', async () => {
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);
    const run = await store.createRun('an older feature');

    const report = describeIsolation(run, configWith(true));

    expect(report.runMode).toBeUndefined();
    expect(report.note).toContain('predates workspace isolation');
  });
});

describe('a configuration change never reaches an existing run (§6.4)', () => {
  it('leaves a sequential run sequential when the flag is switched on', async () => {
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);

    const resolved = await resolveRunGitIdentity(depsFor(repo, false));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));
    expect(run.isolationMode).toBe('none');

    // The user flips the flag. Nothing re-reads it for this run.
    const afterFlip = await checkWorktreePreconditions(
      {
        workspaces: repo.workspaces,
        fs: new NodeFileSystem(),
        host: new FakeHost(1000, 'test-host', [1000], repo.home),
        projectDir: repo.dir,
      },
      await store.loadRun(run.runId),
    );

    expect((await store.loadRun(run.runId)).isolationMode).toBe('none');
    expect(afterFlip.satisfied).toBe(true);
    expect(describeIsolation(await store.loadRun(run.runId), configWith(true)).agrees).toBe(false);
  });

  it('leaves an isolated run isolated when the flag is switched off', async () => {
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);

    const resolved = await resolveRunGitIdentity(depsFor(repo, true));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));
    expect(run.isolationMode).toBe('worktree');

    const report = describeIsolation(await store.loadRun(run.runId), configWith(false));

    expect((await store.loadRun(run.runId)).isolationMode).toBe('worktree');
    // The row that surprises people, so §21.4 requires it be said in words.
    expect(report.agrees).toBe(false);
    expect(report.note).toContain('does not apply to this run');
  });

  it('says nothing when the two agree', async () => {
    const fs = new InMemoryFileSystem();
    const store = storeIn(fs);
    const run = await store.createRun('f', (runId) =>
      composeRunIdentity(runId, { isolationMode: 'none', entropyHex: 'a93f085c23dd9321' }),
    );

    expect(describeIsolation(run, configWith(false)).note).toBeUndefined();
  });
});

describe('execution preconditions, against a real repository (§6.3)', () => {
  async function isolatedRunIn(temp: TempRepo) {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: temp.dir });
    const resolved = await resolveRunGitIdentity(depsFor(temp, true));
    if (!resolved.ok) throw new Error(`could not create an isolated run: ${resolved.refusal.code}`);
    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));
    return { store, run };
  }

  function repositoryDeps(temp: TempRepo) {
    return {
      workspaces: temp.workspaces,
      fs: new NodeFileSystem(),
      host: new FakeHost(1000, 'test-host', [1000], temp.home),
      projectDir: temp.dir,
    };
  }

  it('is satisfied on the tree the run was created against', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');
    const { run } = await isolatedRunIn(repo);

    const result = await checkWorktreePreconditions(repositoryDeps(repo), run);

    expect(result.satisfied).toBe(true);
  });

  it('refuses when HEAD moved after the run was created', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');
    const { run } = await isolatedRunIn(repo);
    const base = run.planningBase;

    repo.write('later.ts', 'export {};\n');
    repo.commitAll('a commit after the run was created');

    const result = await checkWorktreePreconditions(repositoryDeps(repo), run);

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.code).toBe('planning_base_moved');
    // The base itself did not move. That is the whole point of freezing it.
    expect(run.planningBase).toBe(base);
  });

  it('refuses a dirty working tree, and the refusal is not forcible', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');
    const { run } = await isolatedRunIn(repo);

    repo.write('README.md', 'edited while the run was waiting\n');

    const result = await checkWorktreePreconditions(repositoryDeps(repo), run);

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.code).toBe('working_tree_dirty');
    expect(result.detail).toContain('README.md');
  });

  it('refuses when Agent Flow state is not ignored, rather than refusing itself', async () => {
    // Without check 8 the run reports its own files as making the tree dirty,
    // which is a message that teaches the user the tool is broken.
    repo = await makeTempRepoWithCommit();
    const { run } = await isolatedRunIn(repo);

    const result = await checkWorktreePreconditions(repositoryDeps(repo), run);

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.code).toBe('agent_flow_state_not_ignored');
  });

  it('refuses a namespace that already holds refs this run did not create', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');
    const { run } = await isolatedRunIn(repo);

    // Somebody else's attempt ref, inside this run's namespace. Found through a
    // prefix rather than a glob — the M2-02 finding — so a nested ref like this
    // one is seen at all.
    repo.userGit([
      'update-ref',
      `refs/heads/agent-flow/${String(run.gitRunKey)}/TASK-001/attempt-1`,
      repo.head(),
    ]);

    const result = await checkWorktreePreconditions(repositoryDeps(repo), run);

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.code).toBe('git_run_key_collision');
  });

  it('does not refuse a lone integration branch as a collision with itself', async () => {
    // §5.3 case B: the run's own namespace, created moments before a crash. A
    // rule that refused it would make every resumed run refuse itself.
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');
    const { run } = await isolatedRunIn(repo);

    repo.userGit([
      'update-ref',
      `refs/heads/agent-flow/${String(run.gitRunKey)}/integration`,
      repo.head(),
    ]);

    const result = await checkWorktreePreconditions(repositoryDeps(repo), run);

    expect(result.satisfied).toBe(true);
  });

  it('refuses a run whose recorded namespace belongs to another run', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');
    const { run } = await isolatedRunIn(repo);

    const result = await checkWorktreePreconditions(repositoryDeps(repo), {
      ...run,
      gitRunKey: 'AF-2026-999-a93f085c23dd9321',
    });

    expect(result.satisfied).toBe(false);
    if (result.satisfied) return;
    expect(result.code).toBe('git_identity_missing');
  });

  it('creates no worktree, branch or commit while checking', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');
    const { run } = await isolatedRunIn(repo);

    const refsBefore = repo.userGit(['for-each-ref', '--format=%(refname)']).trim();
    const headBefore = repo.head();
    const worktreesBefore = repo.userGit(['worktree', 'list', '--porcelain']).trim();

    await checkWorktreePreconditions(repositoryDeps(repo), run);

    // M2-03 captures identity and checks. It creates nothing: that is M2-04's
    // and M2-06's, and this is the assertion they will have to come and change.
    expect(repo.userGit(['for-each-ref', '--format=%(refname)']).trim()).toBe(refsBefore);
    expect(repo.head()).toBe(headBefore);
    expect(repo.userGit(['worktree', 'list', '--porcelain']).trim()).toBe(worktreesBefore);
  });
});

describe('the §5.3 initialisation algorithm, as a pure decision (§26.2)', () => {
  // Pure, so every branch is reachable without constructing a repository that
  // happens to be in the right shape. The one that matters most is B not being
  // C: get that wrong and every resumed run refuses itself.
  const BASE = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);

  it('A — an empty namespace may be initialised', () => {
    expect(
      decideNamespace({
        integrationHead: undefined,
        planningBase: BASE,
        integrationBranch: undefined,
        otherRefs: [],
      }),
    ).toEqual({ kind: 'initialise' });
  });

  it('B — the integration branch alone, exactly at planningBase, is adoptable', () => {
    // The crash window: the branch was created and the process died before the
    // state write. Every distinguishing fact matches what initialisation would
    // have produced, and nothing matches what a different run would have left.
    const decision = decideNamespace({
      integrationHead: undefined,
      planningBase: BASE,
      integrationBranch: BASE,
      otherRefs: [],
    });

    expect(decision.kind).toBe('adopt');
    expect(decision.kind).not.toBe('refuse');
  });

  it('C — an attempt ref is a collision, even beside a well-placed branch', () => {
    const decision = decideNamespace({
      integrationHead: undefined,
      planningBase: BASE,
      integrationBranch: BASE,
      otherRefs: ['refs/heads/agent-flow/AF-2026-001-aaaaaaaaaaaaaaaa/TASK-001/attempt-1'],
    });

    expect(decision).toMatchObject({ kind: 'refuse', code: 'git_run_key_collision' });
  });

  it('C — an integration branch at another commit is a collision', () => {
    // Not at `planningBase`, so it carries work nobody here planned against.
    const decision = decideNamespace({
      integrationHead: undefined,
      planningBase: BASE,
      integrationBranch: OTHER,
      otherRefs: [],
    });

    expect(decision).toMatchObject({ kind: 'refuse', code: 'git_run_key_collision' });
  });

  it('C — a branch with no planningBase to compare against is a collision', () => {
    expect(
      decideNamespace({
        integrationHead: undefined,
        planningBase: undefined,
        integrationBranch: BASE,
        otherRefs: [],
      }),
    ).toMatchObject({ kind: 'refuse', code: 'git_run_key_collision' });
  });

  it('D — a recorded head with no branch is namespace_missing', () => {
    // Work recorded as integrated is gone. Re-creating the branch from the base
    // would silently discard it, so this is a refusal and not a repair.
    expect(
      decideNamespace({
        integrationHead: BASE,
        planningBase: BASE,
        integrationBranch: undefined,
        otherRefs: [],
      }),
    ).toMatchObject({ kind: 'refuse', code: 'namespace_missing' });
  });

  it('D — a recorded head with its branch present is a resume', () => {
    // Ancestry is the caller's half: it needs the repository, so the pure
    // function says "resume" and `checkNamespace` confirms containment.
    expect(
      decideNamespace({
        integrationHead: BASE,
        planningBase: BASE,
        integrationBranch: OTHER,
        otherRefs: [],
      }),
    ).toEqual({ kind: 'resume' });
  });
});

describe('every precondition code, and the order §6.3 fixes', () => {
  // §6.3 lists the checks "cheapest and most conclusive first", and the order is
  // part of the contract rather than an implementation detail: when two things
  // are wrong, the user should be told about the one that explains the other.
  // Each ordering case therefore breaks *two* conditions and asserts the lower
  // index wins.

  function repositoryDeps(temp: TempRepo) {
    return {
      workspaces: temp.workspaces,
      fs: new NodeFileSystem(),
      host: new FakeHost(1000, 'test-host', [1000], temp.home),
      projectDir: temp.dir,
    };
  }

  /** An isolated run, without asking the repository whether it is allowed. */
  function isolatedState(temp: TempRepo, overrides: Record<string, unknown> = {}) {
    return {
      runId: 'AF-2026-001',
      feature: 'f',
      stage: 'discovery',
      status: 'running',
      approved: false,
      degradations: [],
      tasks: [],
      isolationMode: 'worktree',
      planningBase: temp.head(),
      gitRunKey: 'AF-2026-001-a93f085c23dd9321',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    } as unknown as Parameters<typeof checkWorktreePreconditions>[1];
  }

  function ignoreAgentFlowState(temp: TempRepo): void {
    temp.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    temp.commitAll('ignore agent-flow state');
  }

  it('1 — not_a_git_repository', async () => {
    repo = await makeTempRepoWithCommit();

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), projectDir: repo.home },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'not_a_git_repository' });
  });

  it('2 — repository_is_bare', async () => {
    repo = await makeTempRepoWithCommit();
    const bare = join(repo.home, 'bare.git');
    repo.userGit(['clone', '--bare', '--quiet', repo.dir, bare]);

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), projectDir: bare },
      isolatedState(repo),
    );

    // Told apart from "not a repository", which it also is not a work tree for.
    expect(result).toMatchObject({ satisfied: false, code: 'repository_is_bare' });
  });

  it('3 — repository_has_no_commits', async () => {
    repo = await makeTempRepoWithCommit();
    const empty = join(repo.home, 'unborn');
    repo.userGit(['init', '--quiet', '--initial-branch=main', empty]);

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), projectDir: empty },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'repository_has_no_commits' });
  });

  it('4 — repository_has_submodules', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const inner = join(repo.home, 'inner');
    repo.userGit(['init', '--quiet', '--initial-branch=main', inner]);
    writeFileSync(join(inner, 'x.txt'), 'x\n');
    repo.userGit(['add', '-A'], inner);
    repo.userGit(['commit', '--quiet', '-m', 'inner'], inner);
    repo.userGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', inner, 'vendor']);
    repo.commitAll('add a submodule');

    const result = await checkWorktreePreconditions(repositoryDeps(repo), isolatedState(repo));

    // `git worktree add` does not populate submodules, so the worktree would
    // build against missing code and fail for a reason nothing would explain.
    expect(result).toMatchObject({ satisfied: false, code: 'repository_has_submodules' });
  });

  it('5 — git_version_unsupported', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const belowFloor = workspacesWith(repo, {
      requireSupportedVersion: async () => ({
        ok: false as const,
        failure: { code: 'git_version_unsupported' as const, message: 'needs 2.33.0, has 2.30.0' },
      }),
    });

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), workspaces: belowFloor },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'git_version_unsupported' });
  });

  it('6 — worktree_path_too_long, from a deep home', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    // §23 projects root + repoKey + gitRunKey + taskId + attempt-<n> + the
    // repository's deepest tracked path. A home long enough on its own pushes
    // the projection past the platform limit before the repository contributes.
    const deepHome = `/${'very-long-directory-name'.repeat(9)}`;

    const result = await checkWorktreePreconditions(
      {
        ...repositoryDeps(repo),
        // Windows' classic limit, which is the case §23 is written for.
        host: new FakeHost(1000, 'test-host', [1000], deepHome, 'a93f085c23dd9321', 260),
      },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'worktree_path_too_long' });
  });

  it('6 — a short home with shallow files is allowed', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);

    // The same repository, a short home, and a limit that is the real POSIX one.
    const result = await checkWorktreePreconditions(
      {
        ...repositoryDeps(repo),
        host: new FakeHost(1000, 'test-host', [1000], '/home/dev', 'a93f085c23dd9321', 260),
      },
      isolatedState(repo),
    );

    expect(result.satisfied).toBe(true);
  });

  it('6 — a short home with a very deep tracked path is refused', async () => {
    // The term §23 names explicitly and that nothing else can bound: the
    // repository's own deepest tracked file. Same home, same limit, same
    // everything — only the repository changed.
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);

    const host = new FakeHost(1000, 'test-host', [1000], '/home/dev', 'a93f085c23dd9321', 260);
    const before = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), host },
      isolatedState(repo),
    );
    expect(before.satisfied).toBe(true);

    // A real tracked file, nested deeply enough to consume the remaining budget.
    const deepDir = join(repo.dir, ...Array.from({ length: 12 }, () => 'a-nested-directory-name'));
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, 'a-file-with-a-long-name.ts'), 'export {};\n');
    repo.commitAll('a deeply nested tracked file');

    const after = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), host },
      isolatedState(repo),
    );

    expect(after).toMatchObject({ satisfied: false, code: 'worktree_path_too_long' });
  });

  it('6 — the platform limit is what decides, not a fixed budget', async () => {
    // §23: "exceeds the platform limit **and long paths are not enabled**". The
    // two halves are one number from the `Host`, so a Windows machine with long
    // paths enabled and one without differ here and nowhere else.
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const home = '/home/dev';

    const classic = await checkWorktreePreconditions(
      {
        ...repositoryDeps(repo),
        host: new FakeHost(1000, 'test-host', [1000], home, 'a93f085c23dd9321', 100),
      },
      isolatedState(repo),
    );
    const longPaths = await checkWorktreePreconditions(
      {
        ...repositoryDeps(repo),
        host: new FakeHost(1000, 'test-host', [1000], home, 'a93f085c23dd9321', 32_767),
      },
      isolatedState(repo),
    );

    expect(classic).toMatchObject({ satisfied: false, code: 'worktree_path_too_long' });
    expect(longPaths.satisfied).toBe(true);
  });

  it('6 — the projection is the sum §23 names', () => {
    // Pure, so the arithmetic is checkable without a repository. Each term
    // moving the answer is what says the term is actually in the sum.
    const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
    const base = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: 'repo-0f3a91c4bd27',
      deepestTrackedPathLength: 0,
      measure: bytes,
    });
    const deeperRepo = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: 'repo-0f3a91c4bd27',
      deepestTrackedPathLength: 40,
      measure: bytes,
    });
    const deeperHome = projectWorstCaseWorktreePath({
      homeDir: '/home/a-much-longer-name',
      repoKey: 'repo-0f3a91c4bd27',
      deepestTrackedPathLength: 0,
      measure: bytes,
    });

    expect(base).not.toBeNull();
    expect(deeperRepo).toBe((base ?? 0) + 40);
    expect(deeperHome).toBeGreaterThan(base ?? 0);
    expect(base ?? 0).toBeGreaterThan('/home/dev/.agent-flow/worktrees/repo-0f3a91c4bd27'.length);
  });

  it('6 — the attempt term is the widest the contract admits, not three digits', () => {
    // `validAttempt` accepts any safe integer and `retry.maxAttempts` has no
    // ceiling, so `attempt-1000` is legal. A three-digit assumption would
    // under-project by exactly the digits it left out — in the direction that
    // permits a path the filesystem then refuses.
    const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
    const projected = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: 'repo-0f3a91c4bd27',
      deepestTrackedPathLength: 0,
      measure: bytes,
    });

    // The widest `attempt-<n>` the policy allows, straight from the constant the
    // validator uses — so policy and projection cannot drift apart.
    const widest = `attempt-${String(MAX_SUPPORTED_ATTEMPT)}`;
    expect(widest.length).toBeGreaterThan('attempt-999'.length);

    // The projection contains the widest form, not a three-digit one.
    const withThreeDigits =
      '/home/dev/.agent-flow/worktrees'.length +
      5 +
      'repo-0f3a91c4bd27'.length +
      'AF-2026-001-0000000000000000'.length +
      'TASK-000'.length +
      'attempt-999'.length;

    expect(projected).toBe(withThreeDigits + (widest.length - 'attempt-999'.length));
  });

  it('6 — a four-digit attempt is inside the projection already', async () => {
    // Behavioural: the same repository and host, and a limit set just under the
    // real projection. A projection built on three digits would have thought
    // there was room.
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);

    const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
    const real = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: 'temp-repo-0f3a91c4bd',
      deepestTrackedPathLength: 10,
      measure: bytes,
    });
    const asIfThreeDigits = (real ?? 0) - (String(MAX_SUPPORTED_ATTEMPT).length - 3);

    const host = new FakeHost(
      1000,
      'test-host',
      [1000],
      '/home/dev',
      'a93f085c23dd9321',
      asIfThreeDigits,
    );

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), host },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'worktree_path_too_long' });
  });

  it('6 — linux keeps its own limit; the same path is refused at darwin’s and allowed at linux’s', async () => {
    // §23 says "the platform limit", not a portable minimum. Giving Linux
    // macOS's 1024 would refuse runs that work, with advice the user cannot act
    // on — the path was already short enough.
    //
    // The tracked depth is injected rather than created on disk, and that is not
    // convenience: this suite runs on macOS, where `PATH_MAX` is 1024, so a real
    // directory deep enough to sit between the two limits **cannot be created**.
    // The subject here is the comparison, and the `ls-files` half is covered by
    // the real-file case above.
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);

    const here = repo;
    const between = 1500;
    const workspaces = workspacesWith(here, {
      deepestTrackedPathLength: async () => ({ ok: true as const, value: between }),
    });

    const at = async (limit: number) =>
      checkWorktreePreconditions(
        {
          ...repositoryDeps(here),
          workspaces,
          host: new FakeHost(1000, 'test-host', [1000], '/home/dev', 'a93f085c23dd9321', limit),
        },
        isolatedState(here),
      );

    expect(await at(PATH_LIMITS.darwin)).toMatchObject({
      satisfied: false,
      code: 'worktree_path_too_long',
    });
    expect((await at(PATH_LIMITS.linux)).satisfied).toBe(true);
    // Usable widths — the NUL terminator is subtracted where the platform fact
    // lives, so nothing here adjusts for it.
    expect(PATH_LIMITS.linux).toBe(4095);
    expect(PATH_LIMITS.darwin).toBe(1023);
  });

  it('6 — a multibyte tracked path is measured in bytes, not UTF-16 units', async () => {
    // `PATH_MAX` bounds a NUL-terminated byte string, so a repository of CJK
    // filenames is three times longer than its JavaScript length. Measuring with
    // `String.length` would under-report exactly the repositories most likely to
    // be near a limit — which is why the unit is the `Host`'s to decide and the
    // adapter is handed a measuring function rather than assuming one.
    repo = await makeTempRepoWithCommit();
    const name = '\u4e2d'.repeat(60);
    writeFileSync(join(repo.dir, `${name}.ts`), 'export {};\n');
    repo.commitAll('a multibyte tracked path');

    const inBytes = await repo.workspaces.deepestTrackedPathLength(repo.dir, (path) =>
      Buffer.byteLength(path, 'utf8'),
    );
    const inUtf16 = await repo.workspaces.deepestTrackedPathLength(repo.dir, (path) => path.length);

    expect(inBytes.ok).toBe(true);
    expect(inUtf16.ok).toBe(true);
    if (!inBytes.ok || !inUtf16.ok) return;

    // 60 CJK characters: 60 UTF-16 units, 180 UTF-8 bytes, plus `.ts`.
    expect(inUtf16.value).toBe(63);
    expect(inBytes.value).toBe(183);
    expect(inBytes.value).toBeGreaterThan(inUtf16.value);
  });

  it('6 — the unit changes the projection for the same repository', () => {
    // Pure, because the end-to-end version of this needs the *real* `repoKey` of
    // a temporary repository to pick a limit between the two measurements, and a
    // test that guesses that number is a test that passes for the wrong reason.
    //
    // The chain is covered in three pieces instead: the adapter measures in the
    // unit it is given (above), the projection uses that measurement (here), and
    // the policy compares the projection against `Host.maxPathLength` (the
    // platform-limit case above).
    const cjkPathLength = { utf16: 63, bytes: 183 };

    const asWindows = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: 'repo-0f3a91c4bd27',
      deepestTrackedPathLength: cjkPathLength.utf16,
      measure: (value) => value.length,
    });
    const asPosix = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: 'repo-0f3a91c4bd27',
      deepestTrackedPathLength: cjkPathLength.bytes,
      measure: (value) => Buffer.byteLength(value, 'utf8'),
    });

    expect(asPosix).toBeGreaterThan(asWindows ?? 0);
    expect((asPosix ?? 0) - (asWindows ?? 0)).toBe(cjkPathLength.bytes - cjkPathLength.utf16);
  });

  it('6 — the boundary is exact: a path of exactly the limit is allowed', async () => {
    // `Host.maxPathLength` is the longest pathname that **fits** — the NUL
    // terminator is already subtracted where the platform fact lives, so the
    // comparison here is `projected > limit` with no second adjustment. These
    // two cases are what say the contract is applied once rather than
    // approximately: a limit published as the documented `PATH_MAX` would let
    // exactly one character too many through, and it would surface at the
    // deepest file, halfway into a checkout.
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const here = repo;

    const measured = 200;
    const workspaces = workspacesWith(here, {
      deepestTrackedPathLength: async () => ({ ok: true as const, value: measured }),
    });

    const projected = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: (await deriveRepoKeyOf(here)) ?? '',
      deepestTrackedPathLength: measured,
      measure: (value) => Buffer.byteLength(value, 'utf8'),
    });
    expect(projected).not.toBeNull();

    const at = async (limit: number) =>
      checkWorktreePreconditions(
        {
          ...repositoryDeps(here),
          workspaces,
          host: new FakeHost(1000, 'test-host', [1000], '/home/dev', 'a93f085c23dd9321', limit),
        },
        isolatedState(here),
      );

    // POSIX, measured in bytes.
    expect((await at(projected ?? 0)).satisfied).toBe(true);
    expect(await at((projected ?? 0) - 1)).toMatchObject({
      satisfied: false,
      code: 'worktree_path_too_long',
    });
  });

  it('6 — the boundary is exact in UTF-16 units too', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const here = repo;

    const measured = 200;
    const workspaces = workspacesWith(here, {
      deepestTrackedPathLength: async () => ({ ok: true as const, value: measured }),
    });

    const projected = projectWorstCaseWorktreePath({
      homeDir: '/home/dev',
      repoKey: (await deriveRepoKeyOf(here)) ?? '',
      deepestTrackedPathLength: measured,
      measure: (value) => value.length,
    });
    expect(projected).not.toBeNull();

    const at = async (limit: number) =>
      checkWorktreePreconditions(
        {
          ...repositoryDeps(here),
          workspaces,
          host: new FakeHost(
            1000,
            'test-host',
            [1000],
            '/home/dev',
            'a93f085c23dd9321',
            limit,
            'utf16',
          ),
        },
        isolatedState(here),
      );

    expect((await at(projected ?? 0)).satisfied).toBe(true);
    expect(await at((projected ?? 0) - 1)).toMatchObject({
      satisfied: false,
      code: 'worktree_path_too_long',
    });
  });

  it('6 — the refusal names lengths, never a filename', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const secret = 'a-file-name-that-must-not-appear';
    writeFileSync(join(repo.dir, `${secret}.ts`), 'export {};\n');
    repo.commitAll('a tracked file with a distinctive name');

    const result = await checkWorktreePreconditions(
      {
        ...repositoryDeps(repo),
        host: new FakeHost(1000, 'test-host', [1000], '/home/dev', 'a93f085c23dd9321', 100),
      },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'worktree_path_too_long' });
    if (result.satisfied) return;
    expect(result.detail).not.toContain(secret);
    expect(result.detail).not.toContain(repo.dir);
    expect(result.detail).toMatch(/\d+ characters/);
  });

  it('repository_root_unresolvable — a root that cannot be canonicalised', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    // §5.1: "If `realpath` fails, worktree mode is refused with
    // `repository_root_unresolvable` rather than guessed." A guessed root
    // produces a `repoKey` that is not stable, and an unstable key means two
    // invocations disagree about which directory a run's worktrees live in.
    const unresolvable = fsWith({ realPath: async () => null });

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), fs: unresolvable },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'repository_root_unresolvable' });
  });

  it('git_unavailable — a required primitive fails, and stays its own answer', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    // A real typed failure from the boundary, not an absent repository. It must
    // not be reported as one of the repository-shape codes: "git could not run"
    // and "your repository is bare" have different fixes.
    const broken = workspacesWith(repo, {
      isWorkTree: async () => ({
        ok: false as const,
        failure: { code: 'git_unavailable' as const, message: 'git could not be started: ENOENT' },
      }),
    });

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), workspaces: broken },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'git_unavailable' });
  });

  it('git_unavailable — a timeout is not mistaken for a clean tree', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const timingOut = workspacesWith(repo, {
      status: async () => ({
        ok: false as const,
        failure: { code: 'git_timed_out' as const, message: 'git status exceeded its 60s timeout' },
      }),
    });

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), workspaces: timingOut },
      isolatedState(repo),
    );

    // The dangerous shape would be `satisfied: true` — a run proceeding because
    // the cleanliness check could not answer.
    expect(result).toMatchObject({ satisfied: false, code: 'git_unavailable' });
  });

  it('a check-ignore failure is not "not ignored"', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    // The two are different facts and only one of them has `.gitignore` as its
    // fix. Telling somebody to edit a file when Git would not run teaches them
    // the message is unreliable.
    const cannotAnswer = workspacesWith(repo, {
      isIgnored: async () => ({
        ok: false as const,
        failure: { code: 'git_command_failed' as const, message: 'git check-ignore exited 128' },
      }),
    });

    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), workspaces: cannotAnswer },
      isolatedState(repo),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'git_unavailable' });
    if (result.satisfied) return;
    expect(result.code).not.toBe('agent_flow_state_not_ignored');
  });

  it('a genuine "not ignored" still says so', async () => {
    // The other half of the pair, so the change above did not simply hide the
    // check-8 refusal behind a failure path.
    repo = await makeTempRepoWithCommit();

    const result = await checkWorktreePreconditions(repositoryDeps(repo), isolatedState(repo));

    expect(result).toMatchObject({ satisfied: false, code: 'agent_flow_state_not_ignored' });
  });

  it('7 — git_identity_missing', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);

    const absent = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { gitRunKey: undefined }),
    );
    const foreign = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { gitRunKey: 'AF-2026-999-a93f085c23dd9321' }),
    );

    expect(absent).toMatchObject({ satisfied: false, code: 'git_identity_missing' });
    expect(foreign).toMatchObject({ satisfied: false, code: 'git_identity_missing' });
  });

  it('8 — agent_flow_state_not_ignored', async () => {
    repo = await makeTempRepoWithCommit();

    const result = await checkWorktreePreconditions(repositoryDeps(repo), isolatedState(repo));

    expect(result).toMatchObject({ satisfied: false, code: 'agent_flow_state_not_ignored' });
  });

  it('9 — working_tree_dirty', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    repo.write('README.md', 'edited\n');

    const result = await checkWorktreePreconditions(repositoryDeps(repo), isolatedState(repo));

    expect(result).toMatchObject({ satisfied: false, code: 'working_tree_dirty' });
  });

  it('10 — planning_base_moved', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const planned = repo.head();
    repo.write('later.ts', 'export {};\n');
    repo.commitAll('moved on');

    const result = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { planningBase: planned }),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'planning_base_moved' });
  });

  it('11 — git_run_key_collision, namespace_missing and integration_head_diverged', async () => {
    repo = await makeTempRepoWithCommit();
    ignoreAgentFlowState(repo);
    const base = repo.head();
    const key = 'AF-2026-001-a93f085c23dd9321';

    // A foreign attempt ref — found only because `refsUnder` takes a prefix.
    repo.userGit(['update-ref', `refs/heads/agent-flow/${key}/TASK-001/attempt-1`, base]);
    const collision = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { planningBase: base }),
    );
    expect(collision).toMatchObject({ satisfied: false, code: 'git_run_key_collision' });
    repo.userGit(['update-ref', '-d', `refs/heads/agent-flow/${key}/TASK-001/attempt-1`]);

    // A recorded head whose branch is gone.
    const missing = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { planningBase: base, integrationHead: base }),
    );
    expect(missing).toMatchObject({ satisfied: false, code: 'namespace_missing' });

    // A branch that no longer contains the recorded head: rewound under the run.
    repo.userGit(['checkout', '--quiet', '-b', 'sideline', base]);
    repo.write('diverged.ts', 'export {};\n');
    const elsewhere = repo.commitAll('a commit the branch was rewound onto');
    repo.userGit(['checkout', '--quiet', 'main']);
    repo.userGit(['update-ref', `refs/heads/agent-flow/${key}/integration`, base]);

    const diverged = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { planningBase: base, integrationHead: elsewhere }),
    );
    expect(diverged).toMatchObject({ satisfied: false, code: 'integration_head_diverged' });
  });

  it('reports the lower-indexed condition when two are wrong at once', async () => {
    repo = await makeTempRepoWithCommit();
    // 8 (state not ignored) and 9 (dirty) are both true. 8 must win, and this is
    // the pair that matters most: without check 8 the run reports files Agent
    // Flow itself wrote as making the tree dirty, which teaches the user the
    // tool is broken.
    repo.write('README.md', 'edited\n');

    const both = await checkWorktreePreconditions(repositoryDeps(repo), isolatedState(repo));
    expect(both).toMatchObject({ satisfied: false, code: 'agent_flow_state_not_ignored' });

    // 9 and 10 together: dirty wins over a moved base.
    ignoreAgentFlowState(repo);
    const planned = repo.head();
    repo.write('later.ts', 'export {};\n');
    repo.commitAll('moved on');
    repo.write('README.md', 'and dirty too\n');

    const dirtyAndMoved = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { planningBase: planned }),
    );
    expect(dirtyAndMoved).toMatchObject({ satisfied: false, code: 'working_tree_dirty' });
  });

  it('reports a structural failure ahead of every per-entry one', async () => {
    repo = await makeTempRepoWithCommit();
    // Not a repository (1) *and* no namespace recorded (7) *and* nothing
    // ignored (8). The structural answer is the one that explains the rest.
    const result = await checkWorktreePreconditions(
      { ...repositoryDeps(repo), projectDir: repo.home },
      isolatedState(repo, { gitRunKey: undefined }),
    );

    expect(result).toMatchObject({ satisfied: false, code: 'not_a_git_repository' });
  });

  it('evaluates nothing for a sequential run and nothing for a legacy one', async () => {
    repo = await makeTempRepoWithCommit();
    // Neither is asked anything, in a repository where several checks would fail
    // if they were: nothing is ignored and the tree is dirty.
    repo.write('README.md', 'dirty\n');

    const sequential = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { isolationMode: 'none' }),
    );
    const legacy = await checkWorktreePreconditions(
      repositoryDeps(repo),
      isolatedState(repo, { isolationMode: undefined, gitRunKey: undefined, planningBase: undefined }),
    );

    expect(sequential.satisfied).toBe(true);
    expect(legacy.satisfied).toBe(true);
  });
});

describe('the initialisation crash window, against real Git (§17.3 window 0)', () => {
  it('adopts its own integration branch rather than refusing itself', async () => {
    // The sequence: the branch is created at `planningBase`, the process dies
    // before the state write, and the run is resumed. `integrationHead` is
    // absent — the state write never happened — so a naive first-entry check
    // would find the run's own branch and call it a collision.
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('ignore agent-flow state');

    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: repo.dir });
    const resolved = await resolveRunGitIdentity(depsFor(repo, true));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));

    // The crash: the branch exists, at exactly the base, and nothing else does.
    repo.userGit([
      'update-ref',
      `refs/heads/agent-flow/${String(run.gitRunKey)}/integration`,
      String(run.planningBase),
    ]);

    const resumed = await checkWorktreePreconditions(
      {
        workspaces: repo.workspaces,
        fs: new NodeFileSystem(),
        host: new FakeHost(1000, 'test-host', [1000], repo.home),
        projectDir: repo.dir,
      },
      await store.loadRun(run.runId),
    );

    expect(resumed.satisfied).toBe(true);
    // And the run's own state is untouched: recognising case B is not writing it.
    expect((await store.loadRun(run.runId)).integrationHead).toBeUndefined();
  });
});

describe('a sequential run is observed, never refused (§6.2)', () => {
  function repositoryDeps(temp: TempRepo) {
    return {
      workspaces: temp.workspaces,
      fs: new NodeFileSystem(),
      host: new FakeHost(1000, 'test-host', [1000], temp.home),
      projectDir: temp.dir,
    };
  }

  async function sequentialRun(temp: TempRepo) {
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: temp.dir });
    const resolved = await resolveRunGitIdentity(depsFor(temp, false));
    if (!resolved.ok) throw new Error('sequential creation must not refuse');
    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));
    return { store, run };
  }

  it('observes a dirty working tree without blocking', async () => {
    repo = await makeTempRepoWithCommit();
    const { run } = await sequentialRun(repo);
    repo.write('README.md', 'edited while planning\n');

    const observation = await observePlanningBaseDrift(repositoryDeps(repo), run);

    expect(observation).not.toBeNull();
    // Appendix B's shape: `clean` and `matches`, the positive forms.
    expect(observation?.clean).toBe(false);
    expect(observation?.matches).toBe(true);
    expect(observation?.changed).toContain('README.md');
    // And the gate itself does not refuse: preconditions are satisfied for a
    // sequential run whatever the repository looks like.
    expect((await checkWorktreePreconditions(repositoryDeps(repo), run)).satisfied).toBe(true);
  });

  it('observes a moved HEAD without blocking', async () => {
    repo = await makeTempRepoWithCommit();
    const { run } = await sequentialRun(repo);
    repo.write('later.ts', 'export {};\n');
    repo.commitAll('moved on');

    const observation = await observePlanningBaseDrift(repositoryDeps(repo), run);

    expect(observation?.matches).toBe(false);
    expect(observation?.planningBase).toBe(run.planningBase);
    expect(observation?.head).not.toBe(run.planningBase);
  });

  it('says nothing about a run with no base — a project that is not a repository', async () => {
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: repo.home });
    const resolved = await resolveRunGitIdentity({ ...depsFor(repo, false), projectDir: repo.home });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));

    expect(run.planningBase).toBeUndefined();
    expect(
      await observePlanningBaseDrift({ ...repositoryDeps(repo), projectDir: repo.home }, run),
    ).toBeNull();
  });

  it('says nothing about a legacy run (§25.2)', async () => {
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: repo.dir });
    const legacy = await store.createRun('an older feature');

    expect(await observePlanningBaseDrift(repositoryDeps(repo), legacy)).toBeNull();
  });
});

describe('a clean sequential run is observed too (§6.2, Appendix B)', () => {
  it('records the result when nothing drifted', async () => {
    // §6.2: "the checks still run and **their result** is written to
    // events.jsonl as planning_base_observation". Not "the failures" — the
    // result. Appendix B's payload is `{ clean, head, planningBase, matches }`,
    // a shape that says "clean and matching" as readily as the opposite, and no
    // section of the spec exempts a clean one. Suppressing it would be choosing
    // noise reduction over the audit trail the deviation was granted for.
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: repo.dir });
    const resolved = await resolveRunGitIdentity(depsFor(repo, false));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));

    const observation = await observePlanningBaseDrift(
      {
        workspaces: repo.workspaces,
        fs: new NodeFileSystem(),
        host: new FakeHost(1000, 'test-host', [1000], repo.home),
        projectDir: repo.dir,
      },
      run,
    );

    expect(observation).not.toBeNull();
    expect(observation?.clean).toBe(true);
    expect(observation?.matches).toBe(true);
    expect(observation?.changed).toEqual([]);
    expect(observation?.head).toBe(run.planningBase);
  });

  it('carries no absolute filesystem path', async () => {
    // Appendix B: "None of these carries an absolute filesystem path
    // (§7.2, §21.3)." The changed paths are repository-relative, as Git reports
    // them.
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: repo.dir });
    const resolved = await resolveRunGitIdentity(depsFor(repo, false));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));
    repo.write('nested-change.ts', 'export {};\n');

    const observation = await observePlanningBaseDrift(
      {
        workspaces: repo.workspaces,
        fs: new NodeFileSystem(),
        host: new FakeHost(1000, 'test-host', [1000], repo.home),
        projectDir: repo.dir,
      },
      run,
    );

    expect(observation?.changed).toContain('nested-change.ts');
    for (const path of observation?.changed ?? []) {
      expect(path.startsWith('/')).toBe(false);
      expect(path).not.toContain(repo?.dir ?? '');
    }
  });

  it('bounds the changed list so an event stays readable', async () => {
    repo = await makeTempRepoWithCommit();
    const fs = new InMemoryFileSystem();
    const store = new StateStore({ fs, clock: new FixedClock(), projectDir: repo.dir });
    const resolved = await resolveRunGitIdentity(depsFor(repo, false));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const run = await store.createRun('f', (runId) => composeRunIdentity(runId, resolved.value));

    for (let index = 0; index < 12; index += 1) {
      repo.write(`change-${String(index)}.ts`, 'export {};\n');
    }

    const observation = await observePlanningBaseDrift(
      {
        workspaces: repo.workspaces,
        fs: new NodeFileSystem(),
        host: new FakeHost(1000, 'test-host', [1000], repo.home),
        projectDir: repo.dir,
      },
      run,
    );

    expect(observation?.clean).toBe(false);
    expect(observation?.changed.length).toBeLessThanOrEqual(5);
  });
});
