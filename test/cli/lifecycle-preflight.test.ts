import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepoWithCommit, type TempRepo } from '../fixtures/temp-repo.js';
import { runFeatureCommand } from '../../src/cli/feature.js';
import { runStatusCommand } from '../../src/cli/status.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { StateStore } from '../../src/app/state-store.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { SystemClock } from '../../src/adapters/clock/system-clock.js';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import type { ExitCodeValue } from '../../src/cli/exit-codes.js';

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

  /**
   * A runner that cannot run without leaving a trace.
   *
   * "0 AgentRunner invocations" is the load-bearing half of C-01, and asserting it by
   * reading the code is not asserting it. So the global configuration — which is *not*
   * `.agent-flow/config.yaml`, and therefore leaves the project uninitialised — points
   * every role at a script whose only job is to create a file. The file's absence is the
   * evidence; its presence would be the milestone failing.
   */
  function setupTracingGlobalConfig(temp: TempRepo): { globalConfigPath: string; sentinel: string } {
    const sentinel = join(temp.home, 'runner-was-invoked');
    const script = join(temp.home, 'tracing-runner.sh');
    writeFileSync(script, `#!/bin/sh\ntouch "${sentinel}"\necho '{}'\n`);
    chmodSync(script, 0o755);

    const globalConfigPath = join(temp.home, 'global.yaml');
    writeFileSync(
      globalConfigPath,
      'runners:\n' +
        '  tracer:\n' +
        '    type: claude-code-cli\n' +
        `    command: ${script}\n` +
        'roles:\n' +
        '  architect:\n' +
        '    runner: tracer\n' +
        '  sdd:\n' +
        '    runner: tracer\n' +
        '  planner:\n' +
        '    runner: tracer\n' +
        '  planReviewer:\n' +
        '    runner: tracer\n' +
        '  executors:\n' +
        '    trivial:\n' +
        '      runner: tracer\n' +
        '    normal:\n' +
        '      runner: tracer\n' +
        '    complex:\n' +
        '      runner: tracer\n' +
        '  verification:\n' +
        '    runner: tracer\n' +
        '  finalReviewer:\n' +
        '    runner: tracer\n',
    );

    return { globalConfigPath, sentinel };
  }

  async function captureStderr(body: () => Promise<ExitCodeValue>) {
    let stderr = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { exitCode: await body(), stderr };
    } finally {
      process.stderr.write = original;
    }
  }

  /**
   * C-01 (AR-01) — the evidence run's intervention #0, made impossible.
   *
   * `agent-flow feature` reached Discovery in a repository that had never been
   * initialised. The `init` that followed wrote files, moved HEAD, and invalidated the
   * planningBase the run had already frozen. Every fact needed to refuse was on disk
   * before a single token was spent.
   */
  describe('uninitialised project (C-01)', () => {
    it('refuses with CONFIG_ERROR, spending nothing and creating nothing', async () => {
      repo = await makeTempRepoWithCommit();
      // Deliberately no setupAgentFlowConfig: this is AF-2026-001's starting condition.
      const { globalConfigPath, sentinel } = setupTracingGlobalConfig(repo);
      const headBefore = repo.head();

      const { exitCode, stderr } = await captureStderr(() =>
        runFeatureCommand('add dark mode', {}, { ...defaultGlobals(repo!.dir), globalConfigPath }),
      );

      expect(exitCode).toBe(ExitCode.CONFIG_ERROR);

      // 0 AgentRunner invocations, mechanically.
      expect(existsSync(sentinel)).toBe(false);

      // 0 runs created — no directory under .agent-flow/runs/.
      expect(existsSync(join(repo.dir, '.agent-flow', 'runs'))).toBe(false);

      // HEAD unchanged.
      expect(repo.head()).toBe(headBefore);

      // One actionable sentence, naming the absent path and the single action.
      expect(stderr).toContain('.agent-flow/config.yaml');
      expect(stderr).toContain('agent-flow init');
    });

    it('creates no planning artifact and no current-run pointer', async () => {
      repo = await makeTempRepoWithCommit();
      const { globalConfigPath } = setupTracingGlobalConfig(repo);

      await captureStderr(() =>
        runFeatureCommand('add dark mode', {}, { ...defaultGlobals(repo!.dir), globalConfigPath }),
      );

      const store = new StateStore({
        fs: new NodeFileSystem(),
        clock: new SystemClock(),
        projectDir: repo.dir,
      });

      expect(await store.listRunIds()).toHaveLength(0);
      expect(await store.loadCurrentRun()).toBeNull();
      expect(existsSync(join(repo.dir, '.agent-flow', 'current-run'))).toBe(false);
    });

    it('does not blame worktree mode, in either isolation mode', async () => {
      // The refusal used to be wrapped in "Worktree mode was requested and this repository
      // is not ready", which is untrue here and untrue for every sequential run.
      repo = await makeTempRepoWithCommit();
      const { globalConfigPath } = setupTracingGlobalConfig(repo);
      writeFileSync(globalConfigPath, `${readFileSync(globalConfigPath, 'utf8')}git:\n  useWorktrees: false\n`);

      const { exitCode, stderr } = await captureStderr(() =>
        runFeatureCommand('add dark mode', {}, { ...defaultGlobals(repo!.dir), globalConfigPath }),
      );

      expect(exitCode).toBe(ExitCode.CONFIG_ERROR);
      expect(stderr).not.toMatch(/worktree/i);
      expect(stderr).toContain('agent-flow init');
    });
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
