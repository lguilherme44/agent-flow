import { describe, it, expect } from 'vitest';
import { sanitizeEndpoint } from './sanitize';

describe('sanitizeEndpoint', () => {
  it('returns "Not configured" for undefined, null, or empty string', () => {
    expect(sanitizeEndpoint(undefined)).toBe('Not configured');
    expect(sanitizeEndpoint(null)).toBe('Not configured');
    expect(sanitizeEndpoint('')).toBe('Not configured');
    expect(sanitizeEndpoint('   ')).toBe('Not configured');
  });

  it('strips userinfo credentials from URL', () => {
    expect(sanitizeEndpoint('http://user:secretpassword@127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434/v1',
    );
    expect(sanitizeEndpoint('https://api-key:sk-proj-123456@api.openai.com/v1')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('strips query strings and tokens from URL', () => {
    expect(sanitizeEndpoint('http://localhost:8080/v1?api_key=secret123&token=abc')).toBe(
      'http://localhost:8080/v1',
    );
    expect(sanitizeEndpoint('https://custom.llm.local/v1#fragment')).toBe(
      'https://custom.llm.local/v1',
    );
  });

  it('redacts standalone API key tokens', () => {
    expect(sanitizeEndpoint('sk-proj-secret-token-value')).toBe('Not configured (redacted)');
    expect(sanitizeEndpoint('ghp_123456789012345678901234567890')).toBe(
      'Not configured (redacted)',
    );
  });
});
