/**
 * One writer at a time per state file, within this process (M2-00.1).
 *
 * `StateStore.updateRun` is a read-modify-write: it loads `state.json`, hands the
 * value to a mutator, and writes what comes back. Two of those in flight over one
 * file lose an update — both read the same snapshot, both write their own
 * conclusion, and the second erases the first. The §22 machine does not catch it,
 * and cannot: each transition, seen on its own, is legal. `running → completed`
 * twice is two legal writes and one lost task.
 *
 * Concurrency is pinned at one today, so nothing has lost an update yet. That is a
 * property of the scheduler's batch size rather than of the store, and a store
 * whose correctness depends on how its callers happen to be scheduled is a store
 * that will be wrong the first time somebody adds a caller.
 *
 * **This is not the execution lock, and it does not overlap with it.** `AF-L01`
 * answers "may this process move this run at all", across processes, and holds for
 * a whole execution. This answers "which of my own in-flight callbacks writes
 * first", inside one process, for the duration of one read-modify-write. A second
 * filesystem lock would buy nothing here: every writer is already under the same
 * lease, and taking a file lock to order two callbacks in one event loop would be
 * a syscall standing in for a promise.
 *
 * **The queue is keyed by the file, and module-scoped rather than per instance.**
 * Both halves matter. `StateStore` is constructed per invocation — `run-actions`
 * builds one for the lock's audit events and `buildExecutionContext` builds
 * another for the same run — so an instance-level mutex would order each object's
 * own writes and none of the writes that actually race. And the key has to be the
 * path rather than the run id, because run ids are derived per project and reset
 * each year: `AF-2026-001` exists in as many repositories as you like, and the
 * workspace-mode server serves all of them from one process. Keying on the id
 * would make two unrelated projects wait on each other, which is the global lock
 * §27 of the analysis exists to avoid.
 */

/**
 * Tail of each key's chain — a promise that never rejects.
 *
 * Never rejecting is what keeps a failed update from wedging the queue: the next
 * writer waits on this, not on the caller's promise, so a mutator that threw
 * blocks nothing. The caller still sees its own rejection, unchanged.
 */
const tails = new Map<string, Promise<void>>();

/**
 * Runs `work` after every earlier call for the same key has finished.
 *
 * Reentrancy is not supported and must not be introduced: `work` calling
 * `serializeStateWrite` with the same key would wait for itself. Nothing that
 * runs inside here may go through it again — which is why `recordDegradation`
 * composes `updateRun` rather than being serialised in its own right.
 */
export async function serializeStateWrite<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();

  const running = previous.then(work);
  // The chain's view of this call: settled, never failed.
  const settled = running.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, settled);

  try {
    return await running;
  } finally {
    // Only when nothing queued behind us. Whoever did will clear it in their own
    // `finally`, so the map holds an entry exactly while a key has work in it.
    if (tails.get(key) === settled) tails.delete(key);
  }
}

/**
 * How many state files currently have queued work. Diagnostics and tests only.
 *
 * Exported because "the queue does not leak" is a claim worth being able to check
 * rather than assert — a long-lived server that kept one entry per run it ever
 * touched would be a leak with a very slow fuse.
 */
export function pendingStateWrites(): number {
  return tails.size;
}
