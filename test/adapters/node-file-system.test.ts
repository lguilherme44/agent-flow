import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as nodeFs } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';

/**
 * AF-L01.1-B — `createExclusive` on the real filesystem.
 *
 * The in-memory fake cannot cover this: it has no separate open and write, so it has
 * no state in which the file exists and the content does not. That state is the whole
 * subject here. `open(path, 'wx')` is what wins the race, and it wins it *before* a
 * single byte is written — so a failing write leaves an empty claim behind, and an
 * empty claim is the one thing the lock can never recover from. It has no pid, so no
 * liveness check can judge it stale, and the reader refuses it forever by design.
 */

const created: string[] = [];

async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'af-fs-'));
  created.push(path);
  return path;
}

/**
 * Makes the next `open` succeed and its write fail.
 *
 * The open is real, so the file is genuinely created and the test is asking a real
 * question about a real path. Only the two members `createExclusive` uses are stood
 * in for — `close` still closes the handle the open returned, so the descriptor this
 * test opens is the descriptor it leaves closed.
 */
function writeFails(error: Error): void {
  const open = nodeFs.open.bind(nodeFs);

  vi.spyOn(nodeFs, 'open').mockImplementation((async (path: string, flags: string) => {
    const handle = await open(path, flags);
    return {
      writeFile: () => Promise.reject(error),
      close: () => handle.close(),
    };
  }) as unknown as typeof nodeFs.open);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('createExclusive', () => {
  it('creates the file and reports that it did', async () => {
    const root = await dir();
    const path = join(root, 'execution.lock.1');

    expect(await new NodeFileSystem().createExclusive(path, 'mine\n')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('mine\n');
  });

  it('reports a file somebody else already has, and does not touch it', async () => {
    const root = await dir();
    const path = join(root, 'execution.lock.1');
    await writeFile(path, 'theirs\n', 'utf8');

    // `EEXIST` is the answer, not a failure — it is how exactly one claimant wins.
    // And it must never trigger the cleanup below: that file belongs to the winner.
    expect(await new NodeFileSystem().createExclusive(path, 'mine\n')).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('theirs\n');
  });

  it('removes the claim it created when the write fails', async () => {
    const root = await dir();
    const path = join(root, 'execution.lock.1');

    writeFails(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));

    await expect(new NodeFileSystem().createExclusive(path, 'mine\n')).rejects.toThrow(
      // The original failure, not something the cleanup produced. A caller told
      // "unlink failed" would be chasing the wrong problem.
      'ENOSPC',
    );

    // The point of the whole test. An `execution.lock.1` left here with no pid in it
    // is a lock nothing can ever judge stale, and the run would stay refused until
    // somebody deleted the file by hand.
    expect(await readdir(root)).toEqual([]);
  });

  it('leaves other claims in the directory alone while cleaning up its own', async () => {
    const root = await dir();
    await writeFile(join(root, 'execution.lock.1'), 'someone else\n', 'utf8');

    writeFails(new Error('EIO: i/o error'));

    await expect(
      new NodeFileSystem().createExclusive(join(root, 'execution.lock.2'), 'mine\n'),
    ).rejects.toThrow('EIO');

    // Only the path this call opened is removed. Generation 1 belongs to a process
    // that may well be alive and relying on it.
    expect(await readdir(root)).toEqual(['execution.lock.1']);
    expect(await readFile(join(root, 'execution.lock.1'), 'utf8')).toBe('someone else\n');
  });
});
