import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  EffectiveConfigSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
  formatValidationError,
  type EffectiveConfig,
} from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';
import { deepMerge } from './merger.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from './defaults.js';

/**
 * A configuration problem, phrased for the person who has to fix it.
 * Never surfaced as a stack trace (AF-16 exit code 2).
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  readonly fs: FileSystem;
  readonly globalConfigPath: string;
  readonly projectDir: string;
}

/** `.agent-flow/config.yaml` under the project — the only versioned artifact. */
export function projectConfigPath(projectDir: string): string {
  return `${projectDir}/.agent-flow/config.yaml`;
}

async function readYaml(fs: FileSystem, path: string): Promise<Record<string, unknown> | null> {
  if (!(await fs.exists(path))) return null;

  const raw = await fs.readFile(path);
  try {
    const parsed: unknown = parseYaml(raw);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(`Invalid ${path}: expected a YAML mapping at the top level.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `Invalid ${path}: could not parse YAML.\n  ${(error as Error).message.split('\n')[0]}`,
    );
  }
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, source: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ConfigError(formatValidationError(result.error, source));
  return result.data;
}

/**
 * Resolution order: built-in defaults → global file → project overlay.
 *
 * The project file carries both its own settings *and* optional overrides of
 * global keys (`roles`, `fallback`, `parallelism`, …). Keeping the split at
 * "80% global, 20% project" (§38) means a repository states what makes it
 * different, not the whole configuration.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<EffectiveConfig> {
  const { fs, globalConfigPath, projectDir } = options;

  const defaults = (parseYaml(DEFAULT_GLOBAL_CONFIG_YAML) ?? {}) as Record<string, unknown>;
  const globalRaw = await readYaml(fs, globalConfigPath);
  const projectPath = projectConfigPath(projectDir);
  const projectRaw = await readYaml(fs, projectPath);

  let merged = deepMerge(defaults, globalRaw ?? {});

  // Global-level keys a project is allowed to override. Anything outside this
  // list belongs to the project schema and is validated separately.
  const OVERRIDABLE = ['roles', 'runners', 'fallback', 'parallelism', 'retry', 'git', 'approval'];
  if (projectRaw) {
    const overrides: Record<string, unknown> = {};
    for (const key of OVERRIDABLE) {
      if (key in projectRaw) overrides[key] = projectRaw[key];
    }
    merged = deepMerge(merged, overrides);
  }

  const global = parseOrThrow(GlobalConfigSchema, merged, globalConfigPath);

  const project = projectRaw
    ? parseOrThrow(ProjectConfigSchema, projectRaw, projectPath)
    : undefined;

  return EffectiveConfigSchema.parse({ global, project });
}
