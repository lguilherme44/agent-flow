import { parse as parseYaml } from 'yaml';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../config/defaults.js';
import { OVERRIDABLE_KEYS, projectConfigPath } from '../config/loader.js';
import type { FileSystem } from '../ports/index.js';

/**
 * Where each effective setting came from (§85, UI-26).
 *
 * The Settings page shows the configuration the tool is actually running on, and
 * the useful part is not the values — it is which layer produced them. "parallelism
 * is 1" invites a change to the global file; "parallelism is 1, and this project
 * overrides it" says the global file is not where to look. Resolution order is
 * built-in defaults → global file → project overlay, exactly as `loadConfig`
 * merges them, and `OVERRIDABLE_KEYS` is imported from the merge rather than copied
 * so the two cannot describe different rules.
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

  const overridable = new Set<string>(OVERRIDABLE_KEYS);

  return {
    globalPath: options.globalConfigPath,
    projectPath,
    globalPresent: global !== null,
    projectPresent: project !== null,

    originOf: (path) => {
      const head = path.split('.')[0];

      // A project may only override the keys the merge lets it override, plus the
      // ones only a project file has. Reporting `project` for anything else would
      // describe a precedence that does not exist: the value would sit in the file
      // and have no effect, which is the worst thing a settings page can imply.
      const claimedByProject =
        head !== undefined && (overridable.has(head) || isProjectOwnKey(head));

      if (claimedByProject && valueAt(project, path) !== undefined) return 'project';
      if (valueAt(global, path) !== undefined) return 'global';
      if (valueAt(defaults, path) !== undefined) return 'default';
      return undefined;
    },
  };
}

/**
 * Keys the project file owns outright rather than overrides.
 *
 * `project`, `commands`, `validationCommands`, `paths` and `rules` exist only in a
 * project's own file; the global schema has no notion of them. They are "project"
 * in origin without being an override of anything.
 */
function isProjectOwnKey(head: string): boolean {
  return ['project', 'commands', 'validationCommands', 'paths', 'rules'].includes(head);
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

/** Walks a dotted path through a nested mapping. */
function valueAt(source: Record<string, unknown> | null, path: string): unknown {
  if (source === null) return undefined;

  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}
