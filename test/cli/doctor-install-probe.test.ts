import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { probeInstallCleanliness } from '../../src/cli/doctor.js';
import type { EffectiveConfig } from '../../src/contracts/index.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * §8.4 — `doctor` must warn about a dirty install **before** a run, not after.
 *
 * The wall this exists for: `npm install` rewrites `package-lock.json` whenever
 * the lock drifts from `package.json`. That is a tracked modification, so it
 * fails the post-setup cleanliness assertion, so worktree mode refuses every
 * task in the project. The gate is working correctly and the user has no way to
 * know that from the refusal alone — which is why the probe is not optional
 * polish.
 *
 * Real Git and a real filesystem, in-process, with the home directory injected
 * through the `Host` port. Driving the built CLI as a subprocess was the obvious
 * alternative and is worse in a way worth recording: `npm run check` never runs
 * `npm run build`, so on a clean checkout the CLI is not there — and because
 * three of these cases assert what the report *does not* say, they would go
 * green against a subprocess that printed nothing at all. A test that passes
 * because the binary is missing is worse than one that fails.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function probe(temp: TempRepo, install?: string): Promise<string> {
  const config = {
    global: {},
    ...(install === undefined ? {} : { project: { commands: { install } } }),
  } as unknown as EffectiveConfig;

  const lines = await probeInstallCleanliness({
    fs: new NodeFileSystem(),
    processRunner: new NodeProcessRunner(),
    config,
    projectDir: temp.dir,
    host: new FakeHost(4242, 'test-host', [4242], temp.home),
  });

  return lines.join('\n');
}

describe('the install-cleanliness probe (§8.4)', () => {
  it('warns when the install rewrites a tracked file, and names it', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('package-lock.json', '{"lockfileVersion":3}\n');
    repo.commitAll('a lockfile');

    const report = await probe(repo, 'echo rewritten > package-lock.json');

    expect(report).toContain('Install probe');
    expect(report).toContain('package-lock.json');
    expect(report).toContain('refuse every task');
    // Actionable, not merely alarming.
    expect(report).toContain('npm ci');
  });

  it('says so plainly when the install leaves the checkout clean', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', 'node_modules/\n');
    repo.commitAll('ignore install output');

    const report = await probe(repo, 'mkdir -p node_modules');

    expect(report).toContain('Install probe');
    expect(report).toContain('leaves a fresh checkout clean');
  });

  it('reports an install that cannot run at all', async () => {
    repo = await makeTempRepoWithCommit();

    const report = await probe(repo, 'exit 9');

    expect(report).toContain('failed in a fresh checkout');
    expect(report).toContain('every task would fail here');
  });

  it('names the checkout phase when a fresh checkout is born dirty', async () => {
    // The same `.gitattributes` smudge filter the preparation tests use: the
    // working-tree content no longer matches the index, so the checkout is dirty
    // before anything is installed. `doctor` must not blame the install for it.
    repo = await makeTempRepoWithCommit();
    repo.write('.gitattributes', '*.txt filter=dirtier\n');
    repo.write('content.txt', 'original\n');
    repo.commitAll('a filtered file');
    repo.userGit(['config', 'filter.dirtier.smudge', 'sed s/original/smudged/']);
    repo.userGit(['config', 'filter.dirtier.clean', 'cat']);

    const report = await probe(repo, 'mkdir -p node_modules');

    expect(report).toContain('not clean before installing');
    expect(report).toContain('content.txt');
    expect(report).toContain('phase: checkout');
  });

  it('is a detached checkout and creates no branch to leave behind', async () => {
    // Cheaper than cleaning up a ref: the probe never makes one. It checks out a
    // commit, so there is no attempt-shaped branch, no `agent-flow/` namespace
    // entry, and nothing for §20's cleanup to have to know about. Asserted rather
    // than assumed, because `addWorktree` takes an optional `branch` and adding
    // one here would look harmless.
    repo = await makeTempRepoWithCommit();
    repo.write('.gitignore', 'node_modules/\n');
    repo.commitAll('ignore install output');
    const refsBefore = repo.userGit(['for-each-ref', '--format=%(refname)']).trim();

    // Observed while it exists, by having the install report what Git thinks the
    // checkout is — the probe's worktree is gone by the time the call returns.
    const report = await probe(repo, 'git rev-parse --abbrev-ref HEAD > /dev/null; mkdir -p node_modules');

    expect(report).toContain('leaves a fresh checkout clean');
    // No ref appeared, and none disappeared.
    expect(repo.userGit(['for-each-ref', '--format=%(refname)']).trim()).toBe(refsBefore);
    expect(refsBefore).toContain('refs/heads/');
    expect(refsBefore).not.toContain('doctor-install-probe');
  });

  describe('leaves no residue, whatever the install did', () => {
    // Three outcomes, one for each branch of the probe, because the removal lives
    // in a `finally` and only one of the three exercises the happy path. The two
    // that warn are the ones a user actually hits, and Git refuses to reclaim a
    // worktree holding a modified tracked file or an untracked non-ignored one —
    // so without `--force` a `doctor` run would leak a checkout every single time
    // it had something useful to say.
    const CASES = [
      {
        label: 'a clean install',
        install: 'mkdir -p node_modules',
        ignore: 'node_modules/\n',
        expect: 'leaves a fresh checkout clean',
      },
      {
        label: 'an install that dirties the tree',
        install: 'echo rewritten > package-lock.json && echo stray > stray.txt',
        ignore: '',
        expect: 'modifies files that are tracked or not ignored',
      },
      {
        label: 'an install that fails outright',
        install: 'echo half-written > package-lock.json && exit 9',
        ignore: '',
        expect: 'failed in a fresh checkout',
      },
    ] as const;

    for (const scenario of CASES) {
      it(scenario.label, async () => {
        repo = await makeTempRepoWithCommit();
        repo.write('package-lock.json', '{"lockfileVersion":3}\n');
        if (scenario.ignore !== '') repo.write('.gitignore', scenario.ignore);
        repo.commitAll('a project');
        const refsBefore = repo.userGit(['for-each-ref', '--format=%(refname)']).trim();

        // The branch of the probe under test really was taken.
        expect(await probe(repo, scenario.install)).toContain(scenario.expect);

        // Not registered with Git any more…
        const listed = repo.userGit(['worktree', 'list', '--porcelain']);
        expect(listed).not.toContain('doctor-install-probe');
        // …and the repository agrees there is exactly one worktree left: the
        // user's own. A `prune`-able stale entry would still be listed.
        expect(listed.split('worktree ').length - 1).toBe(1);

        // Nothing on the filesystem. The probe's location is a single segment, so
        // a correct removal leaves no empty parent behind either.
        const leftovers = existsSync(repo.worktreeRoot)
          ? readdirSync(repo.worktreeRoot).filter((entry) =>
              entry.startsWith('doctor-install-probe'),
            )
          : [];
        expect(leftovers).toEqual([]);

        // No ref created and none destroyed.
        expect(repo.userGit(['for-each-ref', '--format=%(refname)']).trim()).toBe(refsBefore);
      });
    }
  });

  it('leaves the user working tree untouched', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('package-lock.json', '{"lockfileVersion":3}\n');
    repo.commitAll('a lockfile');
    const before = repo.userGit(['status', '--porcelain=v1']).trim();

    await probe(repo, 'echo rewritten > package-lock.json');

    // The probe runs in its own checkout; the install never touches the tree the
    // user has open (I-10).
    expect(repo.userGit(['status', '--porcelain=v1']).trim()).toBe(before);
    expect(repo.userGit(['show', 'HEAD:package-lock.json']).trim()).toBe('{"lockfileVersion":3}');
  });

  it('says nothing when no install is configured', async () => {
    // `doctor` has other checks for a project it cannot read, and a second voice
    // saying the same thing is noise. Asserted against a probe that demonstrably
    // *can* speak — the case above proves the same fixture produces output.
    repo = await makeTempRepoWithCommit();

    expect(await probe(repo)).toBe('');
  });

  it('says nothing in a directory that is not a repository', async () => {
    repo = await makeTempRepoWithCommit();
    const outside = join(repo.home, 'not-a-repo');

    const lines = await probeInstallCleanliness({
      fs: new NodeFileSystem(),
      processRunner: new NodeProcessRunner(),
      config: {
        global: {},
        project: { commands: { install: 'mkdir -p node_modules' } },
      } as unknown as EffectiveConfig,
      projectDir: outside,
      host: new FakeHost(4242, 'test-host', [4242], repo.home),
    });

    expect(lines).toEqual([]);
  });
});
