import { describe, it, expect } from 'vitest';
import { FakeUtilityModel } from '../fakes/fake-utility-model.js';
import { UTILITY_MODEL_ERROR_CODES } from '../../src/ports/index.js';
import type {
  UtilityModelCapabilities,
  UtilityModelInput,
} from '../../src/ports/index.js';

/**
 * Tests for the UtilityModel port (M3-01).
 *
 * These tests exercise the shape and semantics of the port contracts and the
 * FakeUtilityModel test double. They are offline — no network, no real model.
 */

const BASE_INPUT: UtilityModelInput = {
  content: 'Summarise this context.',
  correlationId: 'test-001',
};

// ─── Capability contract ──────────────────────────────────────────────────────

describe('UtilityModelCapabilities', () => {
  it('accepts valid capability combinations', () => {
    const caps: UtilityModelCapabilities = {
      contextWindow: 32_768,
      structuredOutput: true,
      tools: false,
      streaming: false,
    };
    expect(caps.contextWindow).toBe(32_768);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.tools).toBe(false);
    expect(caps.streaming).toBe(false);
  });

  it('accepts a model with structuredOutput false', () => {
    const caps: UtilityModelCapabilities = {
      contextWindow: 4096,
      structuredOutput: false,
      tools: false,
      streaming: false,
    };
    expect(caps.structuredOutput).toBe(false);
  });

  it('accepts a model with tools true', () => {
    const caps: UtilityModelCapabilities = {
      contextWindow: 128_000,
      structuredOutput: true,
      tools: true,
      streaming: false,
    };
    expect(caps.tools).toBe(true);
  });

  it('accepts a model with streaming true', () => {
    const caps: UtilityModelCapabilities = {
      contextWindow: 128_000,
      structuredOutput: false,
      tools: false,
      streaming: true,
    };
    expect(caps.streaming).toBe(true);
  });

  it('capabilities are stable — same reference returned on repeated calls', () => {
    const fake = new FakeUtilityModel();
    expect(fake.capabilities()).toBe(fake.capabilities());
  });

  it('contextWindow from capabilities is the advertised bound, not an enforced budget', () => {
    // M3-00 finding: the safe operational input budget may be lower than the
    // advertised contextWindow. The port does not enforce a budget — that is
    // the adapter's responsibility. This test documents the intent.
    const caps: UtilityModelCapabilities = {
      contextWindow: 64_000,
      structuredOutput: true,
      tools: false,
      streaming: false,
    };
    // The number 40_000 (the M3-00 operational budget) must not be the
    // contextWindow itself — contextWindow is the provider's nominal maximum.
    expect(caps.contextWindow).not.toBe(40_000);
  });
});

// ─── Error vocabulary ─────────────────────────────────────────────────────────

describe('UTILITY_MODEL_ERROR_CODES', () => {
  it('includes unavailable for offline / unreachable scenarios', () => {
    expect(UTILITY_MODEL_ERROR_CODES).toContain('unavailable');
  });

  it('includes timeout for slow inference', () => {
    expect(UTILITY_MODEL_ERROR_CODES).toContain('timeout');
  });

  it('includes invalid_response for unparseable output', () => {
    expect(UTILITY_MODEL_ERROR_CODES).toContain('invalid_response');
  });

  it('includes context_limit for oversized inputs', () => {
    expect(UTILITY_MODEL_ERROR_CODES).toContain('context_limit');
  });

  it('includes execution_failed as catch-all', () => {
    expect(UTILITY_MODEL_ERROR_CODES).toContain('execution_failed');
  });
});

// ─── FakeUtilityModel — healthy path ─────────────────────────────────────────

describe('FakeUtilityModel — healthy path', () => {
  it('reports capabilities without any network or I/O', () => {
    const fake = new FakeUtilityModel();
    const caps = fake.capabilities();
    expect(typeof caps.contextWindow).toBe('number');
    expect(typeof caps.structuredOutput).toBe('boolean');
    expect(typeof caps.tools).toBe('boolean');
    expect(typeof caps.streaming).toBe('boolean');
  });

  it('returns available health when configured as healthy', async () => {
    const fake = new FakeUtilityModel();
    const health = await fake.healthCheck();
    expect(health.status).toBe('available');
  });

  it('returns the configured text result', async () => {
    const fake = new FakeUtilityModel().pushText('summary result');
    const result = await fake.run(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('summary result');
    }
  });

  it('replays queued responses in order, then falls back to the default', async () => {
    const fake = new FakeUtilityModel().pushText('first').pushText('second');
    const opts = BASE_INPUT;

    const r1 = await fake.run(opts);
    const r2 = await fake.run(opts);
    const r3 = await fake.run(opts); // fallback: empty text

    expect(r1.ok && r1.text).toBe('first');
    expect(r2.ok && r2.text).toBe('second');
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.text).toBe('');
  });

  it('returns structured output when configured', async () => {
    const payload = { decision: 'TRIVIAL', rationale: 'small change' };
    const fake = new FakeUtilityModel().pushStructured(JSON.stringify(payload), payload);
    const result = await fake.run(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.structured).toEqual(payload);
    }
  });
});

// ─── FakeUtilityModel — unavailable path ─────────────────────────────────────

describe('FakeUtilityModel — unavailable path', () => {
  it('returns unavailable health when configured so', async () => {
    const fake = new FakeUtilityModel('my-model', undefined as unknown as never, {
      status: 'unavailable',
      detail: 'connection refused',
    });
    const health = await fake.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.detail).toBe('connection refused');
  });

  it('setHealth transitions the fake from available to unavailable', async () => {
    const fake = new FakeUtilityModel();
    expect((await fake.healthCheck()).status).toBe('available');
    fake.setHealth({ status: 'unavailable', detail: 'server down' });
    expect((await fake.healthCheck()).status).toBe('unavailable');
  });

  it('returns a failure result when configured to fail', async () => {
    const fake = new FakeUtilityModel().pushFailure('unavailable');
    const result = await fake.run(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('unavailable');
    }
  });

  it('returns timeout failure code', async () => {
    const fake = new FakeUtilityModel().pushFailure('timeout', 'inference timed out');
    const result = await fake.run(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('timeout');
      expect(result.message).toBe('inference timed out');
    }
  });

  it('returns invalid_response failure code', async () => {
    const fake = new FakeUtilityModel().pushFailure('invalid_response');
    const result = await fake.run(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('invalid_response');
  });

  it('returns context_limit failure code', async () => {
    const fake = new FakeUtilityModel().pushFailure('context_limit');
    const result = await fake.run(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('context_limit');
  });
});

// ─── FakeUtilityModel — input recording ──────────────────────────────────────

describe('FakeUtilityModel — input recording', () => {
  it('records the exact input it receives', async () => {
    const fake = new FakeUtilityModel();
    const input: UtilityModelInput = {
      content: 'check this context',
      systemInstruction: 'be concise',
      correlationId: 'run-001',
    };
    await fake.run(input);
    expect(fake.lastCall).toEqual(input);
  });

  it('records calls from multiple invocations', async () => {
    const fake = new FakeUtilityModel();
    await fake.run({ content: 'a' });
    await fake.run({ content: 'b' });
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0]?.content).toBe('a');
    expect(fake.calls[1]?.content).toBe('b');
  });

  it('exposes callCount', async () => {
    const fake = new FakeUtilityModel();
    expect(fake.callCount).toBe(0);
    await fake.run(BASE_INPUT);
    expect(fake.callCount).toBe(1);
  });
});

// ─── FakeUtilityModel — always() fallback ────────────────────────────────────

describe('FakeUtilityModel — always() fallback', () => {
  it('uses the always() result after the queue is exhausted', async () => {
    const fake = new FakeUtilityModel().pushText('first').always({ ok: true, text: 'rest' });
    await fake.run(BASE_INPUT); // consumes 'first'
    const second = await fake.run(BASE_INPUT);
    expect(second.ok && second.text).toBe('rest');
  });

  it('always() with a failure keeps producing failures', async () => {
    const fake = new FakeUtilityModel().always({ ok: false, errorCode: 'unavailable', message: 'down' });
    for (let i = 0; i < 3; i++) {
      const r = await fake.run(BASE_INPUT);
      expect(r.ok).toBe(false);
    }
  });
});

// ─── Authority boundary ───────────────────────────────────────────────────────

describe('UtilityModel authority boundary', () => {
  it('does not expose shell execution methods', () => {
    const fake = new FakeUtilityModel();
    const keys = Object.keys(Object.getPrototypeOf(fake) as object);
    for (const forbidden of ['exec', 'spawn', 'shell', 'git', 'writeFile', 'readFile']) {
      expect(keys.includes(forbidden), `UtilityModel exposes ${forbidden}`).toBe(false);
    }
  });

  it('input does not carry shell commands, git refs, or filesystem authority', () => {
    // The input type itself is the boundary. This test documents that content is
    // plain text — a caller cannot accidentally pass a shell command via a field
    // that carries operator authority.
    const input: UtilityModelInput = {
      content: 'some text to process',
      systemInstruction: 'answer concisely',
      desiredOutputSchema: { type: 'object' },
      maxOutputTokens: 512,
      correlationId: 'id-001',
    };

    // Enumerate the fields that exist. None of them are operational commands.
    const knownFields = ['content', 'systemInstruction', 'desiredOutputSchema', 'maxOutputTokens', 'correlationId'];
    const actualFields = Object.keys(input);
    for (const field of actualFields) {
      expect(knownFields.includes(field), `Unexpected field ${field} in UtilityModelInput`).toBe(true);
    }
  });
});
