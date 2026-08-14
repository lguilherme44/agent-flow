/**
 * Deterministic synchronisation for concurrency tests.
 *
 * Everything here exists to avoid the one shape of concurrency test that proves
 * nothing: `sleep(100)` in each worker, then an assertion that the whole thing
 * took less than 150ms. That test is green on a fast machine with a broken limit
 * and red on a loaded CI runner with a correct one, and in neither case has it
 * observed two tasks being inside the executor at the same moment.
 *
 * What replaces it is arrival and release as separate, awaited events. A worker
 * announces that it has arrived and then blocks; the test waits for the arrival
 * — not for a duration — observes the world while every arrived worker is
 * demonstrably still inside, and then releases them in whatever order the
 * scenario calls for. "Two tasks overlapped" stops being an inference from a
 * stopwatch and becomes a fact the test held still and looked at.
 */

/** A promise whose resolution somebody else owns. */
export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * A gate per named worker: it arrives, it blocks, the test lets it through.
 *
 * The counter is the point. `inside` is incremented before the block and
 * decremented after the release, so `peak` is the largest number of workers that
 * were simultaneously past the gate and not yet released — which is the
 * definition of concurrent execution, observed rather than timed.
 */
export class Latch {
  private readonly arrived = new Map<string, Deferred>();
  private readonly released = new Map<string, Deferred>();
  private readonly order: string[] = [];
  private inside = 0;
  private peakInside = 0;
  private readonly finished: string[] = [];

  /** The most workers that were inside at one moment. */
  get peak(): number {
    return this.peakInside;
  }

  /** How many are inside right now. */
  get current(): number {
    return this.inside;
  }

  /** Which workers arrived, in arrival order. */
  get arrivals(): readonly string[] {
    return [...this.order];
  }

  /** Which workers were released and returned, in completion order. */
  get completions(): readonly string[] {
    return [...this.finished];
  }

  /**
   * Called from inside the worker. Announces arrival, then waits to be released.
   *
   * The two `Deferred`s are created on first mention from either side, so a test
   * may await an arrival before the worker exists and a worker may be released
   * before it arrives — neither ordering can deadlock.
   */
  async wait(worker: string): Promise<void> {
    this.inside += 1;
    this.peakInside = Math.max(this.peakInside, this.inside);
    this.order.push(worker);
    this.gate(this.arrived, worker).resolve();

    await this.gate(this.released, worker).promise;

    this.inside -= 1;
    this.finished.push(worker);
  }

  /** Resolves once `worker` is inside. Never a timeout — the test hangs or passes. */
  async until(worker: string): Promise<void> {
    await this.gate(this.arrived, worker).promise;
  }

  /** Lets one worker out. */
  release(worker: string): void {
    this.gate(this.released, worker).resolve();
  }

  /** Lets everybody out, in case a scenario ends early. */
  releaseAll(): void {
    for (const gate of this.released.values()) gate.resolve();
    for (const worker of this.order) this.gate(this.released, worker).resolve();
  }

  private gate(map: Map<string, Deferred>, worker: string): Deferred {
    const existing = map.get(worker);
    if (existing !== undefined) return existing;

    const created = deferred();
    map.set(worker, created);
    return created;
  }
}
