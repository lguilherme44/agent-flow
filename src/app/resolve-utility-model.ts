import { OpenAiCompatibleUtilityModel } from '../adapters/utility-model/index.js';
import type { UtilityModelConfig } from '../contracts/index.js';
import type { UtilityModel } from '../ports/index.js';

/**
 * The only seam allowed to resolve a UtilityModel config into a live adapter.
 *
 * Two decisions are deliberate:
 *
 * 1. `process.env[apiKeyEnv]` is read **here**, at the boundary, and nowhere
 *    else. The config document carries only the variable's *name*; the adapter
 *    receives the resolved value. A caller that wants to inject the key for
 *    tests can pass an explicit `apiKey` (or an injectable env) instead.
 *
 * 2. Resolution is total over a well-formed config: anything that cannot
 *    produce a working adapter — disabled, missing required fields, or an
 *    absent/blank env value — yields `undefined` rather than throwing. That
 *    keeps Utility OFF behaviorally identical to pre-MVP3 and turns a missing
 *    key into a graceful bypass (MVP3 acceptance: "utility offline não impede
 *    workflow principal").
 */
export interface ResolveUtilityModelOptions {
  readonly config: UtilityModelConfig;
  /** Injectable env reader; defaults to `process.env`. Tests override it. */
  readonly env?: (name: string) => string | undefined;
  /** Explicit key, for tests that must not touch the environment. */
  readonly apiKey?: string;
}

export function resolveUtilityModel(options: ResolveUtilityModelOptions): UtilityModel | undefined {
  const { config, apiKey } = options;
  if (!config.enabled) return undefined;
  if (config.baseUrl === undefined || config.model === undefined) return undefined;

  const readEnv = options.env ?? ((name: string) => process.env[name]);
  let resolvedKey: string | undefined = apiKey;
  if (resolvedKey === undefined && config.apiKeyEnv !== undefined) {
    const value = readEnv(config.apiKeyEnv);
    if (value === undefined || value.trim().length === 0) return undefined;
    resolvedKey = value;
  }

  return new OpenAiCompatibleUtilityModel({
    baseUrl: config.baseUrl,
    model: config.model,
    contextWindow: config.contextWindow,
    ...(config.targetInputTokens === undefined
      ? {}
      : { targetInputTokens: config.targetInputTokens }),
    maxOutputTokens: config.maxOutputTokens,
    timeoutSeconds: config.timeoutSeconds,
    ...(resolvedKey === undefined ? {} : { apiKey: resolvedKey }),
  });
}