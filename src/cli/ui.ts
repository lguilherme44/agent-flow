import { existsSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { buildServer, type RunningServer, type ServerPairing } from '../server/server.js';
import { resolvePromptsDir } from '../app/prompt-paths.js';
import { NodeHost } from '../adapters/host/node-host.js';
import {
  DEFAULT_WORKSPACE_DEPTH,
  MAX_WORKSPACE_DEPTH,
  discoveredRegistry,
} from '../server/project-registry.js';
import { loadConfig } from '../config/loader.js';
import { isLoopbackHost, extractHostname } from '../core/device-session.js';
import type { FileSystem } from '../ports/index.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import { renderError } from './render/errors.js';
import { readVersion } from './version.js';
import type { GlobalOptions } from './index.js';

export const DEFAULT_UI_PORT = 4782;
/** Loopback, always, unless a person types otherwise (§93). */
export const DEFAULT_UI_HOST = '127.0.0.1';

export interface UiOptions {
  readonly port?: string;
  readonly host?: string;
  readonly open?: boolean;
  readonly depth?: string;
  /** Serve the previous dashboard (`apps/web`) instead of Deck. */
  readonly classic?: boolean;
  /** Enable remote device access through pairing (FR-002). */
  readonly pair?: boolean;
}

/**
 * Which dashboard bundle is on the wire.
 *
 * Two, deliberately, for one release: Deck is the surface `agent-flow ui` opens, and the
 * previous dashboard stays one flag away so nothing anybody bookmarked stops working the
 * day Deck lands. Both read the same API; the server does not know which one it serves.
 */
export type DashboardFlavour = 'deck' | 'classic';

export interface ResolvedWebDir {
  readonly path: string;
  readonly flavour: DashboardFlavour;
}

/**
 * `agent-flow ui [root]` — the local dashboard (§64, §65).
 *
 * With no argument it serves the current project. With one it serves a
 * *workspace*: the directory is scanned, to a bounded depth, for repositories
 * that have been through `agent-flow init`, and the sidebar lists all of them.
 *
 * The root is chosen here and nowhere else. Once the server is up, the browser's
 * whole vocabulary for a project is the id the registry issued — there is no
 * request shape that carries a directory, which is what makes "the operator
 * chose what this server can see" true rather than aspirational (§93).
 *
 * Binds to loopback by default. Binding outside loopback requires remote access
 * authentication (`--pair` or `ui.pairing.enabled: true`, FR-019).
 */
export async function runUiCommand(
  root: string | undefined,
  options: UiOptions,
  globals: GlobalOptions,
  hooks: {
    readonly onListening?: (url: string) => void;
    readonly onReady?: (server: RunningServer) => void;
  } = {},
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const processRunner = new NodeProcessRunner();

  try {
    const port = parsePort(options.port);
    const host = options.host ?? DEFAULT_UI_HOST;
    // Relative to where the command was typed, as every shell path is. The
    // global `--cwd` still decides the single-project case, so the two ways of
    // naming a directory do not compete.
    const workspace = root === undefined ? globals.cwd : resolve(globals.cwd, root);

    const pairingEnabled = await resolvePairingEnabled(options.pair, {
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: workspace,
    });

    if (!pairingEnabled && !isLoopbackHost(extractHostname(host) ?? host)) {
      process.stderr.write(
        [
          `Binding to ${host} exposes the dashboard to the network, which requires authentication.`,
          'Pass `--pair` to enable remote device pairing:',
          '',
          `  agent-flow ui --host ${host} --pair`,
          '',
        ].join('\n'),
      );
      return ExitCode.CONFIG_ERROR;
    }

    if (pairingEnabled && options.classic === true) {
      process.stderr.write(
        [
          'Cannot combine `--pair` with `--classic`.',
          'The classic dashboard (apps/web) does not support device pairing and would fail',
          'with 401 Unauthorized on every read. Drop `--classic` to use Deck with pairing.',
          '',
        ].join('\n'),
      );
      return ExitCode.CONFIG_ERROR;
    }

    const depth = await resolveDepth(options.depth, {
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: workspace,
    });

    const allowedHosts = await resolveAllowedHosts({
      fs,
      globalConfigPath: globals.globalConfigPath,
      projectDir: workspace,
    });

    // A registry that can look again (7.6). The workspace used to be walked once, which
    // was right while registering a project meant stopping the server; it stops being
    // right the moment the Deck can register one, because the write would succeed and the
    // list would still be missing it.
    const registry = discoveredRegistry({ fs, roots: [workspace], depth });
    const discovered = await registry.rescan();

    // Only when there is nothing at all. A workspace holding repositories that have never
    // been through `init` is now a workspace worth opening: the Deck can register them,
    // which is the whole point of 7.6, and refusing to start would send the operator back
    // to the terminal to do the thing the screen exists to do.
    if (discovered.projects.length === 0 && discovered.candidates.length === 0) {
      process.stderr.write(
        [
          `No Agent Flow project or Git repository found under ${workspace}.`,
          '',
          'Run `agent-flow init` in a repository first, or point the UI at a',
          'directory that contains one:',
          '',
          '  agent-flow ui ~/work',
          '',
          ...(discovered.skipped.length === 0
            ? []
            : [
                `${String(discovered.skipped.length)} director${discovered.skipped.length === 1 ? 'y was' : 'ies were'} skipped for resolving outside ${workspace}:`,
                ...discovered.skipped.map((entry) => `  ${entry.path} → ${entry.resolved}`),
                '',
                'Point the UI at a directory that contains them instead.',
                '',
              ]),
        ].join('\n'),
      );
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const web = resolveWebDir(options.classic === true ? 'classic' : 'deck');
    const webDir = web?.path;
    const admittedAddresses = pairingEnabled ? enumerateBoundAddresses(host) : undefined;
    const server = await buildServer({
      fs,
      clock,
      processRunner,
      registry,
      globalConfigPath: globals.globalConfigPath,
      version: readVersion(),
      host,
      port,
      // Who this process is, as distinct from where it listens.
      processHost: new NodeHost(),
      // Resolved by the CLI, which already has to work this out for the planning
      // pipeline. The server takes it as an argument rather than discovering it
      // again, so there is one answer to "where are the prompts".
      promptsDir: resolvePromptsDir(),
      // What the operator declared, and nothing more. An empty list means the server
      // answers only to address literals and `localhost`, which is what closes DNS
      // rebinding for the default install (§93).
      allowedHosts,
      ...(webDir === undefined ? {} : { webDir }),
      ...(admittedAddresses === undefined
        ? {}
        : {
            remoteAccess: {
              admittedAddresses,
              onPair: (session) => {
                process.stdout.write(`Device paired: ${session.deviceId} (${session.label})\n`);
              },
              onRevoke: (session) => {
                process.stdout.write(`Session revoked: ${session.deviceId} (${session.label})\n`);
              },
            },
          }),
    });

    // **A taken port is an ordinary outcome, and it used to print a stack trace.**
    //
    // Measured: `Error: listen EADDRINUSE: address already in use 127.0.0.1:4782` followed
    // by four frames of `node:internal`. The product knows the port, knows the holder is
    // almost certainly another `agent-flow ui`, and knows `--port` exists — and said none
    // of it. Worse than unhelpful: the old server kept answering on that port serving a
    // different workspace, so the failure read as "nothing happened" while the next
    // request went somewhere else entirely.
    const listening = await server.app.listen({ host, port }).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (listening !== undefined) {
      const code = (listening as { code?: string }).code;
      if (code !== 'EADDRINUSE') throw listening;

      await server.close();
      process.stderr.write(
        [
          `Port ${String(port)} on ${host} is already in use.`,
          '',
          'It is almost certainly another `agent-flow ui` — the dashboard keeps running',
          'after the terminal that started it is closed. Stop that one, or use a',
          'different port:',
          '',
          `  agent-flow ui --port ${String(port + 1)}`,
          '',
        ].join('\n'),
      );
      return ExitCode.CONFIG_ERROR;
    }
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${String(port)}`;

    const lines: string[] = [];

    if (server.pairing !== undefined) {
      const code = formatPairingCode(server.pairing.code);
      lines.push(
        `Pairing code: ${code}`,
        '',
        ...server.pairing.admittedAddresses.map((addr) => `http://${addr}:${String(port)}`),
        '',
        'Restarting the server unpairs every device and invalidates any outstanding code.',
        '',
      );
    } else {
      lines.push(`Agent Flow UI on ${url}`, '');
    }

    lines.push(
      `${String(discovered.projects.length)} project(s) under ${workspace}:`,
      ...discovered.projects.map((project) => `  ${project.id.padEnd(24)}${project.path}`),
      '',
    );

    if (discovered.candidates.length > 0) {
      // Said here because otherwise the only way to learn they exist is to open the Deck
      // and find the dialog — and somebody who started the server expecting five projects
      // and got three needs to know the other two are one click away, not missing.
      lines.push(
        `${String(discovered.candidates.length)} repositor${discovered.candidates.length === 1 ? 'y has' : 'ies have'} never been through \`init\` and can be registered from the Deck:`,
        ...discovered.candidates.map((candidate) => `  ${candidate.id.padEnd(24)}${candidate.path}`),
        '',
      );
    }

    if (discovered.skipped.length > 0) {
      // Named rather than dropped in silence. A workspace of symlinks into
      // repositories elsewhere is a normal way to work, and somebody who
      // arranged one would otherwise see their projects missing and conclude
      // the scan is broken.
      lines.push(
        `${String(discovered.skipped.length)} skipped for resolving outside the workspace:`,
        ...discovered.skipped.map((entry) => `  ${entry.path} → ${entry.resolved}`),
        '',
      );
    }

    if (web === undefined) {
      // Said plainly rather than served as a blank page: the API is up and the
      // dashboard has not been built.
      lines.push(
        'No dashboard bundle is built, so only the API is being served.',
        'Build one with: npm run build:deck   (or npm run build:web for the previous dashboard)',
        '',
      );
    } else if (options.classic === true && web.flavour === 'classic') {
      lines.push('Dashboard: the previous one, as asked. Drop --classic for Deck.', '');
    } else if (web.flavour === 'classic') {
      // Asked for Deck, got the fallback. Named, so nobody wonders why the page
      // looks the way it did last week.
      lines.push(
        'Dashboard: the previous one — the Deck bundle is not built.',
        'Build it with: npm run build:deck',
        '',
      );
    } else {
      lines.push('Dashboard: Deck. The previous dashboard is one flag away: --classic', '');
    }

    lines.push(
      'Approve, revise, retry and run work from the dashboard or from here — both go',
      'through the same use cases, so the two cannot disagree about a gate.',
      '',
    );
    process.stdout.write(lines.join('\n'));

    const openUrl =
      server.pairing !== undefined && server.pairing.admittedAddresses.length > 0
        ? `http://${server.pairing.admittedAddresses[0]}:${String(port)}`
        : url;

    let closed = false;
    let rl: readline.Interface | undefined = undefined;
    let resolveShutdown: (() => void) | undefined = undefined;

    const shutdown = (): void => {
      void server.close();
    };

    const originalClose = server.close.bind(server);
    server.close = async () => {
      try {
        await originalClose();
      } finally {
        closed = true;
        rl?.close();
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        resolveShutdown?.();
      }
    };

    hooks.onListening?.(openUrl);
    hooks.onReady?.(server);

    if (options.open !== false) await openBrowser(processRunner, openUrl);

    if (server.pairing !== undefined) {
      rl = installPairingConsole(server.pairing);
    }

    // Resolves when the server closes. Nothing else keeps this process alive,
    // so returning here would exit immediately with the port half-open.
    if (!closed) {
      await new Promise<void>((resolveWait) => {
        resolveShutdown = resolveWait;
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
    }

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_UI_PORT;

  const port = wholeNumber(raw);
  if (port === undefined || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port "${raw}". Expected a number between 1 and 65535.`);
  }
  return port;
}

/**
 * A string that is entirely a number, or nothing.
 *
 * `parseInt` reads a prefix and discards the rest, so `--port 80.5` became 80 and
 * `--depth 2.7` became 2 — the command ran, with a value the person did not type
 * and no sign that anything was ignored.
 */
function wholeNumber(raw: string): number | undefined {
  return /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : undefined;
}

export function parseDepth(raw: string): number {
  const depth = wholeNumber(raw);
  if (depth === undefined || depth > MAX_WORKSPACE_DEPTH) {
    // Bounded on purpose. An unbounded scan of a home directory reads places
    // nobody asked it to and takes minutes to start.
    throw new Error(
      `Invalid --depth "${raw}". Expected a number between 0 and ${String(MAX_WORKSPACE_DEPTH)}.`,
    );
  }
  return depth;
}

/**
 * How deep to scan: the flag, then `ui.workspaceDepth`, then the default (§65).
 *
 * The flag wins because it was typed for this run. Config comes second because
 * somebody who keeps their repositories three levels down should not have to say
 * so every time. Both are bounded by the schema and by `parseDepth`, so neither
 * path can ask for an unbounded walk.
 *
 * A configuration that will not load is not fatal here. `agent-flow ui` is often
 * exactly what somebody opens *because* something is wrong, and refusing to start
 * over a malformed global file would take away the tool that shows them why —
 * the Settings page reports the same error where it can be read (§95).
 */
export async function resolveDepth(
  flag: string | undefined,
  options: { fs: FileSystem; globalConfigPath: string; projectDir: string },
): Promise<number> {
  if (flag !== undefined) return parseDepth(flag);

  try {
    const config = await loadConfig(options);
    return Math.min(config.global.ui.workspaceDepth, MAX_WORKSPACE_DEPTH);
  } catch {
    return DEFAULT_WORKSPACE_DEPTH;
  }
}

/**
 * Host names the operator declared this server may answer to (§93).
 *
 * Same failure posture as `resolveDepth`, and for the same reason: `agent-flow ui` is
 * often what somebody opens *because* the configuration is broken, and refusing to start
 * would take away the page that shows them why. A configuration that will not load
 * yields the empty list, which is the strict answer rather than the lenient one — the
 * degradation cannot open the server to a name.
 */
export async function resolveAllowedHosts(options: {
  fs: FileSystem;
  globalConfigPath: string;
  projectDir: string;
}): Promise<readonly string[]> {
  try {
    const config = await loadConfig(options);
    return config.global.ui.allowedHosts;
  } catch {
    return [];
  }
}

/**
 * Where the built dashboard is, if it was built.
 *
 * Two candidates because the layout differs between running from source and
 * running from a published package — the same problem `resolvePromptsDir`
 * already solves, and solved the same way rather than by guessing at runtime.
 */
export function resolveWebDir(preferred: DashboardFlavour = 'deck'): ResolvedWebDir | undefined {
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates: Record<DashboardFlavour, readonly string[]> = {
    deck: ['../../apps/deck/dist', '../../../apps/deck/dist', '../deck'],
    classic: ['../../apps/web/dist', '../../../apps/web/dist', '../web'],
  };

  // The one asked for first; the other as a fallback, never silently — the caller
  // prints which one it got. A person who typed `--classic` and has no classic
  // bundle still gets a dashboard rather than a blank origin.
  const order: DashboardFlavour[] = preferred === 'deck' ? ['deck', 'classic'] : ['classic', 'deck'];

  for (const flavour of order) {
    for (const candidate of candidates[flavour]) {
      const path = resolve(join(here, candidate));
      if (existsSync(join(path, 'index.html'))) return { path, flavour };
    }
  }

  return undefined;
}

/**
 * Opens the default browser, and never fails the command if it cannot.
 *
 * The server is already up by this point. A machine without a browser — a
 * container, a remote shell — is a perfectly good place to run this.
 */
async function openBrowser(
  processRunner: NodeProcessRunner,
  url: string,
): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';

  try {
    await processRunner.run({ command, args: [url], cwd: process.cwd(), timeoutSeconds: 5 });
  } catch {
    // Nothing to report: the URL is already printed above.
  }
}

/**
 * Resolves whether remote access via pairing is enabled (FR-002).
 *
 * The flag `--pair` wins if passed. Otherwise, reads `ui.pairing.enabled` from configuration.
 * A configuration that will not load yields false (strict-load degradation).
 */
export async function resolvePairingEnabled(
  flag: boolean | undefined,
  options: {
    fs: FileSystem;
    globalConfigPath: string;
    projectDir: string;
  },
): Promise<boolean> {
  if (flag !== undefined) return flag;
  try {
    const config = await loadConfig(options);
    return config.global.ui.pairing.enabled;
  } catch {
    return false;
  }
}

/**
 * Enumerates the network addresses the server will be reachable on (FR-003, FR-018).
 *
 * For non-wildcard addresses (like 127.0.0.1 or a specific IP), returns that address alone.
 * For wildcard addresses (0.0.0.0 or ::), enumerates non-internal IPv4 addresses across
 * all network interfaces using `node:os.networkInterfaces()`.
 */
export function enumerateBoundAddresses(
  host: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): readonly string[] {
  if (host !== '0.0.0.0' && host !== '::') {
    return [host === 'localhost' ? '127.0.0.1' : host];
  }

  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4' || (entry.family as unknown) === 4) {
        if (!addresses.includes(entry.address)) {
          addresses.push(entry.address);
        }
      }
    }
  }

  if (addresses.length === 0) {
    addresses.push('127.0.0.1');
  }

  return addresses;
}

/**
 * Formats a 12-character pairing code as xxxx-xxxx-xxxx for operator display (FR-003).
 */
export function formatPairingCode(code: string): string {
  const clean = code.replace(/-/g, '');
  if (clean.length !== 12) return code;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
}

export type PairingConsoleCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'code' }
  | { readonly kind: 'revoke'; readonly deviceId: string }
  | { readonly kind: 'unknown'; readonly line: string };

/**
 * Parses a line entered into the interactive TTY pairing console (FR-028).
 *
 * Pure and side-effect free:
 * - 'list' -> lists live sessions
 * - 'revoke <deviceId>' -> revokes the session for deviceId
 * - anything else -> unrecognised, prompts with the two supported forms
 */
export function parsePairingConsoleLine(line: string): PairingConsoleCommand {
  const trimmed = line.trim();
  if (trimmed === 'list') {
    return { kind: 'list' };
  }
  if (trimmed === 'code') {
    return { kind: 'code' };
  }
  const match = /^revoke\s+(\S+)$/.exec(trimmed);
  if (match) {
    const deviceId = match[1];
    if (deviceId !== undefined) {
      return { kind: 'revoke', deviceId };
    }
  }
  return { kind: 'unknown', line: trimmed };
}

/**
 * Executes a parsed pairing console command against RunningServer.pairing (FR-028).
 */
export function executePairingConsoleCommand(
  line: string,
  pairing: ServerPairing,
  write: (text: string) => void = (text) => process.stdout.write(text),
): void {
  const command = parsePairingConsoleLine(line);
  switch (command.kind) {
    case 'list': {
      const sessions = pairing.listSessions();
      if (sessions.length === 0) {
        write('No active device sessions.\n');
        return;
      }
      write(`${String(sessions.length)} active device session${sessions.length === 1 ? '' : 's'}:\n`);
      for (const session of sessions) {
        write(`  ${session.deviceId}  ${session.label}\n`);
      }
      return;
    }
    case 'revoke': {
      const outcome = pairing.revokeSession(command.deviceId);
      if (!outcome.ok) {
        write(`No active session found for device "${command.deviceId}".\n`);
      }
      return;
    }
    case 'code': {
      // The outstanding code is replaced, not added to: single-use is a property of the
      // code, and two live codes would be two credentials for one decision. Live sessions
      // are untouched — that is the whole difference between this and a restart.
      write(`Pairing code: ${pairing.issueCode()}\n`);
      write('Valid for 10 minutes, and it replaces any code printed before it.\n');
      return;
    }
    case 'unknown': {
      write(
        `Unrecognised command "${command.line}". Available commands:\n` +
          `  list\n  code\n  revoke <deviceId>\n`,
      );
      return;
    }
  }
}

/**
 * Installs the interactive TTY console for listing and revoking device sessions (FR-028).
 *
 * When process.stdin.isTTY !== true, no console is installed and nothing is read from stdin.
 */
export function installPairingConsole(
  pairing: ServerPairing,
  options: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    isTTY?: boolean;
    write?: (text: string) => void;
  } = {},
): readline.Interface | undefined {
  const isTTY = options.isTTY ?? (process.stdin.isTTY === true);
  if (!isTTY) {
    return undefined;
  }

  const rl = readline.createInterface({
    input: options.stdin ?? process.stdin,
    output: options.stdout ?? process.stdout,
    terminal: true,
  });

  const write = options.write ?? ((text: string) => process.stdout.write(text));

  rl.on('line', (line: string) => {
    executePairingConsoleCommand(line, pairing, write);
  });

  return rl;
}
