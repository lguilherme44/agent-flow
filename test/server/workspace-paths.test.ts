import { describe, it, expect } from 'vitest';
import { posix, win32 } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import {
  assignIds,
  discoverProjects,
  isWithinWorkspace,
  normaliseWorkspaceRoot,
  workspaceBasename,
} from '../../src/server/project-registry.js';

/**
 * Workspace containment, on both platforms (D-F02).
 *
 * The registry *is* the filesystem security boundary (§93), and it used to be
 * enforced with `startsWith(`${root}/`)` and `lastIndexOf('/')`. Those are correct
 * on POSIX and meaningless on Windows: `C:\wk` does not contain `C:\wk\api` by that
 * rule, so a Windows workspace discovered nothing at all, and `\\server\share` was
 * compared as an ordinary string prefix.
 *
 * These tests pass `path.posix` and `path.win32` explicitly rather than relying on
 * whatever platform the suite happens to run on. A rule about Windows that only
 * runs on Windows is a rule nobody checks — and CI here is Linux.
 */

describe('containment, on POSIX', () => {
  const cases: Array<[string, string, boolean]> = [
    // The root is inside itself: `agent-flow ui ~/project` serves one project, and
    // rejecting the root would serve nothing.
    ['/wk', '/wk', true],
    ['/wk', '/wk/api', true],
    ['/wk', '/wk/mono/packages/api', true],
    // The case the separator exists for. A prefix test says yes.
    ['/wk', '/wknight', false],
    ['/wk', '/wknight/api', false],
    ['/wk', '/private/secrets', false],
    ['/wk', '/', false],
    ['/wk/api', '/wk', false],
    // A trailing separator on either side is the same directory.
    ['/wk/', '/wk/api', true],
    ['/wk', '/wk/api/', true],
    ['/', '/anywhere', true],
  ];

  for (const [root, candidate, expected] of cases) {
    it(`${root} ${expected ? 'contains' : 'does not contain'} ${candidate}`, () => {
      expect(isWithinWorkspace(root, candidate, posix)).toBe(expected);
    });
  }
});

describe('containment, on Windows', () => {
  const cases: Array<[string, string, boolean]> = [
    ['C:\\wk', 'C:\\wk', true],
    ['C:\\wk', 'C:\\wk\\api', true],
    ['C:\\wk', 'C:\\wk\\mono\\packages\\api', true],
    // The same near-miss, with the other separator.
    ['C:\\wk', 'C:\\wknight', false],
    ['C:\\wk', 'C:\\wknight\\api', false],
    ['C:\\wk', 'C:\\private\\secrets', false],
    ['C:\\wk\\api', 'C:\\wk', false],
    // A different drive. There is no route between the two, and `relative` says so
    // by answering with an absolute path — the one case a prefix comparison cannot
    // express at all.
    ['C:\\wk', 'D:\\wk', false],
    ['C:\\wk', 'D:\\wk\\api', false],
    // A UNC share is a root of its own, and two shares are two roots.
    ['\\\\server\\share', '\\\\server\\share\\api', true],
    ['\\\\server\\share', '\\\\server\\other\\api', false],
    ['\\\\server\\share', 'C:\\wk', false],
    // Trailing separators, and the forward slashes Windows also accepts.
    ['C:\\wk\\', 'C:\\wk\\api', true],
    ['C:\\wk', 'C:/wk/api', true],
    // Windows roots are case-insensitive, and `path.win32.relative` knows that.
    // Lower-casing here ourselves would be a second answer, and would be wrong on
    // the case-sensitive filesystems Linux actually has.
    ['C:\\WK', 'c:\\wk\\api', true],
  ];

  for (const [root, candidate, expected] of cases) {
    it(`${root} ${expected ? 'contains' : 'does not contain'} ${candidate}`, () => {
      expect(isWithinWorkspace(root, candidate, win32)).toBe(expected);
    });
  }
});

describe('the last segment of a path', () => {
  it('is the directory name on POSIX, trailing separator or not', () => {
    expect(workspaceBasename('/wk/api', posix)).toBe('api');
    expect(workspaceBasename('/wk/api/', posix)).toBe('api');
  });

  it('is the directory name on Windows, not the whole path', () => {
    // `lastIndexOf('/')` found nothing in a backslash path, so the id became a slug
    // of `c-wk-api` — the whole address, as a project name.
    expect(workspaceBasename('C:\\wk\\api', win32)).toBe('api');
    expect(workspaceBasename('C:\\wk\\api\\', win32)).toBe('api');
    expect(workspaceBasename('\\\\server\\share\\api', win32)).toBe('api');
  });

  it('never answers with nothing, even at a root', () => {
    // `basename` of a root is the empty string, and an empty id is one no route can
    // match — the project would be listed and then unreachable.
    expect(workspaceBasename('/', posix)).toBe('/');
    expect(workspaceBasename('C:\\', win32)).toBe('C:\\');
  });

  it('produces a usable id from a Windows path', () => {
    const [project] = assignIds(['C:\\wk\\Booking API'], win32);

    expect(project?.name).toBe('Booking API');
    expect(project?.id).toBe('booking-api');
  });
});

describe('normalising a root', () => {
  it('drops a trailing separator without eating a root', () => {
    expect(normaliseWorkspaceRoot('/wk/', posix)).toBe('/wk');
    expect(normaliseWorkspaceRoot('/wk', posix)).toBe('/wk');
    expect(normaliseWorkspaceRoot('/', posix)).toBe('/');
  });

  it('does the same for both Windows separators', () => {
    expect(normaliseWorkspaceRoot('C:\\wk\\', win32)).toBe('C:\\wk');
    expect(normaliseWorkspaceRoot('C:/wk/', win32)).toBe('C:\\wk');
    expect(normaliseWorkspaceRoot('C:\\', win32)).toBe('C:\\');
  });
});

describe('the guarantee the rewrite must not have lost', () => {
  // The containment rule exists for one reason: a link inside the workspace pointing
  // at a repository outside it must be named and skipped rather than published on a
  // local port. Restated here against the walk itself, because the unit cases above
  // prove the comparison and this proves it is still the comparison being used.
  const CONFIG = 'project:\n  name: demo\n  type: node\n';

  it('still refuses a link that resolves out of the workspace', async () => {
    const fs = new InMemoryFileSystem();
    for (const path of ['/wk/api', '/private/secrets']) {
      fs.seed(`${path}/.agent-flow/config.yaml`, CONFIG);
    }
    fs.link('/wk/elsewhere', '/private/secrets');

    const found = await discoverProjects({ fs, roots: ['/wk'], depth: 3 });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk/api']);
    expect(found.skipped).toEqual([
      { path: '/wk/elsewhere', reason: 'outside_workspace', resolved: '/private/secrets' },
    ]);
  });

  it('still refuses a sibling whose name starts with the root', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/wknight/api/.agent-flow/config.yaml', CONFIG);
    fs.seed('/wk/.agent-flow/config.yaml', CONFIG);
    fs.link('/wk/near', '/wknight');

    const found = await discoverProjects({ fs, roots: ['/wk'], depth: 3 });

    expect(found.projects.map((project) => project.path)).toEqual(['/wk']);
    expect(found.skipped.map((entry) => entry.resolved)).toEqual(['/wknight']);
  });

  it('serves a project when the root is the project', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/wk/api/.agent-flow/config.yaml', CONFIG);

    const found = await discoverProjects({ fs, roots: ['/wk/api'] });

    expect(found.projects.map((project) => project.id)).toEqual(['api']);
  });
});
