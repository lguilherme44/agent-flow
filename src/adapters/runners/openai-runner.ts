import type { ReasoningLevel, RunnerErrorCode } from '../../contracts/common.schema.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  RunnerCapabilities,
  RunnerHealth,
} from '../../ports/agent-runner.js';

/**
 * An `AgentRunner` over an OpenAI-compatible inference endpoint.
 *
 * **Not a coding CLI, and the whole design follows from that.** Claude Code, Codex and AGY
 * are *agents*: they hold a working directory, read files, run commands and edit code. An
 * inference endpoint holds a conversation. It has no filesystem on the other side, so
 * handing it a working directory and `permissions: 'write'` would be asking for something
 * it structurally cannot do — and the failure would arrive as a stage reporting success
 * having changed nothing, which is exactly the shape AR-05a exists to catch.
 *
 * So this adapter declares what is true and refuses what is not, and the role resolver's
 * existing capability gates do the rest. `supportsWorkingDirectory: false` is not a
 * limitation to be worked around; it is the fact that decides which roles may use it.
 *
 * **What it is for.** Nine of the eleven shipped prompts already carry their whole input:
 * `sdd`, `planning` (all three variants), `plan-review` (both), `verification`,
 * `final-review` and `architecture-impact` receive text and produce text or JSON, and
 * touch no file. The three that do are `discovery` — whose prompt says "prefer reading a
 * file over inferring from its name" — `implementation`, and `code-review`. The last is the
 * one that bites: it lands on `finalReviewer`, so pointing that role at an endpoint fails at
 * the end of a run rather than at its start. `test/contracts/prompt-requirements.test.ts`
 * fails if a new prompt declares `workingDirectory: true` without this list following. A local endpoint can serve
 * the nine, which puts the two review stages on a genuinely independent provider at no
 * quota cost, and that is the point rather than a consolation.
 *
 * Provider-neutral above this file, as every adapter is: nothing here leaks upward, and
 * `model` is whatever the server was started with.
 */

/**
 * This adapter's own floor, and it is the tighter of the two in the codebase.
 *
 * 300s is generous for an endpoint answering from a frontier model and tight for a
 * local one: a measured SDD stage took 101s and a planning stage 165s on a model
 * generating at ~39 tokens/second, both inside it — but a longer prompt on a slower
 * machine is not. Set `timeoutSeconds` on the role when that is the case.
 */
const DEFAULT_TIMEOUT_SECONDS = 300;
const HEALTH_TIMEOUT_SECONDS = 10;

/**
 * The reasoning levels the port defines, all of them.
 *
 * An inference endpoint has no effort dial: the server was started with one model at one
 * quantisation, and asking for `high` changes nothing about what it does. Declaring all
 * four is therefore honest rather than generous — every level is equally supported,
 * because none of them is differentiated. Declaring fewer would make `clampReasoning` fire
 * and record a degradation describing a downgrade that did not happen.
 */
const REASONING_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high', 'very_high'];

export interface OpenAiRunnerOptions {
  readonly id: string;
  /** `http://host:port/v1`, or a bare origin. */
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer <key>`. Never logged, never persisted. */
  readonly apiKey?: string;
  /** The model id to request. Defaults to whatever the server serves. */
  readonly model?: string;
  readonly timeoutSeconds?: number;
  /** Injectable for tests. Production leaves it unset. */
  readonly fetch?: typeof fetch;
}

interface ChatChoice {
  readonly message?: { readonly content?: string | null };
  readonly finish_reason?: string;
}

interface ChatResponse {
  readonly choices?: readonly ChatChoice[];
  readonly usage?: Record<string, unknown>;
  readonly error?: { readonly message?: string } | string;
}

export class OpenAiRunner implements AgentRunner {
  readonly id: string;

  private readonly chatUrl: string;
  private readonly modelsUrl: string;
  private readonly apiKey?: string;
  private readonly model?: string;
  private readonly timeoutSeconds: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiRunnerOptions) {
    this.id = options.id;

    const { chatUrl, modelsUrl } = endpointsOf(options.baseUrl);
    this.chatUrl = chatUrl;
    this.modelsUrl = modelsUrl;

    if (options.apiKey !== undefined) this.apiKey = options.apiKey;
    if (options.model !== undefined) this.model = options.model;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * What an inference endpoint can do, stated structurally (AD-30, AD-32).
   *
   * The parameter is accepted and unused: a llama.cpp or vLLM server serves one model at a
   * time, so there is nothing model-specific to say. When a deployment serves several and
   * they differ, the measurement goes here — in the adapter that owns the provider.
   */
  capabilities(_model?: string): RunnerCapabilities {
    return {
      supportedReasoningLevels: REASONING_LEVELS,
      // Satisfied by construction rather than by a flag: there is no filesystem on the
      // other side of an HTTP call, so a stage that must not write cannot.
      supportsReadOnly: true,
      supportsNonInteractive: true,
      // **False, and load-bearing.** This is what makes the role resolver refuse
      // `discovery` and `implementation` here instead of routing them to something that
      // cannot look at the repository.
      supportsWorkingDirectory: false,
      // `response_format: json_schema` is enforced by the server's grammar sampler, not
      // requested in the prompt. Measured against llama.cpp: a schema with an enum and a
      // nested object array came back valid on the first response.
      structuredOutputStrategy: 'native',
      // No tool definitions are sent, so no tool can be exercised. AD-32 answered from the
      // shape of the request rather than from optimism about the model.
      nonInteractiveToolGrants: { fileEdit: false, commandExecution: false },
    };
  }

  async healthCheck(): Promise<RunnerHealth> {
    try {
      const response = await this.send(this.modelsUrl, undefined, HEALTH_TIMEOUT_SECONDS);

      if (response.status === 401 || response.status === 403) {
        return { installed: true, executable: true, auth: 'not_configured' };
      }
      if (!response.ok) {
        return {
          installed: true,
          executable: false,
          auth: 'unknown',
          detail: `the endpoint answered ${String(response.status)}`,
        };
      }

      const body = (await response.json()) as { data?: readonly { id?: string }[] };
      const served = body.data?.map((entry) => entry.id).filter(Boolean).join(', ');

      return {
        installed: true,
        executable: true,
        auth: 'configured',
        ...(served === undefined || served.length === 0 ? {} : { version: served }),
      };
    } catch (error) {
      return {
        installed: false,
        executable: false,
        auth: 'unknown',
        // The endpoint, never the key. This string reaches `doctor` and the read model.
        detail: reasonOf(error),
      };
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = Date.now();

    // **Refused before the request, not after.** A write stage asks the runner to change
    // files; this one has none to change, and accepting the work would produce a stage
    // that reports success having done nothing — a false positive arriving from the
    // opposite direction to the ones AR-05a catches.
    if (input.permissions === 'write') {
      return {
        ok: false,
        errorCode: 'execution_failed',
        raw:
          'this runner is an inference endpoint and cannot write: it has no working ' +
          'directory, so a stage declaring permissions: write must be routed to a coding agent',
        durationMs: Date.now() - startedAt,
      };
    }

    const messages: { role: string; content: string }[] = [
      ...(input.systemPrompt === undefined
        ? []
        : [{ role: 'system', content: input.systemPrompt }]),
      { role: 'user', content: input.prompt },
    ];

    const body: Record<string, unknown> = {
      model: input.model ?? this.model ?? 'default',
      messages,
      ...(input.outputSchema === undefined
        ? {}
        : {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'response', strict: true, schema: input.outputSchema },
            },
          }),
    };

    try {
      const response = await this.send(this.chatUrl, body, input.timeoutSeconds);
      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        return {
          ok: false,
          errorCode: statusToCode(response.status),
          raw: redactKey(await safeText(response), this.apiKey),
          durationMs,
        };
      }

      const parsed = (await response.json()) as ChatResponse;
      const text = parsed.choices?.[0]?.message?.content ?? '';

      if (input.outputSchema === undefined) return { ok: true, text, durationMs };

      // A schema was enforced by the server, so a reply that does not parse means the
      // grammar was not applied — a contract failure rather than a bad answer, and one
      // the repair loop is built for.
      try {
        return { ok: true, text, json: JSON.parse(text.trim()), durationMs };
      } catch {
        return {
          ok: false,
          errorCode: 'invalid_output',
          raw: `a structured response was requested and the reply is not valid JSON: ${text.slice(0, 500)}`,
          durationMs,
        };
      }
    } catch (error) {
      return {
        ok: false,
        errorCode: errorToCode(error),
        raw: redactKey(reasonOf(error), this.apiKey),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * What the endpoint serves, from the endpoint (AD-13).
   *
   * `GET /models` is the one part of the OpenAI shape that is genuinely standard, and
   * `healthCheck` above already reads it — for a *version* string, which flattened the
   * list into prose. This returns the ids as ids, for a control that offers them.
   *
   * A server that will not answer contributes nothing. An editor that suggests nothing is
   * an editor with a plain text box, which is the state this improves on and never worse.
   */
  async listModels(): Promise<readonly string[]> {
    try {
      const response = await this.send(this.modelsUrl, undefined, HEALTH_TIMEOUT_SECONDS);
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: readonly { id?: unknown }[] };
      return (body.data ?? []).map(({ id }) => id).filter((id): id is string => typeof id === 'string' && id !== '');
    } catch {
      return [];
    }
  }

  private async send(
    url: string,
    body: Record<string, unknown> | undefined,
    timeoutSeconds: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, Math.max(1, timeoutSeconds) * 1000);

    try {
      return await this.fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `<base>/chat/completions` and `<base>/models`, whatever shape the base was given in.
 *
 * A user writes the base URL by hand, and both `http://host:8080` and
 * `http://host:8080/v1` are the obvious things to write.
 */
function endpointsOf(rawBaseUrl: string): { chatUrl: string; modelsUrl: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`Invalid baseUrl "${rawBaseUrl}": expected an http(s) URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid baseUrl "${rawBaseUrl}": protocol must be http or https`);
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  const root = `${parsed.protocol}//${parsed.host}${path.endsWith('/v1') ? path : `${path}/v1`}`;

  return { chatUrl: `${root}/chat/completions`, modelsUrl: `${root}/models` };
}

/**
 * HTTP status to the normalised vocabulary (§22.1).
 *
 * Only the two codes that mean *infrastructure* are named; everything else collapses to
 * `execution_failed`, which is deliberately not a fallback trigger (§55).
 */
function statusToCode(status: number): RunnerErrorCode {
  if (status === 401 || status === 403) return 'auth_required';
  if (status === 429) return 'quota_exceeded';
  return 'execution_failed';
}

function errorToCode(error: unknown): RunnerErrorCode {
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  // A machine that is off is infrastructure, and infrastructure is what fallback is for.
  if (error instanceof TypeError) return 'runner_unavailable';
  return 'execution_failed';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return `the endpoint answered ${String(response.status)} with an unreadable body`;
  }
}

/** The key is a credential this adapter holds, and `raw` is persisted (I-21). */
function redactKey(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.length === 0) return text;
  return text.split(apiKey).join('[redacted]').split('Bearer ').join('');
}
