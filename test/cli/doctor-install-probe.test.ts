import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { probeInstallCleanliness } from '../../src/app/diagnostics.js';
import { renderInstallProbe } from '../../src/cli/doctor.js';
import type { EffectiveConfig } from '../../src/contracts/index.js';
import { BORN_DIRTY_FILE, bornDirty, makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * An install command, as a Node script on disk outside the repository.
 *
 * These were POSIX one-liners — `mkdir -p node_modules`, `echo rewritten >
 * package-lock.json` — run through whatever shell the product picks for the host.
 * `cmd.exe` has no `-p`, no `/dev/null` and different redirection, so on Windows the
 * probe reported failures about the fixture rather than about the cleanliness rule under
 * test. `node -e` is not the answer either: the script needs quotes, and a quoted
 * argument inside `cmd /c "…"` nests badly enough that the command silently became
 * something else and the probe reported the tree *clean*.
 *
 * A file has no quoting problem in any shell. It goes in the repository's home directory
 * rather than in the repository, because an install command that dirties the tree by
 * merely existing would be the thing under test.
 */
function installScript(temp: TempRepo, name: string, body: string): string {
  const path = join(temp.home, `${name}.cjs`);
  writeFileSync(path, body, 'utf8');
  return `node ${path.replace(/\\/g, '/')}`;
}

const REWRITE_LOCKFILE = `require('node:fs').writeFileSync('package-lock.json', 'rewritten\\n');\n`;
const MAKE_IGNORED_OUTPUT = `require('node:fs').mkdirSync('node_modules', { recursive: true });\n`;
/** Reports what Git thinks the checkout is, then behaves like a clean install. */
const REPORT_THE_CHECKOUT =
  `require('node:child_process').execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);\n` +
  MAKE_IGNORED_OUTPUT;

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

  const finding = await probeInstallCleanliness({
    fs: new NodeFileSystem(),
    processRunner: new NodeProcessRunner(),
    config,
    projectDir: temp.dir,
    host: new FakeHost(4242, 'test-host', [4242], temp.home),
  });

  // Through the renderer, so the finding and the sentence that explains it are asserted
  // together. `probeInstallCleanliness` answers with an outcome now — the Deck reads the
  // same one — and a structure that stopped producing its line would otherwise pass.
  return renderInstallProbe(finding).join('\n');
}

describe('the install-cleanliness probe (§8.4)', () => {
  it('warns when the install rewrites a tracked file, and names it', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('package-lock.json', '{"lockfileVersion":3}\n');
    repo.commitAll('a lockfile');

    const report = await probe(repo, installScript(repo, 'rewrite-lock', REWRITE_LOCKFILE));

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

    const report = await probe(repo, installScript(repo, 'ignored-output', MAKE_IGNORED_OUTPUT));

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
    // The working-tree content does not match the index the instant Git finishes
    // writing it, so the checkout is dirty before anything is installed. `doctor`
    // must not blame the install for it. The fixture spawns nothing to arrange
    // that — see `bornDirty`, and the gate failure that is the reason it does not.
    repo = await makeTempRepoWithCommit();
    bornDirty(repo);

    const report = await probe(repo, installScript(repo, 'ignored-output', MAKE_IGNORED_OUTPUT));

    expect(report).toContain('not clean before installing');
    expect(report).toContain(BORN_DIRTY_FILE);
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
    const report = await probe(repo, installScript(repo, 'report-checkout', REPORT_THE_CHECKOUT));

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
    const DIRTIES_THE_TREE =
      `require('node:fs').writeFileSync('package-lock.json', 'rewritten\\n');\n` +
      `require('node:fs').writeFileSync('stray.txt', 'stray\\n');\n`;
    const FAILS_HALFWAY =
      `require('node:fs').writeFileSync('package-lock.json', 'half-written\\n');\n` +
      `process.exit(9);\n`;

    const CASES = [
      {
        label: 'a clean install',
        script: MAKE_IGNORED_OUTPUT,
        ignore: 'node_modules/\n',
        expect: 'leaves a fresh checkout clean',
      },
      {
        label: 'an install that dirties the tree',
        script: DIRTIES_THE_TREE,
        ignore: '',
        expect: 'modifies files that are tracked or not ignored',
      },
      {
        label: 'an install that fails outright',
        script: FAILS_HALFWAY,
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
        expect(await probe(repo, installScript(repo, 'residue', scenario.script))).toContain(
          scenario.expect,
        );

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

    it('sweeps the directory itself when Git will not remove the worktree', async () => {
      // **The branch the three scenarios above cannot reach, and the one that leaked.**
      //
      // Measured in the wild: six `doctor-install-probe-pid-*` directories after six
      // `doctor` calls on one repository, each holding a full `node_modules`, none
      // registered with Git — while these tests were green. The reason they were green is
      // that all three of them remove cleanly. What happened live was a removal that
      // *failed*, and the probe discarded `removeWorktree`'s `GitResult`, so nobody was
      // told and the directory stayed.
      //
      // The failure is injected because the real cause is a Windows file lock — `npm ci`'s
      // own children holding `node_modules` — which is not reproducible on demand. What is
      // under test is that Git's answer is *read*.
      repo = await makeTempRepoWithCommit();
      repo.write('.gitignore', 'node_modules/\n');
      repo.commitAll('a project');

      const real = repo.workspaces;
      // `Object.create`, because the adapter's methods are on its prototype.
      const refusing = Object.assign(Object.create(real) as typeof real, {
        removeWorktree: () =>
          Promise.resolve({
            ok: false as const,
            failure: { code: 'git_command_failed', message: 'EBUSY: resource busy or locked' },
          }),
      });

      const finding = await probeInstallCleanliness({
        fs: new NodeFileSystem(),
        processRunner: new NodeProcessRunner(),
        config: {
          global: {},
          project: { commands: { install: installScript(repo, 'sweep', MAKE_IGNORED_OUTPUT) } },
        } as unknown as EffectiveConfig,
        projectDir: repo.dir,
        host: new FakeHost(4242, 'test-host', [4242], repo.home),
        workspaces: refusing as unknown as typeof real,
      });

      // The probe still answered: a cleanup is not allowed to change the verdict.
      expect(finding.outcome).toBe('clean');

      // And nothing was left behind, even though Git refused to take it.
      const leftovers = existsSync(repo.worktreeRoot)
        ? readdirSync(repo.worktreeRoot).filter((entry) => entry.startsWith('doctor-install-probe'))
        : [];
      expect(leftovers).toEqual([]);
    });
  });

  it('leaves the user working tree untouched', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('package-lock.json', '{"lockfileVersion":3}\n');
    repo.commitAll('a lockfile');
    const before = repo.userGit(['status', '--porcelain=v1']).trim();

    await probe(repo, installScript(repo, 'rewrite-lock', REWRITE_LOCKFILE));

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

    const finding = await probeInstallCleanliness({
      fs: new NodeFileSystem(),
      processRunner: new NodeProcessRunner(),
      config: {
        global: {},
        project: { commands: { install: installScript(repo, 'ignored-output', MAKE_IGNORED_OUTPUT) } },
      } as unknown as EffectiveConfig,
      projectDir: outside,
      host: new FakeHost(4242, 'test-host', [4242], repo.home),
    });

    expect(finding).toEqual({ outcome: 'skipped', reason: 'no_head' });
    expect(renderInstallProbe(finding)).toEqual([]);
  });
});
