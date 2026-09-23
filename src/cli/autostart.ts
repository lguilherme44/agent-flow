import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { NodeFileSystem } from '../adapters/fs/node-file-system.js';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import type { GlobalOptions } from './index.js';
import { meetsFloor, nvmNodes, pickNode } from './node-runtime.js';
import { DEFAULT_UI_HOST, parsePort, probeDashboard } from './ui.js';

/**
 * `agent-flow autostart [status|install|uninstall]` — the dashboard up at logon.
 *
 * The project hub made one dashboard able to serve every project; this makes it already be
 * running. Opening it becomes a bookmark — `http://127.0.0.1:4782` — instead of a terminal,
 * a `cd` and a command, which is the chore that kept it closed.
 *
 * **Per-user, and nothing that needs an administrator.** Windows: a script in the user's
 * Startup folder. macOS: a LaunchAgent. Both are one file, both are removed by deleting it,
 * and `uninstall` does exactly that. Linux is refused rather than guessed at: a systemd user
 * unit is the obvious answer and it is not one this could verify.
 *
 * **The Node is chosen here, once.** The dashboard needs 20.19 (see `runUiCommand`), and on
 * the machine this was built on the default Node is 20.10 — so the entry pins the newest
 * Node that qualifies, found the same way `ui` finds one, or the one passed with `--node`.
 */

export interface AutostartOptions {
  readonly node?: string;
  readonly port?: string;
}

export interface AutostartEntryInput {
  readonly platform: NodeJS.Platform;
  readonly node: string;
  readonly script: string;
  /** Everything after the script: global flags, then `ui` and its own. */
  readonly uiArgs: readonly string[];
  readonly home: string;
  /** `%APPDATA%`, Windows only. */
  readonly appData: string | undefined;
  readonly log: string;
  /** The PATH to run under, macOS only — launchd starts agents with almost none. */
  readonly pathEnv: string;
}

export interface AutostartEntry {
  readonly path: string;
  readonly content: string;
}

const LABEL = 'dev.agent-flow.ui';

/** The file a session manager reads to start the dashboard. Pure, so it can be asserted. */
export function autostartEntry(input: AutostartEntryInput): AutostartEntry {
  if (input.platform === 'win32') {
    const appData = input.appData ?? win32.join(input.home, 'AppData', 'Roaming');
    const quote = (value: string): string => `"${value}"`;
    // `cmd /s /c "<command>"` strips exactly the outer pair, so every path inside keeps its
    // own quotes — spaces included. Then VBScript doubles each quote in its literal.
    const command = `cmd.exe /d /s /c "${[input.node, input.script, ...input.uiArgs].map(quote).join(' ')} > ${quote(input.log)} 2>&1"`;
    const literal = `"${command.replace(/"/g, '""')}"`;

    return {
      path: win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'agent-flow-ui.vbs'),
      content: [
        "' Written by `agent-flow autostart install`. Remove with `agent-flow autostart uninstall`.",
        "' Starts the Agent Flow dashboard hidden at logon, serving every project in the hub.",
        'Set shell = CreateObject("WScript.Shell")',
        `shell.CurrentDirectory = "${input.home}"`,
        `shell.Run ${literal}, 0, False`,
        '',
      ].join('\r\n'),
    };
  }

  if (input.platform === 'darwin') {
    const xml = (value: string): string =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const args = [input.node, input.script, ...input.uiArgs].map((arg) => `    <string>${xml(arg)}</string>`);

    return {
      path: posix.join(input.home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<!-- Written by `agent-flow autostart install`. Remove with `agent-flow autostart uninstall`. -->',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  <string>${LABEL}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...args,
        '  </array>',
        '  <key>WorkingDirectory</key>',
        `  <string>${xml(input.home)}</string>`,
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        '      <key>PATH</key>',
        `      <string>${xml(input.pathEnv)}</string>`,
        '  </dict>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>StandardOutPath</key>',
        `  <string>${xml(input.log)}</string>`,
        '  <key>StandardErrorPath</key>',
        `  <string>${xml(input.log)}</string>`,
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    };
  }

  throw new Error(
    `autostart is not supported on ${input.platform} yet. Start the dashboard from your session instead:\n` +
      `  agent-flow ui --no-open`,
  );
}

export async function runAutostartCommand(
  action: 'status' | 'install' | 'uninstall',
  options: AutostartOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const fs = new NodeFileSystem();
  const port = parsePort(options.port);
  const log = join(dirname(globals.globalConfigPath), 'ui.log');

  let entryPath: string;
  try {
    entryPath = autostartEntry({
      platform: process.platform,
      node: 'node',
      script: 'agent-flow.js',
      uiArgs: [],
      home: homedir(),
      appData: process.env.APPDATA,
      log,
      pathEnv: '',
    }).path;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.CONFIG_ERROR;
  }

  const running = await probeDashboard(DEFAULT_UI_HOST, port);

  if (action === 'status') {
    const installed = await fs.exists(entryPath);
    process.stdout.write(
      [
        `Autostart: ${installed ? `installed (${entryPath})` : 'not installed'}`,
        `Dashboard: ${running === undefined ? `not answering on http://${DEFAULT_UI_HOST}:${String(port)}` : `running on http://${DEFAULT_UI_HOST}:${String(port)} — agent-flow ${running.version}, ${String(running.projects)} project(s)`}`,
        ...(installed ? [`Log: ${log}`] : ['Install it with: agent-flow autostart install']),
        '',
      ].join('\n'),
    );
    return ExitCode.OK;
  }

  if (action === 'uninstall') {
    if (!(await fs.exists(entryPath))) {
      process.stdout.write('Autostart was not installed.\n');
      return ExitCode.OK;
    }
    // Unload before removing: `launchctl unload` reads the plist it is given, so removing it
    // first made the unload fail silently and left the job loaded until the next logout.
    if (process.platform === 'darwin') spawnSync('launchctl', ['unload', entryPath], { stdio: 'ignore' });
    await fs.remove(entryPath);
    process.stdout.write(
      `Removed ${entryPath}.\n` +
        (running === undefined
          ? ''
          : process.platform === 'darwin'
            // `launchctl unload` stops the job it started, dashboard included.
            ? 'launchctl stopped the dashboard it had started.\n'
            : 'The dashboard running now keeps running until you stop it or log out.\n'),
    );
    return ExitCode.OK;
  }

  // install
  const node = options.node ?? pickNode(
    { path: process.execPath, version: process.versions.node },
    nvmNodes({
      env: process.env,
      platform: process.platform,
      home: homedir(),
      readDir: (path) => readdirSync(path),
      exists: (path) => existsSync(path),
    }),
    { major: 20, minor: 19 },
  )?.path;

  if (node === undefined) {
    process.stderr.write(
      'The dashboard needs Node 20.19 or newer and none was found.\n' +
        'Install one (`nvm install 22`) or name it: agent-flow autostart install --node <path>\n',
    );
    return ExitCode.CONFIG_ERROR;
  }
  if (options.node !== undefined) {
    const version = spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '';
    if (!meetsFloor(version, 20, 19)) {
      process.stderr.write(`${node} reports "${version || 'nothing'}"; the dashboard needs Node 20.19 or newer.\n`);
      return ExitCode.CONFIG_ERROR;
    }
  }

  const script = realpathSync(process.argv[1] ?? '');
  const entry = autostartEntry({
    platform: process.platform,
    node,
    script,
    uiArgs: [
      '--config',
      globals.globalConfigPath,
      'ui',
      '--no-open',
      ...(options.port === undefined ? [] : ['--port', String(port)]),
    ],
    home: homedir(),
    appData: process.env.APPDATA,
    log,
    pathEnv: process.env.PATH ?? '',
  });

  await fs.mkdirp(dirname(entry.path));
  await fs.writeFileAtomic(entry.path, entry.content);

  const lines = [`Installed ${entry.path}`, `  runs: ${node} ${script} ui --no-open`, `  log:  ${log}`];

  if (running !== undefined) {
    lines.push(
      '',
      `A dashboard is already running on http://${DEFAULT_UI_HOST}:${String(port)} (agent-flow ${running.version}).`,
      'The entry takes over from the next logon; stop that one first to have this build serve now.',
    );
  } else {
    // Started now as well, the same way the session will start it, so the first proof that
    // the entry works is today and not the next logon.
    if (process.platform === 'win32') {
      spawn('wscript.exe', [entry.path], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawnSync('launchctl', ['load', '-w', entry.path], { stdio: 'ignore' });
    }
    let answered: Awaited<ReturnType<typeof probeDashboard>>;
    for (let attempt = 0; attempt < 20 && answered === undefined; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      answered = await probeDashboard(DEFAULT_UI_HOST, port);
    }
    lines.push(
      '',
      answered === undefined
        ? `Started it, and nothing answered on port ${String(port)} within 10s. Read ${log}.`
        : `Started: http://${DEFAULT_UI_HOST}:${String(port)} — ${String(answered.projects)} project(s). Bookmark it.`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return ExitCode.OK;
}

