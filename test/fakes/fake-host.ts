import type { Host } from '../../src/ports/index.js';

/**
 * A process identity a test can control (AF-L01).
 *
 * Which pids are alive is the whole subject of the lock's policy — stale recovery,
 * refusal, and the refusal to judge a foreign host all turn on it — and none of that
 * is testable against a real `process.kill`. So it is a set here, and a test says
 * who exists.
 *
 * This fake cannot prove the *lock* works: an in-memory filesystem has no TOCTOU
 * window to lose. It proves the policy. `run-execution-lock.race.test.ts` spawns real
 * processes against the real filesystem for the rest.
 */
export class FakeHost implements Host {
  private readonly alive: Set<number>;

  constructor(
    readonly pid = 1000,
    readonly hostname = 'test-host',
    alive: readonly number[] = [1000],
    /**
     * Where this fake machine keeps `~/.agent-flow`. The default is deliberately
     * a path no test should ever create anything under: a test that needs the
     * worktree root or the no-hooks directory to exist passes a temporary
     * directory, and one that forgets fails visibly rather than writing into the
     * developer's home.
     */
    readonly homeDir = '/fake-home',
    /**
     * Deterministic entropy, so a test can assert on the `gitRunKey` it expects
     * and can force the collision case rather than waiting 2^64 runs for it.
     */
    private entropy: string = 'a93f085c23dd9321',
    /**
     * The platform path limit §23's projection is judged against. Generous by
     * default so that no existing test starts refusing on path length, and
     * lowered explicitly by the tests that are about the limit itself.
     */
    readonly maxPathLength = 4096,
    /**
     * The unit {@link maxPathLength} is counted in. Defaults to POSIX bytes,
     * which is what CI runs on; a test about Windows passes `'utf16'`.
     */
    private readonly pathUnit: 'bytes' | 'utf16' = 'bytes',
  ) {
    this.alive = new Set(alive);
  }

  measurePathLength(value: string): number {
    return this.pathUnit === 'utf16' ? value.length : Buffer.byteLength(value, 'utf8');
  }

  randomHex(byteLength: number): string {
    const wanted = byteLength * 2;
    return this.entropy.repeat(Math.ceil(wanted / this.entropy.length)).slice(0, wanted);
  }

  /** Test helper: the next `randomHex` answer. */
  setEntropy(hex: string): void {
    this.entropy = hex;
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  /** Test helper: the process behind this pid has gone. */
  kill(pid: number): void {
    this.alive.delete(pid);
  }

  /** Test helper: a pid this fake will report as running. */
  spawn(pid: number): void {
    this.alive.add(pid);
  }
}
