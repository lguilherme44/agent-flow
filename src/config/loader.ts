import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  EffectiveConfigSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
  WorktreeSourceSchema,
  formatValidationError,
  type EffectiveConfig,
} from '../contracts/index.js';
import type { FileSystem } from '../ports/index.js';
import { samePath } from '../core/path-containment.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from './defaults.js';
import { PROJECT_OVERRIDABLE_KEYS, resolveConfigSources, type IgnoredLoosening } from './resolver.js';
import { decideProjectTrust } from './trust.js';

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

/**
 * Global-level keys a project is allowed to override (§38).
 *
 * Compatibility alias. The resolver owns the list so runtime, editor and origin
 * reporting cannot drift into separate precedence rules.
 */
export const OVERRIDABLE_KEYS = PROJECT_OVERRIDABLE_KEYS;

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

export interface LoadConfigWithReportOptions extends LoadConfigOptions {
  /** Decides how trust entries are compared (FR-022). `process.platform` when absent. */
  readonly platform?: string;
}

export interface LoadedConfigReport {
  readonly config: EffectiveConfig;
  /** What an untrusted project tried to loosen and was refused, for `doctor` (FR-026). */
  readonly ignoredLoosenings: readonly IgnoredLoosening[];
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
  return (await loadConfigWithReport(options)).config;
}

/**
 * `loadConfig`, plus the project loosenings the resolver dropped (FR-027).
 *
 * A sibling rather than a wider return type: `loadConfig` has some twenty callers that
 * want the configuration and nothing else, and only `doctor` has anything to say about
 * what was refused.
 */
export async function loadConfigWithReport(
  options: LoadConfigWithReportOptions,
): Promise<LoadedConfigReport> {
  const { fs, globalConfigPath, projectDir } = options;

  const defaults = (parseYaml(DEFAULT_GLOBAL_CONFIG_YAML) ?? {}) as Record<string, unknown>;
  const globalRaw = await readYaml(fs, globalConfigPath);
  const projectPath = projectConfigPath(projectDir);
  // From the home directory the project path *is* the global file. Reading it twice made the
  // global configuration fail the project schema ("project: expected object") for every
  // command typed in home — which is where a dashboard started at logon lives.
  const projectRaw = samePath(projectPath, globalConfigPath) ? undefined : await readYaml(fs, projectPath);

  // Each file's `worktree` section is checked on its own, before the merge (FR-013). After
  // it, every error is reported against the global path, so a bad pattern in a cloned
  // repository's config would send its reader to a global file that does not contain it. The
  // global file is checked too, because a project `copy` list replaces the global one whole
  // and would otherwise hide a bad global pattern until the day the project dropped its own.
  if (globalRaw) parseOrThrow(WorktreeSourceSchema, globalRaw, globalConfigPath);
  if (projectRaw) parseOrThrow(WorktreeSourceSchema, projectRaw, projectPath);

  // Asked only when there is a project file to screen: without one the resolver has no
  // overlay for the answer to change, and `decideProjectTrust` would resolve paths for it.
  const projectTrusted = projectRaw
    ? await decideProjectTrust({
        fs,
        globalRaw,
        projectDir,
        platform: options.platform ?? process.platform,
      })
    : false;

  const resolved = resolveConfigSources({ defaults, global: globalRaw, project: projectRaw, projectTrusted });

  const global = parseOrThrow(GlobalConfigSchema, resolved.effectiveGlobal, globalConfigPath);

  const project = projectRaw
    ? parseOrThrow(ProjectConfigSchema, projectRaw, projectPath)
    : undefined;

  return {
    // The same trust answer the resolver screened `args` with, kept so the grants derived
    // from `commands` follow it too (SEC-001) instead of each consumer deciding again.
    config: EffectiveConfigSchema.parse({ global, project, projectTrusted }),
    ignoredLoosenings: resolved.ignoredLoosenings,
  };
}
