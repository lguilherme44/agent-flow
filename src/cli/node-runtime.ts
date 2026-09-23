import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding a Node new enough for the dashboard, on a machine whose default one is not.
 *
 * **Measured, and the reason this file exists.** The dashboard needs Node 20.19 (see
 * `runUiCommand`), and the machine this was built on runs 20.10 by default with 22.23 one
 * `nvm` directory away. Switching the default is not the answer: under nvm-windows `nvm use`
 * swaps a symlink for the whole machine, and a repository there does not start on Node 22.
 * So `agent-flow ui` used to refuse with an accurate message and leave the operator to type
 * a node.exe path by hand — every time, from the one command meant to be typed anywhere.
 *
 * nvm's own directories are the source because they are where a second Node actually lives
 * on these machines, and reading them spawns nothing. A Node installed some other way still
 * works: pass it with `--node`, or run `ui` under it.
 */

export interface NodeInstall {
  readonly path: string;
  readonly version: string;
}

/** `major.minor.patch` as numbers, or nothing for a name that is not a version. */
function parse(version: string): readonly number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether `version` is at least `major.minor`. */
export function meetsFloor(version: string, major: number, minor: number): boolean {
  const parsed = parse(version);
  return parsed !== undefined && compare(parsed, [major, minor, 0]) >= 0;
}

/**
 * The Node installs nvm keeps on this machine, newest first.
 *
 * nvm-windows: `%NVM_HOME%\vX.Y.Z\node.exe`. nvm (macOS, Linux): `$NVM_DIR/versions/node/vX.Y.Z/bin/node`.
 */
export function nvmNodes(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly readDir: (path: string) => readonly string[];
  readonly exists: (path: string) => boolean;
}): NodeInstall[] {
  const windows = input.platform === 'win32';
  const roots = windows
    ? [input.env.NVM_HOME, join(input.env.LOCALAPPDATA ?? join(input.home, 'AppData', 'Local'), 'nvm')]
    : [join(input.env.NVM_DIR ?? join(input.home, '.nvm'), 'versions', 'node')];

  const found = new Map<string, NodeInstall & { readonly parsed: readonly number[] }>();
  for (const root of roots) {
    if (root === undefined || root === '') continue;
    let entries: readonly string[];
    try {
      entries = input.readDir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const parsed = parse(entry);
      if (parsed === undefined) continue;
      const path = windows ? join(root, entry, 'node.exe') : join(root, entry, 'bin', 'node');
      if (!found.has(path) && input.exists(path)) found.set(path, { path, version: parsed.join('.'), parsed });
    }
  }

  return [...found.values()]
    .sort((a, b) => compare(b.parsed, a.parsed))
    .map(({ path, version }) => ({ path, version }));
}

/** The running Node when it meets the floor, else the newest install that does, else nothing. */
export function pickNode(
  running: NodeInstall,
  installs: readonly NodeInstall[],
  floor: { readonly major: number; readonly minor: number },
): NodeInstall | undefined {
  if (meetsFloor(running.version, floor.major, floor.minor)) return running;
  return installs.find((install) => meetsFloor(install.version, floor.major, floor.minor));
}

/** The floor `agent-flow ui` needs; see `runUiCommand` for why it is 20.19. */
export const DASHBOARD_NODE_FLOOR = { major: 20, minor: 19 } as const;

/** The Node `agent-flow ui` would run on from this machine, or nothing when none qualifies. */
export function dashboardNode(): NodeInstall | undefined {
  return pickNode(
    { path: process.execPath, version: process.versions.node },
    nvmNodes({
      env: process.env,
      platform: process.platform,
      home: homedir(),
      readDir: (path) => readdirSync(path),
      exists: (path) => existsSync(path),
    }),
    DASHBOARD_NODE_FLOOR,
  );
}

/**
 * Runs this same command again under `node`, attached to this terminal, and returns its exit
 * code. The arguments are the ones typed; nothing is re-parsed on the way.
 */
export function rerunUnder(node: string): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(node, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
    child.once('error', () => resolveExit(1));
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}
