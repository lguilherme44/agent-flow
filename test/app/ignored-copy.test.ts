import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { gitFailure, gitOk, type GitResult } from '../../src/adapters/git/git-command.js';
import {
  copyIgnoredFiles,
  describeIgnoredCopyFailure,
  type IgnoredCopyDeps,
  type IgnoredCopyOutcome,
} from '../../src/app/ignored-copy.js';

/**
 * N2's copy, against a fake filesystem and a scripted Git answer. What Git lists and what
 * `:(glob)` means is real-Git territory, in `git-workspaces.integration.test.ts`; this file
 * is about what the helper does with a listing — which checks refuse, what they leave
 * behind, and what a refusal is allowed to say.
 */

const FROM = '/repo';
const TO = '/wt';

interface Scripted {
  readonly listed?: GitResult<readonly string[]>;
  /** Paths `check-ignore` in `to` reports as not ignored. Everything else is ignored. */
  readonly notIgnored?: readonly string[];
  readonly ignoreCheck?: GitResult<boolean>;
}

function gitScript(script: Scripted) {
  const calls: { op: 'list' | 'check'; cwd: string; value: string }[] = [];
  const workspaces: IgnoredCopyDeps['workspaces'] = {
    listIgnoredFiles: async ({ cwd, patterns }) => {
      calls.push({ op: 'list', cwd, value: patterns.join(',') });
      return script.listed ?? gitOk([]);
    },
    isIgnored: async ({ cwd, path }) => {
      calls.push({ op: 'check', cwd, value: path });
      return script.ignoreCheck ?? gitOk(!(script.notIgnored ?? []).includes(path));
    },
  };
  return { workspaces, calls };
}

function failed(outcome: IgnoredCopyOutcome) {
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome;
}

/** Everything a refusal carries, as the caller would persist it. */
function persisted(outcome: IgnoredCopyOutcome): string {
  const refusal = failed(outcome);
  return JSON.stringify({ ...refusal, detail: describeIgnoredCopyFailure(refusal) });
}

describe('copying the declared ignored files (N2, FR-014)', () => {
  it('copies each listed file to the same relative path, and checks it in `to`', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${FROM}/.env.test`, 'A=1\r\nB=2\r\n');
    fs.seed(`${FROM}/config/local/secrets.json`, '{"k":1}');
    fs.seed(`${FROM}/undeclared.json`, 'no');
    const { workspaces, calls } = gitScript({ listed: gitOk(['.env.test', 'config/local/secrets.json']) });

    const outcome = await copyIgnoredFiles(
      { fs, workspaces },
      { from: FROM, to: TO, patterns: ['.env.test', 'config/**'] },
    );

    expect(outcome).toEqual({ ok: true, count: 2 });
    expect(await fs.readFile(`${TO}/.env.test`)).toBe('A=1\r\nB=2\r\n');
    expect(await fs.readFile(`${TO}/config/local/secrets.json`)).toBe('{"k":1}');
    // Only what Git listed: a file the patterns did not match stays behind.
    expect(await fs.exists(`${TO}/undeclared.json`)).toBe(false);
    // One listing in `from`, then one check per copied file in `to` (NFR-003).
    expect(calls).toEqual([
      { op: 'list', cwd: FROM, value: '.env.test,config/**' },
      { op: 'check', cwd: TO, value: '.env.test' },
      { op: 'check', cwd: TO, value: 'config/local/secrets.json' },
    ]);
  });

  it('asks Git nothing for no patterns', async () => {
    const { workspaces, calls } = gitScript({ listed: gitOk(['.env.test']) });

    const outcome = await copyIgnoredFiles(
      { fs: new InMemoryFileSystem(), workspaces },
      { from: FROM, to: TO, patterns: [] },
    );

    expect(outcome).toEqual({ ok: true, count: 0 });
    expect(calls).toEqual([]);
  });

  it('succeeds, copying nothing, when the patterns match nothing (FR-016)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${FROM}/README.md`, 'x');
    const before = fs.snapshot();
    const { workspaces } = gitScript({ listed: gitOk([]) });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['nothing/**'] });

    expect(outcome).toEqual({ ok: true, count: 0 });
    expect(fs.snapshot()).toEqual(before);
  });
});

describe('what refuses the copy, and what a refusal leaves behind (FR-015, SEC-006)', () => {
  it('refuses a listed source that a symlink carries outside `from`, writing nothing', async () => {
    const fs = new InMemoryFileSystem();
    // Listed first and legitimate, so a check made inside the copy loop would already
    // have written it by the time the bad one came up.
    fs.seed(`${FROM}/.env.test`, 'fine');
    fs.seed('/home/dev/.ssh/id_ed25519', 'PRIVATE');
    fs.link(`${FROM}/leak.env`, '/home/dev/.ssh/id_ed25519');
    const before = fs.snapshot();
    const { workspaces, calls } = gitScript({ listed: gitOk(['.env.test', 'leak.env']) });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['*.env*'] });

    expect(failed(outcome).code).toBe('source_outside');
    expect(failed(outcome).count).toBe(0);
    expect(fs.snapshot()).toEqual(before);
    expect(await fs.exists(`${TO}/.env.test`)).toBe(false);
    // Refused before any check in `to`, because nothing reached it.
    expect(calls.filter((call) => call.op === 'check')).toEqual([]);
    expect(persisted(outcome)).not.toContain('/');
  });

  it('copies a symlink that stays inside `from` (positive control for the refusal above)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${FROM}/secrets/real.env`, 'inside');
    fs.link(`${FROM}/alias.env`, `${FROM}/secrets/real.env`);
    const { workspaces } = gitScript({ listed: gitOk(['alias.env']) });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['alias.env'] });

    expect(outcome).toEqual({ ok: true, count: 1 });
    expect(await fs.readFile(`${TO}/alias.env`)).toBe('inside');
  });

  it('refuses a destination that already exists, overwriting and writing nothing', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${FROM}/.env.test`, 'from the checkout');
    fs.seed(`${FROM}/.env.local`, 'also from the checkout');
    // A tracked file of the same name, checked out by `worktree add`.
    fs.seed(`${TO}/.env.local`, 'tracked');
    const before = fs.snapshot();
    const { workspaces } = gitScript({ listed: gitOk(['.env.test', '.env.local']) });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['.env.*'] });

    expect(failed(outcome).code).toBe('destination_exists');
    expect(failed(outcome).count).toBe(0);
    expect(fs.snapshot()).toEqual(before);
    expect(await fs.readFile(`${TO}/.env.local`)).toBe('tracked');
    expect(persisted(outcome)).not.toContain('/');
    expect(persisted(outcome)).not.toContain('.env');
  });

  it('refuses a source that cannot be resolved, rather than guessing its containment', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${FROM}/present`, 'x');
    const { workspaces } = gitScript({ listed: gitOk(['vanished.env']) });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['*.env'] });

    expect(failed(outcome).code).toBe('source_unresolvable');
  });

  it('reports the count copied before a failure partway through, and no path', async () => {
    const fs = new (class extends InMemoryFileSystem {
      override async copyFile(from: string, to: string): Promise<void> {
        if (from.endsWith('/b.env')) throw new Error(`EACCES: permission denied, copyfile '${from}' -> '${to}'`);
        return super.copyFile(from, to);
      }
    })();
    fs.seed(`${FROM}/a.env`, 'a');
    fs.seed(`${FROM}/b.env`, 'b');
    fs.seed(`${FROM}/c.env`, 'c');
    const { workspaces } = gitScript({ listed: gitOk(['a.env', 'b.env', 'c.env']) });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['*.env'] });

    expect(failed(outcome).code).toBe('copy_failed');
    expect(failed(outcome).count).toBe(1);
    const detail = describeIgnoredCopyFailure(failed(outcome));
    expect(detail).toContain('1 file copied before it');
    // The error named both absolute paths; none of it reaches the refusal.
    expect(persisted(outcome)).not.toContain('/');
    expect(persisted(outcome)).not.toContain('EACCES');
    expect(persisted(outcome)).not.toContain('b.env');
  });
});

describe('a copied file must stay ignored where it lands (SEC-005, FR-019)', () => {
  it('refuses when a destination is not ignored in `to`, with the count copied', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${FROM}/.env.test`, 'x');
    fs.seed(`${FROM}/other.env`, 'y');
    const { workspaces } = gitScript({ listed: gitOk(['.env.test', 'other.env']), notIgnored: ['other.env'] });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['*'] });

    expect(failed(outcome).code).toBe('not_ignored');
    expect(failed(outcome).count).toBe(2);
    expect(persisted(outcome)).not.toContain('other.env');
  });

  it('refuses when the ignore check itself fails, naming the Git code only', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${FROM}/.env.test`, 'x');
    const { workspaces } = gitScript({
      listed: gitOk(['.env.test']),
      ignoreCheck: gitFailure({
        code: 'git_command_failed',
        message: `git check-ignore exited 128: fatal: not a git repository: ${TO}/.git`,
        stderr: `fatal: not a git repository: ${TO}/.git`,
      }),
    });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['.env.test'] });

    expect(failed(outcome).code).toBe('ignore_check_failed');
    const detail = describeIgnoredCopyFailure(failed(outcome));
    expect(detail).toContain('git_command_failed');
    expect(persisted(outcome)).not.toContain('fatal');
    expect(persisted(outcome)).not.toContain(TO);
  });
});

describe('a listing failure (FR-016)', () => {
  it('refuses with the Git failure code, and never the stderr', async () => {
    const fs = new InMemoryFileSystem();
    const before = fs.snapshot();
    const { workspaces } = gitScript({
      listed: gitFailure({
        code: 'git_timed_out',
        message: `git ls-files exceeded its timeout in ${FROM}`,
        stderr: `warning: could not open directory '${FROM}/private/'`,
      }),
    });

    const outcome = await copyIgnoredFiles({ fs, workspaces }, { from: FROM, to: TO, patterns: ['**/*'] });

    expect(failed(outcome).code).toBe('list_failed');
    expect(describeIgnoredCopyFailure(failed(outcome))).toContain('git_timed_out');
    expect(persisted(outcome)).not.toContain(FROM);
    expect(persisted(outcome)).not.toContain('warning');
    expect(fs.snapshot()).toEqual(before);
  });
});
