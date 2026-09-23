import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { meetsFloor, nvmNodes, pickNode } from '../../src/cli/node-runtime.js';

/**
 * Finding a Node the dashboard can run on, when the machine's default cannot (20.10 here,
 * with 22.23 installed beside it by nvm-windows).
 */

const FLOOR = { major: 20, minor: 19 } as const;

function machine(dirs: Record<string, readonly string[]>, files: readonly string[]) {
  return {
    readDir: (path: string): readonly string[] => {
      const entries = dirs[path];
      if (entries === undefined) throw new Error(`ENOENT ${path}`);
      return entries;
    },
    exists: (path: string): boolean => files.includes(path),
  };
}

describe('meetsFloor', () => {
  it('compares numerically, not as text', () => {
    expect(meetsFloor('20.10.0', 20, 19)).toBe(false);
    expect(meetsFloor('20.19.0', 20, 19)).toBe(true);
    expect(meetsFloor('v22.23.2', 20, 19)).toBe(true);
    expect(meetsFloor('not-a-version', 20, 19)).toBe(false);
  });
});

describe('nvmNodes', () => {
  it('lists nvm-windows installs newest first, skipping what is not a version or has no node.exe', () => {
    const root = 'C:\\nvm';
    const { readDir, exists } = machine(
      { [root]: ['v20.10.0', 'v22.23.2', 'nvm.exe', 'v18.0.0'] },
      [join(root, 'v20.10.0', 'node.exe'), join(root, 'v22.23.2', 'node.exe')],
    );

    const installs = nvmNodes({ env: { NVM_HOME: root }, platform: 'win32', home: 'C:\\Users\\me', readDir, exists });

    expect(installs).toEqual([
      { path: join(root, 'v22.23.2', 'node.exe'), version: '22.23.2' },
      { path: join(root, 'v20.10.0', 'node.exe'), version: '20.10.0' },
    ]);
  });

  it('reads nvm on macOS and Linux from $NVM_DIR/versions/node', () => {
    const root = join('/home/me/.nvm', 'versions', 'node');
    const { readDir, exists } = machine({ [root]: ['v22.1.0'] }, [join(root, 'v22.1.0', 'bin', 'node')]);

    expect(nvmNodes({ env: {}, platform: 'darwin', home: '/home/me', readDir, exists })).toEqual([
      { path: join(root, 'v22.1.0', 'bin', 'node'), version: '22.1.0' },
    ]);
  });

  it('is empty on a machine without nvm, rather than failing', () => {
    const { readDir, exists } = machine({}, []);
    expect(nvmNodes({ env: {}, platform: 'linux', home: '/home/me', readDir, exists })).toEqual([]);
  });
});

describe('pickNode', () => {
  const installs = [
    { path: '/n/22/node', version: '22.23.2' },
    { path: '/n/20/node', version: '20.10.0' },
  ];

  it('keeps the running Node when it is new enough, so nothing re-spawns needlessly', () => {
    const running = { path: '/usr/bin/node', version: '20.19.1' };
    expect(pickNode(running, installs, FLOOR)).toBe(running);
  });

  it('picks the newest install that meets the floor when the running one does not', () => {
    expect(pickNode({ path: '/n/20/node', version: '20.10.0' }, installs, FLOOR)?.path).toBe('/n/22/node');
  });

  it('answers nothing when no install is new enough, so the refusal still speaks', () => {
    expect(pickNode({ path: '/n/20/node', version: '20.10.0' }, [installs[1]!], FLOOR)).toBeUndefined();
  });
});
