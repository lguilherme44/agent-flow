import { describe, it, expect } from 'vitest';
import { clampReasoning, compareReasoning, highestSupported } from '../../src/core/reasoning.js';

describe('compareReasoning', () => {
  it('orders levels low → very_high', () => {
    expect(compareReasoning('low', 'medium')).toBeLessThan(0);
    expect(compareReasoning('very_high', 'high')).toBeGreaterThan(0);
    expect(compareReasoning('high', 'high')).toBe(0);
  });
});

describe('highestSupported', () => {
  it('picks the strongest level a runner offers', () => {
    expect(highestSupported(['low', 'high', 'medium'])).toBe('high');
  });

  it('returns undefined when a runner supports nothing', () => {
    expect(highestSupported([])).toBeUndefined();
  });
});

describe('clampReasoning (R-15)', () => {
  it('leaves a supported level untouched', () => {
    const result = clampReasoning('high', ['low', 'medium', 'high', 'very_high']);
    expect(result).toEqual({ reasoning: 'high', clamped: false });
  });

  it('lowers to the strongest level the runner actually supports', () => {
    // A fallback runner that tops out below the requested level must not fail
    // the run — but the downgrade has to be recorded, never silent.
    const result = clampReasoning('very_high', ['low', 'medium', 'high']);
    expect(result).toEqual({ reasoning: 'high', clamped: true });
  });

  it('prefers the closest level at or below the request', () => {
    const result = clampReasoning('high', ['low', 'medium', 'very_high']);
    expect(result).toEqual({ reasoning: 'medium', clamped: true });
  });

  it('raises to the runner minimum only when nothing lower exists', () => {
    // Going up costs more of the user's quota than they asked for, so it is a
    // last resort — taken only because the alternative is not running at all.
    // Either way the adjustment is flagged, never silent.
    const result = clampReasoning('low', ['high', 'very_high']);
    expect(result).toEqual({ reasoning: 'high', clamped: true });
  });

  it('throws when the runner supports no levels at all', () => {
    expect(() => clampReasoning('high', [])).toThrow();
  });
});
