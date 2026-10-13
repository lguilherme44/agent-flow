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

// Regression suite — the §6 misclassification, back in a different adapter.
//
// The stderr in this fixture is real, captured from codex 0.147.0 on a
// successful run. It is not an error channel: it is the session transcript,
// containing the prompt that was sent and the answer that came back. Two rules
// read it as diagnosis, and both were wrong.
describe('a successful run is not reclassified by what the prompt said', () => {
  const transcript = fixture('session-transcript-stderr.txt');

  it('does not report quota_exceeded because the prompt discussed rate limits', async () => {
    // The prompt is echoed into stderr verbatim. A plan for a retry helper —
    // or any SDD about throttling, billing, or backoff — put the words
    // "rate limit" in the channel the error rules scanned. The content of the
    // work decided the classification of the run.
    const proc = new FakeProcessRunner();
    const { runner, fs } = makeRunner({ process: proc });
    proc.always((spawn) => {
      const outIndex = spawn.args.indexOf('-o');
      const path = spawn.args[outIndex + 1];
      if (path) fs.seed(path, '{"answer":"OK"}');
      return { exitCode: 0, stderr: transcript };
    });

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(true);
  });

  it('does not mistake the echoed answer for an error envelope', async () => {
    // stderr contains `{"answer":"OK"}` on its own line — the reply, echoed.
    // The envelope parser took the first parseable object it found anywhere in
    // stderr, so a successful reply disarmed the success guard, which is what
    // let the text rules run at all.
    const proc = new FakeProcessRunner();
    const { runner, fs } = makeRunner({ process: proc });
    proc.always((spawn) => {
      const outIndex = spawn.args.indexOf('-o');
      const path = spawn.args[outIndex + 1];
      if (path) fs.seed(path, '{"answer":"OK"}');
      return { exitCode: 0, stderr: transcript };
    });

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.json).toEqual({ answer: 'OK' });
  });

  it('still reports a genuine quota failure', async () => {
    // The rule has to keep working when the CLI actually says so — on a
    // non-zero exit, which is what a real refusal looks like.
    const proc = new FakeProcessRunner();
    const { runner } = makeRunner({ process: proc });
    proc.always(() => ({
      exitCode: 1,
      stderr: 'ERROR: You have hit your usage limit. Try again later.',
    }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('still reports a structured quota failure that exits zero', async () => {
    // Status codes are evidence in a way that prose is not, so they outrank
    // the exit code — but only when they arrive in an actual error envelope.
    const proc = new FakeProcessRunner();
    const { runner } = makeRunner({ process: proc });
    proc.always(() => ({
      exitCode: 0,
      stderr: 'ERROR: {"status":429,"message":"rate limited"}',
    }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });
});

describe('the prompt cannot decide how the run is classified', () => {
  const transcript = fixture('session-transcript-stderr.txt');

  it('ignores rate-limit wording echoed from the prompt on a failed exit', async () => {
    // The envelope fix covers the exit-zero case. This is the other half: a run
    // that fails for an unrelated reason still has the prompt sitting in its
    // stderr, and a plan about throttling would be reported as a throttled
    // runner — and, with fallback enabled, would spend the other provider's
    // quota to escape a limit nobody hit.
    const proc = new FakeProcessRunner();
    const { runner } = makeRunner({ process: proc });
    proc.always(() => ({ exitCode: 1, stderr: transcript }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    // Unclassified rather than misclassified: `execution_failed` is not
    // fallback-eligible, so an unknown failure stays visible instead of being
    // routed around.
    if (!result.ok) expect(result.errorCode).toBe('execution_failed');
  });

  it('reads the wording when the CLI is the one saying it', async () => {
    const proc = new FakeProcessRunner();
    const { runner } = makeRunner({ process: proc });
    proc.always(() => ({
      exitCode: 1,
      stderr: `${transcript}\nERROR: usage limit reached for this account.`,
    }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('applies the same rule to authentication', async () => {
    const proc = new FakeProcessRunner();
    const { runner } = makeRunner({ process: proc });
    proc.always(() => ({
      exitCode: 1,
      stderr: 'A design note: users who are not logged in see the banner.',
    }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('execution_failed');
  });
});

/**
 * Dogfood 08/10 — "tela congelada", for this runner too. `exec --json` prints the session as
 * events. Measured on codex-cli 0.162.0-alpha.17.2: the thread and turn events, an
 * `agent_message` item, `turn.completed` with the usage — and, with no credential, `error`
 * events and a `turn.failed`. The other item shapes are the ones the binary names; their
 * fields are read defensively.
 */
describe('the event stream (dogfood 08/10)', () => {
  const event = (fields: Record<string, unknown>) => JSON.stringify(fields);
  const lines = [
    event({ type: 'thread.started', thread_id: 't' }),
    event({ type: 'turn.started' }),
    event({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'PRIVATE-THOUGHT' } }),
    event({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } }),
    event({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm test', aggregated_output: 'COMMAND-OUTPUT', exit_code: 0, status: 'completed' } }),
    event({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } }),
    event({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Changed a.ts; the tests pass.' } }),
    event({ type: 'turn.completed', usage: { input_tokens: 28393, cached_input_tokens: 24064, output_tokens: 62 } }),
  ];
  const stream = `${lines.join('\n')}\n`;

  /** A codex that writes `answer` to its `-o` file and prints `stdout`, fed through the pipe. */
  function streaming(answer: string, stdout: string, exitCode = 0) {
    const proc = new FakeProcessRunner();
    const made = makeRunner({ process: proc });
    proc.always((spawn) => {
      const path = spawn.args[spawn.args.indexOf('-o') + 1];
      if (path && answer !== '') made.fs.seed(path, answer);
      spawn.onStdout?.(stdout.slice(0, 150));
      spawn.onStdout?.(stdout.slice(150));
      return { exitCode, stdout };
    });
    return made;
  }

  it('asks the CLI for the event stream and still reads the answer from -o', async () => {
    const { runner, proc } = streaming('ok', stream);

    const result = await runner.run(baseInput);

    expect(proc.lastCall?.args).toContain('--json');
    expect(result.ok && result.text).toBe('ok');
  });

  it('reports each item once, as it starts, and keeps the reasoning private', async () => {
    const seen: unknown[] = [];
    const { runner } = streaming('ok', stream);

    await runner.run({ ...baseInput, onActivity: (activity) => seen.push(activity) });

    expect(seen).toEqual([
      { kind: 'tool', tool: 'command_execution', target: 'npm test' },
      { kind: 'tool', tool: 'file_change', target: 'src/a.ts' },
      { kind: 'text', text: 'Changed a.ts; the tests pass.' },
    ]);
  });

  it('does not report the answer of a structured stage as something the agent said', async () => {
    const seen: unknown[] = [];
    const answer = '{"verdict":"PASS"}';
    const { runner } = streaming(answer, `${event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer } })}\n`);

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' }, onActivity: (activity) => seen.push(activity) });

    expect(result.ok && result.json).toEqual({ verdict: 'PASS' });
    expect(seen).toEqual([]);
  });

  it('keeps none of the stream in what a failure carries to logs', async () => {
    const { runner } = streaming('', `${lines.slice(0, 5).join('\n')}\n`, 1);

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.raw).not.toContain('COMMAND-OUTPUT');
    expect(result.raw).not.toContain('PRIVATE-THOUGHT');
  });

  // Measured: with no credential, `--json` leaves stderr without one `ERROR:` line — the
  // failure is the `turn.failed` event, after five reconnect errors.
  const loggedOut = [
    event({ type: 'thread.started', thread_id: 't' }),
    event({ type: 'turn.started' }),
    event({ type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)' }),
    event({ type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' }),
    event({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' } }),
  ].join('\n');
  const tracing =
    'Reading prompt from stdin...\n2026-10-13T12:59:30.104360Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized';

  it('reads a logged-out codex as auth_required from its turn.failed event', async () => {
    const proc = new FakeProcessRunner();
    const { runner } = makeRunner({ process: proc });
    proc.always((spawn) => {
      spawn.onStdout?.(`${loggedOut}\n`);
      return { exitCode: 1, stdout: `${loggedOut}\n`, stderr: tracing };
    });

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('auth_required');
    expect(result.raw).toContain('unexpected status 401 Unauthorized');
  });

  it('reads the same failure in text mode, where it is an ERROR: line on stderr', async () => {
    // Measured too, before `--json`: no rule read this line, so a logged-out codex failed as
    // `execution_failed`.
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({
        exitCode: 1,
        stderr: 'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      }),
    });

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('auth_required');
  });

  it('does not read a retry the run recovered from as the reason it later failed', async () => {
    // Adversarial review: a 429 retry, a recovery, then a crash with no turn.failed. Read as a
    // quota failure, fallback would spend the other provider's quota on a limit nobody hit.
    const recovered = [
      event({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 429 Too Many Requests)' }),
      event({ type: 'error', message: 'unexpected status 429 Too Many Requests' }),
      event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Working on it.' } }),
    ].join('\n');
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({ exitCode: 1, stdout: `${recovered}\n` }),
    });

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('execution_failed');

    // And a retry alone, with nothing after it, is still a retry and not the verdict.
    const retrying = event({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 429 Too Many Requests)' });
    const { runner: second } = makeRunner({
      process: new FakeProcessRunner().always({ exitCode: 1, stdout: `${retrying}\n` }),
    });
    const retried = await second.run(baseInput);
    if (!retried.ok) expect(retried.errorCode).toBe('execution_failed');
    expect(retried.ok).toBe(false);
  });

  it('reads a usage limit from turn.failed, and not from a retry that came before it', async () => {
    // Measured shape: a plain `error` right before `turn.failed`, not only retries.
    const limited = [
      event({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized)' }),
      event({ type: 'error', message: 'unexpected status 401 Unauthorized' }),
      event({ type: 'turn.failed', error: { message: 'You have hit your usage limit. Try again later.' } }),
    ].join('\n');
    const { runner } = makeRunner({
      process: new FakeProcessRunner().always({ exitCode: 1, stdout: `${limited}\n` }),
    });

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });
});
