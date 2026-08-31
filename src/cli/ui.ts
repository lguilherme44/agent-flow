import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { SystemClock } from '../adapters/clock/system-clock.js';
import { NodeProcessRunner } from '../adapters/process/node-process-runner.js';
import { buildServer } from '../server/server.js';
import { resolvePromptsDir } from '../app/prompt-paths.js';
import { NodeHost } from '../adapters/host/node-host.js';
import {
  DEFAULT_WORKSPACE_DEPTH,
  MAX_WORKSPACE_DEPTH,
  discoverProjects,
  registryOf,
} from '../server/project-registry.js';
import { loadConfig } from '../config/loader.js';
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
 * Binds to loopback by default and says so. Binding to `0.0.0.0` is possible and
 * loud: the server has no authentication, so anything that can reach the port
 * can read every run, every artifact and every project path on this machine.
 * That is a reasonable thing to want on a trusted network and an unreasonable
 * thing to do by accident, which is the difference a warning makes.
 */
export async function runUiCommand(
  root: string | undefined,
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
    // Relative to where the command was typed, as every shell path is. The
    // global `--cwd` still decides the single-project case, so the two ways of
    // naming a directory do not compete.
    const workspace = root === undefined ? globals.cwd : resolve(globals.cwd, root);

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

    const discovered = await discoverProjects({ fs, roots: [workspace], depth });

    if (discovered.projects.length === 0) {
      process.stderr.write(
        [
          `No Agent Flow project found under ${workspace}.`,
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

    const registry = registryOf(discovered.projects);

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
    });

    await server.app.listen({ host, port });
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${String(port)}`;

    const lines = [
      `Agent Flow UI on ${url}`,
      '',
      `${String(discovered.projects.length)} project(s) under ${workspace}:`,
      ...discovered.projects.map((project) => `  ${project.id.padEnd(24)}${project.path}`),
      '',
    ];

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
        '  It answers to addresses, not to names: reach it at an IP, or declare the',
        '  name under ui.allowedHosts. A name it was not told about is refused,',
        '  because a name an attacker controls can be pointed back at this machine.',
        '',
      );
    }

    lines.push(
      'Approve, revise, retry and run work from the dashboard or from here — both go',
      'through the same use cases, so the two cannot disagree about a gate.',
      '',
    );
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
