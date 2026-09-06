import type { AgentRunInput, AgentRunUsage, RunnerCapabilities, RunnerHealth } from '../../ports/agent-runner.js';
import type { ProcessResult } from '../../ports/process-runner.js';
import type { ReasoningLevel } from '../../contracts/common.schema.js';
import { BaseRunner, type ErrorRule, type RunnerInvocation } from './base-runner.js';

/**
 * Logical reasoning level → the value Claude Code accepts.
 *
 * `max` is supported by the CLI and deliberately unused: the cost is
 * disproportionate to the gain over `xhigh` for these stages.
 *
 * Getting this table wrong is quiet rather than loud. An unrecognised --effort
 * prints a warning and falls back to the default instead of failing, so a bad
 * mapping would run at the wrong level while looking fine — which is why the
 * tests assert every produced value is one the CLI recognises.
 */
const EFFORT: Readonly<Record<ReasoningLevel, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  very_high: 'xhigh',
};

/** Denied outright for read-only stages, on top of plan mode (§35). */
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

/** Shape of the `--output-format json` envelope. See docs/runner-capabilities.md. */
interface ClaudeEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  /** Per-model accounting, keyed by the id the API answered with. */
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; canonicalModel?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/** A number the envelope actually carried, or nothing. Never a zero this file invented. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The model that wrote the answer, out of every model the call touched.
 *
 * `canonicalModel` rather than the record key: the key is whatever id the API answered
 * with, and the canonical name is the one that stays comparable across a run. The key is
 * the fallback for an envelope that omits it.
 *
 * Ranked by output tokens because a call served by a main model and a small sub-agent
 * should be attributed to the one that produced the response, and ties keep the first
 * entry so the answer does not depend on object iteration luck.
 */
function principalModel(
  modelUsage: Record<string, { outputTokens?: number; canonicalModel?: string }> | undefined,
): string | undefined {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) return undefined;

  let best = entries[0];
  for (const entry of entries.slice(1)) {
    if ((count(entry[1].outputTokens) ?? 0) > (count(best?.[1].outputTokens) ?? 0)) best = entry;
  }
  return best?.[1].canonicalModel ?? best?.[0];
}

function asEnvelope(value: unknown): ClaudeEnvelope | undefined {
  return typeof value === 'object' && value !== null ? (value as ClaudeEnvelope) : undefined;
}

/**
 * Claude Code adapter.
 *
 * Everything provider-specific about this CLI lives here: flag names, the effort
 * vocabulary, the JSON envelope, and how failures are phrased. Nothing above
 * this file knows any of it.
 */
export class ClaudeCodeRunner extends BaseRunner {
  protected defaultCommand(): string {
    return 'claude';
  }

  capabilities(): RunnerCapabilities {
    return {
      supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
      supportsReadOnly: true,
      supportsNonInteractive: true,
      supportsWorkingDirectory: true,
      // `--json-schema` is enforced by the runtime, not merely requested in the
      // prompt: the response carries a parsed `structured_output` field.
      structuredOutputStrategy: 'native',
      // AD-32. Declared from what the CLI documents and what the probe exercised, not
      // from a run that happened to work: `--permission-mode acceptEdits` is what the
      // adapter passes for a write stage, and it is what makes `fileEdit` true.
      //
      // `commandExecution` is false, and that is a measurement rather than a
      // pessimism: the probe never exercised a Bash tool call under
      // `acceptEdits`, and `--dangerously-skip-permissions` is explicitly out of
      // scope (it would remove the containment AD-14 assigns to the runner). False
      // does not block execution — it produces a `permission_not_ready` warning and
      // a preflight finding, so an unmeasured grant is visible instead of assumed.
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
      // Present but not runnable — the state a single boolean would hide.
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
      // Deliberately not probed here: confirming auth means spending quota, so
      // it is opt-in via `doctor --deep` (R-14).
      auth: 'unknown',
      version: result.stdout.trim().split('\n')[0] ?? undefined,
    };
  }

  /**
   * The aliases this CLI accepts, not the model ids behind them (AD-13).
   *
   * Claude Code has no `models` subcommand to ask, so this is the one list here that is
   * declared rather than enumerated — and it is declared as *aliases* on purpose. An
   * alias like `opus` keeps meaning the current Opus as versions land; the dated id it
   * resolves to today is exactly the kind of name AD-13 says rots. A person who wants a
   * pinned id still types it: this is a suggestion list, and the field stays open.
   */
  async listModels(): Promise<readonly string[]> {
    return ['opus', 'sonnet', 'haiku'];
  }

  /**
   * Both flags, because one of them was measured to be insufficient (PRI-18).
   *
   * `--setting-sources ''` names which settings files load, and an empty list loads none.
   * `--safe-mode` disables the customisation surface that is *not* a settings file:
   * `CLAUDE.md`, skills, plugins, hooks, MCP servers, custom commands and agents, output
   * styles — while auth, model selection, the built-in tools and permissions keep working.
   *
   * **`--safe-mode` alone does not close the leak that produced the finding, and this was
   * checked rather than assumed.** Same prompt, `claude 2.1.263`, on a machine whose
   * `~/.claude/settings.json` sets `language: Portugues`:
   *
   * ```
   * … --disallowedTools Write Edit NotebookEdit --safe-mode
   *   → "Uma lista ligada é uma estrutura de dados linear …"
   *
   * … --disallowedTools Write Edit NotebookEdit --setting-sources '' --safe-mode
   *   → "A linked list is a linear data structure …"
   * ```
   *
   * So the live-dogfood report was right about `--setting-sources` and this adapter was
   * briefly wrong to prefer `--safe-mode` over it. Neither is redundant: the first covers
   * `language` and `outputStyle`, the second covers `CLAUDE.md` and everything loaded
   * beside it.
   *
   * The same run answers the ordering question. These land after `--disallowedTools`,
   * which is variadic, and an option token terminates it — proven by the English answer
   * above rather than by reading a parser's documentation.
   *
   * `--restricted` was a third candidate and goes too far: it removes Bash and the other
   * code-running tools, which an implementation stage needs.
   *
   * **Not `--system-prompt` in place of `--append-system-prompt`.** The report proposed
   * that too, and there it is wrong: `--system-prompt` replaces the CLI's built-in prompt,
   * which is where its own tool conventions live. Removing them to remove a persona costs
   * far more than it saves, and the persona arrives through settings.
   */
  protected override isolationArgs(): readonly string[] {
    return ['--setting-sources', '', '--safe-mode'];
  }

  protected buildInvocation(input: AgentRunInput): RunnerInvocation {
    const args = ['-p', '--output-format', 'json'];

    // Omitted when unset so the CLI applies the user's own default (AD-13).
    if (input.model !== undefined) args.push('--model', input.model);

    args.push('--effort', EFFORT[input.reasoning]);

    if (input.permissions === 'read-only') {
      args.push('--permission-mode', 'plan');
      // Plan mode already blocks project writes; denying the tools outright
      // means the guarantee does not rest on one flag alone.
      args.push('--disallowedTools', ...WRITE_TOOLS);
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }

    if (input.systemPrompt !== undefined) {
      args.push('--append-system-prompt', input.systemPrompt);
    }

    for (const path of input.additionalReadPaths ?? []) {
      args.push('--add-dir', path);
    }

    if (input.outputSchema !== undefined) {
      args.push('--json-schema', JSON.stringify(input.outputSchema));
    }

    // The prompt goes on stdin: `--disallowedTools` is variadic and swallows a
    // positional prompt word by word (see docs/runner-capabilities.md).
    return { command: this.command, args, stdin: input.prompt };
  }

  protected override parseEnvelope(result: ProcessResult): unknown {
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      return undefined;
    }
  }

  /**
   * The accounting this CLI returns on every response, and this adapter used to discard
   * (PRI-19).
   *
   * `modelUsage` is the field that matters: it names the model that answered, which no
   * other source can supply once AD-13's advice not to pin a model is followed. Where more
   * than one model served one call — a sub-agent alongside the main one — the entry with
   * the most output tokens is reported, because that is the one that wrote the answer; the
   * token and cost totals below come from `usage` and `total_cost_usd`, which already
   * cover every model in the call.
   *
   * Nothing is defaulted to zero. A field the envelope did not carry stays absent, so a
   * reader can tell "this CLI did not say" from "this cost nothing".
   */
  protected override parseUsage(_result: ProcessResult, parsed: unknown): AgentRunUsage | undefined {
    const envelope = asEnvelope(parsed);
    if (envelope === undefined) return undefined;

    const usage: AgentRunUsage = {
      ...(principalModel(envelope.modelUsage) === undefined
        ? {}
        : { model: principalModel(envelope.modelUsage) }),
      ...(count(envelope.usage?.input_tokens) === undefined
        ? {}
        : { inputTokens: count(envelope.usage?.input_tokens) }),
      ...(count(envelope.usage?.output_tokens) === undefined
        ? {}
        : { outputTokens: count(envelope.usage?.output_tokens) }),
      ...(count(envelope.usage?.cache_read_input_tokens) === undefined
        ? {}
        : { cacheReadTokens: count(envelope.usage?.cache_read_input_tokens) }),
      ...(count(envelope.usage?.cache_creation_input_tokens) === undefined
        ? {}
        : { cacheWriteTokens: count(envelope.usage?.cache_creation_input_tokens) }),
      ...(count(envelope.total_cost_usd) === undefined
        ? {}
        : { costUsd: count(envelope.total_cost_usd) }),
    };

    // An empty object would claim a measurement was taken. Nothing was.
    return Object.keys(usage).length === 0 ? undefined : usage;
  }

  protected override isDefiniteSuccess(result: ProcessResult, parsed: unknown): boolean {
    // The envelope says so outright. This must win over the text-matching rules
    // below, or a document that merely *discusses* rate limits gets reported as
    // one — which is not hypothetical: an SDD about booking quotas was
    // misclassified as quota_exceeded before this check existed.
    const envelope = asEnvelope(parsed);
    return envelope?.is_error === false && envelope.subtype === 'success' && result.exitCode === 0;
  }

  protected errorRules(): readonly ErrorRule[] {
    return [
      {
        // Status first: wording changes between releases, a status code does not.
        code: 'auth_required',
        when: (_result, parsed) => asEnvelope(parsed)?.api_error_status === 401,
      },
      {
        code: 'quota_exceeded',
        when: (_result, parsed) => {
          const status = asEnvelope(parsed)?.api_error_status;
          return status === 429;
        },
      },
      {
        // Secondary signal. The synthetic fixtures are guesses about phrasing,
        // so a wording change degrades this to execution_failed rather than
        // silently mislabelling something else as a quota problem.
        code: 'quota_exceeded',
        when: (result, parsed) => /usage limit reached|rate limit|quota/i.test(diagnosisOf(result, parsed)),
      },
      {
        code: 'auth_required',
        when: (result, parsed) => /please run \/login|invalid api key|not authenticated/i.test(diagnosisOf(result, parsed)),
      },
      {
        code: 'execution_failed',
        when: (_result, parsed) => asEnvelope(parsed)?.is_error === true,
      },
    ];
  }

  protected parseSuccess(
    result: ProcessResult,
    input: AgentRunInput,
    _context: unknown,
  ): { text: string; json?: unknown } {
    const envelope = asEnvelope(this.parseEnvelope(result));

    if (envelope === undefined) {
      throw new Error('expected a JSON envelope on stdout, got unparseable output');
    }

    const text = envelope.result ?? '';

    if (input.outputSchema === undefined) return { text };

    // The runtime normally fills structured_output; `result` carries the same
    // JSON as a string, so it is a sufficient fallback.
    if (envelope.structured_output !== undefined) {
      return { text, json: envelope.structured_output };
    }

    try {
      return { text, json: JSON.parse(text) };
    } catch {
      throw new Error('a structured response was requested but the output is not valid JSON');
    }
  }
}

/**
 * The text that counts as the CLI reporting a problem.
 *
 * `envelope.result` is included only when the envelope calls itself an error.
 * Otherwise it is the model's answer, and reading it as diagnosis lets the
 * subject matter of the work decide the error code — an SDD about rate limits
 * classified as a rate limit. That happened here once (§6) and again in the
 * codex adapter, from a different direction, which is why the rule is now
 * stated rather than left to the success guard alone.
 */
function diagnosisOf(result: ProcessResult, parsed: unknown): string {
  const envelope = asEnvelope(parsed);
  const message = envelope?.is_error === true ? (envelope.result ?? '') : '';
  return `${String(message)} ${result.stderr}`;
}
