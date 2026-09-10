import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';
import { runUiCommand } from '../../src/cli/ui.js';
import { ExitCode } from '../../src/cli/exit-codes.js';

/** The globals the command reads, and nothing it does not. */
const GLOBALS = (temp: TempRepo) => ({
  cwd: temp.dir,
  globalConfigPath: `${temp.home}/.agent-flow/config.yaml`,
  verbose: false,
  dryRun: false,
  json: false,
  strict: false,
});

/**
 * A taken port is an ordinary outcome, and it used to print a stack trace (D1).
 *
 * Measured: `agent-flow ui` against a port an earlier instance still held answered with
 * `Error: listen EADDRINUSE: address already in use 127.0.0.1:4782` and four frames of
 * `node:internal`. The product knew the port, knew the holder was almost certainly another
 * `agent-flow ui`, and knew `--port` existed — and said none of it.
 *
 * **It cost something**, which is why this is a test and not a polish item. The failure was
 * silent to the caller, the old server kept answering on that port serving a workspace
 * under `%TEMP%`, and a feature was very nearly planned against the wrong repository.
 *
 * A real listener on a real port, because that is the only way to produce the error the
 * fix reads: `EADDRINUSE` comes from the kernel, and a stubbed `listen` would be a test of
 * the stub.
 */

let repo: TempRepo | undefined;
let squatter: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (squatter === undefined) return resolve();
    squatter.close(() => {
      resolve();
    });
  });
  squatter = undefined;
  repo?.cleanup();
  repo = undefined;
  vi.restoreAllMocks();
});

/** A port nobody else on the machine is using, held open. */
async function occupied(): Promise<number> {
  const server = createServer();
  squatter = server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port was assigned');
  return address.port;
}

describe('D1 — `agent-flow ui` on a port that is taken', () => {
  it('says which port, who probably has it, and what to do', async () => {
    repo = await makeTempRepoWithCommit();
    const port = await occupied();

    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const code = await runUiCommand(
      repo.dir,
      { port: String(port), open: false },
      GLOBALS(repo),
    );

    const report = written.join('');

    // A configuration problem, not an execution one: the operator changes a flag or stops
    // a process. That is the distinction `exit-codes.ts` exists to draw.
    expect(code).toBe(ExitCode.CONFIG_ERROR);

    expect(report).toContain(`Port ${String(port)}`);
    expect(report).toContain('already in use');
    // The three things the stack trace did not say.
    expect(report).toContain('agent-flow ui');
    expect(report).toContain(`--port ${String(port + 1)}`);

    // And no stack trace. This is the assertion the fix exists for: a person reading
    // `node:internal/process/task_queues` learns nothing they can act on.
    expect(report).not.toContain('node:internal');
    expect(report).not.toContain('EADDRINUSE');
    expect(report).not.toContain('at Server.');
  });

  it('positive control: a different refusal does not borrow the port sentence', async () => {
    // The control has to be a *refusal*, because the success path never returns — the
    // command is a server, and a test that awaited it would hang. So it asserts the other
    // half of the claim: the port message is printed for a taken port and for nothing
    // else. Without it, a fix that wrote that paragraph unconditionally would pass above.
    repo = await makeTempRepoWithCommit();
    const port = await occupied();

    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    // An empty directory: no project, no repository, nothing to serve. The port is still
    // occupied, so a message printed regardless of the reason would show up here.
    const empty = join(repo.home, 'nothing-here');
    mkdirSync(empty, { recursive: true });

    const code = await runUiCommand(
      empty,
      { port: String(port), open: false },
      GLOBALS(repo),
    );

    const report = written.join('');

    expect(code).toBe(ExitCode.GATE_NOT_SATISFIED);
    expect(report).toContain('No Agent Flow project or Git repository found');
    expect(report).not.toContain('already in use');
  });
});
