import { FetchHubClient } from '../adapters/hub/fetch-hub-client.js';
import type { HubClient } from '../ports/hub-client.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { HUB_URL_ENV, resolveHubUrl } from './mcp.js';

/**
 * `agent-flow pairing-code` — a new pairing code from the running hub (dogfood 08–09/10).
 *
 * A code was single-use and printed only on the hub's console at start. Under autostart the
 * hub has no console, so pairing a second device meant restarting it — and a restart unpairs
 * every device. This asks the hub on this machine for a fresh one; live sessions are untouched.
 * The hub issues codes to loopback only, so this works from the hub's own machine.
 */
export interface PairingCodeOptions {
  /** `--hub <url>`, as `agent-flow mcp` takes it. */
  readonly hub?: string;
}

export interface PairingCodeSeams {
  readonly hub: (url: string) => HubClient;
}

export async function runPairingCodeCommand(
  options: PairingCodeOptions,
  seams: PairingCodeSeams = { hub: (baseUrl) => new FetchHubClient({ baseUrl }) },
): Promise<ExitCodeValue> {
  const url = resolveHubUrl(options.hub, process.env[HUB_URL_ENV]);
  if (!url.ok) {
    process.stderr.write(`${url.message}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  const response = await seams.hub(url.url).send({ method: 'POST', path: '/pairing/code', body: {} });
  if (response.kind === 'ok') {
    const code = (response.body as { code?: unknown } | null)?.code;
    if (typeof code === 'string') {
      process.stdout.write(
        `Pairing code: ${code}\nValid for 10 minutes, once, and it replaces any code issued before it.\n` +
          'Devices already paired stay paired.\n',
      );
      return ExitCode.OK;
    }
  }

  const why =
    response.kind === 'http_error'
      ? response.message
      : response.kind === 'ok'
        ? 'the hub answered without a code; it is probably an older build — restart it'
        : `the hub at ${url.url} did not answer (${response.kind})`;
  process.stderr.write(
    `No pairing code: ${why}.\n` +
      'Pairing needs the hub started with --pair (`agent-flow ui --pair`), on this machine.\n',
  );
  return ExitCode.GATE_NOT_SATISFIED;
}
