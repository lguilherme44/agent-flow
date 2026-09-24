import { describe, it, expect, afterEach } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { NodeProcessRunner } from '../../src/adapters/process/node-process-runner.js';
import { NodeFileSystem } from '../../src/adapters/fs/node-file-system.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import { StageRunner, StageFailure, type StageDefinition } from '../../src/app/stage-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { PromptLoader } from '../../src/app/prompt-loader.js';
import { TaskExecutor } from '../../src/app/task-executor.js';
import { runPaths } from '../../src/app/paths.js';
import {
  FailedAttemptSchema,
  GlobalConfigSchema,
  TaskResultSchema,
  TaskSchema,
} from '../../src/contracts/index.js';

/**
 * No file agent-flow writes carries a denied call's `tool_input` (SEC-002, AC-009c).
 *
 * The unit tests prove `ClaudeCodeRunner.rawMessage` cuts it. This proves nothing *else*
 * writes it: a real adapter, a real spawn through `NodeProcessRunner`, a real file system,
 * and then every byte under `.agent-flow/` read back. A reader added later that persists
 * stdout by some other route than `raw` fails here and nowhere else.
 *
 * The CLI is a stub that prints a fixture and exits with the fixture's code. It is written
 * per platform because that is what the product spawns per platform: on Windows an npm CLI
 * is a `.cmd`, which only launches through the cross-spawn shim path
 * (`process-runner-shim-resolution.test.ts`); elsewhere it is an executable script. Both
 * run this Node on a small script, so the fixture reaches stdout byte for byte.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/responses/claude');
const PROMPTS = join(import.meta.dirname, '../../prompts');
const CANARY = 'TOOL-INPUT-CANARY-7f3a';

const ERROR_FIXTURE = 'SYNTHETIC-error-permission-denial.json';
const SUCCESS_FIXTURE = 'SYNTHETIC-permission-denial.json';

const config = GlobalConfigSchema.parse({
  runners: { claude: { type: 'claude-code-cli' } },
  roles: {
    architect: { runner: 'claude', effort: 'high' },
    sdd: { runner: 'claude', effort: 'high' },
    planner: { runner: 'claude', effort: 'high' },
    planReviewer: { runner: 'claude', effort: 'high' },
    executors: {
      trivial: { runner: 'claude', effort: 'low' },
      normal: { runner: 'claude', effort: 'medium' },
      complex: { runner: 'claude', effort: 'high' },
    },
    verification: { runner: 'claude', effort: 'medium' },
    finalReviewer: { runner: 'claude', effort: 'very_high' },
  },
});

const SDD_STAGE: StageDefinition = { name: 'sdd', role: 'sdd', prompt: 'sdd', artifact: 'sdd' };

const SDD_VARS = {
  featureRequest: 'write probe.txt',
  architecture: 'none',
  architectureImpact: 'none',
  projectConfig: 'none',
  agentsMd: 'none',
};

const task = () =>
  TaskSchema.parse({
    id: 'TASK-001',
    title: 'Write the probe',
    description: 'Write probe.txt.',
    complexity: 'normal',
    risk: 'low',
    dependencies: [],
    requirements: ['FR-001'],
    acceptanceCriteria: ['probe.txt exists.'],
    validation: [],
  });

const created: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A `claude` that ignores its argv and stdin, prints `fixture` and exits with `exitCode`.
 *
 * The Node binary is named by its absolute path because the spawn hands the child an
 * allowlisted environment (PRI-17), and a stub that depended on PATH finding `node` would
 * be testing that allowlist instead of this.
 */
async function stubClaude(fixture: string, exitCode: number): Promise<string> {
  const dir = await tempDir('af-claude-stub-');
  const script = join(dir, 'claude-stub.cjs');
  await writeFile(
    script,
    [
      "const { readFileSync } = require('node:fs');",
      `process.stdout.write(readFileSync(${JSON.stringify(join(FIXTURES, fixture))}, 'utf8'));`,
      `process.exitCode = ${String(exitCode)};`,
      '',
    ].join('\n'),
  );

  if (process.platform === 'win32') {
    const command = join(dir, 'claude.cmd');
    await writeFile(command, `@"${process.execPath}" "${script}"\r\n@exit /b %ERRORLEVEL%\r\n`);
    return command;
  }

  const command = join(dir, 'claude');
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`);
  await chmod(command, 0o755);
  return command;
}

/** A temp project, with a run, wired the way `task-executor.test.ts` wires its harness. */
async function project(fixture: string, exitCode: number) {
  const projectDir = await tempDir('af-denial-project-');
  const fs = new NodeFileSystem();
  const clock = new FixedClock();
  const store = new StateStore({ fs, clock, projectDir });
  const run = await store.createRun('probe');

  const runner = new ClaudeCodeRunner({
    id: 'claude',
    processRunner: new NodeProcessRunner(),
    command: await stubClaude(fixture, exitCode),
  });

  const stageRunner = new StageRunner({
    fs,
    clock,
    store,
    config,
    capabilities: { claude: runner.capabilities() },
    promptLoader: new PromptLoader({ fs, promptsDir: PROMPTS }),
    getRunner: () => runner,
    projectDir,
  });

  const executor = new TaskExecutor({
    fs,
    clock,
    store,
    stageRunner,
    // Validation and Git only — the agent is the real adapter above. The task declares no
    // validation, and the worktree case is handed its isolation record directly.
    processRunner: new FakeProcessRunner().always({ exitCode: 0 }),
    config: { global: config },
    projectDir,
  });

  return { projectDir, store, run, stageRunner, executor, paths: runPaths(projectDir, run.runId) };
}

/** Every file under `<project>/.agent-flow/`, read whole, keyed by resolved path. */
async function everyFile(projectDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(resolve(path), await readFile(path, 'utf8'));
    }
  };
  await walk(join(projectDir, '.agent-flow'));
  return files;
}

/** The scan's verdict: which files carry the canary. Empty is the only passing answer. */
async function leaks(projectDir: string, mustHaveRead: readonly string[]): Promise<string[]> {
  const files = await everyFile(projectDir);

  // Positive control: the scan reached the files that would carry a leak, so an empty
  // answer below is not the answer of a scan that read nothing.
  for (const path of mustHaveRead) expect([...files.keys()]).toContain(resolve(path));

  return [...files].filter(([, text]) => text.includes(CANARY)).map(([path]) => path);
}

describe('the stub is a CLI that really prints the canary', () => {
  it.each([
    [ERROR_FIXTURE, 1],
    [SUCCESS_FIXTURE, 0],
  ])('%s', async (fixture, exitCode) => {
    // Positive control for every scan below: the input to the product carries the secret.
    const result = await new NodeProcessRunner().run({
      command: await stubClaude(fixture, exitCode),
      args: ['-p', '--output-format', 'json', '--setting-sources', ''],
      cwd: await tempDir('af-stub-cwd-'),
      timeoutSeconds: 60,
      stdin: 'ignored',
    });

    expect(result.spawnFailed).toBe(false);
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toContain(CANARY);
  });
});

describe('a denied tool input reaches no file under .agent-flow/ (SEC-002, AC-009c)', () => {
  it('a failing stage', async () => {
    const world = await project(ERROR_FIXTURE, 1);

    const failure = await world.stageRunner
      .run(SDD_STAGE, world.run.runId, SDD_VARS)
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(StageFailure);
    expect((failure as StageFailure).raw).not.toContain(CANARY);

    const failed = (await world.store.readEvents(world.run.runId)).find(
      (event) => event.type === 'stage_failed',
    );
    expect(String(failed?.detail['rawExcerpt'])).toContain('Write');
    expect(failed?.detail['usage']).toMatchObject({ permissionDenials: { tools: ['Write', 'Bash'] } });

    expect(await leaks(world.projectDir, [world.paths.log('sdd'), world.paths.events])).toEqual([]);
  });

  it('a failing sequential task', async () => {
    const world = await project(ERROR_FIXTURE, 1);

    const result = await world.executor.execute(task(), world.run.runId, 'SDD');
    expect(result.status).toBe('failed');

    const persisted = TaskResultSchema.parse(
      JSON.parse(await readFile(world.paths.taskResult('TASK-001'), 'utf8')),
    );
    expect(persisted.usage?.permissionDenials?.tools).toEqual(['Write', 'Bash']);

    const failed = (await world.store.readEvents(world.run.runId)).find(
      (event) => event.type === 'stage_failed',
    );
    expect(String(failed?.detail['rawExcerpt'])).toContain('Write');

    expect(
      await leaks(world.projectDir, [world.paths.taskResult('TASK-001'), world.paths.events]),
    ).toEqual([]);
  });

  it('a failing worktree-mode task', async () => {
    const world = await project(ERROR_FIXTURE, 1);
    // A real directory, because the stub is really spawned in it.
    const workspace = {
      path: await tempDir('af-denial-worktree-'),
      attempt: 1,
      isolation: {
        base: 'a'.repeat(40),
        branch: 'agent-flow/AF-2026-001-0123456789abcdef/TASK-001/attempt-1',
        relativePath: 'repo-abc/AF-2026-001-0123456789abcdef/TASK-001/attempt-1',
      },
    };

    const result = await world.executor.execute(task(), world.run.runId, 'SDD', workspace);
    expect(result.status).toBe('failed');

    const artifactPath = world.paths.failedAttempt('TASK-001', 1);
    const artifact = FailedAttemptSchema.parse(JSON.parse(await readFile(artifactPath, 'utf8')));
    expect(artifact.usage?.permissionDenials?.tools).toEqual(['Write', 'Bash']);
    expect(artifact.rawExcerpt).toContain('Write');

    expect(await leaks(world.projectDir, [artifactPath, world.paths.events])).toEqual([]);
  });

  it('a successful invocation', async () => {
    const world = await project(SUCCESS_FIXTURE, 0);

    await world.stageRunner.run(SDD_STAGE, world.run.runId, SDD_VARS);

    const completed = (await world.store.readEvents(world.run.runId)).find(
      (event) => event.type === 'stage_completed',
    );
    expect(completed?.detail['usage']).toMatchObject({
      turns: 4,
      permissionDenials: { count: 3, tools: ['Write', 'Bash'] },
    });

    expect(
      await leaks(world.projectDir, [world.paths.sdd, world.paths.log('sdd'), world.paths.events]),
    ).toEqual([]);
  });
});
