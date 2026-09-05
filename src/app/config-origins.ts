import { parse as parseYaml } from 'yaml';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../config/defaults.js';
import { projectConfigPath } from '../config/loader.js';
import { resolveConfigSources } from '../config/resolver.js';
import type { FileSystem } from '../ports/index.js';

/**
 * Where each effective setting came from (§85, UI-26).
 *
 * The Settings page shows the configuration the tool is actually running on, and
 * the useful part is not the values — it is which layer produced them. "parallelism
 * is 1" invites a change to the global file; "parallelism is 1, and this project
 * overrides it" says the global file is not where to look. Resolution order is
 * built-in defaults → global file → project overlay, exactly as `loadConfig`
 * merges them. The pure resolver supplies the answer so origin reporting and
 * runtime loading cannot describe different precedence rules.
 *
 * This reads three YAML files and nothing else. No credential, no environment, no
 * auth file — the same boundary the rest of the server keeps.
 */

export type SettingOrigin = 'default' | 'global' | 'project';

export interface SettingOrigins {
  /**
   * Which layer supplied the value at a dotted path.
   *
   * `undefined` when no layer mentions it, which happens for a key a schema
   * defaults in code rather than in the shipped YAML.
   */
  originOf(path: string): SettingOrigin | undefined;
  readonly globalPath: string;
  readonly projectPath: string;
  readonly globalPresent: boolean;
  readonly projectPresent: boolean;
}

export interface ReadOriginsOptions {
  readonly fs: FileSystem;
  readonly globalConfigPath: string;
  readonly projectDir: string;
}

export async function readSettingOrigins(
  options: ReadOriginsOptions,
): Promise<SettingOrigins> {
  const defaults = asRecord(parseYaml(DEFAULT_GLOBAL_CONFIG_YAML));
  const global = await readYamlRecord(options.fs, options.globalConfigPath);
  const projectPath = projectConfigPath(options.projectDir);
  const project = await readYamlRecord(options.fs, projectPath);

  const resolved = resolveConfigSources({ defaults, global, project });

  return {
    globalPath: options.globalConfigPath,
    projectPath,
    globalPresent: global !== null,
    projectPresent: project !== null,

    originOf: (path) => resolved.originOf(path),
  };
}

async function readYamlRecord(
  fs: FileSystem,
  path: string,
): Promise<Record<string, unknown> | null> {
  if (!(await fs.exists(path))) return null;

  try {
    return asRecord(parseYaml(await fs.readFile(path)));
  } catch {
    // A file that will not parse contributes no origins. The caller surfaces the
    // parse failure from `loadConfig`, which produces the better message.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
