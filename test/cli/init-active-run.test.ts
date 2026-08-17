import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInitCommand } from '../../src/cli/init.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { StateStore } from '../../src/app/state-store.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { SystemClock } from '../../src/adapters/clock/system-clock.js';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';

/**
 * C-02 (AR-01) — `init` during an active run.
 *
 * The evidence run's second intervention, and the one that made the first one expensive.
 * `agent-flow init` was run *after* planning had already frozen a planningBase, and the
 * commit its files require moved HEAD out from under the run. Every worktree the run
 * later cut was cut from a base the run had not planned against.
 *
 * The refusal is a gate rather than an error: `--force` proceeds, and records that it did.
 */

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const globalsFor = (cwd: string) => ({
  cwd,
  globalConfigPath: join(cwd, 'global.yaml'),
  strict: false,
  verbose: false,
  json: false,
  dryRun: false,
});

function storeIn(projectDir: string): StateStore {
  return new StateStore({
    fs: new NodeFileSystem(),
    clock: new SystemClock(),
    projectDir,
  });
}

async function capture(body: () => Promise<number>) {
  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { exitCode: await body(), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe('`init` with an active run (C-02)', () => {
  it('refuses, naming the run and its planningBase, and writes nothing', async () => {
    repo = await makeTempRepoWithCommit();
    const store = storeIn(repo.dir);
    const head = repo.head();
    const run = await store.createRun('a feature', () => ({
      isolationMode: 'worktree',
      planningBase: head,
      gitRunKey: 'AF-2026-003-0123456789abcdef',
    }));

    const { exitCode, stderr } = await capture(() =>
      runInitCommand({}, globalsFor(repo!.dir)),
    );

    expect(exitCode).toBe(ExitCode.GATE_NOT_SATISFIED);
    expect(stderr).toContain(run.runId);
    expect(stderr).toContain(head);

    // "It writes nothing" — the two files init would otherwise create.
    expect(existsSync(join(repo.dir, '.agent-flow', 'config.yaml'))).toBe(false);
    expect(existsSync(join(repo.dir, 'AGENTS.md'))).toBe(false);
  });

  it('explains that the commit init requires is what invalidates the base', async () => {
    repo = await makeTempRepoWithCommit();
    const store = storeIn(repo.dir);
    await store.createRun('a feature', () => ({
      isolationMode: 'worktree',
      planningBase: repo!.head(),
      gitRunKey: 'AF-2026-003-0123456789abcdef',
    }));

    const { stderr } = await capture(() => runInitCommand({}, globalsFor(repo!.dir)));

    expect(stderr).toMatch(/planningBase/);
    expect(stderr).toContain('--force');
  });

  it('records no event on the run when it refuses', async () => {
    repo = await makeTempRepoWithCommit();
    const store = storeIn(repo.dir);
    const run = await store.createRun('a feature');

    await capture(() => runInitCommand({}, globalsFor(repo!.dir)));

    const events = await store.readEvents(run.runId);
    expect(events.map((event) => event.type)).not.toContain('init_during_active_run');
  });

  it('proceeds under --force and records init_during_active_run on the run', async () => {
    repo = await makeTempRepoWithCommit();
    const store = storeIn(repo.dir);
    const run = await store.createRun('a feature', () => ({
      isolationMode: 'worktree',
      planningBase: repo!.head(),
      gitRunKey: 'AF-2026-003-0123456789abcdef',
    }));

    const { exitCode } = await capture(() =>
      runInitCommand({ force: true }, globalsFor(repo!.dir)),
    );

    expect(exitCode).toBe(ExitCode.OK);
    expect(existsSync(join(repo.dir, '.agent-flow', 'config.yaml'))).toBe(true);

    const events = await store.readEvents(run.runId);
    const forced = events.find((event) => event.type === 'init_during_active_run');
    expect(forced).toBeDefined();
    expect(forced?.detail).toMatchObject({ forced: true });
  });

  it('persists no absolute path on that event (§21.3)', async () => {
    // The event names the files init wrote, and an absolute path names this machine's home
    // directory. §21.3 makes persisted detail path-free by construction, and an event added
    // by a later milestone is no exception to a rule the earlier ones already keep.
    repo = await makeTempRepoWithCommit();
    const store = storeIn(repo.dir);
    const run = await store.createRun('a feature');

    await capture(() => runInitCommand({ force: true }, globalsFor(repo!.dir)));

    const events = await store.readEvents(run.runId);
    const forced = events.find((event) => event.type === 'init_during_active_run');

    const serialised = JSON.stringify(forced?.detail ?? {});
    expect(serialised).not.toContain(repo.dir);
    expect(serialised).not.toContain(repo.home);
    // And it still says something useful about what moved.
    expect(serialised).toContain('.agent-flow/config.yaml');
  });

  it('runs normally when the only run is finished', async () => {
    // "A run whose status is not completed or failed." A finished run holds no base that
    // a commit could invalidate, so there is nothing to gate.
    repo = await makeTempRepoWithCommit();
    const store = storeIn(repo.dir);
    const run = await store.createRun('a finished feature');
    await store.updateRun(run.runId, (state) => ({ ...state, status: 'completed' }));

    const { exitCode } = await capture(() => runInitCommand({}, globalsFor(repo!.dir)));

    expect(exitCode).toBe(ExitCode.OK);
    expect(existsSync(join(repo.dir, '.agent-flow', 'config.yaml'))).toBe(true);
  });

  it('runs normally in a project that has no runs at all', async () => {
    // The ordinary first contact, which this gate must not make harder.
    repo = await makeTempRepoWithCommit();

    const { exitCode, stdout } = await capture(() => runInitCommand({}, globalsFor(repo!.dir)));

    expect(exitCode).toBe(ExitCode.OK);
    expect(stdout).toContain('Detected:');
    expect(readFileSync(join(repo.dir, '.agent-flow', 'config.yaml'), 'utf8')).toContain('project:');
  });
});
