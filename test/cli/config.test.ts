import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runConfigGetCommand,
  runConfigSetCommand,
  runConfigListCommand,
} from '../../src/cli/config.js';
import { ExitCode } from '../../src/cli/exit-codes.js';

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
