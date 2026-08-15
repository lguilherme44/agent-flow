import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFeatureCommand } from '../../src/cli/feature.js';
import { ExitCode } from '../../src/cli/exit-codes.js';

describe('CLI feature workflow validation & high-risk protection', () => {
  let tempDir: string;
  let globalConfigFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'af-feature-test-'));
    globalConfigFile = join(tempDir, 'global-config.yaml');
    await mkdir(join(tempDir, '.git'), { recursive: true });
    await writeFile(
      globalConfigFile,
      'runners:\n  claude:\n    type: claude-code-cli\nroles:\n  planner:\n    runner: claude\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects invalid --workflow string with CONFIG_ERROR before planning', async () => {
    const code = await runFeatureCommand(
      'some feature request',
      { workflow: 'banana' },
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
  });
});
