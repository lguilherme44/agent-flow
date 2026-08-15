import type { AgentRunInput, RunnerCapabilities, RunnerHealth } from '../../ports/agent-runner.js';
import type { ProcessResult } from '../../ports/process-runner.js';
import { BaseRunner, type ErrorRule, type RunnerInvocation } from './base-runner.js';

const EFFORT: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

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

  capabilities(): RunnerCapabilities {
    return {
      supportedReasoningLevels: ['low', 'medium', 'high'],
      // Strict containment is not guaranteed by standalone CLI flags (writes to ~/.gemini/antigravity-cli occurred during probe),
      // so supportsReadOnly is explicitly declared false per security baseline requirements.
      supportsReadOnly: false,
      supportsNonInteractive: true,
      supportsWorkingDirectory: true,
      // Structured output strategy is prompted because native json-schema enforcement in headless CLI mode requires manual permission configuration.
      structuredOutputStrategy: 'prompted',
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
