import { WORKTREE_CONFIG_KEY } from '../contracts/config.schema.js';
import { deepMerge } from './merger.js';

export type ConfigRecord = Record<string, unknown>;
export type ConfigValueOrigin = 'default' | 'global' | 'project';

/**
 * Top-level global settings a repository is allowed to narrow or override.
 *
 * `trust` is in neither this list nor `PROJECT_OWN_KEYS`, and that absence is the whole of
 * SEC-001: a project file's `trust` never reaches the overlay, so no repository can
 * declare itself trusted.
 */
export const PROJECT_OVERRIDABLE_KEYS = [
  'roles', 'runners', 'fallback', 'parallelism', 'retry', 'git', 'approval', 'recovery',
  // The language a repository's SDDs, plans and task titles are written in belongs to the
  // repository and its team, not to whoever happened to start the CLI. Overridable so one
  // repo reads the same for every operator of it.
  'language',
  // Which ignored files a repository's tests need is a fact about the repository (FR-012).
  // A project `copy` list replaces the global one whole, as every array does in the merge.
  WORKTREE_CONFIG_KEY,
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
  /**
   * Whether the operator's global `trust.projectConfig` covers the project (FR-022).
   *
   * Optional and **false when omitted**, so a caller that forgets to ask gets the safe
   * answer: the project's loosenings are dropped and reported, not silently applied.
   */
  readonly projectTrusted?: boolean;
}

export type IgnoredLooseningKind = 'skip_permissions' | 'tool_grant_args' | 'mcp' | 'approval';

/** A value an untrusted project set that would have widened the operator's posture. */
export interface IgnoredLoosening {
  readonly path: readonly string[];
  readonly kind: IgnoredLooseningKind;
}

export interface ResolvedConfigSources {
  readonly effectiveGlobal: ConfigRecord;
  /** The project record the overlay was built from — filtered when the project is untrusted. */
  readonly project?: ConfigRecord;
  /** Empty for a trusted project, and for one that loosened nothing. */
  readonly ignoredLoosenings: readonly IgnoredLoosening[];
  originOf(path: string | readonly (string | number)[]): ConfigValueOrigin | undefined;
}

/** Pure precedence shared by runtime loading, previews and origin inspection. */
export function resolveConfigSources(input: ResolveConfigSourcesInput): ResolvedConfigSources {
  const global = input.global ?? {};
  // Filtered here, before the overlay *and* before `originOf`, so the two cannot disagree:
  // a dropped value is absent from the effective config and is never attributed to the
  // project, and every consumer — runtime, preview, origins — sees the same answer (SEC-002).
  const raw = input.project ?? undefined;
  const screened: ScreenedProject = raw === undefined || input.projectTrusted === true
    ? { filtered: raw, ignored: [] }
    : filterProjectLoosenings(raw);
  const project = screened.filtered;
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
    ignoredLoosenings: screened.ignored,
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

export interface ProjectScreening {
  readonly filtered: ConfigRecord;
  readonly ignored: readonly IgnoredLoosening[];
}

interface ScreenedProject {
  readonly filtered: ConfigRecord | undefined;
  readonly ignored: readonly IgnoredLoosening[];
}

/**
 * Flags that widen what a coding CLI may do without asking (FR-023).
 *
 * **Runner-agnostic on purpose, and here rather than in an adapter.** The Claude adapter
 * has its own `grantsCommands`, but `src/config` may not import an adapter, and a rule
 * keyed by runner type is a rule a project dodges by declaring a runner of another type
 * with the same argv. Any runner's `args` carrying one of these is treated as a grant.
 */
const TOOL_GRANT_FLAGS = [
  '--allowedTools',
  '--allowed-tools',
  '--dangerously-skip-permissions',
  '--permission-mode',
] as const;

/** Whether one argv token is a tool grant, in its spaced or its `--flag=value` spelling. */
export function isToolGrantArg(token: string): boolean {
  return TOOL_GRANT_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`));
}

/**
 * The project record with the four named loosenings removed, and a list of what was (N4).
 *
 * The project config only tightens unless the operator trusts it. What an untrusted
 * project may not do, for every runner it names — including a runner only it declares:
 *
 *   - turn `dangerouslySkipPermissions` on (turning it off stays: that tightens),
 *   - carry a tool grant in `args` — and then the **whole list** goes, not the token.
 *     `--allowedTools` is variadic: dropping it alone would leave `Bash(x)` behind as a
 *     positional argument, which the CLI would read as the prompt. A grant-free list,
 *     `[]` included, still replaces the global one,
 *   - declare `mcp` at all, since declaring it also drops `--safe-mode`,
 *   - turn `approval.requiredBeforeImplementation` off.
 *
 * Everything else is left exactly as written. Pure and non-mutating: the input record is
 * the caller's parsed file, and `originOf` must be able to answer from this copy alone.
 */
export function filterProjectLoosenings(project: ConfigRecord): ProjectScreening {
  const ignored: IgnoredLoosening[] = [];
  const filtered: ConfigRecord = { ...project };

  const runners = project['runners'];
  if (isRecord(runners)) {
    const kept: ConfigRecord = {};
    for (const [name, runner] of Object.entries(runners)) {
      if (!isRecord(runner)) {
        kept[name] = runner;
        continue;
      }
      const copy: ConfigRecord = { ...runner };
      if (copy['dangerouslySkipPermissions'] === true) {
        delete copy['dangerouslySkipPermissions'];
        ignored.push({ path: ['runners', name, 'dangerouslySkipPermissions'], kind: 'skip_permissions' });
      }
      const args = copy['args'];
      if (Array.isArray(args) && args.some((token) => typeof token === 'string' && isToolGrantArg(token))) {
        delete copy['args'];
        ignored.push({ path: ['runners', name, 'args'], kind: 'tool_grant_args' });
      }
      if (copy['mcp'] !== undefined) {
        delete copy['mcp'];
        ignored.push({ path: ['runners', name, 'mcp'], kind: 'mcp' });
      }
      kept[name] = copy;
    }
    filtered['runners'] = kept;
  }

  const approval = project['approval'];
  if (isRecord(approval) && approval['requiredBeforeImplementation'] === false) {
    const copy: ConfigRecord = { ...approval };
    delete copy['requiredBeforeImplementation'];
    filtered['approval'] = copy;
    ignored.push({ path: ['approval', 'requiredBeforeImplementation'], kind: 'approval' });
  }

  return { filtered, ignored };
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
