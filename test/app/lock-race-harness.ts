import { spawn } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

/**
 * The machinery for racing real processes at one lock file (AF-L01).
 *
 * Shared by the race suite and the opt-in stress run, so there is one description of
 * how a child takes the lock rather than two that can drift. Everything here is
 * mechanical — spawning, timing, scanning the directory. Every assertion lives in the
 * test files, because that is what a reader should be able to find in one place.
 */

export const RUN = 'AF-2026-001';

/**
 * A standalone script that takes the lock, waits, and releases.
 *
 * Bundled rather than run through a TypeScript loader, so the child is plain Node with
 * no dependency on how the test runner happens to resolve modules — and so what runs
 * in the child is the same code the CLI would run.
 *
 * The imports are absolute, resolved at build time: a relative specifier would resolve
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

// The barrier. Everything expensive — process start-up, the module graph, the
// lock object — is done by the time READY is written, so what happens after GO
// is the acquisition and nothing else.
//
// On stderr, deliberately: stdout carries the result the assertions parse, and
// putting a handshake line in front of ACQUIRED would change what every existing
// test reads.
process.stderr.write('READY\\n');

await new Promise((resolve) => {
  let seen = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    seen += chunk;
    if (seen.includes('GO')) resolve(undefined);
  });
  // A closed stdin means the parent is not coordinating this one — proceed
  // rather than hang, so a caller that wants one child does not need the dance.
  process.stdin.on('end', () => resolve(undefined));
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

export interface Harness {
  /** Temp root holding the bundle and every project directory. Remove when done. */
  readonly dir: string;
  /** A fresh project directory, so no two tests share a lock file. */
  project(): string;
  /** Spawns one child, releases it immediately, and resolves when it exits. */
  attempt(projectDir: string, holdMs: number, mode?: string): Promise<Attempt>;
  /**
   * Spawns `contenders` children, waits for every one to report READY, and only
   * then releases them together.
   *
   * This is what makes "exactly one gets in" a statement about the lock rather
   * than about process start-up. Without it the eight children reach `acquire()`
   * whenever the scheduler gets to them, and under load a straggler can arrive
   * after the winner has already released — a second acquisition that is
   * perfectly correct and that a count-based assertion reads as a failure.
   */
  race(projectDir: string, contenders: number, holdMs: number): Promise<Attempt[]>;
  /** The generation files present in a project, ascending. */
  generations(projectDir: string): Promise<number[]>;
  lockPath(projectDir: string, generation: number): string;
}

export interface Attempt {
  readonly stdout: string;
  readonly code: number | null;
}

interface Contender {
  /** Resolves when the child has announced it is ready to acquire. */
  readonly ready: Promise<void>;
  /** Releases the child from the barrier. */
  go(): void;
  readonly finished: Promise<Attempt>;
}

/**
 * One contender, held at the barrier until `go()`.
 *
 * `spawn` with piped stdio rather than `execFile`, because the handshake needs
 * both directions: READY comes back on stderr and GO goes out on stdin.
 */
function start(bundle: string, projectDir: string, holdMs: number, mode: string): Contender {
  const child = spawn(process.execPath, [bundle, projectDir, RUN, String(holdMs), mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let announceReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    announceReady = resolve;
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.includes('READY')) announceReady();
  });
  // A child that dies before announcing must not hang the barrier; the failure
  // then shows up in the assertions rather than as a timeout with no detail.
  child.on('error', () => announceReady());
  child.on('close', () => announceReady());

  const finished = new Promise<Attempt>((settle) => {
    child.on('close', (code) => settle({ stdout, code }));
    child.on('error', () => settle({ stdout, code: null }));
  });

  return {
    ready,
    go() {
      child.stdin.end('GO\n');
    },
    finished,
  };
}

export async function buildHarness(root: string): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'af-lock-race-'));

  const entry = join(dir, 'harness.entry.mjs');
  await writeFile(entry, harnessSource(root), 'utf8');

  const bundle = join(dir, 'harness.mjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundle,
    absWorkingDir: root,
    plugins: [resolveTypeScript],
    logLevel: 'silent',
  });

  let projects = 0;

  return {
    dir,

    project() {
      projects += 1;
      return join(dir, `project-${String(projects)}`);
    },

    attempt(projectDir, holdMs, mode = 'release') {
      const child = start(bundle, projectDir, holdMs, mode);
      child.go();
      return child.finished;
    },

    async race(projectDir, contenders, holdMs) {
      const children = Array.from({ length: contenders }, () =>
        start(bundle, projectDir, holdMs, 'release'),
      );

      // Every child has started, loaded its modules and built its lock object.
      // Nothing below this line is waiting on the scheduler to catch up.
      await Promise.all(children.map((child) => child.ready));

      for (const child of children) child.go();

      return Promise.all(children.map((child) => child.finished));
    },

    async generations(projectDir) {
      const entries = await readdir(join(projectDir, '.agent-flow', 'runs', RUN)).catch(() => []);
      return entries
        .map((entry) => /^execution\.lock\.(\d+)$/.exec(entry)?.[1])
        .filter((match): match is string => match !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    },

    lockPath(projectDir, generation) {
      return join(projectDir, '.agent-flow', 'runs', RUN, `execution.lock.${String(generation)}`);
    },
  };
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
export interface Held {
  readonly pid: number;
  readonly from: number;
  readonly to: number;
}

export function heldIntervals(results: readonly Attempt[]): Held[] {
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
export function overlaps(held: readonly Held[]): string[] {
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

/**
 * The most holders inside the lock at any single instant.
 *
 * `overlaps` reports *which* pairs collided and this reports *how many* were in
 * at once; both are the same invariant seen from two directions, and stating it
 * as a number is what lets a test assert the property directly instead of
 * inferring it from an acquisition count.
 */
export function maxSimultaneous(held: readonly Held[]): number {
  const edges = held
    .flatMap((entry) => [
      { at: entry.from, delta: 1 },
      { at: entry.to, delta: -1 },
    ])
    // A release at exactly the moment of an acquisition is not an overlap, so the
    // exit is processed first.
    .sort((a, b) => a.at - b.at || a.delta - b.delta);

  let inside = 0;
  let most = 0;
  for (const edge of edges) {
    inside += edge.delta;
    if (inside > most) most = inside;
  }

  return most;
}
