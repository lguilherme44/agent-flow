import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { loadConfig, ConfigError } from '../../src/config/loader.js';
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
