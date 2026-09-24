import type { AgentRunInput, AgentRunUsage, RunnerCapabilities, RunnerHealth } from '../../ports/agent-runner.js';
import type { ProcessResult } from '../../ports/process-runner.js';
import type { ReasoningLevel } from '../../contracts/common.schema.js';
import type { FileSystem } from '../../ports/file-system.js';
import { join } from 'node:path';
import { BaseRunner, type BaseRunnerOptions, type ErrorRule, type RunnerInvocation } from './base-runner.js';

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
  /**
   * Measured on Claude Code 2.1.280 (`-p --output-format json --setting-sources ''`), next
   * to `duration_api_ms, stop_reason, session_id, terminal_reason, errors, duration_ms`.
   * Typed `unknown` because nothing here trusts the CLI's word on the shape.
   */
  num_turns?: unknown;
  /**
   * One entry per refused tool call, measured on 2.1.280 as
   * `{"tool_name":"Write","tool_use_id":"toolu_…","tool_input":{"file_path":…,"content":"hi"}}`.
   * `tool_input` is the content the model tried to write, and is never read here.
   */
  permission_denials?: unknown;
}

/** A number the envelope actually carried, or nothing. Never a zero this file invented. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A turn count the persisted mirror will accept, or nothing.
 *
 * Tighter than `count` on purpose: `RunUsageSchema` takes a non-negative integer, so a
 * `-1` or `1.5` passed through here would fail `result.json`'s parse or drop a telemetry
 * row (D10). Leaving it absent loses one malformed number and nothing else.
 */
function turnCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * How many calls were refused, and which tools — never what they tried to do.
 *
 * Only `tool_name` is read off an entry. `tool_input` carries the content the model meant
 * to write (measured on 2.1.280), which can be a secret, and `tool_use_id` has no reader.
 * An entry with no usable name still counts: it was a refusal, just an unnamed one.
 */
function denialsOf(value: unknown): AgentRunUsage['permissionDenials'] {
  if (!Array.isArray(value)) return undefined;

  const tools: string[] = [];
  for (const entry of value as readonly unknown[]) {
    const name =
      typeof entry === 'object' && entry !== null ? (entry as { tool_name?: unknown }).tool_name : undefined;
    if (typeof name === 'string' && name.length > 0 && !tools.includes(name)) tools.push(name);
  }
  return { count: value.length, tools };
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

/** What stands in for a stdout that carried denied input this adapter could not cut out. */
const WITHHELD_STDOUT = '[claude stdout withheld: unparseable envelope carrying permission_denials tool_input]';

/**
 * stdout with every `permission_denials[].tool_input` removed, or stdout itself.
 *
 * Returned untouched unless there is something to remove, so an envelope without denied
 * input reads in the logs exactly as the CLI printed it. When there is, the envelope is
 * re-serialised: its whitespace changes, which costs nothing because raw text is diagnosis
 * and never drives control flow, and every other key — `tool_name`, `tool_use_id`,
 * `errors`, `result` — stays, because those are what a person reads to find the missing
 * grant.
 *
 * **Fails closed.** A stdout that is not JSON but still names `"tool_input"` cannot be cut
 * safely — a truncated or interleaved envelope has no structure to cut along — so the whole
 * stdout is withheld rather than guessed at (SEC-003).
 */
function withoutToolInput(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return stdout.includes('"tool_input"') ? WITHHELD_STDOUT : stdout;
  }

  const envelope = record(parsed);
  const denials = envelope?.permission_denials;
  if (envelope === undefined || !Array.isArray(denials)) return stdout;
  if (!denials.some((entry: unknown) => Object.hasOwn(record(entry) ?? {}, 'tool_input'))) return stdout;

  return JSON.stringify({
    ...envelope,
    permission_denials: denials.map((entry: unknown) => {
      const denial = record(entry);
      return denial === undefined
        ? entry
        : Object.fromEntries(Object.entries(denial).filter(([key]) => key !== 'tool_input'));
    }),
  });
}

/**
 * The aliases `claude --help` documents, in its order: "an alias for the latest model
 * (e.g. 'fable', 'opus', or 'sonnet')". `haiku` is accepted the same way.
 */
const ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];

export interface ClaudeCodeRunnerOptions extends BaseRunnerOptions {
  /** Reads the model catalog. Absent means the aliases are all there is to offer. */
  readonly fs?: FileSystem;
  /** `<claude config dir>/cache/model-catalog`. See `ClaudeCodeRunner.listModels`. */
  readonly modelCatalogDir?: string;
  /** Which command tool a grant must name. `process.platform` when absent. */
  readonly platform?: NodeJS.Platform;
}

interface CatalogModel {
  readonly id: string;
  readonly minVersion: string | undefined;
}

interface ParsedCatalog {
  readonly fetchedAt: number;
  readonly models: readonly CatalogModel[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One cached catalog, or nothing when it is not a Claude Code catalog of the shape measured.
 *
 * `surface: "cc"` is checked because the directory is keyed per surface and only this one
 * describes what the `claude` binary accepts.
 */
function parseCatalog(value: unknown): ParsedCatalog | undefined {
  const root = record(value);
  const catalog = record(root?.catalog);
  if (catalog === undefined || (catalog.surface !== undefined && catalog.surface !== 'cc')) return undefined;

  const entries = record(catalog.config)?.models;
  if (!Array.isArray(entries)) return undefined;

  const models = entries.flatMap((entry): CatalogModel[] => {
    const model = record(entry);
    const id = model?.id;
    if (typeof id !== 'string' || id.trim() === '') return [];
    const floor = model?.min_claude_code_version;
    return [{ id: id.trim(), minVersion: typeof floor === 'string' ? floor : undefined }];
  });
  if (models.length === 0) return undefined;

  return { fetchedAt: typeof root?.fetchedAt === 'number' ? root.fetchedAt : 0, models };
}

/**
 * Whether `args` carry `--allowedTools` (or `--allowed-tools`) with an entry for the tool this
 * platform runs commands with: `PowerShell` on Windows, `Bash` elsewhere. A `Bash(...)` rule
 * alone was measured denied on Windows (claude 2.1.280, 23/09/2026), so counting it there
 * reported a grant the executor did not have.
 *
 * The flag is variadic, so every token after it up to the next option is one of its values.
 */
function grantsCommands(args: readonly string[], platform: NodeJS.Platform): boolean {
  const tool = platform === 'win32' ? /^PowerShell(\(|$)/ : /^Bash(\(|$)/;
  const names = (value: string): boolean => value.split(/[\s,]+/).some((entry) => tool.test(entry));
  let inAllowlist = false;
  for (const token of args) {
    if (token === '--allowedTools' || token === '--allowed-tools') {
      inAllowlist = true;
      continue;
    }
    // `--allowedTools=PowerShell(npm:*)`: one token, the value after the sign.
    const inline = /^--allowed-?[Tt]ools=(.*)$/.exec(token);
    if (inline !== null) {
      if (names(inline[1] ?? '')) return true;
      inAllowlist = false;
      continue;
    }
    if (token.startsWith('-')) {
      inAllowlist = false;
      continue;
    }
    if (inAllowlist && names(token)) return true;
  }
  return false;
}

/** Numeric, segment by segment: `2.1.280` > `2.1.99`. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (Number.isNaN(difference)) return 0;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Claude Code adapter.
 *
 * Everything provider-specific about this CLI lives here: flag names, the effort
 * vocabulary, the JSON envelope, and how failures are phrased. Nothing above
 * this file knows any of it.
 */
export class ClaudeCodeRunner extends BaseRunner {
  private readonly fs: FileSystem | undefined;
  /** Where `claude` caches the account's model picker. See {@link listModels}. */
  private readonly modelCatalogDir: string | undefined;
  private readonly platform: NodeJS.Platform;

  constructor(options: ClaudeCodeRunnerOptions) {
    super(options);
    this.fs = options.fs;
    this.modelCatalogDir = options.modelCatalogDir;
    this.platform = options.platform ?? process.platform;
  }

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
      //
      // **True when the operator granted it in `RunnerConfig.args`**: `--allowedTools` with a
      // `Bash(…)` entry (`PowerShell(…)` on Windows) is how Claude Code allows a command in `-p`, and it is the remedy
      // `doctor` itself prints. Reading only the default made the Diagnostics page say
      // "missing permission" for a project whose args granted exactly that, while `doctor`
      // in the terminal said OK — two answers from one configuration.
      nonInteractiveToolGrants: { fileEdit: true, commandExecution: grantsCommands(this.extraArgs, this.platform) },
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
   * The models this account can run, read from the catalog the CLI itself caches, then the
   * aliases it documents (AD-13).
   *
   * Claude Code has no `models` subcommand, and the list used to be declared here as
   * `opus, sonnet, haiku`. That is the defect this replaces, and it was measured rather than
   * reasoned: on 23/09/2026 the account could run Opus 5.5 and Fable 5.1, and the editor
   * offered neither — the aliases list had no `fable` at all, and a declared list of dated
   * ids would have rotted the same way one release later.
   *
   * **The source is `<config dir>/cache/model-catalog/*.json`,** which `claude` 2.1.280
   * writes after fetching the account's model picker. It is the same list `/model` shows,
   * so it follows the account (a model an organisation disabled is absent) and it follows
   * releases without this file changing. It carries no credential — ids, names, effort
   * options — which is what makes reading it acceptable next to AD-14. It is also an
   * undocumented cache, so every field is checked and anything unexpected contributes
   * nothing: this feeds a suggestion list, and the field stays open for a typed id.
   *
   * A model with `min_claude_code_version` above the installed CLI is left out. Offering it
   * would let a role be pinned to an id the spawned CLI rejects, and that failure would
   * surface mid-run instead of in the editor. The version is asked only when some model
   * sets a floor, and an unreadable version keeps the model: the CLI is the real judge.
   *
   * The aliases ride after the ids because they answer a different wish — "the current
   * Opus, whatever that is" — and removing them would take that choice away.
   */
  async listModels(): Promise<readonly string[]> {
    const catalog = await this.readModelCatalog();
    if (catalog.length === 0) return ALIASES;

    const installed = catalog.some((model) => model.minVersion !== undefined)
      ? await this.installedVersion()
      : undefined;
    const runnable = catalog.filter((model) =>
      model.minVersion === undefined || installed === undefined || compareVersions(installed, model.minVersion) >= 0,
    );

    return [...new Set([...runnable.map((model) => model.id), ...ALIASES])];
  }

  /** The newest catalog in {@link modelCatalogDir}, or nothing. Never throws. */
  private async readModelCatalog(): Promise<readonly CatalogModel[]> {
    const dir = this.modelCatalogDir;
    if (this.fs === undefined || dir === undefined) return [];

    let names: string[];
    try {
      names = await this.fs.readDir(dir);
    } catch {
      return [];
    }

    let newest: ParsedCatalog | undefined;
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      let parsed: ParsedCatalog | undefined;
      try {
        parsed = parseCatalog(JSON.parse(await this.fs.readFile(join(dir, name))));
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && (newest === undefined || parsed.fetchedAt > newest.fetchedAt)) newest = parsed;
    }
    return newest?.models ?? [];
  }

  /** `2.1.280` out of `2.1.280 (Claude Code)`, or nothing. */
  private async installedVersion(): Promise<string | undefined> {
    const result = await this.processRunner.run({
      command: this.command,
      args: ['--version'],
      cwd: process.cwd(),
      timeoutSeconds: 15,
    });
    if (result.spawnFailed || result.exitCode !== 0) return undefined;
    return /\d+(?:\.\d+)+/.exec(result.stdout)?.[0];
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
   *
   * **`--safe-mode` goes when an MCP set is declared, because the two cannot coexist.**
   * Probed on `claude 2.1.268` against a stub server returning a known marker: with
   * `--mcp-config` and `--strict-mcp-config` the tool answered; adding `--safe-mode` to the
   * otherwise identical command made the model report the tool did not exist. The blanket
   * wins, and it takes the repository's own code index with it — which is how one discovery
   * stage came to read a monorepo file by file until its timeout killed it.
   * `RunnerConfig.mcp` carries what the trade costs; this is where it is spent.
   */
  protected override isolationArgs(): readonly string[] {
    if (this.mcp === undefined) return ['--setting-sources', '', '--safe-mode'];

    return [
      // The settings files stay shut either way: this is the flag that closed the measured
      // `language` leak, and nothing about MCP re-opens it.
      '--setting-sources',
      '',
      '--mcp-config',
      this.mcp.config,
      // **Granted per server, with `--strict-mcp-config` last on purpose.** `--allowedTools`
      // is variadic and swallows the words after it — the hazard `--disallowedTools` already
      // documents above — so an option token has to terminate it *inside* this list, before
      // `RunnerConfig.args` rides after. A server loaded but not granted is worse than
      // absent: measured, it returns one permission denial per call, which spends the
      // invocation and answers nothing.
      ...(this.mcp.servers.length === 0
        ? []
        : ['--allowedTools', ...this.mcp.servers.map((server) => `mcp__${server}`)]),
      '--strict-mcp-config',
    ];
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
   * The failure text, without the input of any tool call the CLI refused.
   *
   * For this CLI stdout is the whole envelope, and `permission_denials[].tool_input` carries
   * what the model tried to pass — measured on 2.1.280 as the full `content` of a denied
   * `Write`, which can be a secret. The base text reaches the stage log, `stage_failed`'s
   * excerpt, `attempt-<n>.failed.json`, failure-context packets, `doctor --deep` and the CLI
   * error renderer, and `redactEvidence` removes credential patterns, not file content. So
   * it is cut here, once, where the vocabulary is allowed to be known (AD-13), rather than
   * in each of those readers.
   *
   * Only stdout: stderr is joined unchanged by the base rules. Nothing was seen on stderr
   * under a denial, but stderr under one was never captured either — see
   * docs/runner-capabilities.md.
   */
  protected override rawMessage(result: ProcessResult): string {
    return super.rawMessage({ ...result, stdout: withoutToolInput(result.stdout) });
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
   *
   * `turns` and `permissionDenials` (P1.2) follow the same rule. `permission_denials: []`
   * is a statement — none were refused — so it becomes `{ count: 0, tools: [] }`; only a
   * missing or non-array field is silence.
   */
  protected override parseUsage(_result: ProcessResult, parsed: unknown): AgentRunUsage | undefined {
    const envelope = asEnvelope(parsed);
    if (envelope === undefined) return undefined;

    const turns = turnCount(envelope.num_turns);
    const permissionDenials = denialsOf(envelope.permission_denials);

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
      ...(turns === undefined ? {} : { turns }),
      ...(permissionDenials === undefined ? {} : { permissionDenials }),
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
