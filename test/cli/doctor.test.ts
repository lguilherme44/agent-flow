import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { renderDiagnosis, renderRemoteAccess, runDoctorCommand } from '../../src/cli/doctor.js';
import type { Diagnosis } from '../../src/app/diagnostics.js';
import { ptBR } from '../../src/core/phrases/pt-BR.js';
import { en } from '../../src/core/phrases/en.js';
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
    vi.spyOn(configLoader, 'loadConfigWithReport').mockResolvedValue({ config: effectiveConfig, ignoredLoosenings: [] });

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

  describe('in a project the global config does not trust (FR-027)', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'af-doctor-trust-'));
      await mkdir(join(root, 'project', '.agent-flow'), { recursive: true });
      await writeFile(
        join(root, 'project', '.agent-flow', 'config.yaml'),
        'project:\n  name: demo\n  type: node\nrunners:\n  claude:\n    dangerouslySkipPermissions: true\n',
      );
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /**
     * The real loader on real files, and the real `diagnose` — with only the machine taken
     * away: no process spawned, no Git home provisioned under the real home directory.
     */
    async function doctorWith(globalYaml: string): Promise<string> {
      const globalConfigPath = join(root, 'global.yaml');
      await writeFile(globalConfigPath, globalYaml);

      const real = diagnosticsApp.diagnose;
      const prompts = new InMemoryFileSystem();
      vi.spyOn(diagnosticsApp, 'diagnose').mockImplementation((options) =>
        real({
          ...options,
          fs: prompts,
          processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: 'v20.11.0' }),
          host: new FakeHost(),
          promptsDir: '/install/prompts',
          installProbe: false,
        }),
      );

      await runDoctorCommand({}, {
        cwd: join(root, 'project'),
        globalConfigPath,
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      });
      return stdoutChunks.join('');
    }

    it('prints the note naming the refused path and trust.projectConfig', async () => {
      const output = await doctorWith('parallelism:\n  maxTasks: 1\n');

      expect(output).toContain('`runners.claude.dangerouslySkipPermissions`');
      expect(output).toContain('trust.projectConfig');
    });

    it('positive control: prints no such note once the global list trusts the project', async () => {
      const output = await doctorWith(`trust:\n  projectConfig: [${JSON.stringify(join(root, 'project'))}]\n`);

      expect(output).not.toContain('`runners.claude.dangerouslySkipPermissions`');
    });
  });

  describe("the executor's command grants (FR-003, FR-004, FR-021)", () => {
    let root: string;
    const GRANTLESS = 'granted no tool beyond editing files';

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'af-doctor-grants-'));
      await mkdir(join(root, 'project', '.agent-flow'), { recursive: true });
      await writeFile(
        join(root, 'project', '.agent-flow', 'config.yaml'),
        [
          'project:',
          '  name: demo',
          '  type: node',
          'commands:',
          '  lint: npm run lint',
          "  test: 'eslint src/**/*.ts'",
          'validationCommands:',
          '  typecheck-deck: npm run typecheck:deck',
          '',
        ].join('\n'),
      );
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /** The real loader and the real `diagnose`, as above, with no process spawned. */
    async function doctorWith(globalYaml: string): Promise<string> {
      const globalConfigPath = join(root, 'global.yaml');
      await writeFile(globalConfigPath, globalYaml);

      const real = diagnosticsApp.diagnose;
      vi.spyOn(diagnosticsApp, 'diagnose').mockImplementation((options) =>
        real({
          ...options,
          fs: new InMemoryFileSystem(),
          processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: 'v20.11.0' }),
          host: new FakeHost(),
          promptsDir: '/install/prompts',
          installProbe: false,
        }),
      );

      await runDoctorCommand({}, {
        cwd: join(root, 'project'),
        globalConfigPath,
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      });
      return stdoutChunks.join('');
    }

    it('prints the grants under the write role of a trusted project, and no grantless note', async () => {
      const output = await doctorWith(`trust:\n  projectConfig: [${JSON.stringify(join(root, 'project'))}]\n`);
      const grants = output.split('\n').find((line) => line.includes('may run: '));

      expect(grants).toContain('npm run lint');
      expect(grants).toContain('npm run typecheck:deck');
      expect(output).not.toContain(GRANTLESS);
      expect(output).not.toContain(en.doctor.projectCommandsNotGranted);
    });

    it('prints no grant for the same project untrusted, the trust note and the grantless note', async () => {
      const output = await doctorWith('parallelism:\n  maxTasks: 1\n');

      expect(output).not.toContain('may run: ');
      expect(output).toContain(en.doctor.projectCommandsNotGranted);
      expect(output).toContain('trust.projectConfig');
      expect(output).toContain(GRANTLESS);
    });

    it('names the excluded line with its id and reason', async () => {
      const output = await doctorWith('parallelism:\n  maxTasks: 1\n');

      expect(output).toContain(
        en.doctor.declaredCommandNotGranted('test', 'eslint src/**/*.ts', en.doctor.grantExcludedWildcard),
      );
    });
  });
});
