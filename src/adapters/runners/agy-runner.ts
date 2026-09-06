import type { ReasoningLevel } from '../../contracts/common.schema.js';
import type { AgentRunInput, AgentRunUsage, RunnerCapabilities, RunnerHealth } from '../../ports/agent-runner.js';
import type { ProcessResult } from '../../ports/process-runner.js';
import { BaseRunner, type ErrorRule, type RunnerInvocation } from './base-runner.js';

const EFFORT: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/**
 * What the CLI's own `--effort` flag accepts: `low|medium|high`, from `--help`.
 *
 * **The CLI surface, not the effective capability.** The flag parses all three; whether the
 * *model* behind it offers all three is a different question, and the old zero-argument
 * `capabilities()` was structurally incapable of asking it. This remains the answer for a
 * role that configures no model, and for every family nobody has measured.
 */
const CLI_REASONING_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high'];

/**
 * Reasoning levels measured per model family (AD-30, C-03).
 *
 * **Measured, not inferred.** `agy models` enumerates one model id *per offered effort*,
 * which makes the effective set directly observable: `gemini-3.1-pro` lists `-high` and
 * `-low` and no `-medium`. That is the configuration that cost the AF-2026-002 dogfood a
 * task attempt — a role at `effort: medium` against a model with no `medium` — and the
 * whole provenance is recorded in `docs/runner-capabilities.md`.
 *
 * **Keyed by family prefix, deliberately.** The effort suffix is a *setting*, not a
 * distinct model: `gemini-3.1-pro-low` and `gemini-3.1-pro-high` are one model at two
 * settings. Matching on the full id would make the clamp depend on which id somebody
 * happened to type, which is a different answer to the same question.
 *
 * **Only measured families appear.** The other families show a `-medium` id and would
 * *plausibly* offer all three — and plausibly is not a measurement, so they have no entry
 * and fall through to the CLI surface. Adding a row means probing first.
 *
 * This table lives here, in the adapter that owns the provider, and may never move up:
 * AD-13 keeps provider knowledge below the port, and AD-30 says a capability table keyed by
 * model name in the core would make one vendor a core concern. An architecture test
 * confines it to `src/adapters/runners/`.
 */
const MEASURED_MODEL_REASONING: readonly {
  readonly family: string;
  readonly levels: readonly ReasoningLevel[];
}[] = [{ family: 'gemini-3.1-pro', levels: ['low', 'high'] }];

/**
 * The effective levels for one model id.
 *
 * The id is matched against the family prefixes above; anything unrecognised — including
 * `undefined` — gets the CLI surface, because "no measurement" must never read as "no
 * capability".
 */
function reasoningLevelsFor(model?: string): readonly ReasoningLevel[] {
  if (model === undefined) return CLI_REASONING_LEVELS;

  const measured = MEASURED_MODEL_REASONING.find((entry) => model.startsWith(entry.family));
  return measured?.levels ?? CLI_REASONING_LEVELS;
}

interface AgyEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
  result?: string;
  error?: string;
  is_error?: boolean;
  status_code?: number | null;
  structured_output?: unknown;
  /** Token accounting, as measured from `agy 1.1.27`. No cost and no model in it. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

/** A number the envelope actually carried, or nothing. Never a zero this file invented. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asEnvelope(value: unknown): AgyEnvelope | undefined {
  return typeof value === 'object' && value !== null ? (value as AgyEnvelope) : undefined;
}

/**
 * AGY (Antigravity CLI) adapter.
 */
export class AgyRunner extends BaseRunner {
  protected defaultCommand(): string {
    return 'agy';
  }

  /**
   * AD-30's signature, in the adapter whose mismatch motivated it — now acted on.
   *
   * Only the reasoning levels vary by model. Everything else here is a property of the
   * CLI: read-only containment, non-interactivity, the working directory flag, the output
   * strategy and the tool grants are the same whichever model the CLI is pointed at, and
   * letting any of them drift because a model string was passed would be inventing a
   * measurement.
   */
  capabilities(model?: string): RunnerCapabilities {
    return {
      supportedReasoningLevels: reasoningLevelsFor(model),
      /**
       * `true` since PRI-18, and the change is a criterion rather than a concession.
       *
       * It was `false`, justified by "writes to `~/.gemini/antigravity-cli` occurred
       * during probe". That criterion — *no write anywhere* — was applied to this adapter
       * and to no other: `claude` writes `~/.claude` and `codex` writes `~/.codex` during
       * every run, both declare `true`, and neither wrote a word of justification. Three
       * CLIs, the same behaviour, one of them barred from six of the nine roles.
       *
       * The cost was not academic. It excluded the only second provider on the machine
       * from every read-only role, which is most of a run's model calls — and it took
       * cross-provider review with it, so `approve` warned that the plan review "does not
       * protect against an assumption repeated from planning" for a reason that was not
       * the operator's choice.
       *
       * **The criterion, stated once and applied to all three: can this CLI be put in a
       * mode where it does not modify the repository under test.** `--mode plan` here,
       * `--permission-mode plan` at Claude Code, `-s read-only` at Codex. Every one of the
       * three is declared from its CLI's documentation and none of the three has been
       * probed with a write attempt, so this is now the same evidentiary footing rather
       * than a stricter one for one vendor.
       *
       * The one measured write into a repository under test came from this runner and is
       * not evidence against read-only mode: it happened during an *implementation* task,
       * which is allowed to write, through skill expansion from the operator's home
       * directory — closed on write stages by {@link AgyRunner.isolationArgs}, and caught
       * in the first place by `assertScopeContainment`, which owns that question. Read-only
       * stages keep plan mode instead, for the reason that method records.
       */
      supportsReadOnly: true,
      supportsNonInteractive: true,
      supportsWorkingDirectory: true,
      // Structured output strategy is prompted because native json-schema enforcement in headless CLI mode requires manual permission configuration.
      structuredOutputStrategy: 'prompted',
      // AD-32, and the measurement that motivated the whole capability. This runner was
      // non-interactive and still failed: `--mode accept-edits` grants file edits
      // without a prompt, and a command the local policy had not authorised was
      // soft-denied with nobody present to confirm it. So `fileEdit` is true and
      // `commandExecution` is false — the two properties are different, and conflating
      // them under `supportsNonInteractive` is what hid the failure until it cost an
      // attempt.
      nonInteractiveToolGrants: { fileEdit: true, commandExecution: false },
    };
  }

  async healthCheck(): Promise<RunnerHealth> {
    const result = await this.processRunner.run({
      command: this.command,
      args: ['--version'],
      cwd: process.cwd(),
      timeoutSeconds: 15,
    });

    if (result.spawnFailed) {
      return {
        installed: false,
        executable: false,
        auth: 'unknown',
        detail: result.stderr.trim() || 'executable not found on PATH',
      };
    }

    if (result.exitCode !== 0) {
      return {
        installed: true,
        executable: false,
        auth: 'unknown',
        detail: result.stderr.trim() || `--version exited with ${String(result.exitCode)}`,
      };
    }

    return {
      installed: true,
      executable: true,
      auth: 'unknown',
      version: result.stdout.trim().split('\n')[0] ?? undefined,
    };
  }

  /**
   * What `agy models` enumerates, verbatim (AD-13).
   *
   * The same command `docs/runner-capabilities.md` used to measure the effective effort
   * per family, read here for a different question: which ids a person may point a role
   * at. The format is `<id>\t<label>`, and only lines carrying that tab are ids: the
   * command opens with `Fetching available models...`, which has no tab and is progress
   * rather than data. Splitting on whitespace instead offered `Fetching` as a model —
   * caught by running the real CLI, not by a fixture written from the shape it should
   * have had.
   *
   * A CLI that is absent or refuses contributes nothing rather than an error: this feeds
   * a suggestion list, and a screen with no suggestions is the screen we already have.
   */
  async listModels(): Promise<readonly string[]> {
    const result = await this.processRunner.run({
      command: this.command,
      args: ['models'],
      cwd: process.cwd(),
      timeoutSeconds: 15,
    });

    if (result.spawnFailed || result.exitCode !== 0) return [];

    return result.stdout
      .split('\n')
      .flatMap((line) => {
        const [id] = line.split('\t');
        return line.includes('\t') && id !== undefined && id.trim() !== '' ? [id.trim()] : [];
      });
  }

  /**
   * `--disable-slash-commands` — on write stages only, and the exception was measured
   * (PRI-18).
   *
   * "Disable slash command and skill expansion in print mode", from `agy --help` on 1.1.27.
   * Skill expansion is not a hypothetical here: in the live dogfood this runner invoked one
   * of the operator's own skills mid-task and left `.atl/skill-registry.md` and a 56 KB
   * cache **inside the repository under test**, untracked, in the tree the run was judging.
   *
   * **The flag cancels plan mode.** Running the real CLI to capture its usage envelope
   * produced this on stderr, reproducibly, and only for this pair:
   *
   * ```
   * $ agy --output-format json --effort low --mode plan --disable-slash-commands
   * warning: --mode plan has no effect while slash command expansion is disabled.
   * ```
   *
   * `--mode accept-edits --disable-slash-commands` warns about nothing, and `--mode plan`
   * alone warns about nothing. So on a read-only stage the two flags trade the containment
   * that makes {@link AgyRunner.capabilities} declare `supportsReadOnly` for the isolation —
   * a strictly worse bargain, and one that would have made that declaration a lie.
   *
   * Containment is never traded away, so read-only stages keep `--mode plan` and go without
   * this flag. They are also the stages where the loss costs least: the leak that produced
   * the finding was a *write* into the repository from an implementation task, and plan mode
   * is what stops a skill from writing at all.
   *
   * A person who wants the personalisation gone from read-only stages too can turn the
   * skill off in their own `agy` configuration. This product will not disarm the sandbox to
   * do it for them.
   *
   * **Taken on the CLI's word about skills, unlike the other two adapters' flags.** Those
   * were each verified by observing a behaviour change on the same prompt — a language that
   * stopped leaking, a hook count that fell from 30 to 0. This one could not be: this
   * machine's `agy` carries no persona or language setting, so there was nothing to measure
   * the flag against, and the `.atl/` write has not been re-run with it on. What *is*
   * measured is that the flag takes effect at all, which is the plan-mode warning above.
   */
  protected override isolationArgs(input: AgentRunInput): readonly string[] {
    return input.permissions === 'read-only' ? [] : ['--disable-slash-commands'];
  }

  /**
   * The accounting this CLI returns on every response (PRI-19).
   *
   * Measured, not assumed. The envelope from `agy 1.1.27`, captured by running it:
   *
   * ```json
   * {"status":"SUCCESS","response":"ok\n","duration_seconds":1.8,"num_turns":1,
   *  "usage":{"input_tokens":20735,"output_tokens":1,"thinking_tokens":0,
   *           "cache_read_tokens":0,"total_tokens":20736}}
   * ```
   *
   * **No cost and no model, so neither is reported.** This CLI does not price its calls and
   * does not name the model that answered — inventing either would be worse than the gap,
   * and a reader of `AgentRunUsage` is told to treat an absent field as unmeasured. The
   * model for an agy stage therefore still comes from the configuration when one was
   * pinned, which is the honest limit of what this provider says.
   */
  protected override parseUsage(_result: ProcessResult, parsed: unknown): AgentRunUsage | undefined {
    const usage = asEnvelope(parsed)?.usage;
    if (usage === undefined) return undefined;

    const measured: AgentRunUsage = {
      ...(count(usage.input_tokens) === undefined ? {} : { inputTokens: count(usage.input_tokens) }),
      ...(count(usage.output_tokens) === undefined ? {} : { outputTokens: count(usage.output_tokens) }),
      ...(count(usage.cache_read_tokens) === undefined
        ? {}
        : { cacheReadTokens: count(usage.cache_read_tokens) }),
    };

    return Object.keys(measured).length === 0 ? undefined : measured;
  }

  protected buildInvocation(input: AgentRunInput): RunnerInvocation {
    const args = ['--output-format', 'json'];

    if (input.model !== undefined) {
      args.push('--model', input.model);
    }

    const effortKey = input.reasoning === 'very_high' ? 'high' : input.reasoning;
    args.push('--effort', EFFORT[effortKey]);

    if (input.permissions === 'read-only') {
      args.push('--mode', 'plan');
    } else {
      args.push('--mode', 'accept-edits');
    }

    args.push('--add-dir', input.workingDirectory);

    for (const path of input.additionalReadPaths ?? []) {
      args.push('--add-dir', path);
    }

    if (input.outputSchema !== undefined) {
      args.push('--json-schema', JSON.stringify(input.outputSchema));
    }

    return { command: this.command, args, stdin: input.prompt };
  }

  protected override parseEnvelope(result: ProcessResult): unknown {
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      return undefined;
    }
  }

  protected override isDefiniteSuccess(result: ProcessResult, parsed: unknown): boolean {
    const envelope = asEnvelope(parsed);
    if (envelope?.status === 'SUCCESS' && result.exitCode === 0) return true;
    if (envelope?.is_error === false && result.exitCode === 0) return true;
    if (result.exitCode === 0 && envelope?.error === undefined && envelope?.status !== 'ERROR' && envelope?.status !== 'FAILED') return true;
    return false;
  }

  protected errorRules(): readonly ErrorRule[] {
    return [
      {
        code: 'auth_required',
        when: (_result, parsed) => asEnvelope(parsed)?.status_code === 401,
      },
      {
        code: 'quota_exceeded',
        when: (_result, parsed) => asEnvelope(parsed)?.status_code === 429,
      },
      {
        code: 'quota_exceeded',
        when: (result, parsed) => /usage limit|rate limit|quota exceeded/i.test(diagnosisOf(result, parsed)),
      },
      {
        code: 'auth_required',
        when: (result, parsed) => /not authenticated|login required|invalid api key/i.test(diagnosisOf(result, parsed)),
      },
      {
        code: 'execution_failed',
        when: (_result, parsed) => asEnvelope(parsed)?.is_error === true || asEnvelope(parsed)?.status === 'ERROR' || asEnvelope(parsed)?.status === 'FAILED',
      },
    ];
  }

  protected parseSuccess(
    result: ProcessResult,
    input: AgentRunInput,
    _context: unknown,
  ): { text: string; json?: unknown } {
    const raw = result.stdout.trim();
    const envelope = asEnvelope(this.parseEnvelope(result));

    const text = envelope?.response ?? envelope?.result ?? raw;

    if (input.outputSchema === undefined) return { text };

    if (envelope?.structured_output !== undefined) {
      return { text, json: envelope.structured_output };
    }

    try {
      return { text, json: JSON.parse(text) };
    } catch {
      throw new Error('a structured response was requested but the output is not valid JSON');
    }
  }
}

function diagnosisOf(result: ProcessResult, parsed: unknown): string {
  const envelope = asEnvelope(parsed);
  const message = envelope?.error ?? (envelope?.is_error === true ? (envelope.result ?? envelope.response ?? '') : '');
  return `${String(message)} ${result.stderr}`;
}
