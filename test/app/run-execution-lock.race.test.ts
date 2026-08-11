import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { NodeHost } from '../../src/adapters/host/node-host.js';
import { SystemClock } from '../../src/adapters/clock/system-clock.js';
import { RunExecutionLock, LOCK_VERSION } from '../../src/app/run-execution-lock.js';

/**
 * AF-L01 — mutual exclusion, proved with real processes and a real filesystem.
 *
 * The policy tests next door run against an in-memory map, which is single-threaded
 * and therefore has no race to lose: they can show that a dead pid is reclaimed and a
 * foreign host is left alone, and they cannot show that two processes cannot both
 * acquire. That is the only claim that matters, and the only way to make it is to run
 * two processes.
 *
 * So the lock is bundled with esbuild — the same bundler the CLI ships through — into
 * a script that acquires and prints the answer, and N copies of it are spawned at
 * once against one lock file on the real disk. Nothing here is simulated: separate
 * OS processes, separate address spaces, one `open(path, 'wx')` each.
 *
 * The three tests in the first block are the ones to read. Everything after them is
 * detail.
 */

let dir: string;
let harness: string;

/**
 * A standalone script that takes the lock, waits, and releases.
 *
 * Bundled rather than run through a TypeScript loader, so the child is plain Node with
 * no dependency on how the test runner happens to resolve modules — and so what runs
 * in the child is the same code the CLI would run.
 *
 * The imports are absolute, resolved at test time: a relative specifier would resolve
 * against the temp directory the entry is written into rather than against the repo.
 */
function harnessSource(root: string): string {
  return `
import { NodeFileSystem } from '${root}/src/adapters/fs/node-file-system.ts';
import { NodeHost } from '${root}/src/adapters/host/node-host.ts';
import { SystemClock } from '${root}/src/adapters/clock/system-clock.ts';
import { RunExecutionLock } from '${root}/src/app/run-execution-lock.ts';

const [projectDir, runId, holdMs, mode] = process.argv.slice(2);

const lock = new RunExecutionLock({
  fs: new NodeFileSystem(),
  clock: new SystemClock(),
  host: new NodeHost(),
  projectDir,
});

const result = await lock.acquire({ runId, owner: 'cli', operation: 'run' });

if (!result.ok) {
  process.stdout.write('REFUSED ' + JSON.stringify(result.refusal) + '\\n');
  process.exit(3);
}

process.stdout.write(
  'ACQUIRED ' + String(process.pid) + ' ' + String(Date.now()) +
  ' gen=' + String(result.lease.lock.generation) + '\\n',
);

// 'abandon' leaves the lock behind without releasing, which is what a killed process
// does. Used to make a genuinely stale lock rather than a hand-written one.
if (mode === 'abandon') {
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  process.exit(0);
}

await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));

// Stamped *before* releasing, not after. The recorded interval has to be a subset of
// the real one, or a slow unlink makes it look as though the next process got in while
// we still held it — a measurement artifact that reads exactly like the bug this test
// is for. Erring the other way is safe: a recorded overlap then means a real one.
const heldUntil = Date.now();
await result.lease.release();
process.stdout.write('RELEASED ' + String(heldUntil) + '\\n');
`;
}

/**
 * Maps a NodeNext `.js` specifier onto the `.ts` file it means.
 *
 * `src/**` imports its siblings with `.js` extensions, which is correct for Node and
 * meaningless to a bundler pointed at TypeScript. Ten lines here, instead of a
 * separate build step, keeps the child running the same sources the suite does.
 */
const resolveTypeScript = {
  name: 'ts-from-js',
  setup(builder: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string; resolveDir: string }) => { path: string } | null,
    ): void;
  }): void {
    builder.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.')) return null;
      const candidate = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts');
      return existsSync(candidate) ? { path: candidate } : null;
    });
  },
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-lock-race-'));

  const root = join(import.meta.dirname, '../..');
  const entry = join(dir, 'harness.entry.mjs');
  await writeFile(entry, harnessSource(root), 'utf8');

  harness = join(dir, 'harness.mjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: harness,
    absWorkingDir: root,
    plugins: [resolveTypeScript],
    logLevel: 'silent',
  });
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let projects = 0;

/** A fresh project directory per test, so no two share a lock file. */
function project(): string {
  projects += 1;
  return join(dir, `project-${String(projects)}`);
}

const RUN = 'AF-2026-001';

interface Attempt {
  readonly stdout: string;
  readonly code: number | null;
}

/** Spawns the harness. Returns when it exits. */
function attempt(projectDir: string, holdMs: number, mode = 'release'): Promise<Attempt> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [harness, projectDir, RUN, String(holdMs), mode],
      (error, stdout) => {
        resolve({
          stdout,
          code: error === null ? 0 : ((error as { code?: number }).code ?? null),
        });
      },
    );
  });
}

/**
 * When each process held the lock.
 *
 * The invariant mutual exclusion actually asserts is that no two of these overlap —
 * *not* that only one process ever acquires. A refused process retries after a stale
 * reclaim, and a retry that lands after the holder released is a perfectly correct
 * second acquisition. Counting acquisitions instead of checking overlap made this
 * suite fail on behaviour that was right.
 */
interface Held {
  readonly pid: number;
  readonly from: number;
  readonly to: number;
}

function heldIntervals(results: readonly Attempt[]): Held[] {
  // `from` is stamped after acquisition returns and `to` before release begins, so
  // every interval here sits strictly inside the time the lock was actually held.
  const held: Held[] = [];

  for (const result of results) {
    const acquired = /^ACQUIRED (\d+) (\d+)/m.exec(result.stdout);
    if (acquired === null) continue;

    const released = /^RELEASED (\d+)/m.exec(result.stdout);
    held.push({
      pid: Number(acquired[1]),
      from: Number(acquired[2]),
      // No release line means the process abandoned the lock, so it held it until it
      // exited — treated as open-ended, which is the conservative reading.
      to: released === null ? Number.POSITIVE_INFINITY : Number(released[1]),
    });
  }

  return held.sort((a, b) => a.from - b.from);
}

/** Every pair of holders that were inside the lock at the same time. Must be empty. */
function overlaps(held: readonly Held[]): string[] {
  const found: string[] = [];

  for (let index = 1; index < held.length; index += 1) {
    const previous = held[index - 1];
    const current = held[index];
    if (previous === undefined || current === undefined) continue;
    if (current.from < previous.to) {
      found.push(`pid ${String(previous.pid)} and pid ${String(current.pid)}`);
    }
  }

  return found;
}

/** The generation files present, ascending. The holder owns the highest. */
async function generations(projectDir: string): Promise<number[]> {
  const entries = await readdir(join(projectDir, '.agent-flow', 'runs', RUN)).catch(() => []);
  return entries
    .map((entry) => /^execution\.lock\.(\d+)$/.exec(entry)?.[1])
    .filter((match): match is string => match !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function lockPath(projectDir: string, generation: number): string {
  return join(projectDir, '.agent-flow', 'runs', RUN, `execution.lock.${String(generation)}`);
}

function inProcessLock(projectDir: string): RunExecutionLock {
  return new RunExecutionLock({
    fs: new NodeFileSystem(),
    clock: new SystemClock(),
    host: new NodeHost(),
    projectDir,
  });
}

afterEach(() => {
  // Nothing to reset: every test gets its own project directory.
});

describe('two real processes, one run', () => {
  it('lets exactly one of eight concurrent processes in', async () => {
    // The test this whole mechanism exists for. Eight separate OS processes, started
    // together, racing for one lock file. `exists()` then `write()` would let several
    // through here; `open(path, 'wx')` cannot.
    const projectDir = project();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => attempt(projectDir, 250)),
    );

    const held = heldIntervals(results);
    const refused = results.filter((result) => result.stdout.startsWith('REFUSED'));

    // Exactly one gets in, and the other seven are told who has it. With a 250ms hold
    // and an immediate refusal for a live holder, nobody has a chance to retry into a
    // released lock — so the count is meaningful here as well as the overlap.
    expect(held).toHaveLength(1);
    expect(refused).toHaveLength(7);
    expect(overlaps(held)).toEqual([]);

    for (const result of refused) {
      expect(result.stdout).toContain('"sameHost":true');
      expect(result.stdout).toContain('"holderAlive":true');
      expect(result.code).toBe(3);
    }
  }, 60_000);

  it('refuses a second process while the first is still holding', async () => {
    const projectDir = project();

    const first = attempt(projectDir, 900);
    // Long enough for the first to have the lock, short enough to still be inside its
    // hold window.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await attempt(projectDir, 0);

    expect(second.stdout).toMatch(/^REFUSED/);
    expect(second.code).toBe(3);

    const held = JSON.parse(second.stdout.replace('REFUSED ', '')) as {
      holder: { pid: number; owner: string; operation: string };
      holderAlive: boolean;
    };
    expect(held.holderAlive).toBe(true);
    expect(held.holder.owner).toBe('cli');
    expect(held.holder.operation).toBe('run');

    const finished = await first;
    expect(finished.stdout).toContain('RELEASED');
  }, 60_000);

  it('lets the next process in once the first releases', async () => {
    const projectDir = project();

    const first = await attempt(projectDir, 0);
    expect(first.stdout).toMatch(/^ACQUIRED/);
    expect(first.stdout).toContain('RELEASED');
    // Released means gone from disk, not merely marked.
    expect(await generations(projectDir)).toEqual([]);

    const second = await attempt(projectDir, 0);
    expect(second.stdout).toMatch(/^ACQUIRED/);
  }, 60_000);
});

describe('a process that died holding the lock', () => {
  it('leaves a lock that the next acquisition recovers', async () => {
    const projectDir = project();

    // A real abandonment: the child takes the lock and exits without releasing, which
    // is what Ctrl-C, a crash and SIGKILL all look like from here. No heartbeat has
    // expired, because there is no heartbeat — the pid is the liveness signal.
    const abandoned = await attempt(projectDir, 0, 'abandon');
    expect(abandoned.stdout).toMatch(/^ACQUIRED/);
    expect(await generations(projectDir)).toEqual([1]);

    const stale = JSON.parse(await readFile(lockPath(projectDir, 1), 'utf8')) as { pid: number };
    // The pid is real and the process is genuinely gone.
    expect(new NodeHost().isAlive(stale.pid)).toBe(false);

    const result = await inProcessLock(projectDir).acquire({
      runId: RUN,
      owner: 'server',
      operation: 'run',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.recoveredStale?.pid).toBe(stale.pid);
    // Superseded rather than deleted-then-recreated: generation 2 is the holder and
    // generation 1 is tidied away only after that claim was confirmed as the highest.
    expect(result.lease.lock.generation).toBe(2);
    expect(await generations(projectDir)).toEqual([2]);
  }, 60_000);

  it('is recovered by exactly one of several processes racing for it', async () => {
    // The second race, and the subtler one. Every process agrees the lock is stale,
    // so every one of them tries to claim it. `remove` then `create` would let a
    // second process delete the winner's *fresh* lock and believe it had won too;
    // moving the stale file aside with `rename` can only succeed once.
    const projectDir = project();

    const abandoned = await attempt(projectDir, 0, 'abandon');
    expect(abandoned.stdout).toMatch(/^ACQUIRED/);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => attempt(projectDir, 250)),
    );

    const held = heldIntervals(results);

    // At least one gets in — the stale lock does not block the run forever.
    expect(held.length).toBeGreaterThanOrEqual(1);
    // And no two are ever inside it together, which is the whole claim. More than one
    // *acquisition* is legitimate here: a process refused during the reclaim retries,
    // and a retry that lands after the holder released is correct. What must never
    // happen is two holders at once.
    expect(overlaps(held)).toEqual([]);
    // Nobody ended up holding a lock somebody else had reclaimed underneath them.
    expect(new Set(held.map((entry) => entry.pid)).size).toBe(held.length);
  }, 60_000);
});

describe('a lock written by another machine', () => {
  it('is not stolen, even though the pid is not alive here', async () => {
    const projectDir = project();
    const fs = new NodeFileSystem();

    await fs.writeFileAtomic(
      lockPath(projectDir, 1),
      `${JSON.stringify({
        version: LOCK_VERSION,
        generation: 1,
        runId: RUN,
        pid: 424_242,
        hostname: 'a-different-machine',
        owner: 'server',
        operation: 'run',
        createdAt: '2026-08-10T19:00:00.000Z',
      })}\n`,
    );

    const result = await attempt(projectDir, 0);

    // Conservative on purpose. A pid from another host names a local process that
    // happens to share the number, and acting on that is how a run gets executed
    // twice. Agent Flow is local-first and this is not a distributed lock.
    expect(result.stdout).toMatch(/^REFUSED/);
    expect(result.stdout).toContain('"sameHost":false');
    expect(JSON.parse(await readFile(lockPath(projectDir, 1), 'utf8'))).toMatchObject({
      hostname: 'a-different-machine',
    });
  }, 60_000);
});

describe('release on the way out', () => {
  it('releases when the work throws', async () => {
    // The `finally` in `withExecutionLock` is what makes this hold, and it is checked
    // here at the lock's own level too: a lease released in a `finally` leaves nothing
    // behind for the next caller to have to recover.
    const projectDir = project();
    const lock = inProcessLock(projectDir);

    const acquired = await lock.acquire({ runId: RUN, owner: 'cli', operation: 'run' });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    await expect(
      (async () => {
        try {
          throw new Error('the scheduler blew up');
        } finally {
          await acquired.lease.release();
        }
      })(),
    ).rejects.toThrow('the scheduler blew up');

    expect(await generations(projectDir)).toEqual([]);
    const next = await attempt(projectDir, 0);
    expect(next.stdout).toMatch(/^ACQUIRED/);
  }, 60_000);
});
