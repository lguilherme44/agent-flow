import { describe, expect, it } from 'vitest';
import { diagnose } from '../../src/app/diagnostics.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { FakeHost } from '../fakes/fake-host.js';
import { loadConfig, loadConfigWithReport } from '../../src/config/loader.js';
import { en, ptBR, type Phrases } from '../../src/core/phrases/index.js';
import type { ProcessSpawnOptions } from '../../src/ports/index.js';

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

describe('the notes about loosenings an untrusted project was refused (FR-026)', () => {
  const LOOSENING_PROJECT = [
    'project:',
    '  name: demo',
    '  type: node',
    'commands: {}',
    'approval:',
    '  requiredBeforeImplementation: false',
    'runners:',
    '  claude:',
    '    dangerouslySkipPermissions: true',
    "    args: ['--allowedTools', 'Bash(x)']",
    '    mcp:',
    '      config: mcp.json',
    '',
  ].join('\n');
  const PATHS = [
    'approval.requiredBeforeImplementation',
    'runners.claude.dangerouslySkipPermissions',
    'runners.claude.args',
    'runners.claude.mcp',
  ];

  async function diagnosed(global: string, say?: Phrases) {
    const fs = new InMemoryFileSystem();
    fs.seed('/repo/.agent-flow/config.yaml', LOOSENING_PROJECT);
    fs.seed('/home/.agent-flow/config.yaml', global);
    const base = await createOptions();
    const { config, ignoredLoosenings } = await loadConfigWithReport({
      fs,
      globalConfigPath: '/home/.agent-flow/config.yaml',
      projectDir: '/repo',
      platform: 'linux',
    });
    return diagnose({ ...base, config, ignoredLoosenings, ...(say === undefined ? {} : { say }) });
  }

  const loosenings = (notes: readonly string[]) => notes.filter((note) => note.includes('trust.projectConfig'));

  it('emits one note per ignored loosening, naming its path and the switch, in en and pt-BR (AC-17)', async () => {
    for (const say of [en, ptBR]) {
      const notes = loosenings((await diagnosed(GLOBAL_CONFIG, say)).notes);

      expect(notes).toHaveLength(4);
      for (const path of PATHS) {
        expect(notes.filter((note) => note.includes(`\`${path}\``))).toHaveLength(1);
      }
    }
  });

  it("says the project is not trusted, in the reader's language", async () => {
    const [english] = loosenings((await diagnosed(GLOBAL_CONFIG, en)).notes);
    const [portuguese] = loosenings((await diagnosed(GLOBAL_CONFIG, ptBR)).notes);

    expect(english).toContain('not trusted');
    expect(portuguese).toContain('não é confiável');
  });

  it('emits none for a project the global list trusts', async () => {
    const trusted = await diagnosed(`${GLOBAL_CONFIG}trust:\n  projectConfig: [/repo]\n`);

    expect(loosenings(trusted.notes)).toEqual([]);
  });

  it('emits none when nothing was ignored, and none when the caller passes no report', async () => {
    const options = await createOptions();

    expect(loosenings((await diagnose({ ...options, ignoredLoosenings: [] })).notes)).toEqual([]);
    expect(loosenings((await diagnose(options)).notes)).toEqual([]);
  });
});

describe('the notes about worktree.copy patterns that expose a .env file (FR-018)', () => {
  const isListing = (options: ProcessSpawnOptions) => options.command === 'git' && options.args.includes('ls-files');

  /**
   * `listing` answers each `ls-files` call with the files Git would list for the one
   * pattern it names, or `failed` to have Git exit 128. Every other process answers the way
   * `createOptions` has it answer.
   */
  async function diagnosed(
    worktree: string | undefined,
    listing: (pattern: string) => readonly string[] | 'failed' = () => [],
    say?: Phrases,
  ) {
    const fs = new InMemoryFileSystem();
    fs.seed('/repo/.agent-flow/config.yaml', PROJECT_CONFIG);
    fs.seed('/home/.agent-flow/config.yaml', worktree === undefined ? GLOBAL_CONFIG : `${GLOBAL_CONFIG}worktree:\n${worktree}`);
    const base = await createOptions();
    const config = await loadConfig({ fs, globalConfigPath: '/home/.agent-flow/config.yaml', projectDir: '/repo' });

    const processRunner = new FakeProcessRunner().always((options) => {
      if (!isListing(options)) return { exitCode: 0, stdout: 'v20.11.0' };
      const pathspec = options.args.at(-1) ?? '';
      const answer = listing(pathspec.replace(/^:\(glob\)/, ''));
      if (answer === 'failed') return { exitCode: 128, stderr: 'fatal: listing failed' };
      return { exitCode: 0, stdout: answer.map((path) => `${path}\0`).join('') };
    });
    const diagnosis = await diagnose({ ...base, config, processRunner, ...(say === undefined ? {} : { say }) });
    return { diagnosis, listings: processRunner.calls.filter(isListing) };
  }

  const envNotes = (notes: readonly string[]) => notes.filter((note) => note.includes('`worktree.copy`'));

  it('warns for a pattern that names .env even though no such file exists (AC-16)', async () => {
    const { diagnosis } = await diagnosed("  copy: ['.env.test']\n");

    expect(envNotes(diagnosis.notes)).toEqual([en.doctor.worktreeCopyExposesEnv('.env.test')]);
  });

  it('does not warn for *.yaml.example when the listing returns app.yaml.example (AC-16)', async () => {
    const { diagnosis, listings } = await diagnosed("  copy: ['*.yaml.example']\n", () => ['app.yaml.example']);

    expect(envNotes(diagnosis.notes)).toEqual([]);
    // Positive control: the listing was asked, so the silence is its answer and not a skip.
    expect(listings).toHaveLength(1);
  });

  it('warns by rule (b) when a pattern that names no .env matches one today', async () => {
    const { diagnosis } = await diagnosed("  copy: ['config/*']\n", () => ['config/app.json', 'config/.env.local']);

    expect(envNotes(diagnosis.notes)).toEqual([en.doctor.worktreeCopyExposesEnv('config/*')]);
  });

  it('says rule (b) could not be checked for the pattern whose listing failed, and only that one', async () => {
    const { diagnosis } = await diagnosed("  copy: ['*.json', '*.yaml.example']\n", (pattern) =>
      pattern === '*.json' ? 'failed' : ['app.yaml.example'],
    );

    expect(envNotes(diagnosis.notes)).toEqual([en.doctor.worktreeCopyEnvUnchecked('*.json')]);
  });

  it('emits exactly one warning for a pattern both rules match', async () => {
    const { diagnosis } = await diagnosed("  copy: ['.env.test']\n", () => ['.env.test']);

    expect(envNotes(diagnosis.notes)).toEqual([en.doctor.worktreeCopyExposesEnv('.env.test')]);
  });

  it('asks Git once per pattern, naming only that pattern', async () => {
    const { listings } = await diagnosed("  copy: ['.env.test', '*.json']\n");

    expect(listings.map((call) => call.args.at(-1))).toEqual([':(glob).env.test', ':(glob)*.json']);
  });

  it('issues no ls-files call and emits no note when worktree.copy is absent or empty', async () => {
    for (const worktree of [undefined, '  copy: []\n']) {
      const { diagnosis, listings } = await diagnosed(worktree);

      expect(listings).toEqual([]);
      expect(envNotes(diagnosis.notes)).toEqual([]);
    }
  });

  it("names the pattern in the reader's language", async () => {
    const warned = await diagnosed("  copy: ['.env.test']\n", () => [], ptBR);
    const unchecked = await diagnosed("  copy: ['*.json']\n", () => 'failed', ptBR);

    expect(envNotes(warned.diagnosis.notes)).toEqual([ptBR.doctor.worktreeCopyExposesEnv('.env.test')]);
    expect(envNotes(unchecked.diagnosis.notes)).toEqual([ptBR.doctor.worktreeCopyEnvUnchecked('*.json')]);
    expect(ptBR.doctor.worktreeCopyExposesEnv('.env.test')).not.toBe(en.doctor.worktreeCopyExposesEnv('.env.test'));
  });
});
