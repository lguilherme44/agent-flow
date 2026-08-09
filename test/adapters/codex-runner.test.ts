import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { CodexRunner } from '../../src/adapters/runners/codex-runner.js';
import type { AgentRunInput } from '../../src/ports/index.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/responses/codex');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const TEMP = '/tmp';
const OUT = `${TEMP}/agent-flow-codex-test-1.out`;

function makeRunner(options: { answer?: string; process?: FakeProcessRunner } = {}) {
  const fs = new InMemoryFileSystem();
  const proc = options.process ?? new FakeProcessRunner();

  // Codex writes its answer to the path given to -o, so the fake process has to
  // behave the same way for the adapter to be exercised honestly.
  if (options.answer !== undefined) {
    proc.always((spawn) => {
      const outIndex = spawn.args.indexOf('-o');
      const path = spawn.args[outIndex + 1];
      if (path) fs.seed(path, options.answer as string);
      return { exitCode: 0 };
    });
  }

  const runner = new CodexRunner({
    id: 'codex',
    processRunner: proc,
    fs,
    tempDir: TEMP,
    uniqueId: () => 'test-1',
  });

  return { runner, proc, fs };
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

describe('capabilities', () => {
  it('reports prompted structured output, not native', () => {
    // --output-schema exists but only accepts OpenAI strict-mode schemas, where
    // `required` must list every key including the optional ones. Our contracts
    // have genuinely optional fields, so the flag is unusable without a lossy
    // rewrite — the repair loop covers it instead.
    expect(makeRunner().runner.capabilities().structuredOutputStrategy).toBe('prompted');
  });

  it('reports all four logical reasoning levels', () => {
    expect(makeRunner().runner.capabilities().supportedReasoningLevels).toEqual([
      'low',
      'medium',
      'high',
      'very_high',
    ]);
  });
});

describe('argv construction', () => {
  it('runs the non-interactive subcommand', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);

    expect(proc.lastCall?.command).toBe('codex');
    expect(proc.lastCall?.args[0]).toBe('exec');
  });

  it('passes the working directory through the CLI flag, not just spawn', async () => {
    // Unlike Claude Code, this CLI has a real -C flag.
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);

    expect(valueAfter(proc.lastCall?.args ?? [], '-C')).toBe('/repo');
    expect(proc.lastCall?.cwd).toBe('/repo');
  });

  it('allows running outside a git repository', async () => {
    // Codex refuses by default; agent-flow must work wherever it is pointed.
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);
    expect(proc.lastCall?.args).toContain('--skip-git-repo-check');
  });

  it('leaves no session files behind', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);
    expect(proc.lastCall?.args).toContain('--ephemeral');
  });

  it('disables colour so captured output stays parseable', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);
    expect(valueAfter(proc.lastCall?.args ?? [], '--color')).toBe('never');
  });

  it('passes the prompt on stdin', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);
    expect(proc.lastCall?.stdin).toBe('Analyse this repository.');
  });

  it('prepends a system prompt to the user prompt', async () => {
    // There is no dedicated flag, so it is folded into the prompt itself.
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run({ ...baseInput, systemPrompt: 'You are terse.' });

    expect(proc.lastCall?.stdin).toContain('You are terse.');
    expect(proc.lastCall?.stdin).toContain('Analyse this repository.');
  });
});

describe('model and reasoning', () => {
  it('omits -m when configuration names no model (AD-13)', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);
    expect(proc.lastCall?.args).not.toContain('-m');
  });

  it('passes the model when one is set', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run({ ...baseInput, model: 'gpt-5.6-sol' });
    expect(valueAfter(proc.lastCall?.args ?? [], '-m')).toBe('gpt-5.6-sol');
  });

  const cases = [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['very_high', 'xhigh'],
  ] as const;

  for (const [logical, physical] of cases) {
    it(`maps ${logical} to ${physical} through config override`, async () => {
      const { runner, proc } = makeRunner({ answer: 'ok' });
      await runner.run({ ...baseInput, reasoning: logical });
      expect(proc.lastCall?.args).toContain(`model_reasoning_effort=${physical}`);
    });
  }
});

describe('permissions (§35)', () => {
  it('uses the read-only sandbox for a read-only stage', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run({ ...baseInput, permissions: 'read-only' });
    expect(valueAfter(proc.lastCall?.args ?? [], '-s')).toBe('read-only');
  });

  it('uses workspace-write for an implementation stage', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run({ ...baseInput, permissions: 'write' });
    expect(valueAfter(proc.lastCall?.args ?? [], '-s')).toBe('workspace-write');
  });

  it('never bypasses the sandbox', async () => {
    // The sandbox is the only containment agent-flow actually has (AD-14).
    for (const permissions of ['read-only', 'write'] as const) {
      const { runner, proc } = makeRunner({ answer: 'ok' });
      await runner.run({ ...baseInput, permissions });
      expect(proc.lastCall?.args.join(' ')).not.toContain('dangerously');
    }
  });
});

describe('output handling', () => {
  it('reads the answer from the -o file, not from stdout', async () => {
    // stdout interleaves hook output, colour codes and a token counter, so it
    // cannot be treated as the response.
    const proc = new FakeProcessRunner();
    const { runner, fs } = makeRunner({ process: proc });
    fs.seed(OUT, 'PROBE_OK\n');
    proc.always({ exitCode: 0, stdout: 'hook: Stop Completed\ntokens used\n14.303\nPROBE_OK' });

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('PROBE_OK');
  });

  it('parses recorded real output', async () => {
    const { runner, fs } = makeRunner();
    fs.seed(OUT, fixture('success-text.txt'));

    const result = await runner.run(baseInput);
    expect(result.ok && result.text).toBe('PROBE_OK');
  });

  it('reports invalid_output when the CLI wrote nothing', async () => {
    const { runner } = makeRunner();
    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('invalid_output');
  });
});

describe('structured output', () => {
  it('carries the schema in the prompt rather than through the flag', async () => {
    const { runner, proc, fs } = makeRunner();
    fs.seed(OUT, '{"feature":"x"}');

    const schema = { type: 'object', properties: { feature: { type: 'string' } } };
    await runner.run({ ...baseInput, outputSchema: schema });

    expect(proc.lastCall?.args).not.toContain('--output-schema');
    expect(proc.lastCall?.stdin).toContain('"feature"');
    expect(proc.lastCall?.stdin).toContain('Return only the object');
  });

  it('states the format requirement after the task, not before it', async () => {
    const { runner, proc, fs } = makeRunner();
    fs.seed(OUT, '{"feature":"x"}');

    await runner.run({ ...baseInput, outputSchema: { type: 'object' } });

    const stdin = proc.lastCall?.stdin ?? '';
    expect(stdin.indexOf('Analyse this repository.')).toBeLessThan(
      stdin.indexOf('must be a single JSON object'),
    );
  });

  it('returns the parsed object', async () => {
    const { runner, fs } = makeRunner();
    fs.seed(OUT, fixture('success-structured-output.json'));

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(result.ok && result.json).toEqual({ feature: 'recurring-bookings', count: 3 });
  });

  it('tolerates a fenced JSON response', async () => {
    // Models occasionally wrap the answer despite the schema.
    const { runner, fs } = makeRunner();
    fs.seed(OUT, '```json\n{"feature":"x"}\n```');

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(result.ok && result.json).toEqual({ feature: 'x' });
  });

  it('reports invalid_output when the response is not JSON', async () => {
    const { runner, fs } = makeRunner();
    fs.seed(OUT, 'definitely not json');

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('invalid_output');
  });

  it('omits --output-schema when no schema was requested', async () => {
    const { runner, proc } = makeRunner({ answer: 'ok' });
    await runner.run(baseInput);
    expect(proc.lastCall?.args).not.toContain('--output-schema');
  });
});

describe('temp files', () => {
  it('cleans up after a successful run', async () => {
    const { runner, fs } = makeRunner();
    fs.seed(OUT, '{"a":1}');

    await runner.run({ ...baseInput, outputSchema: { type: 'object' } });

    expect(await fs.exists(OUT)).toBe(false);
  });

  it('cleans up after a failure too', async () => {
    const { runner, fs } = makeRunner({
      process: new FakeProcessRunner().always({ exitCode: 1, stderr: 'boom' }),
    });

    await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(await fs.exists(OUT)).toBe(false);
  });

  it('gives concurrent runs distinct paths', async () => {
    // Instance state would let two parallel runs overwrite each other's files —
    // the scheduler is built to raise concurrency without changes down here.
    const proc = new FakeProcessRunner();
    const fs = new InMemoryFileSystem();
    let counter = 0;

    const runner = new CodexRunner({
      id: 'codex',
      processRunner: proc,
      fs,
      tempDir: TEMP,
      uniqueId: () => `run-${String(++counter)}`,
    });

    proc.always((spawn) => {
      const path = spawn.args[spawn.args.indexOf('-o') + 1];
      if (path) fs.seed(path, `answer from ${path}`);
      return { exitCode: 0 };
    });

    const [first, second] = await Promise.all([runner.run(baseInput), runner.run(baseInput)]);

    expect(first.ok && first.text).not.toBe(second.ok && second.text);
  });
});

describe('error normalisation (§22.1)', () => {
  it('maps a missing binary to runner_unavailable', async () => {
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({ spawnFailed: true, exitCode: null }),
    });
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('runner_unavailable');
  });

  it('maps a 401 status to auth_required', async () => {
    const stderr = 'ERROR: {"type":"error","status":401,"error":{"message":"unauthorized"}}';
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({ exitCode: 1, stderr }),
    });

    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('auth_required');
  });

  it('maps a 429 status to quota_exceeded', async () => {
    const stderr = 'ERROR: {"type":"error","status":429,"error":{"message":"slow down"}}';
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({ exitCode: 1, stderr }),
    });

    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('treats an unsupported model as execution_failed, not a fallback trigger', async () => {
    // A 400 is a configuration mistake. Routing around it would hide it (§55).
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({
        exitCode: 1,
        stderr: fixture('error-invalid-model.txt'),
      }),
    });

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('execution_failed');
  });

  it('does not mistake a successful answer discussing quotas for a quota failure', async () => {
    const { runner, fs } = makeRunner();
    fs.seed(OUT, 'The design enforces a per-user rate limit and a monthly quota.');

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(true);
  });

  it('keeps the original message for diagnosis', async () => {
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({
        exitCode: 1,
        stderr: fixture('error-invalid-model.txt'),
      }),
    });

    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.raw).toContain('not-a-real-model');
  });
});
