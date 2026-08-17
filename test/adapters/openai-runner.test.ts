import { describe, it, expect } from 'vitest';
import { OpenAiRunner } from '../../src/adapters/runners/openai-runner.js';
import type { AgentRunInput } from '../../src/ports/index.js';

/**
 * An `AgentRunner` over an OpenAI-compatible inference endpoint.
 *
 * **This one is not a coding CLI, and the difference is the whole design.** Claude Code,
 * Codex and AGY are agents: they hold a working directory, read files, run commands and
 * edit code. An inference endpoint holds a conversation. Handing it `permissions: 'write'`
 * and a working directory would be asking it to do something it structurally cannot.
 *
 * What it *can* do is every stage whose prompt already carries its input. Nine of the
 * eleven shipped prompts are exactly that — `sdd`, `planning`, `plan-review`,
 * `verification`, `final-review`, `architecture-impact` — text and JSON in, JSON out. The
 * two that are not are `discovery` ("prefer reading a file over inferring from its name")
 * and `implementation`.
 *
 * So the adapter declares what is true and refuses what is not, and the role resolver's
 * existing capability gates do the rest.
 */

const OK_BODY = {
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRunner(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  overrides: Record<string, unknown> = {},
) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (init?.body !== undefined) {
      calls.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: new Headers(init.headers),
      });
    }
    return handler(url, init);
  }) as typeof fetch;

  const runner = new OpenAiRunner({
    id: 'local',
    baseUrl: 'http://192.168.3.51:8080/v1',
    apiKey: 'local',
    fetch: fetchImpl,
    ...overrides,
  });

  return { runner, calls };
}

const input: AgentRunInput = {
  prompt: 'Write an SDD for recurring bookings.',
  reasoning: 'medium',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 300,
};

describe('OpenAiRunner capabilities', () => {
  it('declares no working directory, because it has none', () => {
    // The honest answer, and the one that makes the existing resolver do the right thing:
    // a role whose prompt needs the repository will refuse to resolve here rather than
    // silently receiving an agent that cannot look at it.
    const { runner } = makeRunner(() => jsonResponse(OK_BODY));
    expect(runner.capabilities().supportsWorkingDirectory).toBe(false);
  });

  it('declares read-only, because inference cannot write', () => {
    // Not a sandbox claim — a structural one. There is no filesystem on the other side of
    // an HTTP call, so `read-only` is satisfied by construction rather than by a flag.
    const { runner } = makeRunner(() => jsonResponse(OK_BODY));
    expect(runner.capabilities().supportsReadOnly).toBe(true);
  });

  it('declares native structured output', () => {
    // `response_format: json_schema` is enforced by the server's grammar, not requested in
    // the prompt. Measured against llama.cpp: a schema with an enum and a nested array
    // came back valid on the first response.
    const { runner } = makeRunner(() => jsonResponse(OK_BODY));
    expect(runner.capabilities().structuredOutputStrategy).toBe('native');
  });

  it('grants no tools, because it is given none', () => {
    // AD-32, answered from the shape rather than from optimism: this adapter sends no
    // tool definitions, so no tool can be exercised — interactively or otherwise.
    const { runner } = makeRunner(() => jsonResponse(OK_BODY));
    expect(runner.capabilities().nonInteractiveToolGrants).toEqual({
      fileEdit: false,
      commandExecution: false,
    });
  });

  it('answers the same for every model', () => {
    // A server that serves one model at a time has nothing model-specific to say. When
    // that changes, the measurement goes here (AD-30).
    const { runner } = makeRunner(() => jsonResponse(OK_BODY));
    const baseline = runner.capabilities();
    for (const model of [undefined, 'moe', 'qwen38-27b-iq4xs']) {
      expect(runner.capabilities(model)).toEqual(baseline);
    }
  });
});

describe('OpenAiRunner invocation', () => {
  it('posts the prompt to the chat completions endpoint', async () => {
    const { runner, calls } = makeRunner(() => jsonResponse(OK_BODY));

    const result = await runner.run(input);

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://192.168.3.51:8080/v1/chat/completions');
    expect(JSON.stringify(calls[0]?.body)).toContain('recurring bookings');
  });

  it('sends the api key as a bearer token and never in the body', async () => {
    const { runner, calls } = makeRunner(() => jsonResponse(OK_BODY));

    await runner.run(input);

    expect(calls[0]?.headers.get('authorization')).toBe('Bearer local');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('local');
  });

  it('sends a system prompt as its own message when one is given', async () => {
    const { runner, calls } = makeRunner(() => jsonResponse(OK_BODY));

    await runner.run({ ...input, systemPrompt: 'You are terse.' });

    const messages = calls[0]?.body['messages'] as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
  });

  it('enforces a requested schema through response_format', async () => {
    const { runner, calls } = makeRunner(() =>
      jsonResponse({
        choices: [{ message: { content: '{"verdict":"PASS"}' }, finish_reason: 'stop' }],
      }),
    );

    const result = await runner.run({
      ...input,
      outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
    });

    const format = calls[0]?.body['response_format'] as Record<string, unknown>;
    expect(format['type']).toBe('json_schema');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.json).toEqual({ verdict: 'PASS' });
  });

  it('reports invalid_output when a schema was asked for and the reply is not JSON', async () => {
    const { runner } = makeRunner(() =>
      jsonResponse({ choices: [{ message: { content: 'sorry, no' }, finish_reason: 'stop' }] }),
    );

    const result = await runner.run({ ...input, outputSchema: { type: 'object' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('invalid_output');
  });

  it('refuses a write stage rather than pretending to satisfy it', async () => {
    // The one refusal that matters. Silently accepting `write` would produce a stage that
    // reports success having changed nothing — which is precisely the failure AR-05a
    // exists to catch, arriving from a different direction.
    const { runner, calls } = makeRunner(() => jsonResponse(OK_BODY));

    const result = await runner.run({ ...input, permissions: 'write' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('execution_failed');
    expect(result.raw).toMatch(/write|cannot|inference/i);
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAiRunner error normalisation', () => {
  const cases: { status: number; expected: string }[] = [
    { status: 401, expected: 'auth_required' },
    { status: 403, expected: 'auth_required' },
    { status: 429, expected: 'quota_exceeded' },
    { status: 500, expected: 'execution_failed' },
  ];

  for (const { status, expected } of cases) {
    it(`maps HTTP ${String(status)} to ${expected}`, async () => {
      const { runner } = makeRunner(() => jsonResponse({ error: { message: 'nope' } }, status));

      const result = await runner.run(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorCode).toBe(expected);
    });
  }

  it('maps an unreachable server to runner_unavailable', async () => {
    // The code that makes a fallback eligible (§55). A machine that is off is
    // infrastructure, not a bad answer.
    const { runner } = makeRunner(() => {
      throw new TypeError('fetch failed');
    });

    const result = await runner.run(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('runner_unavailable');
  });

  it('maps an aborted request to timeout', async () => {
    const { runner } = makeRunner(() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    const result = await runner.run(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('timeout');
  });

  it('never puts the api key in the raw output', async () => {
    // I-21's companion at this boundary: the key is a credential this adapter holds, and
    // `raw` is persisted.
    const { runner } = makeRunner(() =>
      jsonResponse({ error: { message: 'bad key: local' } }, 401),
    );

    const result = await runner.run(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.raw).not.toContain('Bearer');
  });
});

describe('OpenAiRunner health', () => {
  it('reports executable and configured when the model list answers', async () => {
    const { runner } = makeRunner((url) =>
      url.endsWith('/models')
        ? jsonResponse({ data: [{ id: 'moe' }] })
        : jsonResponse(OK_BODY),
    );

    const health = await runner.healthCheck();

    expect(health.installed).toBe(true);
    expect(health.executable).toBe(true);
    expect(health.auth).toBe('configured');
  });

  it('reports not executable when the server is unreachable', async () => {
    const { runner } = makeRunner(() => {
      throw new TypeError('fetch failed');
    });

    const health = await runner.healthCheck();

    expect(health.executable).toBe(false);
  });

  it('names the served model, which is what a person needs to see', async () => {
    const { runner } = makeRunner((url) =>
      url.endsWith('/models') ? jsonResponse({ data: [{ id: 'moe' }] }) : jsonResponse(OK_BODY),
    );

    expect((await runner.healthCheck()).version).toContain('moe');
  });

  it('reports auth as not configured on a 401', async () => {
    const { runner } = makeRunner(() => jsonResponse({ error: 'unauthorised' }, 401));

    expect((await runner.healthCheck()).auth).toBe('not_configured');
  });
});
