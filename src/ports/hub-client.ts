/**
 * The agent-flow hub, as an HTTP client sees it (Etapa 1, Passo 3).
 *
 * The MCP server owns no state: every tool is one request to the hub `agent-flow ui`
 * serves, so validation, limits and the run execution lock are the API's, and a decision
 * made through an AI is recorded exactly as any other API write. This port is that one
 * request, so the tools can be tested against a fake and the adapter against a fake
 * `fetch`, and neither needs a socket.
 *
 * The outcome is a value rather than a throw because every failure here is something a
 * tool has to put into words for the model reading it — and "the hub is down", "the hub
 * refused" and "the hub broke" call for three different next steps.
 */

export type HubMethod = 'GET' | 'POST';

export interface HubRequest {
  readonly method: HubMethod;
  /** Under `/api/v1`, for example `/runs/AF-2026-001/approve`. Never a filesystem path. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as JSON. Absent means no body, which is what a bodyless POST route expects. */
  readonly body?: unknown;
}

export type HubResponse =
  /** 2xx, with the parsed JSON body (`null` for an empty one). */
  | { readonly kind: 'ok'; readonly status: number; readonly body: unknown }
  /**
   * The hub answered and refused (4xx) or failed (5xx). `error` is the API's code, or
   * `http_<status>` when the body was not the API's `{ error, message, action }` shape.
   */
  | {
      readonly kind: 'http_error';
      readonly status: number;
      readonly error: string;
      readonly message: string;
      readonly action?: string;
      /** The API's structured extras, such as the job a `run_busy` names. */
      readonly detail?: Readonly<Record<string, unknown>>;
    }
  /**
   * Something answered 2xx with a body that is not JSON: a proxy, a router page, another
   * server on the port. Not the hub, whatever it said.
   */
  | { readonly kind: 'not_hub'; readonly url: string; readonly status: number }
  /** Nothing listens at the URL: no request reached the hub. */
  | { readonly kind: 'unreachable'; readonly url: string; readonly reason: string }
  /** The request left and no answer came back in time: it may or may not have applied. */
  | { readonly kind: 'timeout'; readonly url: string; readonly timeoutMs: number };

export interface HubClient {
  /** The hub's base URL, for messages that have to say where they looked. */
  readonly baseUrl: string;
  send(request: HubRequest): Promise<HubResponse>;
}
