import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { BaseRunner } from '../../src/adapters/runners/base-runner.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import { classifyRunnerFailure } from '../../src/core/failure-classification.js';
import type { AgentRunInput, AgentRunResult, ProcessResult } from '../../src/ports/index.js';

/**
 * Claude's failure text never carries the input of a refused tool call (FR-009, SEC-002).
 *
 * `rawMessage` is stdout plus stderr, and for this CLI stdout is the whole envelope —
 * `permission_denials[].tool_input` included, which is the content the model tried to
 * write. Everything downstream (stage log, `stage_failed.rawExcerpt`, failed-attempt
 * artifacts) persists `raw`, so a leak here is a leak to disk. Each test that asserts the
 * canary is absent has the base behaviour beside it, asserting it is present: an override
 * that stopped being called would otherwise make every absence here pass for nothing.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/responses/claude');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const CANARY = 'TOOL-INPUT-CANARY-7f3a';
const WITHHELD = '[claude stdout withheld: unparseable envelope carrying permission_denials tool_input]';

const input: AgentRunInput = {
  prompt: 'Write probe.txt.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'write',
  timeoutSeconds: 900,
};

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    spawnFailed: false,
    truncated: false,
    ...overrides,
  };
}

function runner(): ClaudeCodeRunner {
  return new ClaudeCodeRunner({ id: 'claude', processRunner: new FakeProcessRunner() });
}

/** The override, called directly — the same method `BaseRunner.run` calls on both failure paths. */
function claudeRaw(result: ProcessResult): string {
  const subject = runner() as unknown as { rawMessage(result: ProcessResult): string };
  return subject.rawMessage(result);
}

/** What `rawMessage` returned before this override existed: `BaseRunner`'s own, on a Claude instance. */
function baseRaw(result: ProcessResult): string {
  const method = (BaseRunner.prototype as unknown as { rawMessage(result: ProcessResult): string }).rawMessage;
  return method.call(runner(), result);
}

async function run(stdout: string, exitCode: number, stderr = '', request: AgentRunInput = input) {
  const proc = new FakeProcessRunner().push({ stdout, stderr, exitCode });
  return new ClaudeCodeRunner({ id: 'claude', processRunner: proc }).run(request);
}

function failed(result: AgentRunResult): Extract<AgentRunResult, { ok: false }> {
  if (result.ok) throw new Error('expected a failed invocation');
  return result;
}

/** The envelope as the CLI printed it, minus exactly the keys the override is meant to cut. */
function withoutInput(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { permission_denials: Record<string, unknown>[] };
  for (const denial of envelope.permission_denials) delete denial['tool_input'];
  return envelope;
}

describe('a failed Claude call hands back no denied tool input (AC-009a)', () => {
  const stdout = fixture('SYNTHETIC-error-permission-denial.json');

  it('drops the canary from `raw` and keeps the denied tool name', async () => {
    const result = failed(await run(stdout, 1));

    expect(result.raw).not.toContain(CANARY);
    expect(result.raw).toContain('"tool_name":"Write"');
  });

  it('positive control: the base text over the same result carries the canary', () => {
    const result = processResult({ stdout });

    expect(stdout).toContain(CANARY);
    expect(baseRaw(result)).toContain(CANARY);
    expect(claudeRaw(result)).not.toContain(CANARY);
  });

  it('cuts only `tool_input`: the rest of the envelope parses back to what the CLI printed', () => {
    const raw = claudeRaw(processResult({ stdout }));
    const parsed = JSON.parse(raw) as { permission_denials: { tool_use_id: string }[] };

    expect(parsed).toEqual(withoutInput(stdout));
    // Stated separately so a deep-equality that went vacuous still fails here.
    expect(Object.keys(parsed).sort()).toEqual(
      Object.keys(JSON.parse(stdout) as Record<string, unknown>).sort(),
    );
    expect(parsed.permission_denials.map((denial) => denial.tool_use_id)).toEqual([
      'toolu_00000000000000000000000004',
      'toolu_00000000000000000000000005',
      'toolu_00000000000000000000000006',
    ]);
  });

  it('appends stderr unchanged, by the base rules', async () => {
    const stderr = '  Error: stopped after repeated permission denials\n';
    const result = failed(await run(stdout, 1, stderr));

    const [envelope, ...rest] = result.raw.split('\n');
    expect(JSON.parse(envelope ?? '')).toEqual(withoutInput(stdout));
    // Only the whole text is trimmed, so stderr's leading spaces survive the join.
    expect(rest.join('\n')).toBe(stderr.trimEnd());
    // Positive control: the base join puts the same stderr in the same place.
    expect(baseRaw(processResult({ stdout, stderr })).endsWith(`\n${stderr.trimEnd()}`)).toBe(true);
  });

  it('covers the `invalid_output` path: a zero exit whose output misses its contract', async () => {
    const success = fixture('SYNTHETIC-permission-denial.json');
    expect(success).toContain(CANARY);
    expect(JSON.parse(success)).not.toHaveProperty('structured_output');

    // A schema was asked for, the envelope has no `structured_output`, and `result` is prose.
    const result = failed(
      await run(success, 0, '', { ...input, outputSchema: { type: 'object', properties: {} } }),
    );

    expect(result.errorCode).toBe('invalid_output');
    expect(result.raw).not.toContain(CANARY);
    expect(result.raw).toContain('"tool_name":"Write"');
    // Positive control: without the override this path would have embedded the canary.
    expect(baseRaw(processResult({ stdout: success, exitCode: 0 }))).toContain(CANARY);
  });
});

describe('an envelope with nothing to cut is handed back byte for byte (AC-009b)', () => {
  const envelope = (overrides: Record<string, unknown>): string =>
    JSON.stringify({ ...(JSON.parse(fixture('success-json.json')) as object), ...overrides });

  it.each([
    'success-json.json',
    'success-structured-output.json',
    'success-text.txt',
    'error-invalid-model.txt',
    'SYNTHETIC-error-auth.json',
    'SYNTHETIC-error-quota.json',
  ])('%s', (name) => {
    for (const stderr of ['', 'a warning on stderr\n']) {
      const result = processResult({ stdout: fixture(name), stderr });
      expect(claudeRaw(result)).toBe(baseRaw(result));
    }
  });

  it('an empty `permission_denials`', () => {
    const result = processResult({ stdout: `  ${envelope({ permission_denials: [] })}\n` });
    expect(claudeRaw(result)).toBe(baseRaw(result));
  });

  it('denial entries that carry no `tool_input`', () => {
    const stdout = envelope({
      permission_denials: [
        { tool_name: 'Write', tool_use_id: 'toolu_1' },
        { tool_name: 'Bash', tool_use_id: 'toolu_2' },
      ],
    });
    // Pretty-printed, so an override that re-serialised anyway would show up as a diff.
    const pretty = JSON.stringify(JSON.parse(stdout), null, 2);
    const result = processResult({ stdout: pretty });

    expect(claudeRaw(result)).toBe(baseRaw(result));
    expect(claudeRaw(result)).toContain('\n  "');
  });

  it('an empty stdout, as a killed CLI leaves it', () => {
    const result = processResult({ stdout: '', stderr: 'killed\n', exitCode: null });
    expect(claudeRaw(result)).toBe(baseRaw(result));
    expect(claudeRaw(result)).toBe('killed');
  });
});

describe('an unparseable stdout that names `tool_input` is withheld (SEC-003)', () => {
  // The head of a denial envelope, cut mid-string — what a truncated buffer looks like.
  const truncated = fixture('SYNTHETIC-error-permission-denial.json').slice(0, 900);

  it('replaces the stdout part with the fixed line, and keeps stderr', () => {
    expect(truncated).toContain('"tool_input"');
    expect(() => JSON.parse(truncated) as unknown).toThrow();

    expect(claudeRaw(processResult({ stdout: truncated }))).toBe(WITHHELD);
    expect(claudeRaw(processResult({ stdout: truncated, stderr: 'boom\n' }))).toBe(`${WITHHELD}\nboom`);
    // Positive control: the base text is the thing that would have leaked.
    expect(baseRaw(processResult({ stdout: truncated }))).toContain(CANARY);
  });

  it('returns an unparseable stdout without that text unchanged', () => {
    const result = processResult({ stdout: 'Error: something went wrong {"tool_name":"Write"' });
    expect(claudeRaw(result)).toBe(baseRaw(result));
    expect(claudeRaw(result)).toContain('something went wrong');
  });
});

describe('cutting the input changes neither the code nor the class (AC-009, §22.1)', () => {
  it.each([
    ['SYNTHETIC-error-permission-denial.json', 'execution_failed'],
    ['SYNTHETIC-error-auth.json', 'auth_required'],
    ['SYNTHETIC-error-quota.json', 'quota_exceeded'],
    ['error-invalid-model.txt', 'execution_failed'],
  ] as const)('%s', async (name, code) => {
    const stdout = fixture(name);
    const result = failed(await run(stdout, 1));
    const base = baseRaw(processResult({ stdout }));

    // The code is decided from the envelope, never from `raw`; asserted anyway, because a
    // future rule reading `raw` is exactly how that would stop being true.
    expect(result.errorCode).toBe(code);
    expect(classifyRunnerFailure({ errorCode: result.errorCode, redactedRaw: result.raw })).toEqual(
      classifyRunnerFailure({ errorCode: result.errorCode, redactedRaw: base }),
    );
  });
});
