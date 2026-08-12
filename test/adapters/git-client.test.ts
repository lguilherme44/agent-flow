import { describe, it, expect, afterEach } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { testGitCommand } from '../fakes/test-git-command.js';
import { GitClient, annotateScaffold } from '../../src/adapters/git/git-client.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * `GitClient` regressions across the M2-02 migration (§40).
 *
 * It used to build `{ command: 'git' }` for a `ProcessRunner` directly; it now
 * goes through `GitCommand`. **Nothing it reports may have changed** — `review`
 * is the only consumer, and a difference here is a difference in what a
 * reviewing model sees. The behavioural cases run against a real repository so
 * that "unchanged" means unchanged against Git rather than against a fake that
 * was written to agree with the new code.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe('what it reports, against a real repository', () => {
  it('recognises a repository, and a directory that is not one', async () => {
    repo = await makeTempRepoWithCommit();

    expect(await new GitClient(repo.git, repo.dir).isRepository()).toBe(true);
    // `review` has always worked outside a repository, and §25 promises that
    // sequential mode is unchanged.
    expect(await new GitClient(repo.git, repo.home).isRepository()).toBe(false);
  });

  it('lists changed files with their status letters, and untracked ones', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('README.md', 'changed\n');
    repo.write('new.ts', 'export {};\n');
    const client = new GitClient(repo.git, repo.dir);

    const changes = await client.changedFiles();

    expect(changes).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'README.md' },
        { status: '??', path: 'new.ts' },
      ]),
    );
    expect(await client.isClean()).toBe(false);
  });

  it('calls an untouched repository clean', async () => {
    repo = await makeTempRepoWithCommit();

    expect(await new GitClient(repo.git, repo.dir).isClean()).toBe(true);
  });

  it('summarises the diff and names untracked files separately', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('README.md', 'changed\n');
    repo.write('untracked.ts', 'export {};\n');

    const stat = await new GitClient(repo.git, repo.dir).diffStat();

    expect(stat).toContain('README.md');
    expect(stat).toContain('Untracked files:');
    expect(stat).toContain('untracked.ts');
  });

  it('says so plainly when there is nothing to report', async () => {
    repo = await makeTempRepoWithCommit();

    expect(await new GitClient(repo.git, repo.dir).diffStat()).toBe('No changes against HEAD.');
  });

  it('returns no changes rather than throwing outside a repository', async () => {
    repo = await makeTempRepoWithCommit();
    const client = new GitClient(repo.git, repo.home);

    expect(await client.changedFiles()).toEqual([]);
    expect(await client.isClean()).toBe(true);
  });
});

describe('it goes through the wrapper (I-7)', () => {
  it('carries hook isolation on every command it issues', async () => {
    const runner = new FakeProcessRunner().always({ exitCode: 0, stdout: '' });
    const client = new GitClient(testGitCommand(runner), '/repo');

    await client.isRepository();
    await client.changedFiles();
    await client.diffStat();

    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.command).toBe('git');
      expect(call.args.slice(0, 2)).toEqual(['-c', 'core.hooksPath=/fake-home/.agent-flow/no-hooks']);
    }
  });

  it('treats git being unavailable as no information, not as an exception', async () => {
    const runner = new FakeProcessRunner().always({ spawnFailed: true, stderr: 'ENOENT' });
    const client = new GitClient(testGitCommand(runner), '/repo');

    // The old code reached the same conclusion from a non-zero exit. Throwing
    // here would take the whole `review` command down on a machine without git.
    expect(await client.isRepository()).toBe(false);
    expect(await client.changedFiles()).toEqual([]);
    expect(await client.diffStat()).toBe('No changes against HEAD.');
  });
});

describe('scaffold annotation is untouched', () => {
  it('still marks what init wrote, and only that', () => {
    const rendered = annotateScaffold([
      { status: 'M', path: 'AGENTS.md' },
      { status: 'A', path: 'src/feature.ts' },
    ]);

    expect(rendered).toContain('written by agent-flow itself');
    expect(rendered.split('\n').filter((line) => line.includes('written by agent-flow'))).toHaveLength(1);
  });
});
