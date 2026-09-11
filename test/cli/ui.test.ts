import { describe, it, expect, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import {
  parseDepth,
  parsePort,
  resolveDepth,
  resolvePairingEnabled,
  enumerateBoundAddresses,
  formatPairingCode,
  runUiCommand,
} from '../../src/cli/ui.js';
import { main } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { DEFAULT_WORKSPACE_DEPTH } from '../../src/server/project-registry.js';
import { makeTempRepoWithCommit } from '../fixtures/temp-repo.js';
import type { RunningServer } from '../../src/server/server.js';

/**
 * `agent-flow ui [root]` — the workspace root and how far it is scanned (UI-29).
 *
 * The depth is the only number on this command that decides what the server can
 * serve at all, so where it comes from is worth pinning down: the flag was typed
 * for this run, the config was typed once, and the default is what neither says.
 */

const GLOBAL = (depth: number): string => `runners:
  codex:
    type: codex-cli
roles:
  architect: { runner: codex }
  sdd: { runner: codex }
  planner: { runner: codex }
  planReviewer: { runner: codex }
  verification: { runner: codex }
  finalReviewer: { runner: codex }
  executors:
    trivial: { runner: codex }
    normal: { runner: codex }
    complex: { runner: codex }
ui:
  workspaceDepth: ${String(depth)}
`;

function world(global?: string): InMemoryFileSystem {
  const fs = new InMemoryFileSystem();
  if (global !== undefined) fs.seed('/home/.agent-flow/config.yaml', global);
  return fs;
}

const at = (fs: InMemoryFileSystem) => ({
  fs,
  globalConfigPath: '/home/.agent-flow/config.yaml',
  projectDir: '/wk',
});

describe('parsePort', () => {
  it('refuses anything that is not a port', () => {
    for (const raw of ['0', '65536', 'eighty', '-1', '80.5']) {
      expect(() => parsePort(raw), raw).toThrow(/Invalid --port/);
    }
  });
});

describe('parseDepth', () => {
  it('refuses a depth outside the bound', () => {
    // Unbounded is the failure mode: a scan of a home directory reads places
    // nobody asked it to and takes minutes before anything renders.
    for (const raw of ['-1', '7', '99', 'deep']) {
      expect(() => parseDepth(raw), raw).toThrow(/Invalid --depth/);
    }
  });

  it('accepts zero, which means the root and nothing under it', () => {
    expect(parseDepth('0')).toBe(0);
  });
});

describe('resolveDepth', () => {
  it('prefers the flag, which was typed for this run', async () => {
    expect(await resolveDepth('1', at(world(GLOBAL(4))))).toBe(1);
  });

  it('falls back to the configured depth', async () => {
    // Somebody who keeps their repositories three levels down should not have to
    // say so every time they open the dashboard.
    expect(await resolveDepth(undefined, at(world(GLOBAL(4))))).toBe(4);
  });

  it('falls back to the default when nothing says otherwise', async () => {
    expect(await resolveDepth(undefined, at(world()))).toBe(DEFAULT_WORKSPACE_DEPTH);
  });

  it('starts anyway when the configuration will not load', async () => {
    // `agent-flow ui` is often exactly what somebody opens *because* something is
    // wrong. Refusing to start over a malformed global file would take away the
    // tool that shows them why — the Settings page reports the same error where
    // it can be read (§95).
    const fs = world('runners: [not a mapping]\n');

    expect(await resolveDepth(undefined, at(fs))).toBe(DEFAULT_WORKSPACE_DEPTH);
  });

  it('refuses a flag beyond the bound rather than clamping it silently', async () => {
    await expect(resolveDepth('9', at(world()))).rejects.toThrow(/Invalid --depth/);
  });
});

const PAIRING_CONFIG = (enabled: boolean): string => `runners:
  codex:
    type: codex-cli
roles:
  architect: { runner: codex }
  sdd: { runner: codex }
  planner: { runner: codex }
  planReviewer: { runner: codex }
  verification: { runner: codex }
  finalReviewer: { runner: codex }
  executors:
    trivial: { runner: codex }
    normal: { runner: codex }
    complex: { runner: codex }
ui:
  pairing:
    enabled: ${String(enabled)}
`;

describe('resolvePairingEnabled (FR-002)', () => {
  it('turns on when ui.pairing.enabled is true and no flag is passed', async () => {
    expect(await resolvePairingEnabled(undefined, at(world(PAIRING_CONFIG(true))))).toBe(true);
  });

  it('turns on when --pair flag is passed even if config has false (flag wins)', async () => {
    expect(await resolvePairingEnabled(true, at(world(PAIRING_CONFIG(false))))).toBe(true);
  });

  it('yields false when config will not load (strict-load degradation)', async () => {
    const brokenFs = world('runners: [not a mapping\n');
    expect(await resolvePairingEnabled(undefined, at(brokenFs))).toBe(false);
  });

  it('yields false with default configuration and no flag', async () => {
    expect(await resolvePairingEnabled(undefined, at(world()))).toBe(false);
  });

  it('positive control: removing flag priority would yield false when key is false', async () => {
    const withFlag = await resolvePairingEnabled(true, at(world(PAIRING_CONFIG(false))));
    const withoutFlag = await resolvePairingEnabled(undefined, at(world(PAIRING_CONFIG(false))));
    expect(withFlag).toBe(true);
    expect(withoutFlag).toBe(false);
  });
});

describe('enumerateBoundAddresses (FR-003, FR-018)', () => {
  it('returns loopback address as-is', () => {
    expect(enumerateBoundAddresses('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(enumerateBoundAddresses('localhost')).toEqual(['127.0.0.1']);
  });

  it('returns explicit interface IP as-is', () => {
    expect(enumerateBoundAddresses('192.168.1.50')).toEqual(['192.168.1.50']);
  });

  it('enumerates non-internal IPv4 addresses when bound to 0.0.0.0', () => {
    const mockInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      eth0: [
        {
          address: '192.168.1.42',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: '192.168.1.42/24',
        },
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 0,
        },
      ],
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    };

    expect(enumerateBoundAddresses('0.0.0.0', mockInterfaces)).toEqual(['192.168.1.42']);
  });

  it('falls back to 127.0.0.1 if only internal interfaces exist on 0.0.0.0', () => {
    const onlyInternal: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    };

    expect(enumerateBoundAddresses('0.0.0.0', onlyInternal)).toEqual(['127.0.0.1']);
  });
});

describe('formatPairingCode (FR-003)', () => {
  it('formats a 12-character pairing code as xxxx-xxxx-xxxx', () => {
    expect(formatPairingCode('1a2b3c4d5e6f')).toBe('1a2b-3c4d-5e6f');
  });

  it('positive control: output matches xxxx-xxxx-xxxx format', () => {
    expect(formatPairingCode('1a2b3c4d5e6f')).toMatch(/^[0-9a-zA-Z]{4}-[0-9a-zA-Z]{4}-[0-9a-zA-Z]{4}$/);
  });
});

describe('pre-binding refusals (FR-019, FR-020)', () => {
  it('refuses --host 0.0.0.0 without --pair and exits CONFIG_ERROR naming --pair (FR-019)', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const code = await runUiCommand(
      undefined,
      { host: '0.0.0.0' },
      {
        cwd: process.cwd(),
        globalConfigPath: '/tmp/nonexistent.yaml',
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      },
    );

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(written.join('')).toContain('--pair');
  });

  it('positive control: loopback host does not trigger the non-loopback refusal', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const netServer = (await import('node:net')).createServer();
    await new Promise<void>((res) => netServer.listen(0, '127.0.0.1', () => res()));
    const freePort = (netServer.address() as { port: number }).port;
    await new Promise<void>((res) => netServer.close(() => res()));

    let capturedServer: RunningServer | undefined;
    const code = await runUiCommand(
      undefined,
      { host: '127.0.0.1', open: false, port: String(freePort) },
      {
        cwd: process.cwd(),
        globalConfigPath: '/tmp/nonexistent.yaml',
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      },
      {
        onReady: (server) => {
          capturedServer = server;
          void server.close();
        },
      },
    );

    expect(capturedServer).toBeDefined();
    expect(code).toBe(ExitCode.OK);
    expect(written.join('')).not.toContain('Pass `--pair` to enable remote device pairing');
  });

  it('refuses --pair --classic before binding and exits CONFIG_ERROR (FR-020)', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const code = await runUiCommand(
      undefined,
      { pair: true, classic: true },
      {
        cwd: process.cwd(),
        globalConfigPath: '/tmp/nonexistent.yaml',
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      },
    );

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(written.join('')).toContain('--classic');
  });
});

describe('help and doc assertions (FR-029)', () => {
  it('agent-flow ui --help states that restarting the server unpairs every device and invalidates any outstanding code', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const code = await main(['node', 'agent-flow', 'ui', '--help']);
    expect(code).toBe(ExitCode.OK);
    const output = written.join('');
    expect(output.replace(/\s+/g, ' ')).toContain(
      'restarting the server unpairs every device and invalidates any outstanding code',
    );
  });
});

describe('agent-flow ui --pair startup output and notifications (FR-002, FR-003, FR-027, FR-029)', () => {
  it('prints exactly one code, reachable URLs, restart warning, and notifications on pair and revoke', async () => {
    const repo = await makeTempRepoWithCommit();
    try {
      const out: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        out.push(String(chunk));
        return true;
      });

      // Find an ephemeral port
      const netServer = (await import('node:net')).createServer();
      await new Promise<void>((res) => netServer.listen(0, '127.0.0.1', () => res()));
      const freePort = (netServer.address() as { port: number }).port;
      await new Promise<void>((res) => netServer.close(() => res()));

      let capturedServer: RunningServer | undefined;
      const codePromise = runUiCommand(
        repo.dir,
        { pair: true, open: false, port: String(freePort) },
        {
          cwd: repo.dir,
          globalConfigPath: `${repo.home}/.agent-flow/config.yaml`,
          verbose: false,
          dryRun: false,
          json: false,
          strict: false,
        },
        {
          onReady: (server) => {
            capturedServer = server;
          },
        },
      );

      for (let i = 0; i < 50 && !capturedServer; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(capturedServer).toBeDefined();
      expect(capturedServer!.pairing).toBeDefined();

      const printed = out.join('');

      // FR-002, FR-003: prints exactly one code matching xxxx-xxxx-xxxx
      const codeMatches = printed.match(/\b[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\b/g);
      expect(codeMatches).toHaveLength(1);

      // FR-003: prints one http://<addr>:<port> line per admitted address
      expect(printed).toContain(`http://127.0.0.1:${String(freePort)}`);

      // FR-029: startup output states restarting unpairs every device
      expect(printed).toContain('Restarting the server unpairs every device and invalidates any outstanding code.');

      // FR-027: prints a line naming deviceId and label when a device pairs
      const pairRes = await capturedServer!.app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        headers: {
          host: `127.0.0.1:${String(freePort)}`,
          'content-type': 'application/json',
          'x-agent-flow-client': '1',
        },
        payload: {
          code: capturedServer!.pairing!.code,
          label: 'Mobile Safari',
        },
      });
      expect(pairRes.statusCode).toBe(200);
      const pairData = pairRes.json() as { deviceId: string; label: string };
      expect(out.join('')).toContain(`Device paired: ${pairData.deviceId} (Mobile Safari)`);

      // FR-027: prints a line naming deviceId and label when a session is revoked
      const revokeOutcome = capturedServer!.pairing!.revokeSession(pairData.deviceId);
      expect(revokeOutcome.ok).toBe(true);
      expect(out.join('')).toContain(`Session revoked: ${pairData.deviceId} (Mobile Safari)`);

      await capturedServer!.close();
      const exitCode = await codePromise;
      expect(exitCode).toBe(ExitCode.OK);
    } finally {
      repo.cleanup();
    }
  });
});
