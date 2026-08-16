import { describe, it, expect, vi } from 'vitest';
import {
  OpenAiCompatibleUtilityModel,
  type OpenAiCompatibleUtilityModelConfig,
} from '../../../src/adapters/utility-model/openai-utility-model.js';
import { estimateInputTokens } from '../../../src/adapters/utility-model/token-estimator.js';
import type { UtilityModelInput } from '../../../src/ports/utility-model.js';
import { FixedClock } from '../../fakes/fixed-clock.js';

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
    expect(health.detail).toBe('Health probe failed');
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
    expect(health.detail).toBe('Health probe failed');
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
      expect(result.message).toBe('Utility model endpoint unavailable');
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
      expect(result.message).toBe('Inference execution failed (HTTP 500)');
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
      expect(result.message).toBe('Utility model endpoint unavailable');
    }
  });
});

describe('OpenAiCompatibleUtilityModel — effective telemetry provenance (M3-07)', () => {
  it('reports estimates and only the provider/model actually established by the response', async () => {
    const configuredModel = 'configured-intent-is-not-proof';
    const mockFetch = createMockFetch(() =>
      jsonResponse({
        model: 'effective-model-from-response',
        choices: [{ message: { content: 'bounded output' } }],
      }),
    );
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      model: configuredModel,
      fetch: mockFetch,
    });

    const result = await adapter.run({ content: 'bounded input' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage?.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.usage?.estimatedOutputTokens).toBeGreaterThan(0);
      expect(result.provenance).toEqual({
        provider: 'openai-compatible',
        model: 'effective-model-from-response',
      });
      expect(result.provenance?.model).not.toBe(configuredModel);
    }
  });

  it('estimates the exact assembled structured prompt once rather than counting its schema twice', async () => {
    const schema = { type: 'object', properties: { result: { type: 'string' } } };
    const content = 'bounded input';
    const systemInstruction = 'Return a concise result.';
    let assembledSystemInstruction = '';
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      injectNoThink: false,
      fetch: createMockFetch(({ body }) => {
        const request = JSON.parse(body!) as CapturedRequestBody;
        assembledSystemInstruction = request.messages?.find(({ role }) => role === 'system')?.content ?? '';
        return jsonResponse({ choices: [{ message: { content: '{"result":"ok"}' } }] });
      }),
    });

    const result = await adapter.run({ content, systemInstruction, desiredOutputSchema: schema });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage?.estimatedInputTokens).toBe(
        estimateInputTokens({ content, systemInstruction: assembledSystemInstruction }),
      );
    }
  });

  it('never treats configured id, URL, or requested model as effective model proof', async () => {
    const secretUrl = 'http://user:password@localhost:1234/v1?token=do-not-leak';
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      id: 'configured-id-do-not-report',
      baseUrl: secretUrl,
      model: 'requested-model-do-not-report',
      fetch: createMockFetch(() =>
        jsonResponse({ choices: [{ message: { content: 'answer' } }] }),
      ),
    });

    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance).toEqual({ provider: 'openai-compatible' });
      expect(JSON.stringify({ usage: result.usage, provenance: result.provenance })).not.toMatch(
        /password|token=|configured-id|requested-model/,
      );
    }
  });

  it.each([
    ['blank', ''],
    ['surrounding whitespace', ' served-model '],
    ['control', 'served\nmodel'],
    ['format control', 'served\u200Bmodel'],
    ['lone surrogate', 'served\uD800model'],
    ['overlong', 'm'.repeat(201)],
    ['URL-shaped', 'http://localhost/private-model'],
    ['authorization-shaped', 'Bearer sk-response-secret'],
    ['credential-shaped', 'api_key=sk-response-secret'],
    ['non-string', { id: 'served-model' }],
  ])('omits unsafe response model identity: %s', async (_label, model) => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() =>
        jsonResponse({ model, choices: [{ message: { content: 'answer' } }] }),
      ),
    });

    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance).toEqual({ provider: 'openai-compatible' });
  });

  it('omits a bounded but non-ASCII response model identity conservatively', async () => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() =>
        jsonResponse({ model: 'moe-café/版本-1', choices: [{ message: { content: 'answer' } }] }),
      ),
    });

    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance).toEqual({ provider: 'openai-compatible' });
  });

  it('omits a response model that contains the configured API key', async () => {
    const apiKey = 'sk-configured-secret-never-report';
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      apiKey,
      fetch: createMockFetch(() =>
        jsonResponse({ model: `model-${apiKey}`, choices: [{ message: { content: 'answer' } }] }),
      ),
    });

    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance).toEqual({ provider: 'openai-compatible' });
      expect(JSON.stringify(result.provenance)).not.toContain(apiKey);
    }
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, 100_000_001])(
    'omits unsafe provider token usage %s while retaining estimates',
    async (unsafeCount) => {
      const adapter = new OpenAiCompatibleUtilityModel({
        ...VALID_CONFIG,
        fetch: createMockFetch(() =>
          jsonResponse({
            model: 'served-model',
            choices: [{ message: { content: 'answer' } }],
            usage: { prompt_tokens: unsafeCount, completion_tokens: unsafeCount },
          }),
        ),
      });

      const result = await adapter.run({ content: 'input' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.usage?.inputTokens).toBeUndefined();
        expect(result.usage?.outputTokens).toBeUndefined();
        expect(result.usage?.estimatedInputTokens).toBeGreaterThan(0);
        expect(result.usage?.estimatedOutputTokens).toBeGreaterThan(0);
      }
    },
  );

  it('preserves explicit provider zero counts rather than confusing them with absence', async () => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() =>
        jsonResponse({
          choices: [{ message: { content: '' } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      ),
    });

    const result = await adapter.run({ content: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage?.inputTokens).toBe(0);
      expect(result.usage?.outputTokens).toBe(0);
      expect(result.usage?.estimatedOutputTokens).toBe(0);
    }
  });

  it.each([
    ['HTTP', () => textResponse('secret response', 500, 'secret status text')],
    ['non-JSON', () => textResponse('secret response', 200)],
    ['shape', () => jsonResponse({ model: 'served-model', choices: [] })],
  ])('carries measured safe duration on %s failure without free-form details', async (_kind, response) => {
    const clock = new FixedClock();
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      clock,
      fetch: createMockFetch(() => {
        clock.advance(37);
        return response();
      }),
    });

    const result = await adapter.run({ content: 'input containing secret-input-value' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.usage?.durationMs).toBe(37);
      expect(result.usage?.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.message).not.toMatch(/secret|localhost|https?:\/\/|input-value/i);
      expect(result.provenance?.provider).toBe('openai-compatible');
    }
  });

  it('carries output estimate, safe response model, and latency on structured-output parse failure', async () => {
    const clock = new FixedClock();
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      clock,
      fetch: createMockFetch(() => {
        clock.advance(41);
        return jsonResponse({
          model: 'served-model',
          choices: [{ message: { content: 'not-json' } }],
        });
      }),
    });

    const result = await adapter.run({
      content: 'input',
      desiredOutputSchema: { type: 'object' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('invalid_response');
      expect(result.usage?.estimatedOutputTokens).toBeGreaterThan(0);
      expect(result.usage?.durationMs).toBe(41);
      expect(result.provenance).toEqual({ provider: 'openai-compatible', model: 'served-model' });
    }
  });

  it('carries measured duration on network and timeout failures without exception details', async () => {
    for (const kind of ['network', 'timeout'] as const) {
      const clock = new FixedClock();
      const secret = 'sk-secret-in-exception-and-url';
      const adapter = new OpenAiCompatibleUtilityModel({
        ...VALID_CONFIG,
        apiKey: secret,
        timeoutSeconds: 0.01,
        clock,
        fetch: createMockFetch(({ signal }) => {
          if (kind === 'network') {
            clock.advance(23);
            throw new Error(`Bearer ${secret} http://localhost/private response-body`);
          }
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              clock.advance(29);
              const error = new Error(`Bearer ${secret} http://localhost/private response-body`);
              error.name = 'AbortError';
              reject(error);
            });
          });
        }),
      });

      const result = await adapter.run({ content: 'input' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.usage?.durationMs).toBe(kind === 'network' ? 23 : 29);
        expect(result.message).not.toMatch(/secret|Bearer|http|response-body/);
        expect(result.provenance).toEqual({ provider: 'openai-compatible' });
      }
    }
  });

  it.each([
    ['NaN clock', [NaN, NaN]],
    ['infinite clock', [Infinity, Infinity]],
    ['negative elapsed', [100, 99]],
    ['huge elapsed', [0, 86_400_001]],
  ])(
    'omits unsafe measured duration: %s rather than coercing it to zero',
    async (_label, clockValues) => {
      let index = 0;
      const clock = {
        now: () => '2026-01-01T00:00:00.000Z',
        monotonicMs: () => clockValues[Math.min(index++, clockValues.length - 1)]!,
      };
      const adapter = new OpenAiCompatibleUtilityModel({
        ...VALID_CONFIG,
        clock,
        fetch: createMockFetch(() => jsonResponse({ choices: [{ message: { content: 'answer' } }] })),
      });

      const result = await adapter.run({ content: 'input' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.usage?.durationMs).toBeUndefined();
    },
  );

  it('preserves finite fractional monotonic latency from the production clock contract', async () => {
    const values = [10.25, 12.75];
    let index = 0;
    const clock = {
      now: () => '2026-01-01T00:00:00.000Z',
      monotonicMs: () => values[Math.min(index++, values.length - 1)]!,
    };
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      clock,
      fetch: createMockFetch(() => jsonResponse({ choices: [{ message: { content: 'answer' } }] })),
    });

    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage?.durationMs).toBe(2.5);
  });

  it('deep-freezes telemetry and provenance contracts', async () => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() =>
        jsonResponse({ model: 'served-model', choices: [{ message: { content: 'answer' } }] }),
      ),
    });
    const result = await adapter.run({ content: 'input' });

    expect(Object.isFrozen(adapter.capabilities())).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
  });
});

describe('OpenAiCompatibleUtilityModel — hostile DTO snapshots (M3-07 review)', () => {
  it('rejects request accessors without reading changing content or maxOutputTokens', async () => {
    let contentReads = 0;
    let maxTokenReads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperties(input, {
      content: {
        enumerable: true,
        get: () => (++contentReads === 1 ? 'nine tokens' : `secret-content ${'x'.repeat(20_000)}`),
      },
      maxOutputTokens: {
        enumerable: true,
        get: () => (++maxTokenReads === 1 ? 1 : 6_000),
      },
    });
    const fetch = createMockFetch(() => jsonResponse({ choices: [{ message: { content: 'answer' } }] }));
    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch });

    const result = await adapter.run(input as unknown as UtilityModelInput);

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_response',
      message: 'Invalid utility model input',
    });
    expect(contentReads).toBe(0);
    expect(maxTokenReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret-content');
  });

  it('rejects inherited input fields and proxies without invoking their traps', async () => {
    const inherited = Object.create({ content: 'inherited secret' }) as UtilityModelInput;
    const proxy = new Proxy({ content: 'safe' }, {
      getPrototypeOf: () => {
        throw new Error('secret proxy trap detail');
      },
    });
    const fetch = createMockFetch(() => jsonResponse({ choices: [{ message: { content: 'answer' } }] }));
    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch });

    for (const input of [inherited, proxy as UtilityModelInput]) {
      const result = await adapter.run(input);
      expect(result).toEqual({
        ok: false,
        errorCode: 'invalid_response',
        message: 'Invalid utility model input',
      });
      expect(JSON.stringify(result)).not.toMatch(/secret|proxy|trap|inherited/i);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('closes schema serialization and proxy failures without invoking toJSON or leaking thrown detail', async () => {
    let toJsonCalls = 0;
    const schema = {
      type: 'object',
      toJSON: () => {
        toJsonCalls += 1;
        throw new Error('secret-schema-throw-detail');
      },
    };
    const proxySchema = new Proxy({ type: 'object' }, {
      getPrototypeOf: () => {
        throw new Error('secret-schema-proxy-detail');
      },
    });
    const fetch = createMockFetch(() => jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch });

    for (const desiredOutputSchema of [schema, proxySchema]) {
      await expect(adapter.run({ content: 'input', desiredOutputSchema })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_response',
        message: 'Invalid utility model input',
      });
    }
    expect(toJsonCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'X-Api-Key sk-response-secret',
    'Cookie session=sk-response-secret',
    'plain model identity prose',
    'postgres://user:secret@localhost/database',
    'model\\windows',
    'model=value',
    'moe-café',
  ])('omits non-identifier response model provenance: %s', async (model) => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() =>
        jsonResponse({ model, choices: [{ message: { content: 'answer' } }] }),
      ),
    });

    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance).toEqual({ provider: 'openai-compatible' });
      expect(JSON.stringify(result.provenance)).not.toContain(model);
    }
  });

  it('accepts a response-proven slash-delimited model alias with conservative identifier segments', async () => {
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() =>
        jsonResponse({ model: 'Qwen/Qwen3.5-30B_A3B', choices: [{ message: { content: 'answer' } }] }),
      ),
    });
    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance?.model).toBe('Qwen/Qwen3.5-30B_A3B');
  });

  it('rejects patched response methods and inherited/accessor completion properties without reading them', async () => {
    let modelReads = 0;
    let choicesReads = 0;
    const maliciousData = Object.create({ model: 'inherited-secret-model' }) as Record<string, unknown>;
    Object.defineProperties(maliciousData, {
      model: {
        enumerable: true,
        get: () => {
          modelReads += 1;
          return 'accessor-secret-model';
        },
      },
      choices: {
        enumerable: true,
        get: () => {
          choicesReads += 1;
          return [{ message: { content: 'secret response' } }];
        },
      },
    });
    const response = jsonResponse({ choices: [{ message: { content: 'safe body' } }] });
    Object.defineProperty(response, 'json', { value: async () => maliciousData });
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() => response),
    });

    const result = await adapter.run({ content: 'input' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_response',
      message: 'Invalid utility model response',
      usage: expect.objectContaining({ estimatedInputTokens: expect.any(Number) }),
      provenance: { provider: 'openai-compatible' },
    });
    expect(modelReads).toBe(0);
    expect(choicesReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    { ok: false, status: '599 X-Api-Key: secret-status', statusText: 'secret status text' },
    Object.create({ ok: false, status: 599, statusText: 'inherited secret status' }),
    Object.defineProperty({ ok: false }, 'status', {
      get: () => {
        throw new Error('secret status accessor');
      },
    }),
    { ok: false, status: 99 },
    { ok: false, status: 600 },
  ])('rejects non-native or unsafe HTTP status without formatting its value: %#', async (response) => {
    const fetch = createMockFetch(() => response as unknown as Response);
    const adapter = new OpenAiCompatibleUtilityModel({ ...VALID_CONFIG, fetch });

    const result = await adapter.run({ content: 'input' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_response',
      message: 'Invalid utility model response',
      usage: expect.objectContaining({ estimatedInputTokens: expect.any(Number) }),
      provenance: { provider: 'openai-compatible' },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-status|X-Api-Key|status accessor|inherited secret/);
  });

  it('does not inspect a hostile thrown value while normalizing fetch failure', async () => {
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error('secret thrown proxy detail');
      },
      get: () => {
        throw new Error('secret thrown getter detail');
      },
    });
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() => {
        throw hostile;
      }),
    });

    await expect(adapter.run({ content: 'input' })).resolves.toEqual({
      ok: false,
      errorCode: 'unavailable',
      message: 'Utility model endpoint unavailable',
      usage: expect.objectContaining({ estimatedInputTokens: expect.any(Number) }),
      provenance: { provider: 'openai-compatible' },
    });
  });

  it('accepts a native Response that carries engine-internal own symbol slots', async () => {
    // Node's undici Response stores its state in own symbol properties
    // (Symbol(state), Symbol(headers)). A snapshot boundary that treated every
    // own property as hostile rejected every genuine Response and made the whole
    // adapter unusable. Only own string-keyed properties can shadow the native
    // status getter or json method, so symbols must be allowed through.
    const healthApiResponse = () =>
      new Response(JSON.stringify({ data: [{ id: VALID_CONFIG.model }] }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      });
    const chatApiResponse = () =>
      new Response(
        JSON.stringify({ model: 'Qwen/Qwen3.5-30B_A3B', choices: [{ message: { content: 'answer' } }] }),
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } },
      );
    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(({ url }) =>
        url.endsWith('/models') ? healthApiResponse() : chatApiResponse(),
      ),
    });

    const health = await adapter.healthCheck();
    expect(health.status).toBe('available');

    const result = await adapter.run({ content: 'input' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance?.model).toBe('Qwen/Qwen3.5-30B_A3B');
  });

  it('rejects a native Response shadowed with an own string-keyed json property', async () => {
    const response = new Response(JSON.stringify({ choices: [{ message: { content: 'safe' } }] }), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    });
    Object.defineProperty(response, 'json', {
      value: async () => {
        throw new Error('secret-shadowed-json-detail');
      },
      enumerable: true,
      configurable: true,
    });

    const adapter = new OpenAiCompatibleUtilityModel({
      ...VALID_CONFIG,
      fetch: createMockFetch(() => response),
    });

    const result = await adapter.run({ content: 'input' });
    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_response',
      message: 'Invalid utility model response',
      usage: expect.objectContaining({ estimatedInputTokens: expect.any(Number) }),
      provenance: { provider: 'openai-compatible' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-shadowed');
  });
});
