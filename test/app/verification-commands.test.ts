import { describe, it, expect } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import {
  runVerification,
  summariseVerification,
  failureDetail,
  VERIFICATION_ORDER,
} from '../../src/app/verification-commands.js';
import { ProjectConfigSchema } from '../../src/contracts/index.js';

const project = (commands: Record<string, string>) =>
  ProjectConfigSchema.parse({ project: { name: 'x', type: 'node' }, commands });

const run = (proc: FakeProcessRunner, commands: Record<string, string>) =>
  runVerification({ processRunner: proc, project: project(commands), cwd: '/repo' });

describe('running the project commands (AD-10)', () => {
  it('runs each configured command', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    const outcome = await run(proc, { lint: 'npm run lint', test: 'npm test' });

    expect(outcome.results).toHaveLength(2);
    expect(proc.calls).toHaveLength(2);
  });

  it('runs them in the configured order, cheapest first', async () => {
    // Lint failing is worth knowing before a long test suite runs.
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    await run(proc, { build: 'b', test: 't', lint: 'l', typecheck: 'tc' });

    const executed = proc.calls.map((call) => call.args[1]);
    expect(executed).toEqual(['l', 'tc', 't', 'b']);
    expect(VERIFICATION_ORDER).toEqual(['lint', 'typecheck', 'test', 'build']);
  });

  it('executes in the project directory', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    await run(proc, { test: 'npm test' });
    expect(proc.lastCall?.cwd).toBe('/repo');
  });

  it('runs command lines through a shell, since config holds strings', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    await run(proc, { test: 'npm test -- --coverage' });

    expect(proc.lastCall?.command).toBe('/bin/sh');
    expect(proc.lastCall?.args).toEqual(['-c', 'npm test -- --coverage']);
  });

  it('costs no LLM call at all', async () => {
    // The point of the split: knowing whether the build is broken is an exit
    // code, not a judgement.
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    const outcome = await run(proc, { test: 'npm test' });
    expect(outcome.passed).toBe(true);
  });
});

describe('missing commands are not failures (§7)', () => {
  it('skips steps the project does not define', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    const outcome = await run(proc, { test: 'npm test' });

    expect(outcome.skipped).toEqual(['lint', 'typecheck', 'build']);
    expect(outcome.passed).toBe(true);
  });

  it('treats an empty command as absent', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    const outcome = await run(proc, { lint: '   ', test: 'npm test' });

    expect(outcome.skipped).toContain('lint');
    expect(proc.calls).toHaveLength(1);
  });

  it('passes when nothing is configured at all', async () => {
    const proc = new FakeProcessRunner();
    const outcome = await runVerification({
      processRunner: proc,
      project: undefined,
      cwd: '/repo',
    });

    expect(outcome.passed).toBe(true);
    expect(proc.calls).toHaveLength(0);
  });
});

describe('failures', () => {
  it('reports failure without stopping the remaining commands', async () => {
    // Someone fixing a broken build wants to know the tests are broken too,
    // not to discover it one round later.
    const proc = new FakeProcessRunner()
      .push({ exitCode: 1, stdout: 'lint failed' })
      .always({ exitCode: 0 });

    const outcome = await run(proc, { lint: 'l', test: 't', build: 'b' });

    expect(outcome.passed).toBe(false);
    expect(outcome.results).toHaveLength(3);
  });

  it('records the exit code of each command', async () => {
    const proc = new FakeProcessRunner().push({ exitCode: 2 }).always({ exitCode: 0 });
    const outcome = await run(proc, { lint: 'l', test: 't' });

    expect(outcome.results[0]?.exitCode).toBe(2);
    expect(outcome.results[1]?.exitCode).toBe(0);
  });

  it('treats a timeout as a failure rather than as unknown', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: null, timedOut: true });
    const outcome = await run(proc, { test: 'npm test' });

    expect(outcome.passed).toBe(false);
    expect(outcome.results[0]?.exitCode).toBe(124);
  });

  it('treats a missing binary as a failure', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: null, spawnFailed: true });
    const outcome = await run(proc, { test: 'pytest' });

    expect(outcome.passed).toBe(false);
    expect(outcome.results[0]?.exitCode).toBe(127);
  });

  it('marks truncated output so nobody reads it as complete', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 1, truncated: true, stdout: 'huge' });
    const outcome = await run(proc, { test: 't' });
    expect(outcome.results[0]?.truncated).toBe(true);
  });
});

describe('progress', () => {
  it('reports each step as it finishes', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    const seen: string[] = [];

    await runVerification({
      processRunner: proc,
      project: project({ lint: 'l', test: 't' }),
      cwd: '/repo',
      onStep: (step) => seen.push(step),
    });

    expect(seen).toEqual(['lint', 'test']);
  });
});

describe('summaries', () => {
  it('states what ran and what was skipped', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0, durationMs: 120 });
    const summary = summariseVerification(await run(proc, { test: 'npm test' }));

    expect(summary).toContain('npm test');
    expect(summary).toContain('passed');
    expect(summary).toContain('not configured');
  });

  it('says so plainly when there is nothing to run', async () => {
    const outcome = await runVerification({
      processRunner: new FakeProcessRunner(),
      project: undefined,
      cwd: '/repo',
    });
    expect(summariseVerification(outcome)).toMatch(/no validation commands/i);
  });

  it('includes only failing output in the detail', async () => {
    // A reviewer's attention should go to what broke, not to a passing log.
    const proc = new FakeProcessRunner()
      .push({ exitCode: 0, stdout: 'lint fine' })
      .push({ exitCode: 1, stdout: 'expected 1 to be 2' });

    const detail = failureDetail(await run(proc, { lint: 'l', test: 't' }));

    expect(detail).toContain('expected 1 to be 2');
    expect(detail).not.toContain('lint fine');
  });

  it('returns nothing when everything passed', async () => {
    const proc = new FakeProcessRunner().always({ exitCode: 0 });
    expect(failureDetail(await run(proc, { test: 't' }))).toBe('');
  });
});
