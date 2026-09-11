import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  parsePairingConsoleLine,
  executePairingConsoleCommand,
  installPairingConsole,
} from '../../src/cli/ui.js';
import type { ServerPairing } from '../../src/server/server.js';
import type { DeviceSessionView } from '../../src/contracts/index.js';

describe('Pairing console line parser (FR-028)', () => {
  it('parses "list" command with optional surrounding whitespace', () => {
    expect(parsePairingConsoleLine('list')).toEqual({ kind: 'list' });
    expect(parsePairingConsoleLine('  list  ')).toEqual({ kind: 'list' });
  });

  it('parses "revoke <deviceId>" command with device identifier', () => {
    expect(parsePairingConsoleLine('revoke dev-1234')).toEqual({
      kind: 'revoke',
      deviceId: 'dev-1234',
    });
    expect(parsePairingConsoleLine('  revoke   device_abc-567  ')).toEqual({
      kind: 'revoke',
      deviceId: 'device_abc-567',
    });
  });

  it('treats unrecognised commands or malformed inputs as unknown', () => {
    expect(parsePairingConsoleLine('help')).toEqual({ kind: 'unknown', line: 'help' });
    expect(parsePairingConsoleLine('status')).toEqual({ kind: 'unknown', line: 'status' });
    expect(parsePairingConsoleLine('revoke')).toEqual({ kind: 'unknown', line: 'revoke' });
    expect(parsePairingConsoleLine('')).toEqual({ kind: 'unknown', line: '' });
  });

  it('positive control: distinct commands produce distinct kinds', () => {
    const listCmd = parsePairingConsoleLine('list');
    const revokeCmd = parsePairingConsoleLine('revoke dev-1');
    const unknownCmd = parsePairingConsoleLine('other');

    expect(listCmd.kind).toBe('list');
    expect(revokeCmd.kind).toBe('revoke');
    expect(unknownCmd.kind).toBe('unknown');
    expect(listCmd.kind).not.toBe(revokeCmd.kind);
    expect(listCmd.kind).not.toBe(unknownCmd.kind);
  });
});

describe('Pairing console command execution (FR-028)', () => {
  function makeMockPairing(overrides: Partial<ServerPairing> = {}): ServerPairing {
    return {
      code: 'test-code-12',
      admittedAddresses: ['127.0.0.1'],
      listSessions: () => [],
      revokeSession: () => ({ ok: false, refusal: 'unknown' }),
      issueCode: () => 'dddd-eeee-ffff',
      ...(overrides as object),
    } as ServerPairing;
  }

  it('lists live sessions when "list" is typed', () => {
    const sessions: DeviceSessionView[] = [
      {
        deviceId: 'dev-001',
        label: 'My Phone',
        pairedAt: 1700000000000,
        lastSeenAt: 1700000050000,
      },
      {
        deviceId: 'dev-002',
        label: 'Tablet',
        pairedAt: 1700000010000,
        lastSeenAt: 1700000040000,
      },
    ];

    const written: string[] = [];
    const write = (text: string) => {
      written.push(text);
    };

    const pairing = makeMockPairing({
      listSessions: () => sessions,
    });

    executePairingConsoleCommand('list', pairing, write);

    const output = written.join('');
    expect(output).toContain('2 active device sessions');
    expect(output).toContain('dev-001');
    expect(output).toContain('My Phone');
    expect(output).toContain('dev-002');
    expect(output).toContain('Tablet');
  });

  it('reports when no sessions are active on "list"', () => {
    const written: string[] = [];
    const write = (text: string) => {
      written.push(text);
    };

    const pairing = makeMockPairing({
      listSessions: () => [],
    });

    executePairingConsoleCommand('list', pairing, write);

    const output = written.join('');
    expect(output).toContain('No active device sessions');
  });

  it('calls revokeSession when "revoke <deviceId>" is typed', () => {
    const revoked: string[] = [];
    const pairing = makeMockPairing({
      revokeSession: (deviceId: string) => {
        revoked.push(deviceId);
        return {
          ok: true,
          deviceId,
          label: 'My Device',
          session: {
            deviceId,
            label: 'My Device',
            pairedAt: 1700000000000,
            lastSeenAt: 1700000050000,
          },
        };
      },
    });

    const written: string[] = [];
    const write = (text: string) => {
      written.push(text);
    };

    executePairingConsoleCommand('revoke dev-target', pairing, write);

    expect(revoked).toEqual(['dev-target']);
  });

  it('reports when a session to revoke is not found', () => {
    const pairing = makeMockPairing({
      revokeSession: () => ({ ok: false, refusal: 'unknown' }),
    });

    const written: string[] = [];
    const write = (text: string) => {
      written.push(text);
    };

    executePairingConsoleCommand('revoke missing-dev', pairing, write);

    const output = written.join('');
    expect(output).toContain('No active session found for device "missing-dev"');
  });

  it('prints the two supported forms on unrecognised commands (FR-028)', () => {
    const written: string[] = [];
    const write = (text: string) => {
      written.push(text);
    };

    const pairing = makeMockPairing();
    executePairingConsoleCommand('something else', pairing, write);

    const output = written.join('');
    expect(output).toContain('list');
    expect(output).toContain('revoke <deviceId>');
  });

  it('positive control: unrecognised command fails if not mentioning both forms', () => {
    const written: string[] = [];
    const write = (text: string) => {
      written.push(text);
    };

    const pairing = makeMockPairing();
    executePairingConsoleCommand('foobar', pairing, write);

    const output = written.join('');
    expect(output).toMatch(/\blist\b/);
    expect(output).toMatch(/revoke <deviceId>/);
  });
});

describe('TTY console installation gating (FR-028)', () => {
  it('does not install console when isTTY is false and reads nothing from stdin', () => {
    const stdin = new PassThrough();
    const onData = vi.fn();
    stdin.on('data', onData);

    const pairing: ServerPairing = {
      code: 'code12345678',
      admittedAddresses: ['127.0.0.1'],
      listSessions: () => [],
      revokeSession: () => ({ ok: false, refusal: 'unknown' }),
      issueCode: () => 'dddd-eeee-ffff',
    };

    const rl = installPairingConsole(pairing, {
      stdin,
      isTTY: false,
    });

    expect(rl).toBeUndefined();

    // Writing to stdin produces no console activity
    stdin.write('list\n');
    expect(onData).toHaveBeenCalled();
  });

  it('installs console and processes commands when isTTY is true', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const listCalled = vi.fn().mockReturnValue([]);
    const pairing: ServerPairing = {
      code: 'code12345678',
      admittedAddresses: ['127.0.0.1'],
      listSessions: listCalled,
      revokeSession: () => ({ ok: false, refusal: 'unknown' }),
      issueCode: () => 'dddd-eeee-ffff',
    };

    const written: string[] = [];
    const rl = installPairingConsole(pairing, {
      stdin,
      stdout,
      isTTY: true,
      write: (text) => {
        written.push(text);
      },
    });

    expect(rl).toBeDefined();

    stdin.write('list\n');

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(listCalled).toHaveBeenCalled();
    expect(written.join('')).toContain('No active device sessions');

    rl?.close();
  });
});

/**
 * FR-030 — a new code from the process that already owns the store.
 *
 * Measured live on 11/09/2026, three times in one sitting: a code is printed, it has to
 * survive somebody walking to a phone and typing it, and ten minutes loses that race. The
 * only remedy on offer was restarting the server — which unpairs every device already
 * connected, to help one that is not.
 *
 * This is **not** the FR-014 that AMENDMENT 1 withdrew. That asked for a second *process*
 * to reach the store, which memory-only makes impossible. This is the process that holds
 * the store answering its own terminal, through the seam `list` and `revoke` already use.
 */
describe('the pairing console can mint a code (FR-030)', () => {
  function pairingDouble(overrides: Partial<ServerPairing> = {}): ServerPairing {
    return {
      code: 'aaaa-bbbb-cccc',
      admittedAddresses: ['192.168.0.2'],
      listSessions: () => [],
      revokeSession: () => ({ ok: false as const, refusal: 'unknown' as const }),
      issueCode: () => 'dddd-eeee-ffff',
      ...overrides,
    };
  }

  it('parses "code", with the whitespace a typed line carries', () => {
    expect(parsePairingConsoleLine('code')).toEqual({ kind: 'code' });
    expect(parsePairingConsoleLine('  code  ')).toEqual({ kind: 'code' });
  });

  it('prints the new code and says it replaces the last one', () => {
    let out = '';
    executePairingConsoleCommand('code', pairingDouble(), (text) => (out += text));

    expect(out).toContain('dddd-eeee-ffff');
    // Single-use is a property of the code; two live codes would be two credentials for
    // one decision, and an operator holding an old slip has to know it is dead.
    expect(out).toMatch(/replaces any code printed before it/i);
  });

  it('leaves live sessions alone — that is the whole difference from a restart', () => {
    const revoke = vi.fn();
    const pairing = pairingDouble({
      listSessions: () => [{ deviceId: 'dev-1', label: 'phone', pairedAt: 1, lastSeenAt: 1 }] as unknown as readonly DeviceSessionView[],
      revokeSession: revoke as unknown as ServerPairing['revokeSession'],
    });

    executePairingConsoleCommand('code', pairing, () => {});

    expect(revoke).not.toHaveBeenCalled();
    expect(pairing.listSessions()).toHaveLength(1);
  });

  it('offers all three commands when the line is not one of them', () => {
    let out = '';
    executePairingConsoleCommand('halp', pairingDouble(), (text) => (out += text));

    expect(out).toContain('list');
    expect(out).toContain('code');
    expect(out).toContain('revoke <deviceId>');
  });
});
