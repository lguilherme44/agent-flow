import { describe, it, expect } from 'vitest';
import {
  attemptRef,
  attemptWorkspace,
  gitRunKeyBelongsToRun,
  integrationRef,
  integrationWorkspace,
  makeGitRunKey,
  repoKeyFromCanonicalRoot,
  type PolicyResult,
} from '../../src/core/worktree-policy.js';

/**
 * M2-01 — the naming half of MVP 2, decided without a repository.
 *
 * Every assertion here is on an exact string. A test that only checked a shape
 * would pass for a ref name nobody meant to create, and these names are what a
 * person types into `git log` six weeks later.
 *
 * The refusal cases are the point of the module. A task id, a run key and a
 * repository key all end up inside a ref and inside a directory name, and all
 * three arrive from somewhere that a model, a stale state file or another
 * process wrote — so each one is tried here with the payloads that would matter.
 */

const DIGEST = '0f3a91c4bd27e6153f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60';
const HASH12 = '0f3a91c4bd27';
const OTHER_DIGEST = 'aa11bb22cc33dd44ee55ff66007788990011223344556677889900aabbccddee';

const RUN_KEY = 'AF-2026-001-0f3a91c4bd27e615';
const REPO_KEY = `agent-flow-${HASH12}`;

/** Unwraps a success, failing the test with the refusal if there is not one. */
function value<T>(result: PolicyResult<T>): T {
  if (!result.ok) throw new Error(`expected a value, got ${result.refusal.code}`);
  return result.value;
}

/** The refusal code, or the value that arrived instead — so failures read well. */
function refusalOf(result: PolicyResult<unknown>): string {
  return result.ok ? `unexpected success: ${JSON.stringify(result.value)}` : result.refusal.code;
}

describe('repoKey identifies a repository on this machine (§5.1)', () => {
  it('joins a human-readable slug to twelve hex characters of the digest', () => {
    expect(value(repoKeyFromCanonicalRoot('/Users/me/wk/agent-flow', DIGEST))).toBe(
      'agent-flow-0f3a91c4bd27',
    );
  });

  it('lowercases the basename', () => {
    expect(value(repoKeyFromCanonicalRoot('/Users/me/wk/Agent-Flow', DIGEST))).toBe(
      'agent-flow-0f3a91c4bd27',
    );
  });

  it('replaces punctuation with separators and trims the result', () => {
    expect(value(repoKeyFromCanonicalRoot('/wk/my.repo_v2!', DIGEST))).toBe(
      'my-repo-v2-0f3a91c4bd27',
    );
  });

  it('drops characters outside [a-z0-9], including non-ASCII ones', () => {
    // The slug is decoration; identity is in the hash. A repository named in a
    // script this regex cannot represent still gets a distinct key.
    expect(value(repoKeyFromCanonicalRoot('/wk/café±ñ', DIGEST))).toBe('caf-0f3a91c4bd27');
  });

  it('collapses runs of separators', () => {
    expect(value(repoKeyFromCanonicalRoot('/wk/a---b', DIGEST))).toBe('a-b-0f3a91c4bd27');
  });

  it('trims leading and trailing separators', () => {
    expect(value(repoKeyFromCanonicalRoot('/wk/---abc---', DIGEST))).toBe('abc-0f3a91c4bd27');
  });

  it('falls back to a fixed slug when the basename survives as nothing', () => {
    expect(value(repoKeyFromCanonicalRoot('/', DIGEST))).toBe('repo-0f3a91c4bd27');
    expect(value(repoKeyFromCanonicalRoot('/wk/___', DIGEST))).toBe('repo-0f3a91c4bd27');
  });

  it('caps the slug at twenty-four characters', () => {
    const long = `/wk/${'abcdefghijklmnopqrstuvwxyz0123456789'}`;

    expect(value(repoKeyFromCanonicalRoot(long, DIGEST))).toBe(
      'abcdefghijklmnopqrstuvwx-0f3a91c4bd27',
    );
  });

  it('trims again when the cap lands on a separator', () => {
    // Truncating first and trimming once would leave `...uvw-` and a key with two
    // adjacent separators, which reads like an empty component.
    const awkward = '/wk/abcdefghijklmnopqrstuvw-xyz';

    expect(value(repoKeyFromCanonicalRoot(awkward, DIGEST))).toBe(
      'abcdefghijklmnopqrstuvw-0f3a91c4bd27',
    );
  });

  it('reads the basename on a Windows-shaped path too', () => {
    expect(value(repoKeyFromCanonicalRoot('C:\\Users\\me\\wk\\agent-flow', DIGEST))).toBe(
      'agent-flow-0f3a91c4bd27',
    );
  });

  it('is stable for one input and distinct for another repository', () => {
    const root = '/Users/me/wk/agent-flow';

    expect(value(repoKeyFromCanonicalRoot(root, DIGEST))).toBe(
      value(repoKeyFromCanonicalRoot(root, DIGEST)),
    );
    // Two clones of one upstream: same basename, different path, different digest.
    expect(value(repoKeyFromCanonicalRoot('/Users/me/other/agent-flow', OTHER_DIGEST))).not.toBe(
      value(repoKeyFromCanonicalRoot(root, DIGEST)),
    );
  });

  it('refuses a root it cannot name', () => {
    expect(refusalOf(repoKeyFromCanonicalRoot('', DIGEST))).toBe('invalid_canonical_root');
    expect(refusalOf(repoKeyFromCanonicalRoot('   ', DIGEST))).toBe('invalid_canonical_root');
  });

  it('refuses a digest that is not a full lowercase SHA-256', () => {
    for (const bad of [
      '',
      DIGEST.slice(0, 63),
      `${DIGEST}0`,
      DIGEST.toUpperCase(),
      `${'z'.repeat(64)}`,
      '../../etc/passwd',
    ]) {
      expect(refusalOf(repoKeyFromCanonicalRoot('/wk/repo', bad)), bad).toBe('invalid_repo_digest');
    }
  });
});

describe('gitRunKey is a run id plus supplied entropy (§5.2)', () => {
  it('composes the frozen shape', () => {
    expect(value(makeGitRunKey('AF-2026-001', '0f3a91c4bd27e615'))).toBe(RUN_KEY);
  });

  it('refuses a run id that is not AF-YYYY-NNN', () => {
    for (const bad of ['AF-2026-1', 'af-2026-001', 'AF-2026-0001', 'AF-2026-001-x', '']) {
      expect(refusalOf(makeGitRunKey(bad, '0f3a91c4bd27e615')), bad).toBe('invalid_run_id');
    }
  });

  it('refuses entropy of the wrong length', () => {
    expect(refusalOf(makeGitRunKey('AF-2026-001', '0f3a91c4bd27e61'))).toBe('invalid_run_entropy');
    expect(refusalOf(makeGitRunKey('AF-2026-001', '0f3a91c4bd27e6153'))).toBe(
      'invalid_run_entropy',
    );
  });

  it('refuses entropy that is not lowercase hex', () => {
    for (const bad of ['0F3A91C4BD27E615', 'zzzzzzzzzzzzzzzz', '0f3a91c4bd27e61 ', '']) {
      expect(refusalOf(makeGitRunKey('AF-2026-001', bad)), bad).toBe('invalid_run_entropy');
    }
  });

  it('refuses an injection payload in place of entropy', () => {
    for (const bad of ['--upload-pack=sh', '../../../x', '@{0}', 'a/b']) {
      expect(refusalOf(makeGitRunKey('AF-2026-001', bad)), bad).toBe('invalid_run_entropy');
    }
  });

  it('knows which run a namespace belongs to', () => {
    expect(gitRunKeyBelongsToRun(RUN_KEY, 'AF-2026-001')).toBe(true);
    // The failure this invariant exists for: a state file pairing a run with
    // another run's namespace.
    expect(gitRunKeyBelongsToRun(RUN_KEY, 'AF-2026-002')).toBe(false);
    expect(gitRunKeyBelongsToRun('AF-2026-0010f3a91c4bd27e615', 'AF-2026-001')).toBe(false);
    expect(gitRunKeyBelongsToRun('not-a-key', 'AF-2026-001')).toBe(false);
    expect(gitRunKeyBelongsToRun(RUN_KEY, 'nonsense')).toBe(false);
  });
});

describe('ref names are derived, never stored (§5.3)', () => {
  it('names the integration branch', () => {
    expect(value(integrationRef(RUN_KEY))).toBe(
      'agent-flow/AF-2026-001-0f3a91c4bd27e615/integration',
    );
  });

  it('names an attempt branch, for both task families', () => {
    expect(value(attemptRef(RUN_KEY, 'TASK-001', 1))).toBe(
      'agent-flow/AF-2026-001-0f3a91c4bd27e615/TASK-001/attempt-1',
    );
    expect(value(attemptRef(RUN_KEY, 'FIX-002', 3))).toBe(
      'agent-flow/AF-2026-001-0f3a91c4bd27e615/FIX-002/attempt-3',
    );
  });

  it('counts attempts beyond the first', () => {
    expect(value(attemptRef(RUN_KEY, 'TASK-001', 2))).toMatch(/\/attempt-2$/);
    expect(value(attemptRef(RUN_KEY, 'TASK-001', 999999))).toMatch(/\/attempt-999999$/);
  });

  it('refuses an attempt number that cannot name an attempt', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(refusalOf(attemptRef(RUN_KEY, 'TASK-001', bad)), String(bad)).toBe('invalid_attempt');
    }
  });

  it('refuses a run key carrying a ref-injection payload (S-2)', () => {
    for (const bad of [
      '--upload-pack=touch /tmp/pwned',
      'AF-2026-001-0f3a91c4bd27e615 --exec=sh',
      'AF-2026-001-0f3a91c4bd27e615/../../refs/heads/master',
      'AF-2026-001-0f3a91c4bd27e615@{0}',
      'AF-2026-001-0f3a91c4bd27e615.lock',
      '../AF-2026-001-0f3a91c4bd27e615',
      'AF-2026-001-0F3A91C4BD27E615',
      '',
    ]) {
      expect(refusalOf(integrationRef(bad)), bad).toBe('invalid_git_run_key');
      expect(refusalOf(attemptRef(bad, 'TASK-001', 1)), bad).toBe('invalid_git_run_key');
    }
  });

  it('refuses a task id carrying traversal or injection (S-1)', () => {
    // The plan's own contract already makes these impossible, and this proves it
    // rather than restating it as a second regex a maintainer would have to keep
    // in step. Every payload below is one that would matter if it reached a ref.
    for (const bad of [
      '../../etc/passwd',
      '..',
      '.',
      'TASK-001/../../x',
      'TASK-001\\..\\..\\x',
      '..\\..\\Windows\\System32',
      'C:\\Windows\\System32',
      'TASK-001 --exec=sh',
      'TASK-001@{0}',
      'TASK-001.lock',
      'TASK-001;rm -rf /',
      '-TASK-001',
      'TASK-1',
      'task-001',
      '',
      'TASK-001\n',
      `TASK-${'0'.repeat(300)}`,
    ]) {
      expect(refusalOf(attemptRef(RUN_KEY, bad, 1)), JSON.stringify(bad)).toBe('invalid_task_id');
    }
  });
});

describe('workspace locations are relative to a root this module never resolves (§7.2)', () => {
  it('places the integration worktree', () => {
    const location = value(integrationWorkspace(REPO_KEY, RUN_KEY));

    expect(location.segments).toEqual([
      'agent-flow-0f3a91c4bd27',
      'AF-2026-001-0f3a91c4bd27e615',
      'integration',
    ]);
    expect(location.relativePath).toBe(
      'agent-flow-0f3a91c4bd27/AF-2026-001-0f3a91c4bd27e615/integration',
    );
  });

  it('places an attempt worktree', () => {
    const location = value(attemptWorkspace(REPO_KEY, RUN_KEY, 'TASK-001', 2));

    expect(location.segments).toEqual([
      'agent-flow-0f3a91c4bd27',
      'AF-2026-001-0f3a91c4bd27e615',
      'TASK-001',
      'attempt-2',
    ]);
    expect(location.relativePath).toBe(
      'agent-flow-0f3a91c4bd27/AF-2026-001-0f3a91c4bd27e615/TASK-001/attempt-2',
    );
  });

  it('is relative, POSIX-joined, and free of anything a join could reinterpret', () => {
    // This is the value that lands in an attempt artifact. A leading separator
    // would make `join(root, value)` return `value`; a backslash or a `..` would
    // put the workspace somewhere the root does not contain.
    const paths = [
      value(integrationWorkspace(REPO_KEY, RUN_KEY)),
      value(attemptWorkspace(REPO_KEY, RUN_KEY, 'TASK-001', 1)),
      value(attemptWorkspace(REPO_KEY, RUN_KEY, 'FIX-999', 12)),
      value(attemptWorkspace('repo-000000000000', RUN_KEY, 'TASK-000', 7)),
    ];

    for (const location of paths) {
      expect(location.relativePath.startsWith('/')).toBe(false);
      expect(location.relativePath).not.toContain('\\');
      expect(location.relativePath).not.toContain('..');
      expect(location.relativePath).not.toContain('//');
      expect(location.relativePath.split('/')).toEqual(location.segments);
      expect(location.segments.every((segment) => segment.length > 0)).toBe(true);
    }
  });

  it('refuses a repository key it did not produce', () => {
    for (const bad of [
      '',
      'repo',
      'Repo-0f3a91c4bd27',
      'repo-XYZ456789012',
      'repo-0f3a91c4bd2',
      '../etc-0f3a91c4bd27',
      '-repo-0f3a91c4bd27',
      'repo-0f3a91c4bd27/../x',
      'repo 0f3a91c4bd27',
      `${'a'.repeat(25)}-0f3a91c4bd27`,
    ]) {
      expect(refusalOf(integrationWorkspace(bad, RUN_KEY)), bad).toBe('invalid_repo_key');
      expect(refusalOf(attemptWorkspace(bad, RUN_KEY, 'TASK-001', 1)), bad).toBe(
        'invalid_repo_key',
      );
    }
  });

  it('accepts every key repoKeyFromCanonicalRoot can produce', () => {
    // The two halves of §5.1 have to agree: a key composed here must be one the
    // path builder will take back. A stricter validator than the producer would
    // be a refusal that only ever fires on Agent Flow's own output.
    for (const root of ['/', '/wk/agent-flow', '/wk/---abc---', '/wk/café±ñ', `/wk/${'x'.repeat(80)}`]) {
      const repoKey = value(repoKeyFromCanonicalRoot(root, DIGEST));

      expect(integrationWorkspace(repoKey, RUN_KEY).ok, repoKey).toBe(true);
    }
  });

  it('refuses the same task ids the ref builder refuses', () => {
    for (const bad of ['../../etc', 'TASK-001/../x', '..', 'TASK-001 --exec=sh', '']) {
      expect(refusalOf(attemptWorkspace(REPO_KEY, RUN_KEY, bad, 1)), bad).toBe('invalid_task_id');
    }
  });

  it('refuses attempt numbers the ref builder refuses', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(refusalOf(attemptWorkspace(REPO_KEY, RUN_KEY, 'TASK-001', bad)), String(bad)).toBe(
        'invalid_attempt',
      );
    }
  });
});
