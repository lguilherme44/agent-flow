import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import type { AgentRunInput } from '../../src/ports/index.js';

/**
 * Not one real CLI invocation in this file.
 *
 * Two things are asserted: the exact argv built for a given input, and the
 * parsing of output recorded from the real CLI in AF-10. That is what keeps the
 * suite fast, free, and still honest about the wire format.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/responses/claude');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

function makeRunner(proc = new FakeProcessRunner()) {
  return { runner: new ClaudeCodeRunner({ id: 'claude', processRunner: proc }), proc };
}

const baseInput: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 900,
};

/** Value that follows a flag in argv, or undefined when the flag is absent. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('capabilities', () => {
  it('reports native structured output (proven in AF-10)', () => {
    expect(makeRunner().runner.capabilities().structuredOutputStrategy).toBe('native');
  });

  it('reports all four logical reasoning levels', () => {
    expect(makeRunner().runner.capabilities().supportedReasoningLevels).toEqual([
      'low',
      'medium',
      'high',
      'very_high',
    ]);
  });

  it('reports read-only and non-interactive support', () => {
    const caps = makeRunner().runner.capabilities();
    expect(caps.supportsReadOnly).toBe(true);
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsWorkingDirectory).toBe(true);
  });
});

describe('argv construction', () => {
  it('runs non-interactively with JSON output', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);

    expect(proc.lastCall?.command).toBe('claude');
    expect(proc.lastCall?.args).toContain('-p');
    expect(valueAfter(proc.lastCall?.args ?? [], '--output-format')).toBe('json');
  });

  it('passes the prompt on stdin, never as a positional argument', async () => {
    // AF-10: --disallowedTools is variadic and swallowed a positional prompt
    // word by word. stdin removes the ambiguity and the argv length ceiling.
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);

    expect(proc.lastCall?.stdin).toBe('Analyse this repository.');
    expect(proc.lastCall?.args).not.toContain('Analyse this repository.');
  });

  it('targets the working directory through spawn, since there is no --cwd', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);
    expect(proc.lastCall?.cwd).toBe('/repo');
  });

  it('forwards the timeout to the process layer', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, timeoutSeconds: 120 });
    expect(proc.lastCall?.timeoutSeconds).toBe(120);
  });
});

describe('model selection (AD-13)', () => {
  it('omits --model entirely when configuration names none', async () => {
    // A pinned model name rots. Leaving the flag off lets the CLI apply
    // whatever the user already configured for it.
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);
    expect(proc.lastCall?.args).not.toContain('--model');
  });

  it('passes the model through untouched when one is set', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, model: 'opus' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--model')).toBe('opus');
  });
});

describe('reasoning translation (R-09)', () => {
  const cases = [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['very_high', 'xhigh'],
  ] as const;

  for (const [logical, physical] of cases) {
    it(`maps ${logical} to ${physical}`, async () => {
      const { runner, proc } = makeRunner(
        new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
      );
      await runner.run({ ...baseInput, reasoning: logical });
      expect(valueAfter(proc.lastCall?.args ?? [], '--effort')).toBe(physical);
    });
  }

  it('never emits max', async () => {
    // `max` exists but costs disproportionately more than xhigh for these
    // stages. Excluded on purpose, asserted so nobody "upgrades" it later.
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, reasoning: 'very_high' });
    expect(proc.lastCall?.args).not.toContain('max');
  });

  it('always emits a value the CLI recognises', async () => {
    // An unknown --effort is ignored with a warning rather than failing, so a
    // wrong mapping would silently run at the default level. The CLI will not
    // catch this for us.
    const VALID = ['low', 'medium', 'high', 'xhigh', 'max'];
    for (const reasoning of ['low', 'medium', 'high', 'very_high'] as const) {
      const { runner, proc } = makeRunner(
        new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
      );
      await runner.run({ ...baseInput, reasoning });
      expect(VALID).toContain(valueAfter(proc.lastCall?.args ?? [], '--effort'));
    }
  });
});

describe('permissions (§35, AD-14)', () => {
  it('uses plan mode and denies edit tools for a read-only stage', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, permissions: 'read-only' });

    const args = proc.lastCall?.args ?? [];
    expect(valueAfter(args, '--permission-mode')).toBe('plan');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Write');
    expect(args).toContain('Edit');
  });

  it('allows edits for an implementation stage', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, permissions: 'write' });

    const args = proc.lastCall?.args ?? [];
    expect(valueAfter(args, '--permission-mode')).toBe('acceptEdits');
    expect(args).not.toContain('--disallowedTools');
  });

  it('never passes --dangerously-skip-permissions', async () => {
    // The only containment agent-flow actually has is the runner's own sandbox.
    // Disabling it would leave nothing at all.
    for (const permissions of ['read-only', 'write'] as const) {
      const { runner, proc } = makeRunner(
        new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
      );
      await runner.run({ ...baseInput, permissions });
      expect(proc.lastCall?.args.join(' ')).not.toContain('dangerously');
    }
  });
});

describe('structured output', () => {
  it('passes the schema and returns the parsed object', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-structured-output.json') }),
    );

    const schema = { type: 'object', properties: { feature: { type: 'string' } } };
    const result = await runner.run({ ...baseInput, outputSchema: schema });

    expect(valueAfter(proc.lastCall?.args ?? [], '--json-schema')).toBe(JSON.stringify(schema));
    expect(result.ok && result.json).toEqual({ feature: 'recurring-bookings', count: 3 });
  });

  it('omits --json-schema when no schema was asked for', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run(baseInput);
    expect(proc.lastCall?.args).not.toContain('--json-schema');
  });

  it('falls back to parsing result when structured_output is absent', async () => {
    // Belt and braces: the runtime normally fills structured_output, but the
    // string in `result` is the same JSON and is enough on its own.
    const envelope = JSON.stringify({
      subtype: 'success',
      is_error: false,
      result: '{"feature":"x"}',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope }));

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(result.ok && result.json).toEqual({ feature: 'x' });
  });

  it('reports invalid_output when a schema was requested but nothing parses', async () => {
    const envelope = JSON.stringify({ subtype: 'success', is_error: false, result: 'not json' });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope }));

    const result = await runner.run({ ...baseInput, outputSchema: { type: 'object' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('invalid_output');
  });
});

describe('extra context flags', () => {
  it('appends a system prompt when given', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, systemPrompt: 'You are terse.' });
    expect(valueAfter(proc.lastCall?.args ?? [], '--append-system-prompt')).toBe('You are terse.');
  });

  it('grants extra read paths through --add-dir', async () => {
    const { runner, proc } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    await runner.run({ ...baseInput, additionalReadPaths: ['/shared/docs'] });

    const args = proc.lastCall?.args ?? [];
    expect(args).toContain('--add-dir');
    expect(args).toContain('/shared/docs');
  });
});

describe('success parsing against recorded output', () => {
  it('extracts the answer from a real JSON envelope', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ stdout: fixture('success-json.json') }),
    );
    const result = await runner.run(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('PROBE_OK');
  });
});

describe('error normalisation (§22.1)', () => {
  it('maps a missing binary to runner_unavailable', async () => {
    // The Codex failure mode, reachable for any runner.
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ spawnFailed: true, exitCode: null, stderr: 'ENOENT' }),
    );
    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('runner_unavailable');
  });

  it('maps a timeout to timeout', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ timedOut: true, exitCode: null, signal: 'SIGKILL' }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('timeout');
  });

  it('maps a 401 envelope to auth_required', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        stdout: fixture('SYNTHETIC-error-auth.json'),
        exitCode: 1,
      }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('auth_required');
  });

  it('maps a 429 envelope to quota_exceeded', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        stdout: fixture('SYNTHETIC-error-quota.json'),
        exitCode: 1,
      }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('recognises a usage-limit message even without a status code', async () => {
    // The synthetic fixtures are guesses about wording, so normalisation keys
    // on the status first. Text matching is the secondary signal, not the only
    // one — that way a phrasing change degrades to execution_failed rather than
    // silently mislabelling a quota problem.
    const envelope = JSON.stringify({
      is_error: true,
      subtype: 'error_during_execution',
      result: 'Claude usage limit reached. Your limit will reset at 9pm.',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope, exitCode: 1 }));

    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('does not mistake a successful document about quotas for a quota failure', async () => {
    // Found end-to-end: an SDD discussing booking rate limits matched the
    // quota heuristic and a perfectly good response was reported as a failure.
    // Explicit success in the envelope has to outrank text matching.
    const envelope = JSON.stringify({
      is_error: false,
      subtype: 'success',
      api_error_status: null,
      result:
        '# Software Design Document\n\n## Security\nSEC-001: enforce a per-user rate limit and ' +
        'a monthly quota; requests beyond the usage limit reached are rejected.',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope, exitCode: 0 }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('rate limit');
  });

  it('still reports a real quota failure when the envelope says it failed', async () => {
    const envelope = JSON.stringify({
      is_error: true,
      subtype: 'error_during_execution',
      result: 'Claude usage limit reached.',
    });
    const { runner } = makeRunner(new FakeProcessRunner().always({ stdout: envelope, exitCode: 1 }));

    const result = await runner.run(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });

  it('falls back to execution_failed for an unrecognised failure', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({
        exitCode: 1,
        stdout: fixture('error-invalid-model.txt'),
      }),
    );
    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    // Not a fallback trigger (§55): a bad model name is a configuration
    // mistake and must stay visible instead of being routed around.
    if (!result.ok) expect(result.errorCode).toBe('execution_failed');
  });

  it('keeps the original message for diagnosis', async () => {
    const { runner } = makeRunner(
      new FakeProcessRunner().always({ exitCode: 1, stdout: fixture('error-invalid-model.txt') }),
    );
    const result = await runner.run(baseInput);
    if (!result.ok) expect(result.raw).toContain('definitely-not-a-model');
  });
});

// The Codex adapter was caught letting the prompt decide the error code (the
// live Python run: an SDD about retry backoff reported the runner as rate
// limited). This adapter's success guard is structural and stronger, but the
// text rule underneath it still read `envelope.result` — the model's own
// answer. Defence in depth: prose written by the model is never diagnosis.
describe('the model answer is not read as a diagnosis', () => {
  const envelope = (over: Record<string, unknown>) =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      ...over,
    });

  it('does not report quota when only the answer mentions rate limits', async () => {
    // `subtype` is deliberately unfamiliar: the guard depends on recognising
    // it, and a CLI release that adds a new one must not turn every design
    // document about throttling into a quota failure.
    const { runner, proc } = makeRunner();
    proc.always(() => ({
      exitCode: 0,
      stdout: envelope({
        subtype: 'success_with_warnings',
        result: 'The retry helper exists to survive rate limit failures.',
      }),
    }));

    const result = await runner.run(baseInput);

    if (!result.ok) expect(result.errorCode).not.toBe('quota_exceeded');
  });

  it('still reads the message when the envelope says it is an error', async () => {
    // When `is_error` is true, `result` holds the CLI's explanation rather than
    // the model's answer — and then its wording is exactly the right evidence.
    const { runner, proc } = makeRunner();
    proc.always(() => ({
      exitCode: 1,
      stdout: envelope({
        subtype: 'error',
        is_error: true,
        result: 'Usage limit reached. Try again later.',
      }),
    }));

    const result = await runner.run(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
  });
})
