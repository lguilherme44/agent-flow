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
