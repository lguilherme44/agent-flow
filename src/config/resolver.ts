import { deepMerge } from './merger.js';

export type ConfigRecord = Record<string, unknown>;
export type ConfigValueOrigin = 'default' | 'global' | 'project';

/** Top-level global settings a repository is allowed to narrow or override. */
export const PROJECT_OVERRIDABLE_KEYS = [
  'roles', 'runners', 'fallback', 'parallelism', 'retry', 'git', 'approval', 'recovery',
] as const;

/** Settings that exist only in a project source. */
export const PROJECT_OWN_KEYS = [
  'project', 'commands', 'validationCommands', 'paths', 'rules',
] as const;
const projectOverridable = new Set<string>(PROJECT_OVERRIDABLE_KEYS);
const projectOwned = new Set<string>(PROJECT_OWN_KEYS);

export interface ResolveConfigSourcesInput {
  readonly defaults: ConfigRecord;
  readonly global?: ConfigRecord | null;
  readonly project?: ConfigRecord | null;
}

export interface ResolvedConfigSources {
  readonly effectiveGlobal: ConfigRecord;
  readonly project?: ConfigRecord;
  originOf(path: string | readonly (string | number)[]): ConfigValueOrigin | undefined;
}

/** Pure precedence shared by runtime loading, previews and origin inspection. */
export function resolveConfigSources(input: ResolveConfigSourcesInput): ResolvedConfigSources {
  const global = input.global ?? {};
  const project = input.project ?? undefined;
  const allowedOverlay: ConfigRecord = {};

  if (project !== undefined) {
    for (const key of PROJECT_OVERRIDABLE_KEYS) {
      if (key in project) allowedOverlay[key] = project[key];
    }
  }

  const effectiveGlobal = deepMerge(deepMerge(input.defaults, global), allowedOverlay);
  return {
    effectiveGlobal,
    ...(project === undefined ? {} : { project }),
    originOf(path) {
      const segments = normalizePath(path);
      const head = segments[0];
      if (head === undefined) return undefined;
      if (project !== undefined && (projectOverridable.has(head) || projectOwned.has(head)) && valueAt(project, segments) !== undefined) return 'project';
      if (valueAt(global, segments) !== undefined) return 'global';
      if (valueAt(input.defaults, segments) !== undefined) return 'default';
      return undefined;
    },
  };
}

function normalizePath(path: string | readonly (string | number)[]): readonly string[] {
  return typeof path === 'string' ? path.split('.') : path.map(String);
}

function valueAt(source: ConfigRecord, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as ConfigRecord)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}
