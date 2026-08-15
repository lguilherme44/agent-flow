import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';
import { runFeatureCommand } from '../../src/cli/feature.js';
import { runStatusCommand } from '../../src/cli/status.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { StateStore } from '../../src/app/state-store.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { SystemClock } from '../../src/adapters/clock/system-clock.js';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

describe('lifecycle & preflight consistency (M2.1-A)', () => {
  let repo: TempRepo | undefined;

  afterEach(() => {
    repo?.cleanup();
  });

  function setupAgentFlowConfig(temp: TempRepo) {
    const configDir = join(temp.dir, '.agent-flow');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.yaml'),
      'project:\n' +
        '  name: test-repo\n' +
        '  type: node\n' +
        'git:\n' +
        '  useWorktrees: true\n' +
        'parallelism:\n' +
        '  maxTasks: 1\n' +
        'runners:\n' +
        '  mock:\n' +
        '    type: claude-code-cli\n' +
        'roles:\n' +
        '  architect:\n' +
        '    runner: mock\n' +
        '    effort: medium\n' +
        '  sdd:\n' +
        '    runner: mock\n' +
        '    effort: medium\n' +
        '  planner:\n' +
        '    runner: mock\n' +
        '    effort: medium\n' +
        '  planReviewer:\n' +
        '    runner: mock\n' +
        '    effort: medium\n' +
        '  executors:\n' +
        '    trivial:\n' +
        '      runner: mock\n' +
        '      effort: low\n' +
        '    normal:\n' +
        '      runner: mock\n' +
        '      effort: medium\n' +
        '    complex:\n' +
        '      runner: mock\n' +
        '      effort: high\n' +
        '  verification:\n' +
        '    runner: mock\n' +
        '    effort: low\n' +
        '  finalReviewer:\n' +
        '    runner: mock\n' +
        '    effort: medium\n',
    );
  }

  const defaultGlobals = (cwd: string) => ({
    cwd,
    globalConfigPath: join(cwd, '.agent-flow-global.yaml'),
    strict: false,
    verbose: false,
    json: false,
    dryRun: false,
  });

  it('refuses preflight on dirty working tree with zero runs created', async () => {
    repo = await makeTempRepoWithCommit();
    setupAgentFlowConfig(repo);
    repo.write('.gitignore', '.agent-flow/runs/\n.agent-flow/cache/\n.agent-flow/current-run\n');
    repo.commitAll('commit config and gitignore');

    // Make working tree dirty
    repo.write('dirty-change.ts', 'export const x = 1;\n');

    let stderr = '';
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const exitCode = await runFeatureCommand(
        'add dark mode',
        {},
        defaultGlobals(repo.dir),
      );

      expect(exitCode).toBe(ExitCode.EXECUTION_ERROR);
      expect(stderr).toContain('working_tree_dirty');
      expect(stderr).toContain('uncommitted changes');
      expect(stderr).toContain('Commit or stash');

      // Assert NO ghost run created
      const store = new StateStore({
        fs: new NodeFileSystem(),
        clock: new SystemClock(),
        projectDir: repo.dir,
      });

      const runs = await store.listRunIds();
      expect(runs).toHaveLength(0);
      expect(await store.loadCurrentRun()).toBeNull();
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  it('refuses preflight when .agent-flow state paths are not ignored', async () => {
    repo = await makeTempRepoWithCommit();
    setupAgentFlowConfig(repo);
    repo.commitAll('commit config without gitignore');

    let stderr = '';
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const exitCode = await runFeatureCommand(
        'add dark mode',
        {},
        defaultGlobals(repo.dir),
      );

      expect(exitCode).toBe(ExitCode.EXECUTION_ERROR);
      expect(stderr).toContain('agent_flow_state_not_ignored');

      // Assert NO ghost run created
      const store = new StateStore({
        fs: new NodeFileSystem(),
        clock: new SystemClock(),
        projectDir: repo.dir,
      });

      const runs = await store.listRunIds();
      expect(runs).toHaveLength(0);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  it('status command reports no active run when preflight refuses', async () => {
    repo = await makeTempRepoWithCommit();
    setupAgentFlowConfig(repo);

    let stdout = '';
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const exitCode = await runStatusCommand(defaultGlobals(repo.dir));

      expect(exitCode).toBe(ExitCode.OK);
      expect(stdout).toContain('No active run');
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });
});
