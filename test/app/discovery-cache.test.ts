import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import {
  computeFingerprint,
  fingerprintDifferences,
  fingerprintsMatch,
  readFingerprint,
  writeFingerprint,
} from '../../src/app/discovery-cache.js';

const PROJECT = '/repo';
const FINGERPRINT_PATH = `${PROJECT}/.agent-flow/cache/architecture.fingerprint.json`;

const git = (head: string, status = '') =>
  new FakeProcessRunner().always((spawn) =>
    spawn.args[0] === 'rev-parse' ? { exitCode: 0, stdout: head } : { exitCode: 0, stdout: status },
  );

const compute = (fs: InMemoryFileSystem, processRunner: FakeProcessRunner, projectConfig = 'cfg') =>
  computeFingerprint({ fs, processRunner, projectDir: PROJECT, projectConfig });

describe('reading a stored fingerprint', () => {
  it('round-trips what was written', async () => {
    const fs = new InMemoryFileSystem();
    const original = await compute(fs, git('abc'));
    await writeFingerprint(fs, PROJECT, original);

    expect(await readFingerprint(fs, PROJECT)).toEqual(original);
  });

  it('returns null when there is none', async () => {
    expect(await readFingerprint(new InMemoryFileSystem(), PROJECT)).toBeNull();
  });

  describe('a corrupt fingerprint invalidates rather than throws (AF-R07 regression)', () => {
    // Was a defect: JSON.parse ran outside the guard, so a truncated file — a
    // crash mid-write, a bad merge — threw out of here and took the whole
    // command with it. The correct response is to re-run discovery.
    for (const [label, content] of [
      ['truncated json', '{ "head": "abc"'],
      ['not json at all', 'garbage'],
      ['empty file', ''],
      ['an array', '[]'],
      ['valid json, wrong shape', '{"unexpected":true}'],
    ] as const) {
      it(`returns null for ${label}`, async () => {
        const fs = new InMemoryFileSystem();
        fs.seed(FINGERPRINT_PATH, content);

        await expect(readFingerprint(fs, PROJECT)).resolves.toBeNull();
      });
    }
  });
});

describe('what the fingerprint covers', () => {
  it('changes when HEAD moves', async () => {
    const fs = new InMemoryFileSystem();
    const before = await compute(fs, git('abc'));
    const after = await compute(fs, git('def'));

    expect(fingerprintsMatch(before, after)).toBe(false);
    expect(fingerprintDifferences(before, after)).toContain('the checked-out commit');
  });

  it('changes when tracked files are modified', async () => {
    const fs = new InMemoryFileSystem();
    const before = await compute(fs, git('abc'));
    const after = await compute(fs, git('abc', ' M src/a.ts'));

    expect(fingerprintsMatch(before, after)).toBe(false);
  });

  it('changes when AGENTS.md changes', async () => {
    const fs = new InMemoryFileSystem();
    const before = await compute(fs, git('abc'));

    fs.seed(`${PROJECT}/AGENTS.md`, '# Rules');
    const after = await compute(fs, git('abc'));

    expect(fingerprintDifferences(before, after)).toContain('AGENTS.md');
  });

  it('changes when the project configuration changes', async () => {
    const fs = new InMemoryFileSystem();
    const before = await compute(fs, git('abc'), 'commands: {}');
    const after = await compute(fs, git('abc'), 'commands: { test: npm test }');

    expect(fingerprintDifferences(before, after)).toContain('the project configuration');
  });

  it('does not change when the same file is edited twice', async () => {
    // Deliberate: the dirty component hashes the *names* git reports, not the
    // contents. Hashing contents would be more correct and would invalidate on
    // every save, turning the most expensive stage into one that runs
    // constantly.
    const fs = new InMemoryFileSystem();
    const first = await compute(fs, git('abc', ' M src/a.ts'));
    const second = await compute(fs, git('abc', ' M src/a.ts'));

    expect(fingerprintsMatch(first, second)).toBe(true);
  });

  it('works in a repository without git', async () => {
    // rev-parse and status both fail; the other two inputs still carry signal.
    const fs = new InMemoryFileSystem();
    const noGit = new FakeProcessRunner().always({ exitCode: 128, stdout: '' });

    const fingerprint = await compute(fs, noGit);
    expect(fingerprint.head).toBe('none');
    expect(fingerprint.projectConfig).not.toBe('none');
  });
});
