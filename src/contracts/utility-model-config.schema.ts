import { z } from 'zod';

/** The only adapter the product ships for UtilityModel as of M3-09. */
export const UTILITY_MODEL_ADAPTERS = ['openai-compatible'] as const;

/**
 * Env var name grammar: a POSIX-ish NAME that can only ever name an environment
 * variable. It deliberately cannot carry a secret value, a path, or a flag.
 */
const ENV_VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Bounds keep a hostile or mistaken config from making absurd requests. */
const MAX_CONTEXT_WINDOW = 1_000_000;
const MAX_OUTPUT_TOKENS = 100_000;
const MAX_TIMEOUT_SECONDS = 3_600;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Configuration for the optional local UtilityModel (M3-09).
 *
 * Contract:
 * - This object is pure **data**. It never resolves `process.env`, never holds
 *   a resolved secret, and never reaches an adapter keyed by anything but names.
 * - `apiKeyEnv` stores only the *name* of the environment variable to read at
 *   the composition boundary. A value in this document is a leak by definition.
 * - Disabled is the shipped default: Utility OFF must behave exactly like
 *   pre-MVP3 (architectural invariant, full MVP3 acceptance).
 */
export const UtilityModelConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    adapter: z.enum(UTILITY_MODEL_ADAPTERS).default('openai-compatible'),
    baseUrl: z
      .string()
      .min(1)
      .max(2_048)
      .refine(isHttpUrl, 'baseUrl must be an http(s) URL')
      .refine(
        (value) => {
          try {
            return new URL(value).username === '' && new URL(value).password === '';
          } catch {
            return false;
          }
        },
        'baseUrl must not carry embedded credentials',
      )
      .optional(),
    model: z.string().trim().min(1).max(512).optional(),
    contextWindow: z
      .number()
      .int()
      .positive()
      .max(MAX_CONTEXT_WINDOW)
      .default(64_000),
    targetInputTokens: z
      .number()
      .int()
      .positive()
      .max(MAX_CONTEXT_WINDOW)
      .optional(),
    maxOutputTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS).default(4_000),
    timeoutSeconds: z.number().positive().max(MAX_TIMEOUT_SECONDS).default(120),
    apiKeyEnv: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(ENV_VAR_NAME, 'apiKeyEnv must be a plain environment variable name')
      .optional(),
  })
  .superRefine((config, context) => {
    if (!config.enabled) return;

    // An enabled utility must be reachable by definition, otherwise "enabled"
    // would silently mean "nothing happens". baseUrl and model are the two
    // fields that cannot be defaulted.
    if (config.baseUrl === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'baseUrl is required when the utility model is enabled',
      });
    }
    if (config.model === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'model is required when the utility model is enabled',
      });
    }

    // The input budget must sit inside the advertised window. A target above
    // the window is a config error, not a runtime surprise.
    if (
      config.targetInputTokens !== undefined &&
      config.targetInputTokens > config.contextWindow
    ) {
      context.addIssue({
        code: 'custom',
        path: ['targetInputTokens'],
        message: 'targetInputTokens must not exceed contextWindow',
      });
    }
  })
  .strict();

export type UtilityModelConfig = z.infer<typeof UtilityModelConfigSchema>;

/** Ships disabled: the pre-MVP3 behavior is the default. */
export const DEFAULT_UTILITY_MODEL_CONFIG: UtilityModelConfig = Object.freeze({
  enabled: false,
  adapter: 'openai-compatible',
  contextWindow: 64_000,
  maxOutputTokens: 4_000,
  timeoutSeconds: 120,
});