import { tmpdir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { FetchHubClient } from '../adapters/hub/fetch-hub-client.js';
import { resolveGuidesDir } from '../app/prompt-paths.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { readRequestFileGuarded } from './mcp-request-file.js';
import { createAgentFlowMcpServer } from './mcp-server.js';
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from './ui.js';
import { readVersion } from './version.js';

/**
 * `agent-flow mcp` — the agent-flow tools over MCP, on stdio (Etapa 1, Passo 3).
 *
 * An input adapter beside the CLI rather than a second server: it holds no state and calls
 * no use case, it relays each tool call to the hub `agent-flow ui` serves. So it starts
 * nothing either — a hub that is not running is reported by every tool, with the command
 * that starts it, rather than spawned from here behind the human's back.
 *
 * **stdout is the protocol.** Nothing in this command may print to it; a stray line there
 * is a corrupt frame to the client. Refusals go to stderr, which an MCP client logs.
 *
 * Read-only towards the hub's project list, and excluded from `postAction` for that
 * reason (see `index.ts`): the client starts it in whatever directory a session opened.
 */

/** Where `agent-flow ui` listens by default, so the two agree without configuration. */
export const DEFAULT_HUB_URL = `http://${DEFAULT_UI_HOST}:${String(DEFAULT_UI_PORT)}`;

/** The environment variable that points the server at another hub, below `--hub`. */
export const HUB_URL_ENV = 'AGENT_FLOW_HUB_URL';

export interface McpCommandOptions {
  readonly hub?: string;
  readonly allowRemoteHub?: boolean;
}

/**
 * The names that are this machine. A literal loopback address cannot be rebound, and
 * `localhost` resolves to loopback on every supported platform; anything else is a host
 * somewhere else, whatever its name looks like (`127.0.0.1.nip.io` is a DNS name).
 */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

export function resolveHubUrl(
  flag: string | undefined,
  env: string | undefined,
  allowRemote = false,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string } {
  const chosen = [flag, env].map((value) => value?.trim()).find((value) => value !== undefined && value !== '');
  if (chosen === undefined) return { ok: true, url: DEFAULT_HUB_URL };

  let parsed: URL;
  try {
    parsed = new URL(chosen);
  } catch {
    return { ok: false, message: `Not a hub URL: "${chosen}". Expected something like ${DEFAULT_HUB_URL}.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: `Not a hub URL: "${chosen}". Expected http(s), like ${DEFAULT_HUB_URL}.` };
  }
  // The hub has no authentication beyond loopback and its Origin guard, so a hub elsewhere
  // would carry every decision, project path and plan across a network unauthenticated —
  // and a decision "in a human's name" could come from anyone who reaches that port.
  if (!allowRemote && !isLoopback(parsed.hostname)) {
    return {
      ok: false,
      message:
        `Refusing hub ${chosen}: it is not on this machine, and the hub has no authentication — ` +
        'every decision, project path and plan would cross the network unauthenticated. Use a ' +
        'loopback address, or pass --allow-remote-hub only when that hub sits behind something ' +
        'that authenticates.',
    };
  }
  return { ok: true, url: chosen };
}

/**
 * The server, wired to the real hub client and the shipped guides. Separate from the
 * transport so a test can drive the same server over an in-memory pair.
 */
export function createMcpServerForHub(hubUrl: string, cwd: string): McpServer {
  const fs = new NodeFileSystem();
  return createAgentFlowMcpServer({
    hub: new FetchHubClient({ baseUrl: hubUrl }),
    guides: { fs, guidesDir: resolveGuidesDir() },
    readRequestFile: (path, projectDirs) => readRequestFileGuarded(path, projectDirs, { cwd, tempDir: tmpdir() }),
    version: readVersion(),
  });
}

export async function runMcpCommand(options: McpCommandOptions): Promise<ExitCodeValue> {
  const hub = resolveHubUrl(options.hub, process.env[HUB_URL_ENV], options.allowRemoteHub === true);
  if (!hub.ok) {
    process.stderr.write(`${hub.message}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  const server = createMcpServerForHub(hub.url, process.cwd());
  const closed = new Promise<void>((done) => {
    server.server.onclose = () => done();
  });
  // Resolved when the client closes stdin: the v2 stdio transport closes itself on input end,
  // which ends the session. Measured with a real child process: exit code 0 on stdin end.
  // Without this await, `main` would return while the session is live and the CLI would
  // stop being the one deciding the exit code.
  await server.connect(new StdioServerTransport());
  await closed;
  return ExitCode.OK;
}
