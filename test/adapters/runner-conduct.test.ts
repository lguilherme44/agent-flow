import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { ClaudeCodeRunner } from '../../src/adapters/runners/claude-code-runner.js';
import { CodexRunner } from '../../src/adapters/runners/codex-runner.js';
import { AgyRunner } from '../../src/adapters/runners/agy-runner.js';
import { OpenAiRunner } from '../../src/adapters/runners/openai-runner.js';
import type { AgentRunInput, AgentRunResult } from '../../src/ports/index.js';

/**
 * How a call conducted itself — turns taken and tool calls refused (P1.2).
 *
 * Kept apart from `runner-usage.test.ts`, whose fixtures are all real output. The two
 * denial fixtures here are `SYNTHETIC-`: only a fragment of a real denying envelope was
 * captured (Claude Code 2.1.280), so they are built from its measured key set and denial
 * shape. Every `tool_input.content` carries a canary, because the input a model tried to
 * pass can be the content of a secret, and the point of these tests is that it never
 * reaches `usage`.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/responses');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const CANARY = 'TOOL-INPUT-CANARY-7f3a';

/** Every key `AgentRunUsage` may carry. Anything else would be envelope vocabulary leaking. */
const USAGE_KEYS = [
  'model',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'turns',
  'permissionDenials',
];

/** The 2.1.280 envelope keys, as measured. The error envelope adds `errors`. */
const MEASURED_KEYS = [
  'duration_api_ms',
  'stop_reason',
  'session_id',
  'total_cost_usd',
  'usage',
  'modelUsage',
  'permission_denials',
  'terminal_reason',
  'is_error',
  'num_turns',
  'subtype',
  'result',
  'duration_ms',
];

const input: AgentRunInput = {
  prompt: 'Analyse this repository.',
  reasoning: 'high',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 900,
};

function claude(stdout: string, exitCode = 0): Promise<AgentRunResult> {
  const proc = new FakeProcessRunner().push({ stdout, exitCode });
  return new ClaudeCodeRunner({ id: 'claude', processRunner: proc }).run(input);
}

function agy(stdout: string): Promise<AgentRunResult> {
  const proc = new FakeProcessRunner().push({ stdout, exitCode: 0 });
  return new AgyRunner({ id: 'agy', processRunner: proc }).run(input);
}

/** The measured success envelope, with its conduct fields replaced or removed. */
function claudeEnvelope(overrides: Record<string, unknown>, omit: readonly string[] = []): string {
  const envelope = JSON.parse(fixture('claude/success-json.json')) as Record<string, unknown>;
  for (const key of omit) delete envelope[key];
  return JSON.stringify({ ...envelope, ...overrides });
}

describe('the two SYNTHETIC denial fixtures', () => {
  it.each(['SYNTHETIC-permission-denial.json', 'SYNTHETIC-error-permission-denial.json'])(
    '%s carries every measured 2.1.280 key and the canary in each tool_input',
    (name) => {
      const envelope = JSON.parse(fixture(`claude/${name}`)) as Record<string, unknown>;

      for (const key of MEASURED_KEYS) expect(envelope).toHaveProperty(key);
      const denials = envelope['permission_denials'] as {
        tool_name: string;
        tool_use_id: string;
        tool_input: { content: string };
      }[];
      expect(denials.map((d) => d.tool_name)).toEqual(['Write', 'Write', 'Bash']);
      for (const denial of denials) {
        expect(denial.tool_use_id).toMatch(/^toolu_/);
        expect(denial.tool_input.content).toContain(CANARY);
      }
    },
  );

  it('the error fixture is an error envelope and carries `errors`', () => {
    const envelope = JSON.parse(fixture('claude/SYNTHETIC-error-permission-denial.json')) as Record<
      string,
      unknown
    >;
    expect(envelope['is_error']).toBe(true);
    expect(envelope).toHaveProperty('errors');
  });
});

describe('Claude Code reports turns (FR-001)', () => {
  it('reads `num_turns` as the turn count', async () => {
    const result = await claude(claudeEnvelope({ num_turns: 2 }));
    expect(result.usage?.turns).toBe(2);
  });

  it('keeps a zero, because the CLI said zero', async () => {
    const result = await claude(claudeEnvelope({ num_turns: 0 }));
    expect(result.usage?.turns).toBe(0);
  });

  it('reports no turns when the envelope carries none', async () => {
    const result = await claude(claudeEnvelope({}, ['num_turns']));
    // Positive control: the rest of the usage is still read, so the absence is specific.
    expect(result.usage?.inputTokens).toBe(2);
    expect(result.usage).not.toHaveProperty('turns');
  });

  // `-1` and `1.5` are finite, and still refused: `RunUsageSchema` takes a non-negative
  // integer, and a value it rejects would fail `result.json` or drop a telemetry row.
  it.each([
    ['null', null],
    ['a string', '2'],
    ['a negative', -1],
    ['a fraction', 1.5],
  ])('reports no turns when `num_turns` is %s', async (_label, value) => {
    const result = await claude(claudeEnvelope({ num_turns: value }));
    expect(result.usage?.inputTokens).toBe(2);
    expect(result.usage).not.toHaveProperty('turns');
  });

  it('reports no turns when `num_turns` is NaN', async () => {
    // JSON cannot carry NaN, so the envelope is the parsed object the adapter reads.
    const runner = new ClaudeCodeRunner({ id: 'claude', processRunner: new FakeProcessRunner() });
    const parse = (
      runner as unknown as { parseUsage(result: unknown, parsed: unknown): AgentRunResult['usage'] }
    ).parseUsage.bind(runner);

    const usage = parse({}, { num_turns: Number.NaN, total_cost_usd: 0.1 });
    expect(usage).toEqual({ costUsd: 0.1 });
    // Positive control: the same call reads an integer.
    expect(parse({}, { num_turns: 3, total_cost_usd: 0.1 })).toEqual({ costUsd: 0.1, turns: 3 });
  });
});

describe('Claude Code reports permission denials, never their input (FR-002)', () => {
  it('counts every denial and names each tool once, in first-appearance order', async () => {
    const stdout = fixture('claude/SYNTHETIC-permission-denial.json');
    // Positive control: the canary is really in what the CLI printed.
    expect(stdout).toContain(CANARY);

    const result = await claude(stdout);

    expect(result.ok).toBe(true);
    expect(result.usage?.permissionDenials).toEqual({ count: 3, tools: ['Write', 'Bash'] });
    expect(result.usage?.turns).toBe(4);
    expect(JSON.stringify(result.usage)).not.toContain(CANARY);
  });

  it('reports the same on a failed call, because the denials still happened', async () => {
    const stdout = fixture('claude/SYNTHETIC-error-permission-denial.json');
    expect(stdout).toContain(CANARY);

    const result = await claude(stdout, 1);

    expect(result.ok).toBe(false);
    expect(result.usage?.permissionDenials).toEqual({ count: 3, tools: ['Write', 'Bash'] });
    expect(JSON.stringify(result.usage)).not.toContain(CANARY);
  });

  it('copies no denial field other than the tool name', async () => {
    const result = await claude(fixture('claude/SYNTHETIC-permission-denial.json'));

    for (const key of Object.keys(result.usage ?? {})) expect(USAGE_KEYS).toContain(key);
    expect(Object.keys(result.usage?.permissionDenials ?? {}).sort()).toEqual(['count', 'tools']);
    expect(JSON.stringify(result.usage)).not.toContain('toolu_');
  });

  it('counts a denial without a usable name, and does not name it', async () => {
    const result = await claude(
      claudeEnvelope({
        permission_denials: [
          { tool_use_id: 'toolu_1', tool_input: { content: CANARY } },
          { tool_name: '', tool_use_id: 'toolu_2' },
          { tool_name: 42, tool_use_id: 'toolu_3' },
          { tool_name: 'Edit', tool_use_id: 'toolu_4' },
          'not an entry',
        ],
      }),
    );

    expect(result.usage?.permissionDenials).toEqual({ count: 5, tools: ['Edit'] });
    expect(JSON.stringify(result.usage)).not.toContain(CANARY);
  });

  it('reports an empty list as none refused, not as silence', async () => {
    const result = await claude(claudeEnvelope({ permission_denials: [] }));
    expect(result.usage?.permissionDenials).toEqual({ count: 0, tools: [] });
  });

  it('reports nothing when the field is absent', async () => {
    const result = await claude(claudeEnvelope({}, ['permission_denials']));
    expect(result.usage?.inputTokens).toBe(2);
    expect(result.usage).not.toHaveProperty('permissionDenials');
  });

  it.each([
    ['an object', { tool_name: 'Write' }],
    ['a string', 'Write'],
    ['null', null],
  ])('reports nothing when the field is %s', async (_label, value) => {
    const result = await claude(claudeEnvelope({ permission_denials: value }));
    expect(result.usage?.inputTokens).toBe(2);
    expect(result.usage).not.toHaveProperty('permissionDenials');
  });
});

describe('agy reports turns from the top of its envelope (FR-003)', () => {
  it('reports turns alone when there is no usage block', async () => {
    const result = await agy(JSON.stringify({ status: 'SUCCESS', response: 'ok\n', num_turns: 1 }));

    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ turns: 1 });
  });

  it('reports turns and tokens on the measured 1.1.27 envelope', async () => {
    const result = await agy(fixture('agy/success-json.json'));
    expect(result.usage).toEqual({ inputTokens: 20735, outputTokens: 1, cacheReadTokens: 0, turns: 1 });
  });

  it('reports nothing when the envelope carries neither tokens nor turns', async () => {
    const result = await agy(JSON.stringify({ status: 'SUCCESS', response: 'ok\n' }));

    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
  });

  it.each([
    ['a negative', -1],
    ['a fraction', 1.5],
    ['a string', '1'],
  ])('reports no turns when `num_turns` is %s', async (_label, value) => {
    const result = await agy(
      JSON.stringify({ status: 'SUCCESS', response: 'ok\n', num_turns: value, usage: { input_tokens: 5 } }),
    );
    expect(result.usage).toEqual({ inputTokens: 5 });
  });
});

describe('codex and openai-compatible report neither (FR-004)', () => {
  it('codex, on its recorded transcript, reports no turns and no denials', async () => {
    const fs = new InMemoryFileSystem();
    const proc = new FakeProcessRunner();
    proc.always((spawn) => {
      const path = spawn.args[spawn.args.indexOf('-o') + 1];
      if (path) fs.seed(path, fixture('codex/success-text.txt'));
      return { exitCode: 0, stderr: fixture('codex/session-transcript-stderr.txt') };
    });
    const runner = new CodexRunner({
      id: 'codex',
      processRunner: proc,
      fs,
      tempDir: '/tmp',
      uniqueId: () => 'conduct',
    });

    const result = await runner.run(input);

    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage ?? {})).not.toContain('turns');
    expect(Object.keys(result.usage ?? {})).not.toContain('permissionDenials');
    expect(result.usage).toBeUndefined();
  });

  it('openai-compatible, whose response carries a usage block, reports no turns and no denials', async () => {
    const body = {
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const runner = new OpenAiRunner({
      id: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'local',
      fetch: fetchImpl,
    });

    const result = await runner.run(input);

    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage ?? {})).not.toContain('turns');
    expect(Object.keys(result.usage ?? {})).not.toContain('permissionDenials');
  });
});
