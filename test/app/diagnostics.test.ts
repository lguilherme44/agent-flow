import { describe, expect, it } from 'vitest';
import { diagnose } from '../../src/app/diagnostics.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { loadConfig } from '../../src/config/loader.js';

const PROJECT_CONFIG = `project:
  name: demo
  type: node
commands: {}
`;

const GLOBAL_CONFIG = `runners:
  claude:
    type: claude-code-cli
roles:
  architect:
    runner: claude
    effort: high
`;

async function createOptions(remoteAccess?: {
  readonly enabled: boolean;
  readonly admittedAddresses: readonly string[];
  readonly liveSessions: number;
}) {
  const fs = new InMemoryFileSystem();
  fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
  fs.seed('/home/.agent-flow/config.yaml', GLOBAL_CONFIG);

  for (const name of [
    'discovery',
    'architecture-impact',
    'sdd',
    'planning',
    'plan-review',
    'code-review',
    'verification',
    'final-review',
  ]) {
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: read-only\noutputFormat: markdown\nrequiredVars: [repositoryMap]\n---\n\n# ${name}\n`,
    );
  }
  fs.seed(
    '/install/prompts/implementation.md',
    '---\npermissions: write\nworkingDirectory: true\noutputFormat: json\nrequiredVars: [repositoryMap]\n---\n\n# implementation\n',
  );

  const config = await loadConfig({
    fs,
    globalConfigPath: '/home/.agent-flow/config.yaml',
    projectDir: '/repo',
  });

  return {
    fs,
    processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: 'v20.11.0' }),
    host: new FakeHost(),
    config,
    projectDir: '/repo',
    promptsDir: '/install/prompts',
    installProbe: false,
    ...(remoteAccess === undefined ? {} : { remoteAccess }),
  };
}

describe('diagnostics remoteAccess projection (FR-023)', () => {
  it('reports remoteAccess as unknown when DiagnoseOptions.remoteAccess is omitted', async () => {
    const options = await createOptions();
    const diagnosis = await diagnose(options);

    expect(diagnosis.remoteAccess).toEqual({ known: false });
  });

  it('reports remoteAccess as known with enabled=true and live facts when options provide it', async () => {
    const options = await createOptions({
      enabled: true,
      admittedAddresses: ['192.168.1.5', '10.0.0.1'],
      liveSessions: 2,
    });
    const diagnosis = await diagnose(options);

    expect(diagnosis.remoteAccess).toEqual({
      known: true,
      enabled: true,
      admittedAddresses: ['192.168.1.5', '10.0.0.1'],
      liveSessions: 2,
    });
  });

  it('reports remoteAccess as known with enabled=false and empty addresses when options provide it', async () => {
    const options = await createOptions({
      enabled: false,
      admittedAddresses: [],
      liveSessions: 0,
    });
    const diagnosis = await diagnose(options);

    expect(diagnosis.remoteAccess).toEqual({
      known: true,
      enabled: false,
      admittedAddresses: [],
      liveSessions: 0,
    });
  });

  it('positive control: omission never produces known: true or enabled facts', async () => {
    const options = await createOptions();
    const diagnosis = await diagnose(options);

    // If options.remoteAccess was guessed or defaulted to known, this control would fail.
    expect(diagnosis.remoteAccess.known).toBe(false);
    expect('enabled' in diagnosis.remoteAccess).toBe(false);
  });
});

describe('the note about an executor that cannot run commands (D-9)', () => {
  async function withExecutorArgs(args: readonly string[]) {
    const fs = new InMemoryFileSystem();
    fs.seed('/repo/.agent-flow/config.yaml', 'project:\n  name: demo\n  type: node\ncommands:\n  test: npm test\n');
    fs.seed('/home/.agent-flow/config.yaml', [
      'runners:',
      '  claude:',
      '    type: claude-code-cli',
      `    args: [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
      'roles:',
      '  architect: { runner: claude }',
      '  executors:',
      '    trivial: { runner: claude }',
      '    normal: { runner: claude }',
      '    complex: { runner: claude }',
      '',
    ].join('\n'));
    const base = await createOptions();
    const config = await loadConfig({ fs, globalConfigPath: '/home/.agent-flow/config.yaml', projectDir: '/repo' });
    return JSON.stringify(await diagnose({ ...base, fs: base.fs, config }));
  }
  const NOTE = 'granted no tool beyond editing files';

  it('reads the grant the way the executor does, whichever spelling the flag has', async () => {
    // It checked the args for `--allowedTools` alone: `--allowed-tools` with a real grant
    // got the note, and a Windows grant naming only `Bash(...)` did not.
    expect(await withExecutorArgs(['--allowed-tools', 'Bash(npm test:*)', 'PowerShell(npm test:*)'])).not.toContain(NOTE);
    expect(await withExecutorArgs([])).toContain(NOTE);
  });
});

const nodeOf = (diagnosis: Awaited<ReturnType<typeof diagnose>>) => diagnosis.tools.find((tool) => tool.name === 'node');

describe('the Node the dashboard runs on', () => {
  /**
   * Measured 23/09/2026: Diagnóstico showed "Node v20.10.0 · abaixo de 20.19" in amber on a
   * dashboard that was being served, at that moment, by Node 22.23.2 — `agent-flow ui`
   * re-runs itself under a newer Node that nvm keeps. The PATH Node is still reported; the
   * verdict now says where the dashboard actually runs.
   */
  it('names the Node the dashboard runs on when the PATH one is below the floor', async () => {
    const options = await createOptions();
    const diagnosis = await diagnose({
      ...options,
      processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: 'v20.10.0' }),
      dashboardNode: () => '22.23.2',
    });

    expect(nodeOf(diagnosis)?.belowFloor).toBe(true);
    expect(nodeOf(diagnosis)?.dashboardNode).toBe('22.23.2');
  });

  it('asks nothing when the PATH Node already meets the floor', async () => {
    let asked = false;
    const diagnosis = await diagnose({
      ...(await createOptions()),
      processRunner: new FakeProcessRunner().always({ exitCode: 0, stdout: 'v22.12.0' }),
      dashboardNode: () => {
        asked = true;
        return '22.23.2';
      },
    });

    expect(nodeOf(diagnosis)?.belowFloor).toBe(false);
    expect(nodeOf(diagnosis)?.dashboardNode).toBeUndefined();
    expect(asked).toBe(false);
  });
});
