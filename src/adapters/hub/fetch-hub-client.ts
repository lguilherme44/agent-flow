import type { HubClient, HubRequest, HubResponse } from '../../ports/hub-client.js';

/**
 * The hub over HTTP, with `fetch` injected so a test can stand in for the network.
 *
 * **No `Origin`, and the client header on every request.** The hub admits a write either
 * on an `Origin` equal to its own (the Deck) or on the client header; a plan-gate decision
 * is recorded with the channel derived from which of the two let it in. Sending only the
 * header is what makes a decision an AI relayed through this server read as `api` — the
 * channel the Deck flags — rather than as the human's own browser. Node's `fetch` adds no
 * `Origin` of its own; this adapter adds none either, and the test holds it to that.
 */

/**
 * The header the hub's write guard reads (`CLIENT_HEADER` in `server/request-guard.ts`).
 *
 * Spelled here rather than imported because an adapter may not depend on the server
 * (`test/architecture.test.ts`); the Deck spells it a third time for the same reason.
 * `test/adapters/fetch-hub-client.test.ts` asserts the two agree.
 */
export const HUB_CLIENT_HEADER = 'x-agent-flow-client';

/** What this client calls itself in that header. A label, not evidence: the hub says so. */
export const MCP_CLIENT_NAME = 'mcp';

/**
 * Long enough for the slowest synchronous route — `POST /runs` creates the run behind the
 * CLI's own preflight, which runs Git — and short enough that a wedged hub does not hold a
 * model's tool call open indefinitely. Planning and execution are jobs and answer at once.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** An error body is quoted to a model, so a proxy's HTML page must not arrive whole. */
const MAX_FOREIGN_ERROR_LENGTH = 500;

/** The part of `fetch` this adapter uses, so a fake needs nothing else. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly status: number; readonly ok: boolean; text(): Promise<string> }>;

export interface FetchHubClientOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export class FetchHubClient implements HubClient {
  readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: FetchHubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(request: HubRequest): Promise<HubResponse> {
    const url = this.urlOf(request);
    const headers: Record<string, string> = {
      accept: 'application/json',
      [HUB_CLIENT_HEADER]: MCP_CLIENT_NAME,
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.ok) {
        // Empty is `null` (no route here answers 2xx empty, but `null` is a legal answer);
        // a body that will not parse is not the hub's, whatever the status said.
        const body = parseJson(text);
        if (body === undefined && text.trim() !== '') {
          return { kind: 'not_hub', url: this.baseUrl, status: response.status };
        }
        return { kind: 'ok', status: response.status, body: body ?? null };
      }
      return errorOf(response.status, text);
    } catch (error) {
      if (timedOut) return { kind: 'timeout', url: this.baseUrl, timeoutMs: this.timeoutMs };
      return {
        kind: 'unreachable',
        url: this.baseUrl,
        reason: error instanceof Error ? causeOf(error) : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private urlOf(request: HubRequest): string {
    const query = new URLSearchParams(request.query ?? {}).toString();
    return `${this.baseUrl}/api/v1${request.path}${query === '' ? '' : `?${query}`}`;
  }
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The API's `{ error, message, action }` when the body is that, a bounded quote when not. */
function errorOf(status: number, text: string): HubResponse {
  const body = parseJson(text) as
    | { error?: unknown; message?: unknown; action?: unknown; detail?: unknown }
    | undefined;
  if (body !== undefined && typeof body === 'object' && body !== null && typeof body.message === 'string') {
    return {
      kind: 'http_error',
      status,
      error: typeof body.error === 'string' ? body.error : `http_${String(status)}`,
      message: body.message,
      ...(typeof body.action === 'string' ? { action: body.action } : {}),
      ...(typeof body.detail === 'object' && body.detail !== null && !Array.isArray(body.detail)
        ? { detail: body.detail as Record<string, unknown> }
        : {}),
    };
  }
  return {
    kind: 'http_error',
    status,
    error: `http_${String(status)}`,
    message: text.trim().slice(0, MAX_FOREIGN_ERROR_LENGTH) || `HTTP ${String(status)}`,
  };
}

/** `fetch failed` says nothing; the refused connection is in `cause`. */
function causeOf(error: Error): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message !== '') return `${error.message} (${cause.message})`;
  return error.message;
}
