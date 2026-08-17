import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  RunnerCapabilities,
  RunnerHealth,
} from '../../ports/agent-runner.js';
import type { ProcessResult, ProcessRunner } from '../../ports/process-runner.js';
import type { RunnerErrorCode } from '../../contracts/common.schema.js';

/**
 * How a concrete adapter describes an invocation to the shared machinery.
 */
export interface RunnerInvocation {
  readonly command: string;
  readonly args: string[];
  /** Prompts go on stdin — see docs/runner-capabilities.md for why. */
  readonly stdin?: string;
  /**
   * Per-invocation state handed back to `parseSuccess`, e.g. the temp files an
   * adapter had to create.
   *
   * Deliberately not instance fields: two runs of the same adapter must not be
   * able to overwrite each other's paths, and the scheduler is built to raise
   * concurrency without the layers beneath it changing.
   */
  readonly context?: unknown;
  /** Always awaited after the run, success or failure. */
  readonly cleanup?: () => Promise<void>;
}

/**
 * One rule for turning a CLI-specific outcome into a normalised code.
 *
 * Rules are ordered and the first match wins, so put structured signals (an
 * HTTP status, an exit code) ahead of text matching. Wording changes between
 * releases; a status code does not.
 */
export interface ErrorRule {
  readonly code: RunnerErrorCode;
  readonly when: (result: ProcessResult, parsed: unknown) => boolean;
}

export interface BaseRunnerOptions {
  readonly id: string;
  readonly processRunner: ProcessRunner;
  /** Overrides the executable looked up on PATH. */
  readonly command?: string;
}

/**
 * Shared runner machinery: build argv, spawn, normalise, parse.
 *
 * The division of labour that matters is error normalisation (§22.1). Each CLI
 * has its own vocabulary for "you are out of quota" — an HTTP status here, a
 * sentence there — and translating that is this layer's job. Above it, the
 * orchestrator branches on `RunnerErrorCode` and never on message text, which is
 * what lets a new runner be added without touching any workflow code.
 *
 * The original message is preserved in `raw` for diagnosis. It must never drive
 * control flow.
 */
export abstract class BaseRunner implements AgentRunner {
  readonly id: string;
  protected readonly processRunner: ProcessRunner;
  protected readonly command: string;

  constructor(options: BaseRunnerOptions) {
    this.id = options.id;
    this.processRunner = options.processRunner;
    this.command = options.command ?? this.defaultCommand();
  }

  /**
   * AD-30's signature. An adapter with no model-specific knowledge ignores the
   * argument, which is why it is optional here rather than required of every subclass.
   */
  abstract capabilities(model?: string): RunnerCapabilities;
  abstract healthCheck(): Promise<RunnerHealth>;

  /** Executable name looked up on PATH when config does not override it. */
  protected abstract defaultCommand(): string;

  /**
   * Builds the concrete invocation for one run. May be async: some adapters
   * have to write a schema to disk before the CLI can be given it.
   */
  protected abstract buildInvocation(
    input: AgentRunInput,
  ): RunnerInvocation | Promise<RunnerInvocation>;

  /**
   * Ordered rules, most specific first. Anything unmatched becomes
   * `execution_failed`, which is deliberately *not* a fallback trigger (§55).
   */
  protected abstract errorRules(): readonly ErrorRule[];

  /**
   * Extracts the answer from a successful invocation.
   *
   * Async because not every CLI puts its answer on stdout — one writes it to a
   * file the adapter has to read back.
   */
  protected abstract parseSuccess(
    result: ProcessResult,
    input: AgentRunInput,
    context: unknown,
  ): { text: string; json?: unknown } | Promise<{ text: string; json?: unknown }>;

  /** Parsed structured envelope, when the CLI emits one. Used by error rules. */
  protected parseEnvelope(_result: ProcessResult): unknown {
    return undefined;
  }

  /**
   * True when the CLI positively reported success.
   *
   * Checked before any error rule runs. Without it, a rule that scans text for
   * failure wording will eventually match the *content* of a successful
   * response — a design document discussing rate limits gets reported as a rate
   * limit. Structured evidence of success has to outrank pattern matching.
   */
  protected isDefiniteSuccess(_result: ProcessResult, _parsed: unknown): boolean {
    return false;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const invocation = await this.buildInvocation(input);

    try {
      const result = await this.processRunner.run({
        command: invocation.command,
        args: invocation.args,
        cwd: input.workingDirectory,
        timeoutSeconds: input.timeoutSeconds,
        ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      });

      const envelope = this.parseEnvelope(result);
      const errorCode = this.normaliseError(result, envelope);

      if (errorCode !== null) {
        return {
          ok: false,
          errorCode,
          raw: this.rawMessage(result),
          durationMs: result.durationMs,
        };
      }

      try {
        const { text, json } = await this.parseSuccess(result, input, invocation.context);
        return {
          ok: true,
          text,
          ...(json === undefined ? {} : { json }),
          durationMs: result.durationMs,
        };
      } catch (error) {
        // A zero exit with unusable output is still a failure, and specifically
        // one that must not trigger a fallback: retrying elsewhere would bury a
        // contract mismatch instead of surfacing it.
        return {
          ok: false,
          errorCode: 'invalid_output',
          raw: `${(error as Error).message}\n${this.rawMessage(result)}`,
          durationMs: result.durationMs,
        };
      }
    } finally {
      // Temp files are removed whatever happened, including on a throw.
      await invocation.cleanup?.();
    }
  }

  /** Returns the normalised code, or null when the invocation succeeded. */
  protected normaliseError(result: ProcessResult, parsed: unknown): RunnerErrorCode | null {
    // Checked ahead of adapter rules: neither depends on how a CLI phrases
    // things, and both mean the CLI never got a chance to respond.
    if (result.spawnFailed) return 'runner_unavailable';
    if (result.timedOut) return 'timeout';

    // An explicit success outranks every heuristic below it.
    if (this.isDefiniteSuccess(result, parsed)) return null;

    for (const rule of this.errorRules()) {
      if (rule.when(result, parsed)) return rule.code;
    }

    if (result.exitCode !== 0) return 'execution_failed';
    return null;
  }

  protected rawMessage(result: ProcessResult): string {
    return [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n').trim();
  }
}
