import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUEST_FILE_MAX_BYTES, readRequestFileGuarded } from '../../src/cli/mcp-request-file.js';
import { SECOND_PERSON_OBSERVING } from '../fakes/second-person.js';

/**
 * The one local read the MCP server does for a model: the request file `run_start` names.
 *
 * A model chooses that path, so it is a way to make the MCP server read any file on the
 * machine and send it to the hub as a feature request — which then reaches a planner's
 * prompt. The guard keeps it to what a request file is: a regular file, small, under a
 * project the hub serves or under the temp directory, where the operator skill writes them.
 */

let root: string;
let temp: string;
let project: string;
let elsewhere: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-mcp-file-'));
  temp = join(root, 'temp');
  project = join(root, 'project');
  elsewhere = join(root, 'elsewhere');
  for (const dir of [temp, project, elsewhere]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function read(path: string, cwd = root) {
  return readRequestFileGuarded(path, [project], { cwd, tempDir: temp });
}

describe('readRequestFileGuarded', () => {
  it('reads a file under a registered project, and one under the temp directory', async () => {
    writeFileSync(join(project, 'request.md'), '# Story\n');
    writeFileSync(join(temp, 'af-request.md'), '# Other\n');

    expect(await read(join(project, 'request.md'))).toEqual({ ok: true, text: '# Story\n' });
    expect(await read(join(temp, 'af-request.md'))).toEqual({ ok: true, text: '# Other\n' });
  });

  it('resolves a relative path against the directory the server started in', async () => {
    writeFileSync(join(project, 'request.md'), 'relative\n');

    expect(await read('request.md', project)).toEqual({ ok: true, text: 'relative\n' });
  });

  it('refuses a file outside every project and the temp directory, naming why', async () => {
    writeFileSync(join(elsewhere, 'secrets.txt'), 'token=1');

    const outcome = await read(join(elsewhere, 'secrets.txt'));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('outside');
    expect(outcome.message).toContain('temp');
  });

  it('refuses a path that only looks inside: a sibling sharing the prefix, and a .. escape', async () => {
    const sibling = `${project}-backup`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'r.md'), 'x');
    writeFileSync(join(elsewhere, 'r.md'), 'x');

    expect((await read(join(sibling, 'r.md'))).ok).toBe(false);
    expect((await read(join(project, '..', 'elsewhere', 'r.md'))).ok).toBe(false);
  });

  it('refuses a directory, a missing file and a file over the size limit', async () => {
    writeFileSync(join(project, 'big.md'), 'x'.repeat(REQUEST_FILE_MAX_BYTES + 1));
    writeFileSync(join(project, 'at-limit.md'), 'x'.repeat(REQUEST_FILE_MAX_BYTES));

    const directory = await read(project);
    const missing = await read(join(project, 'nope.md'));
    const big = await read(join(project, 'big.md'));

    expect(directory.ok).toBe(false);
    // Opened and then refused by the open handle's own `stat`: named as a directory, not missing.
    if (!directory.ok) expect(directory.message).toContain('not a regular file');
    expect(missing.ok).toBe(false);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.message).toContain('32 KB');
    // Positive control for the bound: exactly the limit is a request, read whole from the one
    // open handle (CodeQL js/file-system-race).
    const atLimit = await read(join(project, 'at-limit.md'));
    expect(atLimit.ok && atLimit.text.length).toBe(REQUEST_FILE_MAX_BYTES);
  });

  it('judges where before what: a big file outside is refused as outside, its size unsaid', async () => {
    // Otherwise the guard is an oracle: "is N bytes" about any file on the machine.
    writeFileSync(join(elsewhere, 'big.bin'), 'x'.repeat(REQUEST_FILE_MAX_BYTES + 10));

    const outcome = await read(join(elsewhere, 'big.bin'));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('outside');
    expect(outcome.message).not.toContain(String(REQUEST_FILE_MAX_BYTES + 10));
  });

  it('is 32 KB', () => {
    expect(REQUEST_FILE_MAX_BYTES).toBe(32 * 1024);
  });

  it('says nothing that tells the model to observe on its own', async () => {
    writeFileSync(join(elsewhere, 'x.md'), 'x');
    for (const path of [join(elsewhere, 'x.md'), project, join(project, 'nope.md')]) {
      const outcome = await read(path);
      if (!outcome.ok) expect(outcome.message).not.toMatch(SECOND_PERSON_OBSERVING);
    }
  });
});
