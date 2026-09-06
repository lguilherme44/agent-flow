import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunUsage,
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
  /**
   * Extra environment variables this runner may inherit, from `execution.passEnv`.
   *
   * Carried on the runner rather than read at the spawn, because the spawn boundary must
   * not reach for configuration — and because an operator who needs a variable for their
   * agent needs it for every invocation of it, not for one.
   */
  readonly envPass?: readonly string[];
  /**
   * Extra arguments appended to whatever the adapter builds (`RunnerConfig.args`).
   *
   * Appended at the spawn rather than inside each adapter, so a new adapter gets the
   * seam without knowing it exists, and so no adapter can quietly drop it.
   */
  readonly extraArgs?: readonly string[];
  /**
   * `execution.isolateRunnerSettings` — whether this CLI is cut off from the operator's
   * own customisations (PRI-18).
   *
   * Carried on the runner for the same reason `envPass` is: an operator who wants a
   * reproducible run wants it for every invocation, not for one, and a policy read at the
   * spawn would be a policy the spawn boundary had to know about.
   *
   * Defaults to `true` here as well as in the schema. The two agree on purpose — a fake
   * or a test that constructs an adapter directly gets the isolated behaviour, because
   * the un-isolated one is the one that needs a decision behind it.
   */
  readonly isolateSettings?: boolean;
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
  private readonly extraArgs: readonly string[];
  /** `execution.passEnv`, carried so every spawn of this runner sees the same list. */
  protected readonly envPass: readonly string[] | undefined;
  /** `execution.isolateRunnerSettings` (PRI-18). Read by {@link isolationArgs}. */
  protected readonly isolateSettings: boolean;

  constructor(options: BaseRunnerOptions) {
    this.id = options.id;
    this.processRunner = options.processRunner;
    this.command = options.command ?? this.defaultCommand();
    this.envPass = options.envPass;
    this.extraArgs = options.extraArgs ?? [];
    this.isolateSettings = options.isolateSettings ?? true;
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
   * What this invocation spent, read from whatever the CLI reported (PRI-19).
   *
   * `undefined` here, and `undefined` is a measurement: a CLI that does not report its
   * usage must produce no numbers rather than zeros, because a reader cannot tell a
   * fabricated zero from a free call. Each adapter that *does* get the data overrides
   * this and reads its own envelope, which is where provider vocabulary belongs (AD-13).
   *
   * Called on the success and the failure path alike — the model answered either way, and
   * either way somebody paid for it.
   */
  protected parseUsage(_result: ProcessResult, _parsed: unknown): AgentRunUsage | undefined {
    return undefined;
  }

  /**
   * The flags that cut this CLI off from the operator's own customisations (PRI-18).
   *
   * Empty here, and empty is a real answer: a CLI that offers no such flag must not be
   * given one that looks like it works. Each adapter that *does* have one overrides this
   * and names it, because the flag is provider vocabulary and provider vocabulary lives
   * below the port (AD-13).
   *
   * Consulted on every spawn rather than folded into `buildInvocation`, so an adapter
   * added later gets the seam without knowing it exists — the same reason `extraArgs`
   * is applied here and not inside each adapter.
   *
   * Given the input, because one measured CLI's isolation flag and its read-only mode
   * cancel each other — see {@link AgyRunner.isolationArgs}. An adapter that has to choose
   * between containment and reproducibility must be able to see which stage it is running.
   */
  protected isolationArgs(_input: AgentRunInput): readonly string[] {
    return [];
  }

  /**
   * The whole argv: what the adapter built, then the product's policy, then the operator's.
   *
   * The order is the precedence. An operator's `RunnerConfig.args` comes last so it can
   * still have the final word over a flag this product added on their behalf.
   */
  private argsFor(invocation: RunnerInvocation, input: AgentRunInput): string[] {
    const isolation = this.isolateSettings ? this.isolationArgs(input) : [];
    return [...invocation.args, ...isolation, ...this.extraArgs];
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
        // The adapter's argv, then the product's isolation policy, then the operator's.
        // Appended and never merged: the adapter owns the subcommand and its flags, and a
        // value that fights them is the operator's to resolve.
        args: this.argsFor(invocation, input),
        cwd: input.workingDirectory,
        timeoutSeconds: input.timeoutSeconds,
        // Left at the default, `allowlist` (PRI-17). Stated by omission everywhere else in
        // this codebase; stated here because this is the spawn the invariant is *about* —
        // a coding CLI is a program with a model inside it reading a repository somebody
        // else wrote, and it now receives what it needs rather than everything.
        ...(this.envPass === undefined ? {} : { envPass: this.envPass }),
        // Straight through to the kill that already reaches the whole process group on
        // timeout. Cancel must not grow a second termination mechanism (PRI-09).
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      });

      const envelope = this.parseEnvelope(result);
      const errorCode = this.normaliseError(result, envelope);

      const usage = this.parseUsage(result, envelope);

      if (errorCode !== null) {
        return {
          ok: false,
          errorCode,
          raw: this.rawMessage(result),
          durationMs: result.durationMs,
          ...(usage === undefined ? {} : { usage }),
        };
      }

      try {
        const { text, json } = await this.parseSuccess(result, input, invocation.context);
        return {
          ok: true,
          text,
          ...(json === undefined ? {} : { json }),
          durationMs: result.durationMs,
          ...(usage === undefined ? {} : { usage }),
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
          ...(usage === undefined ? {} : { usage }),
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
