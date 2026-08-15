import { describe, it, expect } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { AgyRunner } from '../../src/adapters/runners/agy-runner.js';
import type { AgentRunInput } from '../../src/ports/index.js';

function makeRunner(proc = new FakeProcessRunner()) {
  return { runner: new AgyRunner({ id: 'agy', processRunner: proc }), proc };
}

const baseInput: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 900,
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('AgyRunner capabilities', () => {
  it('reports native structured output strategy', () => {
    expect(makeRunner().runner.capabilities().structuredOutputStrategy).toBe('native');
  });

  it('declares supportsReadOnly false per security baseline probe requirements', () => {
    expect(makeRunner().runner.capabilities().supportsReadOnly).toBe(false);
  });

  it('reports non-interactive and working directory support', () => {
    const caps = makeRunner().runner.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsWorkingDirectory).toBe(true);
  });
});

describe('AgyRunner argv construction', () => {
  it('runs non-interactively with json output format', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({
        stdout: JSON.stringify({ is_error: false, result: 'done' }),
      }),
    );

    await runner.run(baseInput);

    expect(proc.lastCall?.command).toBe('agy');
    expect(proc.lastCall?.args).toContain('-p');
    expect(valueAfter(proc.lastCall?.args ?? [], '--output-format')).toBe('json');
  });

  it('maps reasoning level to CLI effort flags', async () => {
    const proc = new FakeProcessRunner().always({
      stdout: JSON.stringify({ is_error: false, result: 'done' }),
    });
    const runner = new AgyRunner({ id: 'agy', processRunner: proc });

    await runner.run({ ...baseInput, reasoning: 'low' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--effort')).toBe('low');

    await runner.run({ ...baseInput, reasoning: 'high' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--effort')).toBe('high');
  });

  it('passes prompt on stdin', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({
        stdout: JSON.stringify({ is_error: false, result: 'done' }),
      }),
    );

    await runner.run(baseInput);
    expect(proc.lastCall?.stdin).toBe('Analyse this repository.');
  });
});

describe('AgyRunner error classification', () => {
  it('classifies 429 status as quota_exceeded', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, status_code: 429, error: 'Rate limit' }),
      }),
    );

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('quota_exceeded');
    }
  });

  it('classifies 401 status as auth_required', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, status_code: 401, error: 'Unauthorized' }),
      }),
    );

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('auth_required');
    }
  });
});
