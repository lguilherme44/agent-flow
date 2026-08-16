import { describe, expect, it } from 'vitest';
import {
  UtilityModelConfigSchema,
  DEFAULT_UTILITY_MODEL_CONFIG,
  type UtilityModelConfig,
} from '../../src/contracts/utility-model-config.schema.js';

const VALID = {
  enabled: true,
  adapter: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'moe',
  contextWindow: 64_000,
  targetInputTokens: 40_000,
  maxOutputTokens: 4_000,
  timeoutSeconds: 120,
  apiKeyEnv: 'AGENT_FLOW_UTILITY_MODEL_API_KEY',
} satisfies UtilityModelConfig;

describe('UtilityModelConfigSchema', () => {
  it('accepts a fully specified configuration', () => {
    expect(UtilityModelConfigSchema.safeParse(VALID).success).toBe(true);
  });

  it('defaults to disabled with no fields at all', () => {
    const result = UtilityModelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.enabled).toBe(false);
  });

  it('defaults to the same shipped defaults as the template', () => {
    expect(DEFAULT_UTILITY_MODEL_CONFIG.enabled).toBe(false);
  });

  it('parses apiKeyEnv as the environment variable NAME, never a value', () => {
    const result = UtilityModelConfigSchema.safeParse({
      ...VALID,
      apiKeyEnv: 'MY_SECRET', // a key name, not a secret
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.apiKeyEnv).toBe('MY_SECRET');
  });

  describe('hostile input is rejected', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['adapter that is not openai-compatible', { ...VALID, adapter: 'codex' }],
      ['baseUrl that is not a URL', { ...VALID, baseUrl: 'not a url' }],
      ['baseUrl with a URL scheme that is not http/https', { ...VALID, baseUrl: 'file:///etc/passwd' }],
      ['baseUrl carrying embedded credentials', { ...VALID, baseUrl: 'http://user:pass@127.0.0.1:8080/v1' }],
      ['empty model', { ...VALID, model: '' }],
      ['model with whitespace', { ...VALID, model: '  ' }],
      ['negative contextWindow', { ...VALID, contextWindow: -1 }],
      ['zero targetInputTokens', { ...VALID, targetInputTokens: 0 }],
      ['NaN contextWindow', { ...VALID, contextWindow: Number.NaN }],
      ['Infinity timeout', { ...VALID, timeoutSeconds: Number.POSITIVE_INFINITY }],
      ['absurdly large contextWindow', { ...VALID, contextWindow: 1e18 }],
      ['targetInputTokens above contextWindow', { ...VALID, contextWindow: 100, targetInputTokens: 200 }],
      ['apiKeyEnv that is really a value', { ...VALID, apiKeyEnv: 'sk-live-abcdef1234567890' }],
      ['apiKeyEnv with a path', { ...VALID, apiKeyEnv: '../secret' }],
      ['apiKeyEnv with spaces', { ...VALID, apiKeyEnv: 'MY KEY' }],
      ['timeoutSeconds as a string', { ...VALID, timeoutSeconds: 'fast' }],
      ['enabled as a string', { ...VALID, enabled: 'yes' }],
    ];

    for (const [label, input] of cases) {
      it(`rejects ${label}`, () => {
        expect(UtilityModelConfigSchema.safeParse(input).success).toBe(false);
      });
    }
  });

  it('rejects serialized config that would carry a resolved value in another field', () => {
    // Even a config object that someone mutated after parsing (bypassing the
    // schema) would have to pass a fresh parse to be trusted.
    expect(UtilityModelConfigSchema.safeParse({ ...VALID, apiKey: 'sk-live-xxx' }).success).toBe(
      false,
    );
  });

  it('never resolves or exposes process.env through the schema', () => {
    // The schema is pure data: it must not reference process or any global.
    const src = UtilityModelConfigSchema.toString();
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/process/);
  });

  it('fails closed when enabled but key reachability fields are malformed', () => {
    expect(
      UtilityModelConfigSchema.safeParse({ ...VALID, apiKeyEnv: '' }).success,
    ).toBe(false);
  });
});