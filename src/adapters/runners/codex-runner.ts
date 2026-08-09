import type { AgentRunInput, RunnerCapabilities, RunnerHealth } from '../../ports/agent-runner.js';
import type { ProcessResult, ProcessRunner } from '../../ports/process-runner.js';
import type { FileSystem } from '../../ports/file-system.js';
import type { ReasoningLevel } from '../../contracts/common.schema.js';
import { BaseRunner, type ErrorRule, type RunnerInvocation } from './base-runner.js';

/**
 * Logical reasoning level → the value Codex accepts.
 *
 * Identical to the Claude Code table today, which is a coincidence rather than a
 * guarantee. Keeping the translation inside each adapter is what lets the two
 * diverge without the core noticing.
 *
 * `-c` parses as TOML and an unrecognised effort is passed straight through to
 * config, so a wrong mapping fails quietly here too.
 */
const EFFORT: Readonly<Record<ReasoningLevel, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  very_high: 'xhigh',
};

/** Error envelope Codex writes to stderr. Carries an HTTP status. */
interface CodexError {
  type?: string;
  status?: number;
  error?: { type?: string; message?: string };
}

/** Per-invocation temp paths, carried through instead of stored on the runner. */
interface CodexContext {
  readonly outputPath: string;
}

export interface CodexRunnerOptions {
  readonly id: string;
  readonly processRunner: ProcessRunner;
  readonly command?: string;
  /**
   * Required, unlike the Claude adapter: `--output-schema` takes a *file path*,
   * so producing structured output means writing the schema to disk first.
   */
  readonly fs: FileSystem;
  readonly tempDir?: string;
  /** Injected so tests get deterministic temp paths. */
  readonly uniqueId?: () => string;
}

/**
 * Codex CLI adapter.
 *
 * Two shapes differ from Claude Code and drive the design here:
 *
 *  - The schema goes to disk (`--output-schema <FILE>`), hence the FileSystem
 *    dependency.
 *  - stdout is unusable as the answer — it interleaves hook output, colour
 *    codes and a token counter — so the response is read from the file written
 *    by `-o` instead of parsed out of the stream.
 *
 * All per-run state travels in the invocation context rather than on the
 * instance, so two concurrent runs cannot overwrite each other's temp paths.
 */
export class CodexRunner extends BaseRunner {
  private readonly fs: FileSystem;
  private readonly tempDir: string;
  private readonly uniqueId: () => string;
  private counter = 0;

  constructor(options: CodexRunnerOptions) {
    super({
      id: options.id,
      processRunner: options.processRunner,
      ...(options.command === undefined ? {} : { command: options.command }),
    });
    this.fs = options.fs;
    this.tempDir = options.tempDir ?? '/tmp';
    this.uniqueId =
      options.uniqueId ?? (() => `${String(process.pid)}-${String(++this.counter)}`);
  }

  protected defaultCommand(): string {
    return 'codex';
  }

  capabilities(): RunnerCapabilities {
    return {
      supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
      supportsReadOnly: true,
      supportsNonInteractive: true,
      supportsWorkingDirectory: true,
      /**
       * `prompted`, despite `--output-schema` existing.
       *
       * The flag accepts only OpenAI strict-mode schemas: every object closed,
       * and `required` listing *every* key in `properties` — optional fields
       * included. Our contracts have genuinely optional fields (`scope`,
       * `workspace`, `files`), so satisfying that means rewriting them as
       * nullable-and-required on the way out and stripping the nulls on the way
       * back. A lossy translation in both directions, to gain what the repair
       * loop already provides.
       *
       * So the schema goes in the prompt and the response is validated after
       * the fact, with a bounded retry that names what was wrong. This is
       * exactly the compensation `structuredOutputStrategy` exists to describe.
       */
      structuredOutputStrategy: 'prompted',
    };
  }

  async healthCheck(): Promise<RunnerHealth> {
    const result = await this.processRunner.run({
      command: this.command,
      args: ['--version'],
      cwd: this.tempDir,
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
      // The state a boolean would hide: this CLI's npm package was present here
      // while its native binary was missing, and every call died with ENOENT.
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
      // Not probed: confirming auth costs quota, so it is opt-in (R-14).
      auth: 'unknown',
      version: result.stdout.trim().split('\n')[0] ?? undefined,
    };
  }

  protected async buildInvocation(input: AgentRunInput): Promise<RunnerInvocation> {
    const stamp = this.uniqueId();
    const outputPath = `${this.tempDir}/agent-flow-codex-${stamp}.out`;

    const args = [
      'exec',
      // Codex refuses to run outside a repository by default; agent-flow has to
      // work in whatever directory the user points it at.
      '--skip-git-repo-check',
      // One-shot invocation: no session files left behind.
      '--ephemeral',
      '--color',
      'never',
      '-C',
      input.workingDirectory,
      '-s',
      input.permissions === 'read-only' ? 'read-only' : 'workspace-write',
    ];

    // Omitted when unset so the CLI applies the user's own default (AD-13).
    if (input.model !== undefined) args.push('-m', input.model);

    args.push('-c', `model_reasoning_effort=${EFFORT[input.reasoning]}`);

    for (const path of input.additionalReadPaths ?? []) {
      args.push('--add-dir', path);
    }

    // stdout carries hooks, colour and a token counter; -o gets the answer alone.
    args.push('-o', outputPath);

    const parts: string[] = [];
    if (input.systemPrompt !== undefined) parts.push(input.systemPrompt, '---');
    parts.push(input.prompt);

    // The schema travels in the prompt rather than through --output-schema; see
    // capabilities() for why. Stated after the task so it reads as the format
    // requirement it is, not as part of the work.
    if (input.outputSchema !== undefined) {
      parts.push(
        '---',
        'Your response must be a single JSON object conforming to this JSON Schema.',
        'Return only the object — no prose, no code fences.',
        '',
        JSON.stringify(input.outputSchema, null, 2),
      );
    }

    return {
      command: this.command,
      args,
      stdin: parts.join('\n\n'),
      context: { outputPath } satisfies CodexContext,
      cleanup: async () => {
        await this.fs.remove(outputPath).catch(() => undefined);
      },
    };
  }

  protected override parseEnvelope(result: ProcessResult): unknown {
    // Errors arrive as JSON on stderr, prefixed by "ERROR:" and colour codes.
    // Scan for the first parseable object rather than assuming a fixed shape.
    for (const line of result.stderr.split('\n')) {
      const start = line.indexOf('{');
      if (start === -1) continue;
      try {
        return JSON.parse(line.slice(start)) as unknown;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  protected override isDefiniteSuccess(result: ProcessResult, parsed: unknown): boolean {
    // Exit 0 with no error envelope. Guards the text rules below from matching
    // a response that merely discusses failure — the way an SDD about rate
    // limits was once reported as a rate limit by the other adapter.
    return result.exitCode === 0 && parsed === undefined;
  }

  protected errorRules(): readonly ErrorRule[] {
    const statusOf = (parsed: unknown): number | undefined =>
      typeof parsed === 'object' && parsed !== null ? (parsed as CodexError).status : undefined;

    return [
      // Status first: a code is stable across releases, wording is not.
      { code: 'auth_required', when: (_result, parsed) => statusOf(parsed) === 401 },
      { code: 'auth_required', when: (_result, parsed) => statusOf(parsed) === 403 },
      { code: 'quota_exceeded', when: (_result, parsed) => statusOf(parsed) === 429 },
      {
        code: 'quota_exceeded',
        when: (result) => /usage limit|rate limit|quota exceeded/i.test(result.stderr),
      },
      {
        code: 'auth_required',
        when: (result) => /not (logged in|authenticated)|run `?codex login/i.test(result.stderr),
      },
    ];
  }

  protected async parseSuccess(
    _result: ProcessResult,
    input: AgentRunInput,
    context: unknown,
  ): Promise<{ text: string; json?: unknown }> {
    const { outputPath } = context as CodexContext;

    if (!(await this.fs.exists(outputPath))) {
      throw new Error('the runner produced no final message');
    }

    const text = (await this.fs.readFile(outputPath)).trim();
    if (text.length === 0) throw new Error('the runner produced an empty final message');

    if (input.outputSchema === undefined) return { text };

    try {
      return { text, json: JSON.parse(stripFences(text)) };
    } catch {
      throw new Error('a structured response was requested but the output is not valid JSON');
    }
  }
}

/** Models occasionally wrap JSON in a code fence despite the schema. */
function stripFences(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/m.exec(text.trim());
  return fenced?.[1] ?? text;
}

