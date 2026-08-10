import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { buildServer } from '../server/server.js';
import {
  DEFAULT_WORKSPACE_DEPTH,
  discoverProjects,
  registryOf,
} from '../server/project-registry.js';
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
}

/**
 * `agent-flow ui` — the local dashboard (§64).
 *
 * Binds to loopback by default and says so. Binding to `0.0.0.0` is possible and
 * loud: the server has no authentication, so anything that can reach the port
 * can read every run, every artifact and every project path on this machine.
 * That is a reasonable thing to want on a trusted network and an unreasonable
 * thing to do by accident, which is the difference a warning makes.
 */
export async function runUiCommand(
  options: UiOptions,
  globals: GlobalOptions,
  hooks: { readonly onListening?: (url: string) => void } = {},
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const processRunner = new NodeProcessRunner();

  try {
    const port = parsePort(options.port);
    const host = options.host ?? DEFAULT_UI_HOST;
    const depth = parseDepth(options.depth);

    const discovered = await discoverProjects({ fs, roots: [globals.cwd], depth });

    if (discovered.length === 0) {
      process.stderr.write(
        [
          `No Agent Flow project found under ${globals.cwd}.`,
          '',
          'Run `agent-flow init` in a repository first, or point the UI at a',
          'directory that contains one:',
          '',
          '  agent-flow ui --cwd ~/work',
          '',
        ].join('\n'),
      );
      return ExitCode.GATE_NOT_SATISFIED;
    }

    const registry = registryOf(discovered);

    const webDir = resolveWebDir();
    const server = await buildServer({
      fs,
      clock,
      processRunner,
      registry,
      globalConfigPath: globals.globalConfigPath,
      version: readVersion(),
      host,
      port,
      ...(webDir === undefined ? {} : { webDir }),
    });

    await server.app.listen({ host, port });
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${String(port)}`;

    const lines = [
      `Agent Flow UI on ${url}`,
      '',
      `${String(discovered.length)} project(s):`,
      ...discovered.map((project) => `  ${project.id.padEnd(24)}${project.path}`),
      '',
    ];

    if (webDir === undefined) {
      // Said plainly rather than served as a blank page: the API is up and the
      // dashboard has not been built.
      lines.push(
        'The dashboard bundle is not built, so only the API is being served.',
        'Build it with: npm run build:web',
        '',
      );
    }

    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      lines.push(
        `⚠ Bound to ${host}, not loopback.`,
        '  This server has no authentication. Anything that can reach this port',
        '  can read every run, artifact and project path on this machine.',
        '',
      );
    }

    lines.push('Read-only. Approve, run and review stay with the CLI.', '');
    process.stdout.write(lines.join('\n'));

    hooks.onListening?.(url);

    if (options.open !== false) await openBrowser(processRunner, url);

    // Resolves when the server closes. Nothing else keeps this process alive,
    // so returning here would exit immediately with the port half-open.
    await new Promise<void>((resolveWait) => {
      const shutdown = (): void => {
        void server.close().then(() => {
          resolveWait();
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });

    return ExitCode.OK;
  } catch (error) {
    const rendered = renderError(error);
    process.stderr.write(`${rendered.message}\n`);
    return rendered.exitCode;
  }
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_UI_PORT;

  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port "${raw}". Expected a number between 1 and 65535.`);
  }
  return port;
}

export function parseDepth(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WORKSPACE_DEPTH;

  const depth = Number.parseInt(raw, 10);
  if (!Number.isInteger(depth) || depth < 0 || depth > 6) {
    // Bounded on purpose. An unbounded scan of a home directory reads places
    // nobody asked it to and takes minutes to start.
    throw new Error(`Invalid --depth "${raw}". Expected a number between 0 and 6.`);
  }
  return depth;
}

/**
 * Where the built dashboard is, if it was built.
 *
 * Two candidates because the layout differs between running from source and
 * running from a published package — the same problem `resolvePromptsDir`
 * already solves, and solved the same way rather than by guessing at runtime.
 */
export function resolveWebDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of ['../../apps/web/dist', '../../../apps/web/dist', '../web']) {
    const path = resolve(join(here, candidate));
    if (existsSync(join(path, 'index.html'))) return path;
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
