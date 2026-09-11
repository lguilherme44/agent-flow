import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { renderDiagnosis, renderRemoteAccess, runDoctorCommand } from '../../src/cli/doctor.js';
import type { Diagnosis } from '../../src/app/diagnostics.js';
import { ptBR } from '../../src/core/phrases/pt-BR.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { GlobalConfigSchema, type EffectiveConfig } from '../../src/contracts/index.js';
import type { GlobalOptions } from '../../src/cli/index.js';
import * as configLoader from '../../src/config/loader.js';
import * as diagnosticsApp from '../../src/app/diagnostics.js';

function fakeDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    status: 'OK',
    tools: [
      { name: 'node', present: true, version: 'v20.11.0' },
      { name: 'git', present: true, version: '2.43.0' },
    ],
    install: { outcome: 'skipped', reason: 'not_requested' },
    capabilities: [],
    stageRouting: [],
    unusedRunners: [],
    runners: [],
    probes: [],
    orphanRoles: [],
    degradations: [],
    notes: [],
    unresolvableRoles: [],
    remediations: [],
    readsEnvironment: true,
    remoteAccess: { known: false },
    ...overrides,
  };
}

describe('doctor CLI remote access rendering (FR-023)', () => {
  it('renderRemoteAccess reports undetermined from terminal and names running server when unknown', () => {
    const lines = renderRemoteAccess({ known: false });
    const rendered = lines.join('\n');

    expect(rendered).toContain('Remote access:');
    expect(rendered).toContain(
      'remote access status cannot be determined from a terminal; ask the running server',
    );
    // Never prints 'off' when remote access is unknown
    expect(rendered).not.toContain('off');
  });

  it('renderRemoteAccess supports Portuguese translations', () => {
    const lines = renderRemoteAccess({ known: false }, ptBR);
    const rendered = lines.join('\n');

    expect(rendered).toContain(
      'o status de acesso remoto não pode ser determinado a partir de um terminal; consulte o servidor em execução',
    );
    expect(rendered).not.toContain('off');
  });

  it('renderDiagnosis surfaces the undetermined line on the CLI report and never prints "off"', () => {
    const diagnosis = fakeDiagnosis({ remoteAccess: { known: false } });
    const lines = renderDiagnosis(diagnosis);
    const text = lines.join('\n');

    expect(text).toContain('Remote access:');
    expect(text).toContain(
      'remote access status cannot be determined from a terminal; ask the running server',
    );
    expect(text).not.toContain('off');
  });

  it('positive control: known=true with enabled=false renders "off", but known=false never does', () => {
    const knownOff = renderRemoteAccess({
      known: true,
      enabled: false,
      admittedAddresses: [],
      liveSessions: 0,
    }).join('\n');
    expect(knownOff).toContain('off');

    const unknown = renderRemoteAccess({ known: false }).join('\n');
    expect(unknown).not.toContain('off');
    expect(unknown).toContain('ask the running server');
  });

  it('renderRemoteAccess prints enabled details when known=true and enabled=true', () => {
    const rendered = renderRemoteAccess({
      known: true,
      enabled: true,
      admittedAddresses: ['192.168.1.10:4782'],
      liveSessions: 3,
    }).join('\n');

    expect(rendered).toContain('enabled (3 live sessions)');
    expect(rendered).toContain('192.168.1.10:4782');
  });
});

describe('runDoctorCommand CLI surface (FR-023)', () => {
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];
  let stdoutSpy: { mockRestore(): void };
  let stderrSpy: { mockRestore(): void };

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('runs doctor and prints honest line on stdout without passing remoteAccess to diagnose', async () => {
    const diagnoseSpy = vi.spyOn(diagnosticsApp, 'diagnose').mockResolvedValue(
      fakeDiagnosis({ remoteAccess: { known: false } }),
    );
    const effectiveConfig: EffectiveConfig = {
      global: GlobalConfigSchema.parse(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML)),
    };
    vi.spyOn(configLoader, 'loadConfig').mockResolvedValue(effectiveConfig);

    const globals: GlobalOptions = {
      cwd: '/test',
      globalConfigPath: '/test/config.yaml',
      verbose: false,
      dryRun: false,
      json: false,
      strict: false,
    };

    const exitCode = await runDoctorCommand({}, globals);

    expect(exitCode).toBe(ExitCode.OK);

    // Verify DiagnoseOptions passed to diagnose did NOT contain remoteAccess
    expect(diagnoseSpy).toHaveBeenCalledTimes(1);
    const passedOptions = diagnoseSpy.mock.calls[0]![0];
    expect(passedOptions.remoteAccess).toBeUndefined();

    // Verify rendered output on CLI surface
    const output = stdoutChunks.join('');
    expect(output).toContain('Remote access:');
    expect(output).toContain(
      'remote access status cannot be determined from a terminal; ask the running server',
    );
    expect(output).not.toContain('off');
  });
});
