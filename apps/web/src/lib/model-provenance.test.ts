import { describe, it, expect } from 'vitest';
import { resolveModelProvenance } from './model-provenance';

describe('resolveModelProvenance', () => {
  it('returns Unobservable for AGY runner', () => {
    const res = resolveModelProvenance({
      runner: 'agy',
      configuredModel: 'gpt-4o',
      effectiveModel: 'claude-3-5-sonnet',
    });
    expect(res.display).toBe('Unobservable');
    expect(res.isUnobservable).toBe(true);
  });

  it('returns exact observed effective model when available', () => {
    const res = resolveModelProvenance({
      runner: 'opencode',
      configuredModel: 'qwen2.5-coder:7b',
      effectiveModel: 'qwen2.5-coder:7b-instruct',
    });
    expect(res.display).toBe('qwen2.5-coder:7b-instruct');
    expect(res.isObserved).toBe(true);
  });

  it('returns configured model when not yet observed', () => {
    const res = resolveModelProvenance({
      runner: 'opencode',
      configuredModel: 'qwen2.5-coder:7b',
      effectiveModel: undefined,
    });
    expect(res.display).toBe('qwen2.5-coder:7b');
    expect(res.isConfigured).toBe(true);
  });

  it('returns "Not observed" when neither configured nor observed', () => {
    const res = resolveModelProvenance({
      runner: 'opencode',
      configuredModel: undefined,
      effectiveModel: undefined,
    });
    expect(res.display).toBe('Not observed');
    expect(res.isObserved).toBe(false);
  });
});
