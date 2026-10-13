import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPairingCodeCommand } from '../../src/cli/pairing-code.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { createProgram } from '../../src/cli/index.js';
import type { HubClient, HubRequest, HubResponse } from '../../src/ports/hub-client.js';

/**
 * `agent-flow pairing-code` (dogfood 08–09/10): a new code from the running hub, so a second
 * device pairs without a restart that would unpair the first.
 */

afterEach(() => vi.restoreAllMocks());

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

function hubAnswering(response: HubResponse) {
  const requests: HubRequest[] = [];
  const hub: HubClient = {
    baseUrl: 'http://127.0.0.1:4782',
    send: (request) => (requests.push(request), Promise.resolve(response)),
  };
  return { hub, requests };
}

describe('agent-flow pairing-code (dogfood 08–09/10)', () => {
  it('asks the hub for a code and prints it with how long it lasts', async () => {
    const output = capture();
    const { hub, requests } = hubAnswering({ kind: 'ok', status: 200, body: { code: 'abcd-1234-ef56' } });

    const code = await runPairingCodeCommand({}, { hub: () => hub });

    expect(code).toBe(ExitCode.OK);
    expect(requests).toEqual([{ method: 'POST', path: '/pairing/code', body: {} }]);
    expect(output.stdout()).toContain('abcd-1234-ef56');
    expect(output.stdout()).toContain('10 minutes');
  });

  it('says why when the hub refuses, and fails', async () => {
    const output = capture();
    const { hub } = hubAnswering({
      kind: 'http_error',
      status: 404,
      error: 'not_found',
      message: 'pairing is not enabled on this server',
    });

    const code = await runPairingCodeCommand({}, { hub: () => hub });

    expect(code).not.toBe(ExitCode.OK);
    expect(output.stderr()).toContain('pairing is not enabled');
    expect(output.stderr()).toContain('--pair');
  });

  it('is a command of its own', () => {
    expect(createProgram().program.commands.some((command) => command.name() === 'pairing-code')).toBe(true);
  });
});
