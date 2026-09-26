import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { buildExecutionContext, buildPlanningPipeline } from '../../src/app/execution-context.js';
import { agentFlowPaths } from '../../src/app/paths.js';
import { registryFor } from '../../src/app/executor-commands.js';
import { loadConfig } from '../../src/config/loader.js';
import { roleConfigOf } from '../../src/contracts/index.js';
import type { AgentRunInput } from '../../src/ports/index.js';

/**
 * The grants reach the executor through the production wiring (FR-008, SEC-001).
 *
 * Asserted at the process boundary, on the argv the executor's runner would spawn, because
 * the defect this guards against is a construction site that builds its registry without
 * the grants — every unit below the wiring would still pass.
 */

const PROJECT = '/repo';
const GLOBAL = '/install/config.yaml';
const ENVELOPE = JSON.stringify({ is_error: false, subtype: 'success', result: 'ok' });

const PROJECT_YAML =
  'project:\n  name: demo\n  type: node\n' +
  'commands:\n  install: npm ci\n  lint: npm run lint\n' +
  'validationCommands:\n  typecheck-deck: npm run typecheck:deck\n';

const write: AgentRunInput = {
  prompt: 'implement',
  reasoning: 'medium',
  workingDirectory: PROJECT,
  permissions: 'write',
  timeoutSeconds: 60,
};

async function executorArgv(trusted: boolean): Promise<readonly string[]> {
  const fs = new InMemoryFileSystem();
  fs.seed(`${PROJECT}/.agent-flow/config.yaml`, PROJECT_YAML);
  if (trusted) fs.seed(GLOBAL, `trust:\n  projectConfig: [${PROJECT}]\n`);
  const processRunner = new FakeProcessRunner().always({ stdout: ENVELOPE });

  const context = await buildExecutionContext({
    fs,
    clock: new FixedClock(),
    processRunner,
    host: new FakeHost(),
    projectDir: PROJECT,
    globalConfigPath: GLOBAL,
    promptsDir: '/install/prompts',
  });

  const executor = roleConfigOf(context.config.global.roles, 'executor.normal').runner;
  await context.registry.get(executor).run(write);
  return processRunner.lastCall?.args ?? [];
}

describe('the executor built by buildExecutionContext carries the declared grants', () => {
  it('grants a trusted project its declared lines, and the PowerShell rules exactly on win32', async () => {
    const args = await executorArgv(true);

    expect(args).toContain('Bash(npm run lint:*)');
    expect(args).toContain('Bash(npm run typecheck:deck:*)');
    const windows = process.platform === 'win32';
    expect(args.includes('PowerShell(npm run lint:*)')).toBe(windows);
    expect(args.includes('PowerShell(npm run typecheck:deck:*)')).toBe(windows);
    // Never the install step (FR-004).
    expect(args.some((arg) => arg.includes('npm ci'))).toBe(false);
  });

  it('grants an untrusted project nothing (SEC-001)', async () => {
    const args = await executorArgv(false);
    expect(args.some((arg) => arg.includes('npm run lint'))).toBe(false);
    expect(args).not.toContain('--allowedTools');
  });
});

describe('buildPlanningPipeline holds the planner to the executor it built (FR-008, FR-009)', () => {
  const PROMPTS = '/install/prompts';
  const REAL_PROMPTS = join(import.meta.dirname, '..', '..', 'prompts');

  async function planWith(description: string) {
    const fs = new InMemoryFileSystem();
    for (const file of readdirSync(REAL_PROMPTS)) {
      if (file.endsWith('.md')) fs.seed(`${PROMPTS}/${file}`, readFileSync(join(REAL_PROMPTS, file), 'utf8'));
    }
    fs.seed(`${PROJECT}/.agent-flow/config.yaml`, PROJECT_YAML);
    fs.seed(GLOBAL, `trust:\n  projectConfig: [${PROJECT}]\n`);

    const plan = {
      feature: 'screen',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Add the screen',
          description,
          complexity: 'normal',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          acceptanceCriteria: ['The screen renders.'],
          validation: ['lint'],
        },
      ],
    };
    // Every spawn answers with this plan: the planner twice, and anything after it would
    // fail its own schema — so a plan the checks accept surfaces as a different error.
    const envelope = JSON.stringify({ is_error: false, subtype: 'success', result: JSON.stringify(plan), structured_output: plan });
    const processRunner = new FakeProcessRunner().always({ stdout: envelope });

    const context = await buildExecutionContext({
      fs,
      clock: new FixedClock(),
      processRunner,
      host: new FakeHost(),
      projectDir: PROJECT,
      globalConfigPath: GLOBAL,
      promptsDir: PROMPTS,
    });
    const run = await context.store.createRun('add the screen');
    fs.seed(agentFlowPaths(PROJECT).architectureCache, '# Architecture');
    await context.store.writeArtifact(run.runId, 'architectureImpact', '# Impact');
    await context.store.writeArtifact(run.runId, 'sdd', '## Functional Requirements\n\n- FR-001: A screen.\n');

    const raised = await buildPlanningPipeline(context)
      .run(run.runId, 'Add the screen', { from: 'planning', workflow: 'standard' })
      .catch((error: unknown) => error);
    return String((raised as Error | undefined)?.message);
  }

  it('refuses a citation the trusted grants do not cover, and names operatorVerifications', async () => {
    const message = await planWith('Confirm it with `npm run e2e:android`.');
    expect(message).toContain('`npm run e2e:android`');
    expect(message).toContain('npm run lint, npm run typecheck:deck');
    expect(message).toContain('operatorVerifications');
  });

  it('accepts a citation a derived grant covers', async () => {
    // Positive control: the same wiring, citing a granted line, is not refused by the check.
    const message = await planWith('Confirm it with `npm run typecheck:deck -- --pretty`.');
    expect(message).not.toContain('operatorVerifications');
  });
});

describe('registryFor', () => {
  it('reads an absent trust decision as untrusted', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${PROJECT}/.agent-flow/config.yaml`, PROJECT_YAML);
    fs.seed(GLOBAL, `trust:\n  projectConfig: [${PROJECT}]\n`);
    const loaded = await loadConfig({ fs, globalConfigPath: GLOBAL, projectDir: PROJECT });
    expect(loaded.projectTrusted).toBe(true);

    const deps = { processRunner: new FakeProcessRunner(), fs, platform: 'linux' as const };
    const prefixesOf = (config: typeof loaded) =>
      registryFor(config, deps).get('claude').capabilities().nonInteractiveToolGrants.grantedCommandPrefixes;

    // A config somebody assembled without the loader: no decision, so no grant.
    expect(prefixesOf({ global: loaded.global, project: loaded.project })).toEqual([]);
    // Positive control: the loader's own answer grants the declared lines.
    expect(prefixesOf(loaded)).toEqual(['npm run lint', 'npm run typecheck:deck']);
  });

  it('is the only production caller of buildRegistry', () => {
    const src = join(import.meta.dirname, '..', '..', 'src');
    const callers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /\bbuildRegistry\s*\(/.test(readFileSync(join(src, file), 'utf8')))
      .map((file) => file.replaceAll('\\', '/'))
      .sort();

    // The definition, and the one helper that passes the grants.
    expect(callers).toEqual(['adapters/runners/registry.ts', 'app/executor-commands.ts']);
  });

  it('keeps the grant spelling inside the claude adapter (NFR-003)', () => {
    const src = join(import.meta.dirname, '..', '..', 'src');
    for (const file of [
      'core/command-grants.ts',
      'app/executor-commands.ts',
      'adapters/runners/registry.ts',
      'ports/agent-runner.ts',
    ]) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(/Bash\(|PowerShell\(|--allowedTools/.test(text), file).toBe(false);
    }
  });
});
