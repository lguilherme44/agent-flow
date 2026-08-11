import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import {
  ExecutionLockSchema,
  LOCK_VERSION,
  RunExecutionLock,
} from '../../src/app/run-execution-lock.js';

/**
 * AF-L01 — the lock's *policy*.
 *
 * What this file can prove: which lock is refused, which is recovered, which is left
 * alone, and what the metadata says. What it cannot prove is mutual exclusion — an
 * in-memory map is single-threaded and has no TOCTOU window to lose, so a green run
 * here says nothing about two real processes. `run-execution-lock.race.test.ts`
 * spawns those.
 */

const RUN = 'AF-2026-001';

function lockFor(options: { fs?: InMemoryFileSystem; host?: FakeHost } = {}) {
  const fs = options.fs ?? new InMemoryFileSystem();
  const host = options.host ?? new FakeHost(4242, 'laptop', [4242]);

  const lock = new RunExecutionLock({
    fs,
    clock: new FixedClock(),
    host,
    projectDir: '/repo',
  });

  return {
    fs,
    host,
    lock,
    // The holder is whoever owns the highest generation. A test that seeds one seeds
    // generation 1; a test that reads the winner's file reads the generation it took.
    path: (generation = 1) => `/repo/.agent-flow/runs/${RUN}/execution.lock.${String(generation)}`,
  };
}

describe('acquiring', () => {
  it('writes the diagnostic metadata a refusal will need', async () => {
    const { fs, lock, path } = lockFor();

    const result = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    expect(result.ok).toBe(true);

    const parsed = ExecutionLockSchema.parse(JSON.parse(await fs.readFile(path())));
    expect(parsed).toMatchObject({
      version: LOCK_VERSION,
      runId: RUN,
      pid: 4242,
      hostname: 'laptop',
      owner: 'cli',
      operation: 'run',
    });
    expect(parsed.createdAt).toBeTruthy();
  });

  it('carries no path, command or environment', async () => {
    // A lock file is read by whoever is refused, and printed to them. It holds a pid,
    // a hostname and two enums — nothing a diagnostic message should not contain.
    const { fs, lock, path } = lockFor();
    await lock.acquire({ runId: RUN, owner: 'server', operation: 'run' });

    const raw = await fs.readFile(path());
    expect(raw).not.toMatch(/\/repo|\/Users|command|cwd|env|token|secret/i);
  });

  it('refuses a second acquisition while the holder is alive', async () => {
    const { lock, host } = lockFor();
    host.spawn(4242);

    const first = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    const second = await lock.acquire({ runId: RUN, owner: 'server', operation: 'run' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;

    expect(second.refusal).toMatchObject({
      runId: RUN,
      sameHost: true,
      holderAlive: true,
      holder: { owner: 'cli', operation: 'run', pid: 4242 },
    });
  });

  it('locks each run separately', async () => {
    // A lock per run rather than per project: two runs are two pieces of work, and
    // the pointer in `current-run` is what stops them being started at once anyway.
    const { lock } = lockFor();

    expect((await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' })).ok).toBe(true);
    expect(
      (await lock.acquire({ runId: 'AF-2026-002', owner: 'cli', operation: 'run' })).ok,
    ).toBe(true);
  });

  it('lets the next caller in after a release', async () => {
    const { lock } = lockFor();

    const first = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await first.lease.release();

    const second = await lock.acquire({ runId: RUN, owner: 'server', operation: 'revise' });
    expect(second.ok).toBe(true);
  });
});

describe('staleness', () => {
  it('reclaims a lock whose process is gone, and says it did', async () => {
    const { fs, lock, host, path } = lockFor();

    // A previous execution that never released: Ctrl-C, a crash, a lost terminal.
    // There is no heartbeat to have expired — the pid is the liveness signal.
    fs.seed(
      path(),
      JSON.stringify({
        version: LOCK_VERSION,
        generation: 1,
        runId: RUN,
        pid: 999,
        hostname: 'laptop',
        owner: 'cli',
        operation: 'run',
        createdAt: '2026-08-10T19:00:00.000Z',
      }),
    );
    expect(host.isAlive(999)).toBe(false);

    const result = await lock.acquire({ runId: RUN, owner: 'server', operation: 'run' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reported rather than silent: reclaiming without a trace leaves no record that a
    // previous execution of this run ended without releasing anything.
    expect(result.lease.recoveredStale).toMatchObject({ pid: 999, owner: 'cli' });
    expect(result.lease.lock.pid).toBe(4242);
  });

  it('supersedes the stale generation and tidies it away', async () => {
    const { fs, lock, path } = lockFor();
    fs.seed(
      path(),
      JSON.stringify({
        version: LOCK_VERSION,
        generation: 1,
        runId: RUN,
        pid: 999,
        hostname: 'laptop',
        owner: 'cli',
        operation: 'run',
        createdAt: '2026-08-10T19:00:00.000Z',
      }),
    );

    const result = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Generation 2 is the holder, and generation 1 is gone. The tidy-up happens only
    // after the claim has been confirmed as the highest, which is what makes deleting
    // a lower generation safe: its owner is by definition not the holder.
    expect(result.lease.lock.generation).toBe(2);

    const dir = await fs.readDir(`/repo/.agent-flow/runs/${RUN}`);
    expect(dir.filter((entry) => entry.startsWith('execution.lock'))).toEqual([
      'execution.lock.2',
    ]);
  });

  it('reports a run whose holder has died as free', async () => {
    const { fs, lock, path } = lockFor();
    fs.seed(
      path(),
      JSON.stringify({
        version: LOCK_VERSION,
        generation: 1,
        runId: RUN,
        pid: 999,
        hostname: 'laptop',
        owner: 'cli',
        operation: 'run',
        createdAt: '2026-08-10T19:00:00.000Z',
      }),
    );

    // `describe` is the server's pre-flight read. A dead holder is not a holder, and
    // reporting it as busy would refuse a run for no reason.
    expect(await lock.describe(RUN)).toBeUndefined();
  });
});

describe('a lock from another machine', () => {
  const foreign = JSON.stringify({
    version: LOCK_VERSION,
    generation: 1,
    runId: RUN,
    pid: 4242,
    hostname: 'someone-elses-laptop',
    owner: 'server',
    operation: 'run',
    createdAt: '2026-08-10T19:00:00.000Z',
  });

  it('is never stolen, even when the pid looks dead here', async () => {
    const { fs, lock, path } = lockFor();
    fs.seed(path(), foreign);

    // The pid in that file is *this* process's pid, and it means nothing: it names a
    // process on another machine. Judging it locally is how a run gets executed
    // twice, so Agent Flow does not — this is not a distributed lock and does not
    // pretend to be one.
    const result = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.sameHost).toBe(false);
    // No local liveness answer, because none was attempted.
    expect(result.refusal.holderAlive).toBeUndefined();
    // And the file is untouched.
    expect(await fs.readFile(path())).toBe(foreign);
  });

  it('is reported as held by describe as well', async () => {
    const { fs, lock, path } = lockFor();
    fs.seed(path(), foreign);

    expect(await lock.describe(RUN)).toMatchObject({ sameHost: false });
  });
});

describe('a lock file that will not parse', () => {
  it('is treated as held rather than as absent', async () => {
    const { fs, lock, path } = lockFor();
    fs.seed(path(), 'not json at all');

    // Something wrote it. Inventing a reason to delete it is the one move that could
    // let a second execution start, so acquisition fails and the message says the
    // lock could not be read.
    const result = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.holder).toBeUndefined();
    expect(await fs.readFile(path())).toBe('not json at all');
  });
});

describe('releasing', () => {
  it('cannot delete a lock that is no longer ours', async () => {
    const { fs, lock, path } = lockFor();

    const first = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Somebody judged us stale and superseded us. Release removes *our generation*
    // rather than "the lock", so there is no version of it that could take theirs —
    // which is why nothing here has to compare identities before deleting, and why the
    // whole class of "I deleted a live holder's lock" bugs is gone rather than guarded.
    const theirs = JSON.stringify({
      version: LOCK_VERSION,
      generation: 2,
      runId: RUN,
      pid: 7777,
      hostname: 'laptop',
      owner: 'server',
      operation: 'run',
      createdAt: '2026-08-10T20:00:00.000Z',
    });
    fs.seed(path(2), theirs);

    await first.lease.release();

    expect(await fs.readFile(path(2))).toBe(theirs);
    expect(await fs.exists(path(1))).toBe(false);
  });

  it('is safe to call when the lock has already gone', async () => {
    const { fs, lock, path } = lockFor();

    const first = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await fs.remove(path());
    await expect(first.lease.release()).resolves.toBeUndefined();
  });
});
