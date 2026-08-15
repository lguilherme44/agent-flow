import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('lists tracked repository files via git ls-files', async () => {
    repo = await makeTempRepoWithCommit();
    const client = new GitClient(repo.git, repo.dir);

    const tracked = await client.trackedFiles();
    expect(tracked).toEqual(expect.arrayContaining(['README.md']));
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

describe('bounded commit diff snapshots (M3-06)', () => {
  it('preserves rename/copy paths, deletes, binary flags, odd filenames, and ordering', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('delete me.txt', 'remove me\n');
    repo.write('rename\nsource.txt', 'rename me\n');
    repo.write('copy source.txt', 'copy me exactly\n');
    repo.write('binary.bin', '\u0000old\n');
    const base = repo.commitAll('diff base');

    repo.userGit(['mv', 'rename\nsource.txt', 'renamed\nfile.txt']);
    repo.write('copy destination.txt', 'copy me exactly\n');
    unlinkSync(`${repo.dir}/delete me.txt`);
    repo.write('binary.bin', '\u0000new\n');
    repo.write('space name.txt', 'space\n');
    const head = repo.commitAll('diff head');

    const result = await new GitClient(repo.git, repo.dir).diffSnapshotBetween(base, head);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.base).toBe(base);
    expect(result.value.head).toBe(head);
    expect(result.value.changes).toEqual(
      expect.arrayContaining([
        { status: 'D', path: 'delete me.txt', binary: false },
        { status: 'M', path: 'binary.bin', binary: true },
        { status: 'A', path: 'space name.txt', binary: false },
        {
          status: 'R100',
          previousPath: 'rename\nsource.txt',
          path: 'renamed\nfile.txt',
          binary: false,
        },
        {
          status: 'C100',
          previousPath: 'copy source.txt',
          path: 'copy destination.txt',
          binary: false,
        },
      ]),
    );
    expect(result.value.rawPatch).toContain('GIT binary patch');
    expect(result.value.rawPatchTruncated).toBe(false);
    expect(result.value.rawPatchOmittedCharacters).toBe(0);
  });

  it('returns a truthful empty snapshot for equal commits', async () => {
    repo = await makeTempRepoWithCommit();
    const head = repo.head();

    const result = await new GitClient(repo.git, repo.dir).diffSnapshotBetween(head, head);

    expect(result).toEqual({
      ok: true,
      value: {
        base: head,
        head,
        changes: [],
        rawPatch: '',
        rawPatchTruncated: false,
        rawPatchOmittedCharacters: 0,
      },
    });
  });

  it('never executes a configured textconv and keeps binary evidence binary', async () => {
    repo = await makeTempRepoWithCommit();
    repo.write('.gitattributes', '*.bin diff=sentinel\n');
    repo.write('payload.bin', '\u0000old\n');
    const base = repo.commitAll('binary base');
    repo.write('payload.bin', '\u0000new and longer\n');
    const head = repo.commitAll('binary head');

    const sentinel = join(repo.home, 'textconv-fired');
    const textconv = join(repo.home, 'textconv.sh');
    writeFileSync(
      textconv,
      `#!/bin/sh\nprintf 'fired\\n' >> "${sentinel}"\nwc -c < "$1"\n`,
    );
    chmodSync(textconv, 0o755);
    repo.userGit(['config', 'diff.sentinel.textconv', textconv]);

    // Positive control: ordinary porcelain diff trusts and executes the driver.
    repo.userGit(['diff', '--patch', '--binary', base, head, '--']);
    expect(existsSync(sentinel)).toBe(true);
    unlinkSync(sentinel);

    const result = await new GitClient(repo.git, repo.dir).diffSnapshotBetween(base, head);

    expect(existsSync(sentinel)).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      value: { changes: [{ status: 'M', path: 'payload.bin', binary: true }] },
    });
  });

  it('ignores replace refs when exact object ids are diffed', async () => {
    repo = await makeTempRepoWithCommit();
    const base = repo.head();
    repo.write('README.md', 'head\n');
    const head = repo.commitAll('replacement target');
    const headTree = repo.userGit(['rev-parse', `${head}^{tree}`]).trim();
    const replacement = repo.userGit(['commit-tree', headTree, '-p', base, '-m', 'replacement']).trim();
    repo.userGit(['replace', base, replacement]);

    // Positive control: with replacement enabled, Git lies that the trees match.
    expect(repo.userGit(['diff', '--name-status', '-z', base, head])).toBe('');

    const result = await new GitClient(repo.git, repo.dir).diffSnapshotBetween(base, head);
    expect(result).toMatchObject({
      ok: true,
      value: { changes: [{ status: 'M', path: 'README.md', binary: false }] },
    });
  });

  it('bounds raw patch before inspection and reports exactly what it omitted', async () => {
    const patch = 'diff --git a/file.txt b/file.txt\n' + 'x'.repeat(100);
    const runner = new FakeProcessRunner()
      .push({ stdout: 'M\0file.txt\0' })
      .push({ stdout: patch });
    const client = new GitClient(testGitCommand(runner), '/repo');

    const result = await client.diffSnapshotBetween('a'.repeat(40), 'b'.repeat(40), {
      maxRawPatchCharacters: 32,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        changes: [{ status: 'M', path: 'file.txt' }],
        rawPatch: patch.slice(0, 32),
        rawPatchTruncated: true,
        rawPatchOmittedCharacters: patch.length - 32,
      },
    });
  });

  it('refuses invalid object ids without executing Git', async () => {
    const runner = new FakeProcessRunner();
    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'HEAD',
      'A'.repeat(40),
    );

    expect(result).toMatchObject({ ok: false, failure: { code: 'git_unsafe_argument' } });
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses hostile runtime revision values without coercing them', async () => {
    const runner = new FakeProcessRunner();
    const hostile = new Proxy({}, { get: () => { throw new Error('must not coerce'); } });

    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      hostile as never,
      'b'.repeat(40),
    );

    expect(result).toMatchObject({ ok: false, failure: { code: 'git_unsafe_argument' } });
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    ['name-status non-zero', { exitCode: 2, stderr: 'bad range' }, {}, 'git_command_failed'],
    ['name-status truncation', { truncated: true }, {}, 'git_output_truncated'],
    ['patch non-zero', {}, { exitCode: 2, stderr: 'bad object' }, 'git_command_failed'],
    ['patch truncation', {}, { truncated: true }, 'git_output_truncated'],
  ] as const)('refuses %s rather than returning partial truth', async (_name, names, patch, code) => {
    const runner = new FakeProcessRunner()
      .push({ stdout: 'M\0file.txt\0', ...names })
      .push({ stdout: 'diff --git a/file.txt b/file.txt\n', ...patch });

    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'a'.repeat(40),
      'b'.repeat(40),
    );

    expect(result).toMatchObject({ ok: false, failure: { code } });
  });

  it.each(['name/status', 'patch'])('propagates an explicit GitCommand refusal from %s', async (at) => {
    const runner = new FakeProcessRunner();
    if (at === 'patch') runner.push({ stdout: 'M\0file.txt\0' });
    runner.push({ spawnFailed: true, stderr: 'ENOENT' });

    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'a'.repeat(40),
      'b'.repeat(40),
    );

    expect(result).toMatchObject({ ok: false, failure: { code: 'git_unavailable' } });
  });

  it.each([
    ['missing terminal NUL', 'M\0file.txt'],
    ['missing path', 'M\0'],
    ['missing rename destination', 'R100\0old.txt\0'],
    ['empty interior field', 'M\0\0'],
    ['unknown status', 'Q\0file.txt\0'],
  ])('refuses malformed -z name-status output: %s', async (_name, stdout) => {
    const runner = new FakeProcessRunner().always({ stdout });
    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'a'.repeat(40),
      'b'.repeat(40),
    );

    expect(result).toMatchObject({ ok: false, failure: { code: 'git_invalid_output' } });
    expect(runner.calls).toHaveLength(1);
  });

  it.each(['R', 'C', 'R101', 'C999'])(
    'refuses impossible rename/copy status %s before reading a patch',
    async (status) => {
      const runner = new FakeProcessRunner()
        .push({ stdout: `${status}\0old.txt\0new.txt\0` })
        .always({ stdout: 'diff --git a/old.txt b/new.txt\n' });

      const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
        'a'.repeat(40),
        'b'.repeat(40),
      );

      expect(result).toMatchObject({ ok: false, failure: { code: 'git_invalid_output' } });
      expect(runner.calls).toHaveLength(1);
    },
  );

  it.each(['R0', 'R50', 'R050', 'R100', 'C0', 'C100'])(
    'accepts bounded rename/copy score format %s',
    async (status) => {
      const runner = new FakeProcessRunner()
        .push({ stdout: `${status}\0old.txt\0new.txt\0` })
        .push({ stdout: 'diff --git a/old.txt b/new.txt\n' });

      const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
        'a'.repeat(40),
        'b'.repeat(40),
      );

      expect(result).toMatchObject({ ok: true, value: { changes: [{ status }] } });
    },
  );

  it('refuses a complete patch that cannot correspond to the name/status output', async () => {
    const runner = new FakeProcessRunner()
      .push({ stdout: 'M\0one.txt\0M\0two.txt\0' })
      .push({ stdout: 'diff --git a/one.txt b/one.txt\n' });

    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'a'.repeat(40),
      'b'.repeat(40),
    );

    expect(result).toMatchObject({ ok: false, failure: { code: 'git_invalid_output' } });
  });

  it('sanitizes hostile output caps before passing them to GitCommand', async () => {
    for (const hostile of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      Number.MIN_VALUE,
      0.5,
      1.75,
      Number.MAX_VALUE,
    ]) {
      const runner = new FakeProcessRunner()
        .push({ stdout: '' })
        .push({ stdout: '' });

      await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
        'a'.repeat(40),
        'b'.repeat(40),
        { maxOutputBytes: hostile },
      );

      expect(runner.calls).toHaveLength(2);
      for (const call of runner.calls) {
        expect(call.args).toContain('diff');
        expect(call.args).toContain('--no-textconv');
        expect(Number.isSafeInteger(call.maxOutputBytes)).toBe(true);
        expect(call.maxOutputBytes).toBeGreaterThan(0);
        expect(call.maxOutputBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      }
    }
  });

  it.each([
    ['null options', null],
    ['null numeric field', { maxOutputBytes: null }],
    ['throwing getter', Object.defineProperty({}, 'maxOutputBytes', { get: () => { throw new Error('boom'); } })],
    ['throwing proxy', new Proxy({}, { get: () => { throw new Error('boom'); } })],
  ])('refuses hostile runtime options without throwing: %s', async (_name, options) => {
    const runner = new FakeProcessRunner();
    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'a'.repeat(40),
      'b'.repeat(40),
      options as never,
    );

    expect(result).toMatchObject({ ok: false, failure: { code: 'git_unsafe_argument' } });
    expect(runner.calls).toHaveLength(0);
  });

  it('reads each runtime option exactly once', async () => {
    let outputReads = 0;
    let patchReads = 0;
    const options = {
      get maxOutputBytes() {
        outputReads += 1;
        return 1024;
      },
      get maxRawPatchCharacters() {
        patchReads += 1;
        return 1024;
      },
    };
    const runner = new FakeProcessRunner().push({ stdout: '' }).push({ stdout: '' });

    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'a'.repeat(40),
      'b'.repeat(40),
      options,
    );

    expect(result.ok).toBe(true);
    expect({ outputReads, patchReads }).toEqual({ outputReads: 1, patchReads: 1 });
  });

  it('falls back safely when a fractional raw-patch cap floors below one', async () => {
    const patch = 'diff --git a/file.txt b/file.txt\n';
    const runner = new FakeProcessRunner()
      .push({ stdout: 'M\0file.txt\0' })
      .push({ stdout: patch });

    const result = await new GitClient(testGitCommand(runner), '/repo').diffSnapshotBetween(
      'a'.repeat(40),
      'b'.repeat(40),
      { maxRawPatchCharacters: Number.MIN_VALUE },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { rawPatch: patch, rawPatchTruncated: false, rawPatchOmittedCharacters: 0 },
    });
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
