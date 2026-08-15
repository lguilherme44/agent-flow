import { describe, it, expect, vi } from 'vitest';
import {
  OpenAiCompatibleUtilityModel,
  type OpenAiCompatibleUtilityModelConfig,
} from '../../../src/adapters/utility-model/openai-utility-model.js';
import type { UtilityModelInput } from '../../../src/ports/utility-model.js';

function createMockFetch(
  handler: (req: {
    url: string;
    method: string;
    headers: Headers;
    body?: string;
    signal?: AbortSignal;
  }) => Promise<Response> | Response,
): typeof fetch {
  const fetchMock = vi.fn(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const input = args[0];
      const init = args[1];
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers as Record<string, string>);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      const signal = init?.signal ?? undefined;

      return handler({ url, method, headers, body, signal: signal as AbortSignal | undefined });
    },
  );
  return fetchMock as unknown as typeof fetch;
}

function jsonResponse(data: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200, statusText = 'OK'): Response {
  return new Response(text, {
    status,
    statusText,
    headers: { 'Content-Type': 'text/plain' },
  });
}

const VALID_CONFIG: OpenAiCompatibleUtilityModelConfig = {
  baseUrl: 'http://localhost:1234/v1',
  model: 'qwen2.5-coder-7b-instruct',
  contextWindow: 64_000,
  targetInputTokens: 40_000,
  maxOutputTokens: 4_000,
  timeoutSeconds: 120,
  healthTimeoutSeconds: 5,
  injectNoThink: true,
};

// ─── 1. Construction & Config Validation (Mandatory Tests 1-8) ───────────────

describe('OpenAiCompatibleUtilityModel — Construction & Config (Tests 1-8)', () => {
  it('1. valid config constructs adapter', () => {
    const adapter = new OpenAiCompatibleUtilityModel(VALID_CONFIG);
    expect(adapter.id).toBe('openai-compatible:qwen2.5-coder-7b-instruct');
    expect(adapter.capabilities().contextWindow).toBe(64_000);
  });

  it('2. invalid baseUrl rejected', () => {
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, baseUrl: 'not-a-url' })).toThrow(
      /Invalid baseUrl/,
    );
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, baseUrl: 'ftp://localhost:1234' })).toThrow(
      /protocol must be http: or https:/,
    );
  });

  it('3. empty model rejected', () => {
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, model: '' })).toThrow(
      /non-empty model identifier/,
    );
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, model: '   ' })).toThrow(
      /non-empty model identifier/,
    );
  });

  it('4. targetInputTokens <= 0 rejected', () => {
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, targetInputTokens: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, targetInputTokens: -100 })).toThrow(
      /positive integer/,
    );
  });

  it('5. targetInputTokens > contextWindow rejected deterministically', () => {
    expect(
      () =>
        new OpenAiCompatibleUtilityModel({
          ...VALID_CONFIG,
          contextWindow: 32_000,
          targetInputTokens: 40_000,
        }),
    ).toThrow(/targetInputTokens \(40000\) cannot exceed contextWindow \(32000\)/);
  });

  it('6. invalid timeout rejected', () => {
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, timeoutSeconds: 0 })).toThrow(
      /positive number/,
    );
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, timeoutSeconds: -5 })).toThrow(
      /positive number/,
    );
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, timeoutSeconds: NaN })).toThrow(
      /positive number/,
    );
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, healthTimeoutSeconds: -1 })).toThrow(
      /positive number/,
    );
  });

  it('7. invalid maxOutputTokens rejected', () => {
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, maxOutputTokens: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, maxOutputTokens: -20 })).toThrow(
      /positive integer/,
    );
  });

  it('8. optional API key supported and custom id supported', () => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      id: 'custom-util-model',
      apiKey: 'secret-key-123',
    });
    expect(adapter.id).toBe('custom-util-model');
  });

  it('normalizes base URLs with and without /v1 and trailing slashes', async () => {
    const urlsCalled: string[] = [];
    const mockFetch = createMockFetch(({ url }) => {
      urlsCalled.push(url);
      return jsonResponse({
        choices: [{ message: { content: 'ok' } }],
      });
    });

    const cases = [
      'http://localhost:1234',
      'http://localhost:1234/',
      'http://localhost:1234/v1',
      'http://localhost:1234/v1/',
    ];

    for (const baseUrl of cases) {
      urlsCalled.length = 0;
      const adapter = new OpenAiCompatibleUtilityModel({
        baseUrl,
        model: 'm1',
        fetch: mockFetch,
      });
      await adapter.run({ content: 'hello' });
      expect(urlsCalled[0]).toBe('http://localhost:1234/v1/chat/completions');
    }
  });
});

// ─── 2. Capabilities (Mandatory Tests 9-14) ──────────────────────────────────

describe('OpenAiCompatibleUtilityModel — Capabilities (Tests 9-14)', () => {
  it('9. capabilities returns stable profile', () => {
    const adapter = new OpenAiCompatibleUtilityModel(VALID_CONFIG);
    const caps1 = adapter.capabilities();
    const caps2 = adapter.capabilities();
    expect(caps1).toBe(caps2);
  });

  it('10. contextWindow reports advertised capability', () => {
    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, contextWindow: 64_000 });
    expect(adapter.capabilities().contextWindow).toBe(64_000);
  });

  it('11. targetInputTokens does NOT replace contextWindow', () => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      contextWindow: 64_000,
      targetInputTokens: 40_000,
    });
    expect(adapter.capabilities().contextWindow).toBe(64_000);
    expect(adapter.capabilities().contextWindow).not.toBe(40_000);
  });

  it('12. tools false works', () => {
    const adapter = new OpenAiCompatibleUtilityModel(VALID_CONFIG);
    expect(adapter.capabilities().tools).toBe(false);
  });

  it('13. streaming false works', () => {
    const adapter = new OpenAiCompatibleUtilityModel(VALID_CONFIG);
    expect(adapter.capabilities().streaming).toBe(false);
  });

  it('14. structuredOutput true/false mapping works', () => {
    const adapterTrue = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, structuredOutput: true });
    expect(adapterTrue.capabilities().structuredOutput).toBe(true);

    const adapterFalse = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, structuredOutput: false });
    expect(adapterFalse.capabilities().structuredOutput).toBe(false);
  });
});

// ─── 3. Health Check (Mandatory Tests 15-20) ─────────────────────────────────

describe('OpenAiCompatibleUtilityModel — Health Check (Tests 15-20)', () => {
  it('15. healthy endpoint -> available', async () => {
    const mockFetch = createMockFetch(({ url, method }) => {
      expect(url).toBe('http://localhost:1234/v1/models');
      expect(method).toBe('GET');
      return jsonResponse({
        data: [{ id: 'qwen2.5-coder-7b-instruct' }, { id: 'other-model' }],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const health = await adapter.healthCheck();
    expect(health.status).toBe('available');
    expect(health.detail).toContain('is available');
  });

  it('16. endpoint connection failure -> unavailable', async () => {
    const mockFetch = createMockFetch(() => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const health = await adapter.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.detail).toContain('ECONNREFUSED');
  });

  it('17. malformed health response -> unavailable', async () => {
    const mockFetch = createMockFetch(() => {
      return textResponse('<html>502 Bad Gateway</html>', 502, 'Bad Gateway');
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const health = await adapter.healthCheck();
    expect(health.status).toBe('unavailable');
  });

  it('18. configured model absent -> unavailable', async () => {
    const mockFetch = createMockFetch(() => {
      return jsonResponse({
        data: [{ id: 'unrelated-model-a' }, { id: 'unrelated-model-b' }],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const health = await adapter.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.detail).toContain('was not found in endpoint models list');
  });

  it('19. API key never appears in health detail', async () => {
    const apiKey = 'super-secret-token-xyz-999';
    const mockFetch = createMockFetch(({ headers }) => {
      expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
      throw new Error(`Unauthorized access with token ${apiKey}`);
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      apiKey,
      fetch: mockFetch,
    });
    const health = await adapter.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.detail).not.toContain(apiKey);
    expect(health.detail).toContain('[REDACTED]');
  });

  it('20. health uses lightweight /models endpoint, not chat inference', async () => {
    let calledUrl = '';
    const mockFetch = createMockFetch(({ url }) => {
      calledUrl = url;
      return jsonResponse({ data: [{ id: 'qwen2.5-coder-7b-instruct' }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    await adapter.healthCheck();
    expect(calledUrl).toBe('http://localhost:1234/v1/models');
    expect(calledUrl).not.toContain('chat/completions');
  });
});

interface CapturedRequestBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  max_tokens?: number;
  response_format?: { type: string };
}

// ─── 4. Plain Inference (Mandatory Tests 21-27) ───────────────────────────────

describe('OpenAiCompatibleUtilityModel — Plain Inference (Tests 21-27)', () => {
  it('21-26. sends model, system, user message; returns text, usage, duration', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({
        id: 'chatcmpl-01',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Here is the summary of the context.',
            },
          },
        ],
        usage: {
          prompt_tokens: 150,
          completion_tokens: 42,
        },
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      injectNoThink: false,
      fetch: mockFetch,
    });

    const input: UtilityModelInput = {
      content: 'This is file A content and file B content.',
      systemInstruction: 'You are a repository context summarizer.',
    };

    const result = await adapter.run(input);

    expect(capturedBody.model).toBe('qwen2.5-coder-7b-instruct');
    expect(capturedBody.messages).toEqual([
      { role: 'system', content: 'You are a repository context summarizer.' },
      { role: 'user', content: 'This is file A content and file B content.' },
    ]);
    expect(capturedBody.max_tokens).toBe(4_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('Here is the summary of the context.');
      expect(result.usage?.inputTokens).toBe(150);
      expect(result.usage?.outputTokens).toBe(42);
      expect(typeof result.usage?.durationMs).toBe('number');
      expect(result.usage?.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('27. respects per-call maxOutputTokens override', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({
        choices: [{ message: { content: 'short' } }],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      maxOutputTokens: 4_000,
      fetch: mockFetch,
    });

    await adapter.run({ content: 'test', maxOutputTokens: 512 });
    expect(capturedBody.max_tokens).toBe(512);
  });
});

// ─── 5. /no_think Normalization (Mandatory Tests 28-32) ──────────────────────

describe('OpenAiCompatibleUtilityModel — /no_think Normalization (Tests 28-32)', () => {
  it('28. injectNoThink=true adds /no_think', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({ choices: [{ message: { content: 'ans' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      injectNoThink: true,
      fetch: mockFetch,
    });

    await adapter.run({
      content: 'hello',
      systemInstruction: 'Provide brief response.',
    });

    expect(capturedBody.messages?.[0]?.role).toBe('system');
    expect(capturedBody.messages?.[0]?.content).toBe('/no_think\nProvide brief response.');
  });

  it('29. existing /no_think is NOT duplicated', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({ choices: [{ message: { content: 'ans' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      injectNoThink: true,
      fetch: mockFetch,
    });

    await adapter.run({
      content: 'hello',
      systemInstruction: '/no_think\nProvide brief response.',
    });

    expect(capturedBody.messages?.[0]?.content).toBe('/no_think\nProvide brief response.');
    expect(capturedBody.messages?.[0]?.content.match(/\/no_think/g)?.length).toBe(1);
  });

  it('30. injectNoThink=false does not alter system instruction', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({ choices: [{ message: { content: 'ans' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      injectNoThink: false,
      fetch: mockFetch,
    });

    await adapter.run({
      content: 'hello',
      systemInstruction: 'Provide brief response.',
    });

    expect(capturedBody.messages?.[0]?.content).toBe('Provide brief response.');
    expect(capturedBody.messages?.[0]?.content).not.toContain('/no_think');
  });

  it('31. no caller system instruction + inject true creates valid system message', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({ choices: [{ message: { content: 'ans' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      injectNoThink: true,
      fetch: mockFetch,
    });

    await adapter.run({ content: 'hello' });

    expect(capturedBody.messages).toEqual([
      { role: 'system', content: '/no_think' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('32. user content remains unchanged', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({ choices: [{ message: { content: 'ans' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      injectNoThink: true,
      fetch: mockFetch,
    });

    const rawUserContent = 'exact user content\nwith /no_think mentioned inside user text';
    await adapter.run({ content: rawUserContent });

    const userMessage = capturedBody.messages?.find((m) => m.role === 'user');
    expect(userMessage?.content).toBe(rawUserContent);
  });
});

// ─── 6. Structured Output (Mandatory Tests 33-37) ────────────────────────────

describe('OpenAiCompatibleUtilityModel — Structured Output (Tests 33-37)', () => {
  const schema = {
    type: 'object',
    properties: {
      relevantFiles: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
    },
    required: ['relevantFiles', 'confidence'],
  };

  it('33. desiredOutputSchema translates to OpenAI response_format json_object and schema prompt', async () => {
    let capturedBody: CapturedRequestBody = {};
    const mockFetch = createMockFetch(({ body }) => {
      capturedBody = JSON.parse(body!) as CapturedRequestBody;
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ relevantFiles: ['src/a.ts'], confidence: 0.95 }),
            },
          },
        ],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: mockFetch,
    });

    await adapter.run({
      content: 'Find files',
      desiredOutputSchema: schema,
    });

    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
    const systemMsg = capturedBody.messages?.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('You must respond with a valid JSON object matching this schema');
    expect(systemMsg?.content).toContain('relevantFiles');
  });

  it('34. valid JSON response populates structured field', async () => {
    const payload = { relevantFiles: ['src/main.ts', 'src/util.ts'], confidence: 0.98 };
    const mockFetch = createMockFetch(() => {
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({
      content: 'Find files',
      desiredOutputSchema: schema,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.structured).toEqual(payload);
    }
  });

  it('35. malformed JSON returns invalid_response', async () => {
    const mockFetch = createMockFetch(() => {
      return jsonResponse({
        choices: [{ message: { content: 'Not a JSON payload at all.' } }],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({
      content: 'Find files',
      desiredOutputSchema: schema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('invalid_response');
      expect(result.message).toContain('Failed to parse structured JSON output');
    }
  });

  it('36. <think> polluted response returns invalid_response rather than arbitrary extraction', async () => {
    const pollutedResponse = '<think>\nThinking through the files...\n</think>\n{"relevantFiles": ["a.ts"], "confidence": 1}';
    const mockFetch = createMockFetch(() => {
      return jsonResponse({
        choices: [{ message: { content: pollutedResponse } }],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({
      content: 'Find files',
      desiredOutputSchema: schema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('invalid_response');
    }
  });

  it('37. plain mode does not require JSON', async () => {
    const mockFetch = createMockFetch(() => {
      return jsonResponse({
        choices: [{ message: { content: 'Plain text markdown summary here.' } }],
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({ content: 'Summarize context' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('Plain text markdown summary here.');
      expect(result.structured).toBeUndefined();
    }
  });
});

// ─── 7. Context Budget & Preflight (Mandatory Tests 38-44) ───────────────────

describe('OpenAiCompatibleUtilityModel — Budget & Preflight (Tests 38-44)', () => {
  it('38. input under targetInputTokens is sent', async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      targetInputTokens: 40_000,
      fetch: mockFetch,
    });

    const result = await adapter.run({ content: 'Small text easily fitting in 40k budget.' });
    expect(result.ok).toBe(true);
    expect(callCount).toBe(1);
  });

  it('39-40. estimated input above targetInputTokens returns context_limit with ZERO HTTP calls', async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      targetInputTokens: 100, // Very low budget for test
      contextWindow: 1_000,
      fetch: mockFetch,
    });

    // Content large enough to exceed 100 tokens (> 300 chars)
    const largeContent = 'word '.repeat(150);
    const result = await adapter.run({ content: largeContent });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('context_limit');
      expect(result.message).toContain('exceeds target input budget');
    }
    expect(callCount).toBe(0); // ZERO network calls
  });

  it('41. systemInstruction counts toward estimate', async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      targetInputTokens: 50,
      contextWindow: 500,
      fetch: mockFetch,
    });

    // Small content + large system instruction
    const result = await adapter.run({
      content: 'small',
      systemInstruction: 'instruction '.repeat(100),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('context_limit');
    }
    expect(callCount).toBe(0);
  });

  it('42. schema text/structured instructions count toward estimate', async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      targetInputTokens: 50,
      contextWindow: 500,
      fetch: mockFetch,
    });

    const complexSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`field_${i}`, { type: 'string', description: `field description ${i}` }]),
      ),
    };

    const result = await adapter.run({
      content: 'small content',
      desiredOutputSchema: complexSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('context_limit');
    }
    expect(callCount).toBe(0);
  });

  it('43. /no_think overhead is included in estimate', async () => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      targetInputTokens: 8, // borderline budget
      contextWindow: 100,
      injectNoThink: true,
      fetch: createMockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] })),
    });

    const result = await adapter.run({ content: 'test content' });
    // User content (~4 tokens) + primer (3) + envelope (4) + no_think (~4) = ~15 tokens > 8
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('context_limit');
    }
  });

  it('44. maxOutputTokens handling does not count output budget as input', async () => {
    let callCount = 0;
    const mockFetch = createMockFetch(() => {
      callCount++;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      targetInputTokens: 100,
      contextWindow: 10_000,
      maxOutputTokens: 4_000, // maxOutputTokens is large, but input is small
      fetch: mockFetch,
    });

    const result = await adapter.run({ content: 'small content' });
    expect(result.ok).toBe(true);
    expect(callCount).toBe(1);
  });
});

// ─── 8. Failures, Errors & Security (Mandatory Tests 45-53) ───────────────────

describe('OpenAiCompatibleUtilityModel — Failures & Security (Tests 45-53)', () => {
  it('45. connection refused -> unavailable', async () => {
    const mockFetch = createMockFetch(() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:1234');
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({ content: 'hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('unavailable');
      expect(result.message).toContain('Endpoint unreachable');
    }
  });

  it('46. timeout -> timeout', async () => {
    const mockFetch = createMockFetch(({ signal }) => {
      return new Promise((_, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      timeoutSeconds: 0.05, // 50ms fast timeout
      fetch: mockFetch,
    });

    const result = await adapter.run({ content: 'hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('timeout');
      expect(result.message).toContain('timed out');
    }
  });

  it('47. malformed 200 -> invalid_response', async () => {
    const mockFetch = createMockFetch(() => {
      return textResponse('not valid json at all', 200);
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({ content: 'hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('invalid_response');
    }
  });

  it('48. HTTP 500 / 503 -> normalized failure', async () => {
    const mockFetch500 = createMockFetch(() => {
      return jsonResponse({ error: 'Internal server error' }, 500, 'Internal Server Error');
    });

    const adapter500 = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch500 });
    const res500 = await adapter500.run({ content: 'hello' });
    expect(res500.ok).toBe(false);
    if (!res500.ok) {
      expect(res500.errorCode).toBe('execution_failed');
      expect(res500.message).toContain('HTTP 500');
    }

    const mockFetch503 = createMockFetch(() => {
      return jsonResponse({ error: 'Service Unavailable' }, 503, 'Service Unavailable');
    });
    const adapter503 = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch503 });
    const res503 = await adapter503.run({ content: 'hello' });
    expect(res503.ok).toBe(false);
    if (!res503.ok) {
      expect(res503.errorCode).toBe('unavailable');
    }
  });

  it('49. provider context rejection (HTTP 413) -> context_limit', async () => {
    const mockFetch = createMockFetch(() => {
      return jsonResponse({ error: 'Prompt is too long' }, 413, 'Payload Too Large');
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({ content: 'hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('context_limit');
      expect(result.message).toContain('Context limit exceeded');
    }
  });

  it('50. HTTP 401 / generic error -> execution_failed', async () => {
    const mockFetch = createMockFetch(() => {
      return jsonResponse({ error: 'Unauthorized' }, 401, 'Unauthorized');
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({ content: 'hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('execution_failed');
      expect(result.message).toContain('Authentication failed (HTTP 401)');
    }
  });

  it('51. standard failures are returned, not thrown', async () => {
    const mockFetch = createMockFetch(() => {
      throw new TypeError('Network down');
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    await expect(adapter.run({ content: 'hello' })).resolves.toEqual(
      expect.objectContaining({ ok: false, errorCode: 'unavailable' }),
    );
  });

  it('52. raw response bodies do not leak secrets or full stack traces', async () => {
    const mockFetch = createMockFetch(() => {
      return textResponse('Secret internal database string or credentials', 500, 'Internal Server Error');
    });

    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch: mockFetch });
    const result = await adapter.run({ content: 'hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('Secret internal database string');
      expect(result.message).toBe('HTTP 500: Internal Server Error');
    }
  });

  it('53. API key never leaks in failure message', async () => {
    const apiKey = 'sk-prod-secret-999-never-leak';
    const mockFetch = createMockFetch(() => {
      throw new Error(`Failed to authenticate with token ${apiKey}`);
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      apiKey,
      fetch: mockFetch,
    });

    const result = await adapter.run({ content: 'hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(apiKey);
      expect(result.message).toContain('[REDACTED]');
    }
  });
});
