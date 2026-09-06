import type { ReasoningLevel } from '../../contracts/common.schema.js';
import type { AgentRunInput, RunnerCapabilities, RunnerHealth } from '../../ports/agent-runner.js';
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
      // Strict containment is not guaranteed by standalone CLI flags (writes to ~/.gemini/antigravity-cli occurred during probe),
      // so supportsReadOnly is explicitly declared false per security baseline requirements.
      supportsReadOnly: false,
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
   * at. One id per line, the id being the first field — the human label after it is for
   * the terminal, not for a config file.
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
      .map((line) => line.trim().split(/\s+/)[0] ?? '')
      .filter((id) => id !== '' && !id.startsWith('-'));
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
