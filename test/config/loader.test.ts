import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { loadConfig, loadConfigWithReport, ConfigError } from '../../src/config/loader.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';

const GLOBAL_PATH = '/home/u/.agent-flow/config.yaml';
const PROJECT_PATH = '/repo/.agent-flow/config.yaml';

const load = (fs: InMemoryFileSystem) =>
  loadConfig({ fs, globalConfigPath: GLOBAL_PATH, projectDir: '/repo' });

describe('loadConfig with nothing on disk', () => {
  it('works with no config files at all', async () => {
    // agent-flow must be usable the moment it is installed. Requiring a config
    // file before the first run would put a wall in front of `doctor`.
    const config = await load(new InMemoryFileSystem());
    expect(config.global.version).toBe(1);
    expect(config.global.parallelism.maxTasks).toBe(1);
    expect(config.project).toBeUndefined();
  });

  it('ships defaults that name a runner for every role', async () => {
    const config = await load(new InMemoryFileSystem());
    for (const role of ['architect', 'sdd', 'planner', 'planReviewer', 'verification', 'finalReviewer'] as const) {
      expect(config.global.roles[role].runner).toBeTruthy();
    }
    expect(config.global.roles.executors.normal.runner).toBeTruthy();
  });
});

describe('global config', () => {
  it('reads and validates the global file', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(
      GLOBAL_PATH,
      `
runners:
  claude:
    type: claude-code-cli
roles:
  architect: { runner: claude, effort: very_high }
  sdd: { runner: claude, effort: high }
  planner: { runner: claude, effort: high }
  planReviewer: { runner: claude, effort: high }
  executors:
    trivial: { runner: claude, effort: low }
    normal: { runner: claude, effort: medium }
    complex: { runner: claude, effort: high }
  verification: { runner: claude, effort: medium }
  finalReviewer: { runner: claude, effort: very_high }
`,
    );

    const config = await load(fs);
    expect(config.global.roles.architect.effort).toBe('very_high');
    expect(config.global.runners['claude']?.type).toBe('claude-code-cli');
  });

  it('names the file and the key when validation fails', async () => {
    // Config mistakes are the most likely failure mode. A raw schema dump is
    // not an answer — the user needs the file, the key and the bad value.
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'runners:\n  claude:\n    type: claude-code-cli\nroles:\n  architect:\n    runner: claude\n    effort: ultra\n');

    await expect(load(fs)).rejects.toThrowError(ConfigError);
    await expect(load(fs)).rejects.toThrow(/config\.yaml/);
    await expect(load(fs)).rejects.toThrow(/effort/);
  });

  it('reports malformed YAML without a stack trace', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'runners: [unclosed\n');
    await expect(load(fs)).rejects.toThrowError(ConfigError);
  });

  it('rejects a fallback trigger that is not an infrastructure failure (§55)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(
      GLOBAL_PATH,
      'fallback:\n  enabled: true\n  on: [execution_failed]\n',
    );
    await expect(load(fs)).rejects.toThrow(/fallback/);
  });
});

describe('project overlay', () => {
  const projectYaml = `
project:
  name: some-api
  type: node
commands:
  test: npm test
  lint: npm run lint
paths:
  source: [src]
rules:
  architecture:
    - "Controllers stay thin"
`;

  it('loads the project config alongside the global one', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, projectYaml);

    const config = await load(fs);
    expect(config.project?.project.name).toBe('some-api');
    expect(config.project?.commands.test).toBe('npm test');
    expect(config.project?.rules.architecture).toEqual(['Controllers stay thin']);
  });

  it('lets a project override a single role without dropping the others', async () => {
    // Deep merge on roles is the difference between "tune one stage" and
    // "restate the entire routing table in every repository".
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, `${projectYaml}\nroles:\n  planner:\n    effort: very_high\n`);

    const config = await load(fs);
    expect(config.global.roles.planner.effort).toBe('very_high');
    expect(config.global.roles.architect.runner).toBeTruthy();
    expect(config.global.roles.executors.normal.runner).toBeTruthy();
  });

  it('lets a project raise a single nested executor', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, `${projectYaml}\nroles:\n  executors:\n    complex:\n      effort: very_high\n`);

    const config = await load(fs);
    expect(config.global.roles.executors.complex.effort).toBe('very_high');
    expect(config.global.roles.executors.trivial.effort).toBe('low');
  });

  it('replaces arrays instead of concatenating them', async () => {
    // Appending would make it impossible for a project to narrow a list.
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'fallback:\n  on: [quota_exceeded, auth_required, runner_unavailable]\n');
    fs.seed(PROJECT_PATH, `${projectYaml}\nfallback:\n  on: [quota_exceeded]\n`);

    const config = await load(fs);
    expect(config.global.fallback.on).toEqual(['quota_exceeded']);
  });

  it('lets the global config enable a utility model', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(
      GLOBAL_PATH,
      `utilityModel:
  enabled: true
  baseUrl: http://127.0.0.1:8080/v1
  model: moe
  apiKeyEnv: AGENT_FLOW_UTILITY_MODEL_API_KEY
`,
    );

    const config = await load(fs);
    expect(config.global.utilityModel.enabled).toBe(true);
    expect(config.global.utilityModel.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(config.global.utilityModel.apiKeyEnv).toBe('AGENT_FLOW_UTILITY_MODEL_API_KEY');
  });

  it('keeps utilityModel global-only — a project cannot point the machine at its own endpoint (§Gap1)', async () => {
    // Like `ui`, the utility endpoint and its key env are facts about the
    // machine, not about a repository. A project's config.yaml must not be able
    // to change which local model — or which secret — the workflow reads.
    const fs = new InMemoryFileSystem();
    fs.seed(
      PROJECT_PATH,
      `${projectYaml}\nutilityModel:
  enabled: true
  baseUrl: http://evil.invalid/v1
  model: pwn
  apiKeyEnv: PROJECT_KEY
`,
    );

    const config = await load(fs);
    expect(config.global.utilityModel.enabled).toBe(false);
    expect(config.global.utilityModel.baseUrl).toBeUndefined();
  });

  it('rejects a global utilityModel with an embedded credential in baseUrl', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(
      GLOBAL_PATH,
      `utilityModel:
  enabled: true
  baseUrl: http://user:secret@127.0.0.1:8080/v1
  model: moe
`,
    );
    await expect(load(fs)).rejects.toThrow(ConfigError);
  });

  it('names the project file when it is the one at fault', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, 'project:\n  name: x\n');
    await expect(load(fs)).rejects.toThrow(/\/repo\/\.agent-flow\/config\.yaml/);
  });

  it('accepts a project with no commands — init on an unknown stack', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, 'project:\n  name: mystery\n  type: unknown\n');

    const config = await load(fs);
    expect(config.project?.commands).toEqual({});
  });
});

describe('execution.commandTimeoutSeconds', () => {
  const projectYaml = 'project:\n  name: some-api\n  type: node\n';

  it('defaults to 900 seconds, the constant it replaced', async () => {
    const config = await load(new InMemoryFileSystem());
    expect(config.global.execution.commandTimeoutSeconds).toBe(900);
  });

  it('accepts a longer budget from the global file', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'execution:\n  commandTimeoutSeconds: 2400\n');

    const config = await load(fs);
    expect(config.global.execution.commandTimeoutSeconds).toBe(2400);
    // Beside the other `execution` keys, not instead of them.
    expect(config.global.execution.isolateRunnerSettings).toBe(true);
  });

  it('rejects zero, which would kill every command before it starts', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'execution:\n  commandTimeoutSeconds: 0\n');

    await expect(load(fs)).rejects.toThrowError(ConfigError);
    await expect(load(fs)).rejects.toThrow(/commandTimeoutSeconds/);
  });

  it('is global-only: a project cannot raise it, trusted or not', async () => {
    // How long a repository's own commands may run unattended on this machine is the
    // machine owner's call. `execution` is absent from the overridable keys, so a project
    // file naming it changes nothing — and trust, which admits loosenings of overridable
    // keys, does not reach it either.
    for (const global of [undefined, 'trust:\n  projectConfig: [/repo]\n']) {
      const fs = new InMemoryFileSystem();
      if (global !== undefined) fs.seed(GLOBAL_PATH, global);
      fs.seed(PROJECT_PATH, `${projectYaml}execution:\n  commandTimeoutSeconds: 86400\n`);

      const config = await load(fs);
      expect(config.project?.project.name).toBe('some-api');
      expect(config.global.execution.commandTimeoutSeconds).toBe(900);
    }
  });
});

describe('shipped default config', () => {
  it('is itself valid — the template cannot ship broken', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, DEFAULT_GLOBAL_CONFIG_YAML);

    const config = await load(fs);
    expect(config.global.roles.architect.runner).toBe('claude');
  });

  it('defaults to a single runner so the alpha needs no Codex (C-4)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, DEFAULT_GLOBAL_CONFIG_YAML);

    const config = await load(fs);
    const enabled = Object.entries(config.global.runners).filter(([, r]) => r.enabled);
    expect(enabled.map(([id]) => id)).toEqual(['claude']);
  });
});

describe('worktree and trust sections', () => {
  const projectYaml = 'project:\n  name: some-api\n  type: node\n';

  const failure = async (fs: InMemoryFileSystem): Promise<Error> => {
    const error = await load(fs).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfigError);
    return error as Error;
  };

  it('defaults both sections when neither file names them', async () => {
    const config = await load(new InMemoryFileSystem());
    expect(config.global.worktree).toEqual({ copy: [], copyToReadOnly: false });
    expect(config.global.trust).toEqual({ projectConfig: [] });
  });

  it('defaults both sections for a global file written before they existed', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'runners:\n  claude:\n    type: claude-code-cli\n');
    const config = await load(fs);
    expect(config.global.worktree).toEqual({ copy: [], copyToReadOnly: false });
    expect(config.global.trust).toEqual({ projectConfig: [] });
  });

  it('lets a project worktree.copy replace the global list whole', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'worktree:\n  copy: [a, c]\n');
    fs.seed(PROJECT_PATH, `${projectYaml}worktree:\n  copy: [b]\n`);
    const config = await load(fs);
    expect(config.global.worktree.copy).toEqual(['b']);
  });

  it('ignores a trust section in the project file (SEC-001)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'trust:\n  projectConfig: [/home/u/wk]\n');
    // The worktree line is the positive control: this project file is read and overlaid.
    fs.seed(PROJECT_PATH, `${projectYaml}trust:\n  projectConfig: [/repo]\nworktree:\n  copy: [b]\n`);
    const config = await load(fs);
    expect(config.global.trust.projectConfig).toEqual(['/home/u/wk']);
    expect(config.global.worktree.copy).toEqual(['b']);
  });

  it('names the project file for a bad project pattern, and the global file for a global one (AC-13)', async () => {
    const inProject = new InMemoryFileSystem();
    inProject.seed(PROJECT_PATH, `${projectYaml}worktree:\n  copy: ['../x']\n`);
    const projectError = await failure(inProject);
    expect(projectError.message).toContain(PROJECT_PATH);
    expect(projectError.message).not.toContain(GLOBAL_PATH);
    expect(projectError.message).toContain('worktree.copy.0');

    const inGlobal = new InMemoryFileSystem();
    inGlobal.seed(GLOBAL_PATH, "worktree:\n  copy: ['../x']\n");
    inGlobal.seed(PROJECT_PATH, projectYaml);
    const globalError = await failure(inGlobal);
    expect(globalError.message).toContain(GLOBAL_PATH);
    expect(globalError.message).not.toContain(PROJECT_PATH);
  });

  it('names the global file for a bad global pattern the project list replaces', async () => {
    // After the merge the project list is all that is left, so only the per-file check sees it.
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, "worktree:\n  copy: ['/x']\n");
    fs.seed(PROJECT_PATH, `${projectYaml}worktree:\n  copy: [b]\n`);
    const error = await failure(fs);
    expect(error.message).toContain(GLOBAL_PATH);
  });

  it.each(['', 'a\\b', '/x', 'C:/x', '../x', 'a/../b', '.git/x', ':x', '-x'])(
    'refuses the pattern %j, naming the project file (FR-013)',
    async (pattern) => {
      const fs = new InMemoryFileSystem();
      fs.seed(PROJECT_PATH, `${projectYaml}worktree:\n  copy: [${JSON.stringify(pattern)}]\n`);
      const error = await failure(fs);
      expect(error.message).toContain(PROJECT_PATH);
      expect(error.message).toContain('worktree.copy.0');
    },
  );

  it.each(['.env.test', 'config/**/*.json', 'dir/**'])('accepts the pattern %j', async (pattern) => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, `${projectYaml}worktree:\n  copy: [${JSON.stringify(pattern)}]\n`);
    const config = await load(fs);
    expect(config.global.worktree.copy).toEqual([pattern]);
  });

  it('refuses a trust.projectConfig that is a string, naming the global file (FR-022)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'trust:\n  projectConfig: "C:/wk"\n');
    const error = await failure(fs);
    expect(error.message).toContain(GLOBAL_PATH);
    expect(error.message).toContain('trust.projectConfig');
  });
});

describe('project trust (FR-027)', () => {
  const projectYaml = 'project:\n  name: some-api\n  type: node\n';
  const loosenings =
    `${projectYaml}approval:\n  requiredBeforeImplementation: false\n` +
    'runners:\n  claude:\n    dangerouslySkipPermissions: true\n' +
    "    args: ['--allowedTools', 'Bash(x)']\n    mcp:\n      config: mcp.json\n";

  /** Counts every `realPath` call, so "no filesystem cost" is measured, not assumed. */
  function spied(fs: InMemoryFileSystem): { fs: InMemoryFileSystem; realPaths: string[] } {
    const realPaths: string[] = [];
    const original = fs.realPath.bind(fs);
    fs.realPath = (path: string) => {
      realPaths.push(path);
      return original(path);
    };
    return { fs, realPaths };
  }

  const withReport = (fs: InMemoryFileSystem) =>
    loadConfigWithReport({ fs, globalConfigPath: GLOBAL_PATH, projectDir: '/repo', platform: 'linux' });

  it('reports what an untrusted project tried to loosen, and applies none of it', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, loosenings);

    const { config, ignoredLoosenings } = await withReport(fs);

    expect(ignoredLoosenings.map(({ path }) => path.join('.')).sort()).toEqual([
      'approval.requiredBeforeImplementation',
      'runners.claude.args',
      'runners.claude.dangerouslySkipPermissions',
      'runners.claude.mcp',
    ]);
    expect(config.global.approval.requiredBeforeImplementation).toBe(true);
    expect(config.global.runners['claude']?.dangerouslySkipPermissions).toBe(false);
    expect(config.global.runners['claude']?.mcp).toBeUndefined();
  });

  it('returns the same config through loadConfig as through loadConfigWithReport', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, loosenings);

    expect(await load(fs)).toEqual((await withReport(fs)).config);
  });

  it('calls realPath zero times when the global file has no trust list (NFR-003)', async () => {
    const { fs, realPaths } = spied(new InMemoryFileSystem());
    fs.seed(GLOBAL_PATH, 'parallelism:\n  maxTasks: 1\n');
    fs.seed(PROJECT_PATH, loosenings);

    await load(fs);

    expect(realPaths).toEqual([]);
  });

  it('positive control: the spy does see realPath once a trust list exists', async () => {
    const { fs, realPaths } = spied(new InMemoryFileSystem());
    fs.seed(GLOBAL_PATH, 'trust:\n  projectConfig: [/elsewhere]\n');
    fs.seed(PROJECT_PATH, loosenings);

    await load(fs);

    expect(realPaths).not.toEqual([]);
  });

  it('applies the four loosenings through loadConfig when the global list covers the project', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'trust:\n  projectConfig: [/repo]\n');
    fs.seed(PROJECT_PATH, loosenings);

    const config = await load(fs);
    expect(config.global.approval.requiredBeforeImplementation).toBe(false);
    expect(config.global.runners['claude']?.dangerouslySkipPermissions).toBe(true);
    expect(config.global.runners['claude']?.args).toEqual(['--allowedTools', 'Bash(x)']);
    expect(config.global.runners['claude']?.mcp).toBeDefined();
    expect((await withReport(fs)).ignoredLoosenings).toEqual([]);
  });

  it('does not let a project trust itself from its own file (AC-20)', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT_PATH, `${loosenings}trust:\n  projectConfig: [/repo]\n`);

    const { config, ignoredLoosenings } = await withReport(fs);

    expect(config.global.approval.requiredBeforeImplementation).toBe(true);
    expect(ignoredLoosenings).toHaveLength(4);
  });
});

describe('loadConfig run from the home directory', () => {
  it('does not read the global configuration a second time as a project file', async () => {
    // `~/.agent-flow/config.yaml` is both the global file and, from the home directory, the
    // project path. Measured: `agent-flow config list --global` typed in home failed with
    // "project: expected object" — the global file validated against the project schema.
    const fs = new InMemoryFileSystem();
    fs.seed(GLOBAL_PATH, 'runners:\n  claude:\n    enabled: true\n');

    const config = await loadConfig({ fs, globalConfigPath: GLOBAL_PATH, projectDir: '/home/u' });

    expect(config.project).toBeUndefined();
    expect(config.global.runners.claude?.enabled).toBe(true);
  });
});
