import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runConfigGetCommand,
  runConfigSetCommand,
  runConfigListCommand,
  runConfigUnsetCommand,
} from '../../src/cli/config.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { main } from '../../src/cli/index.js';

describe('CLI config get / set / list commands', () => {
  let tempDir: string;
  let globalConfigFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'af-config-test-'));
    globalConfigFile = join(tempDir, 'global-config.yaml');
    await writeFile(
      globalConfigFile,
      'runners:\n  claude:\n    type: claude-code-cli\nroles:\n  planner:\n    runner: claude\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('gets a config value from global configuration', async () => {
    const code = await runConfigGetCommand(
      'roles.planner.runner',
      { global: true },
      {
        cwd: tempDir,
        globalConfigPath: globalConfigFile,
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      },
    );
    expect(code).toBe(ExitCode.OK);
  });

  it('sets a config value preserving YAML file integrity', async () => {
    const code = await runConfigSetCommand(
      'git.useWorktrees',
      'true',
      { global: true },
      {
        cwd: tempDir,
        globalConfigPath: globalConfigFile,
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      },
    );
    expect(code).toBe(ExitCode.OK);

    const updated = await readFile(globalConfigFile, 'utf8');
    expect(updated).toContain('useWorktrees: true');
  });

  it('uses the shared editor to reject a global-only project setting without mutation', async () => {
    const projectFile = join(tempDir, '.agent-flow', 'config.yaml');
    await mkdir(join(tempDir, '.agent-flow'), { recursive: true });
    await writeFile(projectFile, 'project:\n  name: demo\n  type: node\n', 'utf8');
    const before = await readFile(projectFile, 'utf8');

    const code = await runConfigSetCommand(
      'ui.workspaceDepth',
      '4',
      {},
      {
        cwd: tempDir,
        globalConfigPath: globalConfigFile,
        verbose: false,
        dryRun: false,
        json: false,
        strict: false,
      },
    );

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(await readFile(projectFile, 'utf8')).toBe(before);
  });

  it('rejects an invalid value through the shared editor without mutating global config', async () => {
    const before = await readFile(globalConfigFile, 'utf8');

    const code = await runConfigSetCommand(
      'parallelism.maxTasks',
      '0',
      { global: true },
      {
        cwd: tempDir,
        globalConfigPath: globalConfigFile,
        verbose: false,
        dryRun: false,
        json: true,
        strict: false,
      },
    );

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(await readFile(globalConfigFile, 'utf8')).toBe(before);
  });

  it('unsets a project override through the shared editor so it inherits global configuration', async () => {
    const projectFile = join(tempDir, '.agent-flow', 'config.yaml');
    await mkdir(join(tempDir, '.agent-flow'), { recursive: true });
    await writeFile(projectFile, 'project:\n  name: demo\n  type: node\nparallelism:\n  maxTasks: 4\n', 'utf8');

    const code = await runConfigUnsetCommand('parallelism.maxTasks', {}, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: false, strict: false,
    });

    expect(code).toBe(ExitCode.OK);
    expect(await readFile(projectFile, 'utf8')).not.toContain('maxTasks: 4');
  });

  it('rejects unset of a global-only project field without mutation', async () => {
    const projectFile = join(tempDir, '.agent-flow', 'config.yaml');
    await mkdir(join(tempDir, '.agent-flow'), { recursive: true });
    await writeFile(projectFile, 'project:\n  name: demo\n  type: node\n', 'utf8');
    const before = await readFile(projectFile, 'utf8');

    const code = await runConfigUnsetCommand('ui.workspaceDepth', {}, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: true, strict: false,
    });

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(await readFile(projectFile, 'utf8')).toBe(before);
  });

  it('exposes inherit as a public CLI alias with the same editor behavior', async () => {
    const projectFile = join(tempDir, '.agent-flow', 'config.yaml');
    await mkdir(join(tempDir, '.agent-flow'), { recursive: true });
    await writeFile(projectFile, 'project:\n  name: demo\n  type: node\nparallelism:\n  maxTasks: 5\n', 'utf8');

    expect(await main(['node', 'agent-flow', '--cwd', tempDir, '--config', globalConfigFile, 'config', 'inherit', 'parallelism.maxTasks'])).toBe(ExitCode.OK);
    expect(await readFile(projectFile, 'utf8')).not.toContain('maxTasks: 5');
  });

  it('reports missing reads and accepts typed JSON list values', async () => {
    const missing = await runConfigGetCommand('does.not.exist', { global: true }, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: false, strict: false,
    });
    const changed = await runConfigSetCommand('fallback.on', '["quota_exceeded","auth_required"]', { global: true }, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: false, strict: false,
    });

    expect(missing).toBe(ExitCode.CONFIG_ERROR);
    expect(changed).toBe(ExitCode.OK);
    expect(await readFile(globalConfigFile, 'utf8')).toContain('auth_required');
  });

  it('renders object reads, YAML lists, and plain string edits through public output paths', async () => {
    const objectRead = await runConfigGetCommand('runners', { global: true }, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: false, strict: false,
    });
    const yamlList = await runConfigListCommand({ global: true }, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: false, strict: false,
    });
    const stringEdit = await runConfigSetCommand('roles.planner.model', 'local-model', { global: true }, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: false, strict: false,
    });

    expect([objectRead, yamlList, stringEdit]).toEqual([ExitCode.OK, ExitCode.OK, ExitCode.OK]);
    expect(await readFile(globalConfigFile, 'utf8')).toContain('model: local-model');
  });

  it('returns a safe error when the shared editor cannot parse the source', async () => {
    await writeFile(globalConfigFile, 'runners: [broken\n', 'utf8');
    const code = await runConfigSetCommand('parallelism.maxTasks', '2', { global: true }, {
      cwd: tempDir, globalConfigPath: globalConfigFile, verbose: false, dryRun: false, json: true, strict: false,
    });
    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(await readFile(globalConfigFile, 'utf8')).toBe('runners: [broken\n');
  });

  it('lists effective configuration', async () => {
    const code = await runConfigListCommand(
      { global: true },
      {
        cwd: tempDir,
        globalConfigPath: globalConfigFile,
        verbose: false,
        dryRun: false,
        json: true,
        strict: false,
      },
    );
    expect(code).toBe(ExitCode.OK);
  });
});
