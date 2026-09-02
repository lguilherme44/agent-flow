import type { ProcessResult, ProcessRunner, ProcessSpawnOptions } from '../../src/ports/index.js';

export type ProcessScript = (options: ProcessSpawnOptions) => Partial<ProcessResult>;

/**
 * Scripted ProcessRunner.
 *
 * This is what lets the runner adapters be tested without invoking a CLI: the
 * assertions are about the argv that was built and the parsing of recorded real
 * output, so the suite stays fast and burns no quota.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessSpawnOptions[] = [];
  private readonly scripts: ProcessScript[] = [];
  private fallback: ProcessScript = () => ({});

  /** Queues one response, consumed in order. */
  push(script: ProcessScript | Partial<ProcessResult>): this {
    this.scripts.push(typeof script === 'function' ? script : () => script);
    return this;
  }

  /** Response for calls beyond the queued scripts. */
  always(script: ProcessScript | Partial<ProcessResult>): this {
    this.fallback = typeof script === 'function' ? script : () => script;
    return this;
  }

  async run(options: ProcessSpawnOptions): Promise<ProcessResult> {
    this.calls.push(options);

    // The real runner refuses to spawn on an already-aborted signal, so a cancellation
    // test that used this fake would otherwise see a success the product cannot produce.
    if (options.signal?.aborted === true) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        cancelled: true,
        spawnFailed: false,
        truncated: false,
      };
    }

    const script = this.scripts.shift() ?? this.fallback;
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      cancelled: false,
      spawnFailed: false,
      truncated: false,
      ...script(options),
    };
  }

  get lastCall(): ProcessSpawnOptions | undefined {
    return this.calls.at(-1);
  }
}
