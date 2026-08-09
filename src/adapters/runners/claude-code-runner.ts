import type { AgentRunInput, RunnerCapabilities, RunnerHealth } from '../../ports/agent-runner.js';
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
        when: (result, parsed) => {
          const text = `${asEnvelope(parsed)?.result ?? ''} ${result.stdout} ${result.stderr}`;
          return /usage limit reached|rate limit|quota/i.test(text);
        },
      },
      {
        code: 'auth_required',
        when: (result, parsed) => {
          const text = `${asEnvelope(parsed)?.result ?? ''} ${result.stdout} ${result.stderr}`;
          return /please run \/login|invalid api key|not authenticated/i.test(text);
        },
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
