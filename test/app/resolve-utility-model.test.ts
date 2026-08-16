import { describe, expect, it } from 'vitest';
import { resolveUtilityModel } from '../../src/app/resolve-utility-model.js';
import { OpenAiCompatibleUtilityModel } from '../../src/adapters/utility-model/index.js';
import type { UtilityModelConfig } from '../../src/contracts/index.js';

const CONFIG = {
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

describe('resolveUtilityModel', () => {
  it('returns undefined when disabled — Utility OFF equals pre-MVP3', () => {
    expect(resolveUtilityModel({ config: { ...CONFIG, enabled: false } })).toBeUndefined();
  });

  it('returns undefined when required fields are missing', () => {
    expect(
      resolveUtilityModel({ config: { ...CONFIG, baseUrl: undefined } }),
    ).toBeUndefined();
    expect(resolveUtilityModel({ config: { ...CONFIG, model: undefined } })).toBeUndefined();
  });

  it('returns undefined when the apiKeyEnv variable is absent', () => {
    const result = resolveUtilityModel({
      config: CONFIG,
      env: () => undefined,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when the apiKeyEnv variable is blank', () => {
    const result = resolveUtilityModel({
      config: CONFIG,
      env: () => '   ',
    });
    expect(result).toBeUndefined();
  });

  it('resolves the key from env at the boundary and builds a real adapter', () => {
    const result = resolveUtilityModel({
      config: CONFIG,
      env: () => 'sk-live-test-secret',
    });
    expect(result).toBeInstanceOf(OpenAiCompatibleUtilityModel);
    expect(result).toBeDefined();
  });

  it('never leaks the resolved key through the returned adapter identity', () => {
    const result = resolveUtilityModel({
      config: CONFIG,
      env: () => 'sk-live-do-not-log',
    });
    const described = String(result).replaceAll('\n', ' ');
    expect(described).not.toMatch(/sk-live-do-not-log/);
  });

  it('accepts an explicit apiKey without touching env', () => {
    let envRead = false;
    const result = resolveUtilityModel({
      config: CONFIG,
      apiKey: 'sk-explicit',
      env: () => {
        envRead = true;
        return undefined;
      },
    });
    expect(result).toBeDefined();
    expect(envRead).toBe(false);
  });

  it('resolves without an apiKey at all when no apiKeyEnv is configured', () => {
    const result = resolveUtilityModel({
      config: {
        ...CONFIG,
        apiKeyEnv: undefined,
      },
      env: () => {
        throw new Error('env must not be read without apiKeyEnv');
      },
    });
    expect(result).toBeInstanceOf(OpenAiCompatibleUtilityModel);
  });

  it('passes through injectable env for deterministic tests', () => {
    const result = resolveUtilityModel({
      config: CONFIG,
      env: (name) => (name === 'AGENT_FLOW_UTILITY_MODEL_API_KEY' ? 'sk-from-env' : undefined),
    });
    expect(result).toBeDefined();
  });
});