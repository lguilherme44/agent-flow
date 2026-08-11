import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { StateStore } from '../../src/app/state-store.js';
import { pendingStateWrites } from '../../src/app/state-write-queue.js';
import { runPaths } from '../../src/app/paths.js';
import type { RunState, TaskState } from '../../src/contracts/index.js';
import type { FileSystem } from '../../src/ports/index.js';

/**
 * M2-00.1 — `updateRun` is read-modify-write, and two of them must not interleave.
 *
 * The race is not theoretical and it is not caught by the §22 machine: each
 * transition, observed on its own, is legal. Two writers that both read
 * `{TASK-001: running, TASK-002: running}` and then write their own conclusion
 * produce a file where one of the two conclusions never happened — and the state
 * machine sees `running → completed` both times and approves.
 *
 * Concurrency is pinned at one today, which is the only reason this has not bitten
 * anybody. That is not a property of the StateStore, and this file is about making
 * it one.
 *
 * **Determinism comes from controlling the read, not from hoping about timing.**
 * A `Promise.all` of two updates passes or fails depending on Node's scheduler, so
 * it would prove nothing on the days it passed. The filesystem double below holds
 * every read of `state.json` until the test releases it, which makes "how many
 * reads are in flight at once" an assertion rather than a coincidence.
 */

const PROJECT = '/repo';

/**
 * A FileSystem whose reads of one path wait to be let through.
 *
 * Everything else delegates. The inner read happens *after* the gate opens, so a
 * writer released second genuinely observes what the first one wrote.
 */
class GatedReads implements FileSystem {
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly inner: InMemoryFileSystem,
    private readonly gated: string,
  ) {}

  /** How many reads of the gated path are parked right now. */
  get inFlight(): number {
    return this.waiting.length;
  }

  releaseAll(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  async readFile(path: string): Promise<string> {
    if (path === this.gated) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    return this.inner.readFile(path);
  }

  writeFileAtomic(path: string, content: string): Promise<void> {
    return this.inner.writeFileAtomic(path, content);
  }
  appendFile(path: string, content: string): Promise<void> {
    return this.inner.appendFile(path, content);
  }
  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }
  mkdirp(path: string): Promise<void> {
    return this.inner.mkdirp(path);
  }
  readDir(path: string): Promise<string[]> {
    return this.inner.readDir(path);
  }
  remove(path: string): Promise<void> {
    return this.inner.remove(path);
  }
  stat(path: string): ReturnType<FileSystem['stat']> {
    return this.inner.stat(path);
  }
  createExclusive(path: string, content: string): Promise<boolean> {
    return this.inner.createExclusive(path, content);
  }
  realPath(path: string): Promise<string | null> {
    return this.inner.realPath(path);
  }
}

/** Yields to the macrotask queue, which drains every pending microtask first. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const mark =
  (id: string, state: TaskState) =>
  (current: RunState): RunState => ({
    ...current,
    tasks: current.tasks.map((task) => (task.id === id ? { ...task, state } : task)),
  });

interface World {
  /** Reads of `state.json` park here until released. */
  readonly gate: GatedReads;
  /** Store whose reads go through the gate. */
  readonly gated: StateStore;
  /** Store with an ungated view of the same files. */
  readonly plain: StateStore;
  readonly runId: string;
  stateOf(id: string): Promise<TaskState | undefined>;
}

async function twoRunningTasks(): Promise<World> {
  const inner = new InMemoryFileSystem();
  const clock = new FixedClock();

  // Seeded through the real store, so the file on disk is the shape production
  // writes rather than a fixture that could drift from it.
  const plain = new StateStore({ fs: inner, clock, projectDir: PROJECT });
  const run = await plain.createRun('concurrent writes');
  await plain.updateRun(run.runId, (state) => ({
    ...state,
    tasks: [
      { id: 'TASK-001', state: 'running', attempts: 1 },
      { id: 'TASK-002', state: 'running', attempts: 1 },
    ],
  }));

  const gate = new GatedReads(inner, runPaths(PROJECT, run.runId).state);

  return {
    gate,
    gated: new StateStore({ fs: gate, clock, projectDir: PROJECT }),
    plain,
    runId: run.runId,
    stateOf: async (id) =>
      (await plain.loadRun(run.runId)).tasks.find((task) => task.id === id)?.state,
  };
}

describe('concurrent updateRun calls on one state file', () => {
  it('serialises them, so the second reads what the first wrote', async () => {
    const { gate, gated, runId, stateOf } = await twoRunningTasks();

    const first = gated.updateRun(runId, mark('TASK-001', 'completed'));
    const second = gated.updateRun(runId, mark('TASK-002', 'completed'));

    await settle();

    // The load-bearing assertion. Unserialised, both updates have already read
    // the file by now and both mutators are closed over the same snapshot — so
    // whichever writes second erases the other's task. Serialised, the second
    // has not read anything yet, because it has not started.
    expect(gate.inFlight).toBe(1);

    gate.releaseAll();
    await settle();
    gate.releaseAll();

    await Promise.all([first, second]);

    expect(await stateOf('TASK-001')).toBe('completed');
    expect(await stateOf('TASK-002')).toBe('completed');
  });

  it('keeps every update when four arrive at once', async () => {
    const inner = new InMemoryFileSystem();
    const clock = new FixedClock();
    const store = new StateStore({ fs: inner, clock, projectDir: PROJECT });

    const run = await store.createRun('a wave of four');
    await store.updateRun(run.runId, (state) => ({
      ...state,
      tasks: ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'].map((id) => ({
        id,
        state: 'running' as const,
        attempts: 1,
      })),
    }));

    // No gate here: this is the shape the scheduler will produce once a wave has
    // more than one task in it, and it must hold on the real clock too.
    await Promise.all(
      ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'].map((id) =>
        store.updateRun(run.runId, mark(id, 'completed')),
      ),
    );

    const persisted = await store.loadRun(run.runId);
    expect(persisted.tasks.map((task) => task.state)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
  });

  it('lets the next update through when one throws', async () => {
    // A queue that a failure can wedge is worse than no queue: the run would
    // stop being able to record anything at all, and the reason would be a
    // mutator that had already reported its own error.
    const { plain, runId, stateOf } = await twoRunningTasks();

    const failing = plain.updateRun(runId, () => {
      throw new Error('mutator refused');
    });

    const following = plain.updateRun(runId, mark('TASK-002', 'completed'));

    await expect(failing).rejects.toThrow('mutator refused');
    await following;

    expect(await stateOf('TASK-002')).toBe('completed');
    // The failed update wrote nothing, so the run is exactly as it was.
    expect(await stateOf('TASK-001')).toBe('running');
  });

  it('lets the next update through when an illegal transition is refused', async () => {
    // The §22 machine still raises, and it raises *inside* the queue. Same
    // requirement as above, reached through the guard rather than a caller.
    const { plain, runId, stateOf } = await twoRunningTasks();

    const refused = plain.updateRun(runId, (current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === 'TASK-001' ? { ...task, state: 'queued' as const } : task,
      ),
    }));

    const following = plain.updateRun(runId, mark('TASK-002', 'completed'));

    await expect(refused).rejects.toThrow(/illegal task transition/);
    await following;

    expect(await stateOf('TASK-001')).toBe('running');
    expect(await stateOf('TASK-002')).toBe('completed');
  });

  it('holds no queue once the writes have drained', async () => {
    // Otherwise a long-lived server accumulates one entry per run it ever
    // touched, which is a leak with a very slow fuse.
    const { plain, runId } = await twoRunningTasks();

    await plain.updateRun(runId, mark('TASK-001', 'completed'));
    await plain.updateRun(runId, mark('TASK-002', 'completed'));

    expect(pendingStateWrites()).toBe(0);
  });

  it('does not serialise two projects that happen to share a run id', async () => {
    // Run ids are derived per project and reset each year, so `AF-2026-001` in
    // two repositories is ordinary. The queue is about a file, and a key that
    // was only the run id would make one project wait on another for nothing —
    // which the workspace-mode server would do all day.
    const inner = new InMemoryFileSystem();
    const clock = new FixedClock();

    const a = new StateStore({ fs: inner, clock, projectDir: '/project-a' });
    const b = new StateStore({ fs: inner, clock, projectDir: '/project-b' });

    const runA = await a.createRun('feature a');
    const runB = await b.createRun('feature b');
    expect(runA.runId).toBe(runB.runId);

    const gate = new GatedReads(inner, runPaths('/project-a', runA.runId).state);
    const gatedA = new StateStore({ fs: gate, clock, projectDir: '/project-a' });

    // A is parked on its read. B must not be waiting behind it.
    const blocked = gatedA.updateRun(runA.runId, (state) => ({ ...state, stage: 'planning' }));
    await settle();
    expect(gate.inFlight).toBe(1);

    await b.updateRun(runB.runId, (state) => ({ ...state, stage: 'planning' }));
    expect((await b.loadRun(runB.runId)).stage).toBe('planning');

    gate.releaseAll();
    await blocked;
  });
});
