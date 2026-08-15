import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateInputTokens,
} from '../../../src/adapters/utility-model/token-estimator.js';

describe('estimateTokens', () => {
  it('returns 0 for empty or null string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates conservative token count for short text', () => {
    const text = 'Hello world';
    const tokens = estimateTokens(text);
    // 11 chars / 3 = 4, 2 words * 1.3 = 3 -> max is 4
    expect(tokens).toBeGreaterThanOrEqual(3);
    expect(tokens).toBeLessThanOrEqual(10);
  });

  it('estimates conservative token count for code snippet with special symbols', () => {
    const code = 'function calculateBudget(a: number, b: number): number { return a + b; }';
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(100);
  });

  it('scales conservatively with large content', () => {
    const largeText = 'a'.repeat(30_000);
    const tokens = estimateTokens(largeText);
    // 30_000 / 3.0 = 10_000
    expect(tokens).toBe(10_000);
  });
});

describe('estimateInputTokens', () => {
  it('includes message envelopes and primer overhead', () => {
    const tokens = estimateInputTokens({ content: 'test content' });
    // User message overhead (4) + Primer (3) + Content (~4) = ~11 tokens
    expect(tokens).toBeGreaterThan(7);
  });

  it('includes system instruction overhead when present', () => {
    const withoutSystem = estimateInputTokens({ content: 'test' });
    const withSystem = estimateInputTokens({
      content: 'test',
      systemInstruction: 'You are a helpful assistant.',
    });
    expect(withSystem).toBeGreaterThan(withoutSystem);
  });

  it('includes /no_think overhead when injectNoThink is true', () => {
    const withoutNoThink = estimateInputTokens({ content: 'test' });
    const withNoThink = estimateInputTokens({ content: 'test', injectNoThink: true });
    expect(withNoThink).toBeGreaterThan(withoutNoThink);
  });

  it('includes desiredOutputSchema stringification in token budget', () => {
    const schema = {
      type: 'object',
      properties: {
        classification: { type: 'string', enum: ['TRIVIAL', 'STANDARD', 'HIGH-RISK'] },
        confidence: { type: 'number' },
      },
      required: ['classification', 'confidence'],
    };

    const withoutSchema = estimateInputTokens({ content: 'test' });
    const withSchema = estimateInputTokens({ content: 'test', desiredOutputSchema: schema });
    expect(withSchema).toBeGreaterThan(withoutSchema + 30);
  });

  it('combines content, systemInstruction, schema, and /no_think overhead deterministically', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } } };
    const tokens = estimateInputTokens({
      content: 'Context to compress.',
      systemInstruction: 'Be concise.',
      desiredOutputSchema: schema,
      injectNoThink: true,
    });

    expect(tokens).toBeGreaterThan(30);
  });
});
