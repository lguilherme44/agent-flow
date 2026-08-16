import { describe, expect, it } from 'vitest';
import { resolveUtilityModel } from '../../src/app/resolve-utility-model.js';
import { loadConfig } from '../../src/config/loader.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { OpenAiCompatibleUtilityModel } from '../../src/adapters/utility-model/index.js';
import { UtilityModelConfigSchema } from '../../src/contracts/utility-model-config.schema.js';

const SECRET = 'sk-live-UNIQUE_SECRET_MARKER_9f3c';

const FULL_CONFIG = {
  enabled: true,
  adapter: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'moe',
  contextWindow: 64_000,
  targetInputTokens: 40_000,
  maxOutputTokens: 4_000,
  timeoutSeconds: 120,
  apiKeyEnv: 'AGENT_FLOW_UTILITY_MODEL_API_KEY',
} as const;

/**
 * Gap 2 security contract (§Gap2): `utilityModel.apiKeyEnv` names an environment
 * variable, and the resolved value is a secret that must never be persisted,
 * serialized or logged. This is the invariant that the whole design stands on:
 * the config document holds only the *name*, the key exists in one place at the
 * boundary, and no surface — config dump, adapter state, errors — can re-expose
 * it.
 */
describe('utilityModel secret containment (Gap 2)', () => {
  it('the config document serializes the env name, never the value', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(
      '/home/u/.agent-flow/config.yaml',
      `utilityModel:
  enabled: true
  baseUrl: http://127.0.0.1:8080/v1
  model: moe
  apiKeyEnv: AGENT_FLOW_UTILITY_MODEL_API_KEY
`,
    );

    const config = await loadConfig({
      fs,
      globalConfigPath: '/home/u/.agent-flow/config.yaml',
      projectDir: '/repo',
    });

    const dump = JSON.stringify(config.global);
    expect(dump).toContain('AGENT_FLOW_UTILITY_MODEL_API_KEY');
    expect(dump).not.toContain(SECRET);

    // Loader returns plain data; a hostile `JSON.parse(dump)` round-trip must
    // also stay secret-free because the secret never entered the document.
    const roundTripped = JSON.parse(dump) as { utilityModel: { enabled: boolean } };
    expect(JSON.stringify(roundTripped.utilityModel)).not.toContain(SECRET);
  });

  it('resolving a real adapter with the secret in env exposes it nowhere serializable', () => {
    const model = resolveUtilityModel({
      config: FULL_CONFIG,
      env: () => SECRET,
    });

    expect(model).toBeInstanceOf(OpenAiCompatibleUtilityModel);

    // Serialization surfaces that could plausibly leak: error toString, the
    // adapter's own toString/JSON, and enumerable own keys of the instance.
    const surfaces = [
      String(model),
      JSON.stringify(model),
      Object.keys(model ?? {}).join(','),
      model instanceof Error ? model.message : '',
    ].join('\n');
    expect(surfaces).not.toContain(SECRET);
    expect(surfaces).not.toContain('sk-live-');
  });

  it('schema pre-parse keeps hostile payloads secret-free — apiKey field and credential URLs are rejected', () => {
    const hostile = [
      { enabled: true, baseUrl: 'http://127.0.0.1:8080/v1', model: 'moe', apiKey: SECRET },
      { enabled: true, baseUrl: `http://user:${SECRET}@127.0.0.1:8080/v1`, model: 'moe' },
      { enabled: true, baseUrl: 'http://127.0.0.1:8080/v1', model: 'moe', apiKeyEnv: SECRET },
    ];
    for (const payload of hostile) {
      const result = UtilityModelConfigSchema.safeParse(payload);
      expect(result.success).toBe(false);
    }
  });

  it('an enabled config with apiKeyEnv present still resolves through the pure schema default shape', async () => {
    // The loader path and the adapter factory are the two consumers of the
    // config. Both must stay connected to the same key-free document.
    const fs = new InMemoryFileSystem();
    fs.seed(
      '/home/u/.agent-flow/config.yaml',
      `utilityModel:
  enabled: true
  baseUrl: http://127.0.0.1:8080/v1
  model: moe
  apiKeyEnv: AGENT_FLOW_UTILITY_MODEL_API_KEY
`,
    );
    const config = await loadConfig({
      fs,
      globalConfigPath: '/home/u/.agent-flow/config.yaml',
      projectDir: '/repo',
    });

    const model = resolveUtilityModel({
      config: config.global.utilityModel,
      env: () => SECRET,
    });
    expect(model).toBeInstanceOf(OpenAiCompatibleUtilityModel);
    expect(String(model)).not.toContain(SECRET);
  });

  it('ships a default template whose utilityModel section carries no secret material', () => {
    // DEFAULT_GLOBAL_CONFIG_YAML is parsed into the very config the loader
    // merges from. If the shipped template ever grew a key, every install would
    // ship the same secret.
    expect(DEFAULT_GLOBAL_CONFIG_YAML).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(DEFAULT_GLOBAL_CONFIG_YAML).toContain('utilityModel:');
    expect(DEFAULT_GLOBAL_CONFIG_YAML).toContain('enabled: false');
  });
});