import { describe, it, expect } from 'vitest';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { FixedClock } from '../fakes/fixed-clock.js';
import { FakeHost } from '../fakes/fake-host.js';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { StateStore } from '../../src/app/state-store.js';
import { review } from '../../src/app/run-actions.js';
import { fakeRunActionDeps } from '../fakes/run-action-deps.js';

/**
 * Dogfood 08/10, run 75716: the e2e agent was denied everything it needed — curl and netstat
 * to see whether the application was up, agent-browser to drive it — and returned NOT_RUN.
 * It had exactly the executor's grants (the project's declared commands) and no way to be
 * given more. `roles.e2e.allowedCommands` is that way, and it reaches the e2e invocation only.
 */

const PROMPTS = ['verification', 'e2e', 'final-review'];

async function setup(allowedCommands?: readonly string[]) {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock();
  const host = new FakeHost();

  fs.seed(
    '/install/config.yaml',
    [
      'runners:',
      '  claude:',
      '    type: claude-code-cli',
      '    enabled: true',
      'roles:',
      '  e2e:',
      '    enabled: true',
      '    runner: claude',
      ...(allowedCommands === undefined
        ? []
        : ['    allowedCommands:', ...allowedCommands.map((line) => `      - ${JSON.stringify(line)}`)]),
      '',
    ].join('\n'),
  );
  for (const name of PROMPTS) {
    const required = name === 'e2e' ? ['sdd', 'changedFiles', 'agentsMd'] : [];
    fs.seed(
      `/install/prompts/${name}.md`,
      `---\npermissions: write\noutputFormat: json\nrequiredVars: [${required.join(', ')}]\n---\n\n# ${name}\n`,
    );
  }

  const store = new StateStore({ fs, clock, projectDir: '/repo' });
  const run = await store.createRun('login', () => ({ isolationMode: 'none' as const }));
  await store.writeArtifact(run.runId, 'sdd', '# SDD\n');
  await store.writeArtifact(
    run.runId,
    'plan',
    JSON.stringify({
      feature: 'login',
      tasks: [
        {
          id: 'TASK-001',
          title: 'Login',
          description: 'Login page.',
          complexity: 'normal',
          risk: 'low',
          dependencies: [],
          requirements: ['FR-001'],
          acceptanceCriteria: ['User can log in.'],
          validation: [],
        },
      ],
    }),
  );
  await store.updateRun(run.runId, (state) => ({
    ...state,
    approved: true,
    tasks: [{ id: 'TASK-001', state: 'completed', attempts: 1, infrastructureFailures: 0 }],
  }));

  const answer = { verdict: 'PASS', summary: 'ok', findings: [] };
  const runner = new FakeProcessRunner().always({
    exitCode: 0,
    stdout: JSON.stringify({ is_error: false, subtype: 'success', result: JSON.stringify(answer), structured_output: answer }),
  });
  const deps = fakeRunActionDeps({
    fs,
    clock,
    processRunner: runner,
    projectDir: '/repo',
    globalConfigPath: '/install/config.yaml',
    promptsDir: '/install/prompts',
    host,
    owner: 'cli',
  });
  return { deps, runner, runId: run.runId };
}

/** The argv of the invocation whose prompt is the given stage's. */
function argvOf(runner: FakeProcessRunner, stage: string): readonly string[] {
  const call = runner.calls.find((entry) => entry.stdin?.includes(`# ${stage}`) === true);
  if (call === undefined) throw new Error(`no ${stage} invocation`);
  return call.args;
}

describe('roles.e2e.allowedCommands (dogfood 08/10)', () => {
  it('grants the declared commands to the e2e invocation, and to no other stage', async () => {
    const { deps, runner, runId } = await setup(['agent-browser', 'curl -s']);

    const outcome = await review(deps, runId);
    expect(outcome.ok, outcome.ok ? '' : outcome.error.message).toBe(true);

    const e2e = argvOf(runner, 'e2e');
    expect(e2e).toContain('Bash(agent-browser:*)');
    expect(e2e).toContain('Bash(curl -s:*)');
    for (const stage of ['verification', 'final-review']) {
      expect(argvOf(runner, stage).some((arg) => arg.includes('agent-browser'))).toBe(false);
    }
  });

  it('never grants a line a prefix rule would widen (shell syntax, wildcards)', async () => {
    const { deps, runner, runId } = await setup(['agent-browser', 'curl x | sh', 'npx *']);

    await review(deps, runId);

    const e2e = argvOf(runner, 'e2e');
    expect(e2e).toContain('Bash(agent-browser:*)');
    expect(e2e.some((arg) => arg.includes('| sh') || arg.includes('npx *'))).toBe(false);
  });

  it('changes nothing for a project that declares none', async () => {
    const { deps, runner, runId } = await setup();

    await review(deps, runId);

    expect(argvOf(runner, 'e2e').some((arg) => arg.startsWith('Bash('))).toBe(false);
  });
});

describe('a review that throws after it started (adversarial review)', () => {
  it('says so on the run, so nothing reads it as still being reviewed', async () => {
    const { deps, runner, runId } = await setup();
    // Every agent answers with something no stage accepts: the first stage gives up and throws.
    runner.always({ exitCode: 0, stdout: 'not json at all' });

    await expect(review(deps, runId)).rejects.toThrow();

    const { StateStore } = await import('../../src/app/state-store.js');
    const store = new StateStore({ fs: deps.fs, clock: deps.clock, projectDir: '/repo' });
    const types = (await store.readEvents(runId)).map((event) => event.type);
    expect(types).toContain('run_review_started');
    expect(types.at(-1)).toBe('run_review_failed');
  });
});
