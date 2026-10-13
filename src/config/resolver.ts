import { WORKTREE_CONFIG_KEY, roleConfigKeys } from '../contracts/config.schema.js';
import { WORKFLOW_ROLES, type WorkflowRole } from '../contracts/common.schema.js';
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
  'project', 'commands', 'validationCommands', 'verification', 'paths', 'rules',
  // How this repository's own commands are written — POSIX script or the host's shell.
  // It travels with the commands it describes, so it lives in the project source only.
  'commandShell',
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

export type IgnoredLooseningKind = 'skip_permissions' | 'tool_grant_args' | 'mcp' | 'approval' | 'max_turns';

/**
 * A value a project set that would have widened the operator's posture.
 *
 * The first four kinds are dropped only for an untrusted project. `max_turns` — a turn
 * ceiling raised above the global one — is dropped whatever the trust.
 */
export interface IgnoredLoosening {
  readonly path: readonly string[];
  readonly kind: IgnoredLooseningKind;
  /** What was dropped, when it is a value worth naming (`max_turns` only). */
  readonly value?: string | number;
}

export interface ResolvedConfigSources {
  readonly effectiveGlobal: ConfigRecord;
  /** The project record the overlay was built from — filtered when the project is untrusted. */
  readonly project?: ConfigRecord;
  /** Empty for a project that loosened nothing; a trusted one can still raise a turn ceiling. */
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
  // The turn ceiling is tightened whatever the trust: it bounds what a run may spend, and
  // `trust.projectConfig` is about what an agent may *do*. Applied to the project record
  // itself, like the screen above, so the overlay and `originOf` agree on what survived.
  const tightened = screened.filtered === undefined
    ? undefined
    : tightenProjectMaxTurns(screened.filtered, deepMerge(input.defaults, global));
  const project = tightened?.filtered;
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
    ignoredLoosenings: [...screened.ignored, ...(tightened?.ignored ?? [])],
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

  // A command list the e2e agent may run is a tool grant by another name (dogfood 08/10): an
  // untrusted repository that could write one would grant its own agent `curl` and friends.
  const roles = project['roles'];
  if (isRecord(roles) && isRecord(roles['e2e']) && roles['e2e']['allowedCommands'] !== undefined) {
    const e2e: ConfigRecord = { ...roles['e2e'] };
    delete e2e['allowedCommands'];
    filtered['roles'] = { ...roles, e2e };
    ignored.push({ path: ['roles', 'e2e', 'allowedCommands'], kind: 'tool_grant_args' });
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

/** Where a role config sits under `roles`, in the nested YAML shape. */
const ROLE_CONFIG_PATHS: readonly (readonly string[])[] = [
  ['architect'], ['sdd'], ['planner'], ['planReviewer'],
  ['executors', 'trivial'], ['executors', 'normal'], ['executors', 'complex'],
  ['verification'], ['e2e'], ['finalReviewer'],
];

/**
 * The turn-ceiling flag, as a runner's `args` could carry it.
 *
 * Runner-agnostic for the reason `TOOL_GRANT_FLAGS` is. It matters because `RunnerConfig.args`
 * ride *after* the adapter's own flag, and measured on claude 2.1.281 the last `--max-turns`
 * wins — so a project arg would silently replace the ceiling `roles.*.maxTurns` set.
 */
const MAX_TURNS_FLAG = '--max-turns';

/**
 * The project record with every way of raising a global turn ceiling removed, and a list of
 * what was (`kind: 'max_turns'`).
 *
 * A project may lower a role's ceiling, or set one where the operator set none; it may never
 * lift one the operator set. Compared value by value against the effective global config
 * (`defaults` + global file):
 *
 *   - each role, and each of its stage overrides (whose ceiling is the global stage's own
 *     value, else the global role's),
 *   - each `fallback.roles` entry, against the global fallback entry and then the global
 *     *primary* role — the fallback runs with the primary's ceiling when it declares none,
 *     so a fallback the operator never declared is held to the primary's number,
 *   - every `--max-turns` in a runner's `args`, dropped whatever its value: the project's
 *     ceiling belongs in `roles`, where it is compared, and not in argv, where it wins.
 *
 * A raising value is dropped rather than clamped, so what applies is exactly the global
 * number. Applied whatever the trust: it bounds what a run may spend, and
 * `trust.projectConfig` is about what an agent may do. Pure and non-mutating, for the same
 * reason `filterProjectLoosenings` is.
 */
export function tightenProjectMaxTurns(project: ConfigRecord, global: ConfigRecord): ProjectScreening {
  const ignored: IgnoredLoosening[] = [];
  let result = project;

  const roles = project['roles'];
  if (isRecord(roles)) {
    let nextRoles: ConfigRecord = roles;
    for (const path of ROLE_CONFIG_PATHS) {
      const projectRole = valueAt(roles, [...path]);
      if (!isRecord(projectRole)) continue;
      const tightened = tightenRole(projectRole, [valueAt(global, ['roles', ...path])], ['roles', ...path], ignored);
      if (tightened !== projectRole) nextRoles = setAt(nextRoles, path, tightened);
    }
    if (nextRoles !== roles) result = { ...result, roles: nextRoles };
  }

  const fallback = project['fallback'];
  const fallbackRoles = isRecord(fallback) ? fallback['roles'] : undefined;
  if (isRecord(fallback) && isRecord(fallbackRoles)) {
    let nextFallbackRoles: ConfigRecord = fallbackRoles;
    for (const [name, projectRole] of Object.entries(fallbackRoles)) {
      if (!isRecord(projectRole)) continue;
      const globals = [valueAt(global, ['fallback', 'roles', name]), primaryRoleOf(global, name)];
      const tightened = tightenRole(projectRole, globals, ['fallback', 'roles', name], ignored, lowestCeiling(globals));
      if (tightened !== projectRole) nextFallbackRoles = { ...nextFallbackRoles, [name]: tightened };
    }
    if (nextFallbackRoles !== fallbackRoles) {
      result = { ...result, fallback: { ...fallback, roles: nextFallbackRoles } };
    }
  }

  const runners = result['runners'];
  if (isRecord(runners)) {
    let nextRunners: ConfigRecord = runners;
    for (const [name, runner] of Object.entries(runners)) {
      if (!isRecord(runner) || !Array.isArray(runner['args'])) continue;
      const { args, dropped } = withoutMaxTurnsArgs(runner['args'] as readonly unknown[]);
      if (dropped.length === 0) continue;
      nextRunners = { ...nextRunners, [name]: { ...runner, args } };
      ignored.push({ path: ['runners', name, 'args'], kind: 'max_turns', value: dropped.join(', ') });
    }
    if (nextRunners !== runners) result = { ...result, runners: nextRunners };
  }

  return { filtered: result, ignored };
}

/** The global primary role a `fallback.roles` key names, or nothing for an unknown key. */
function primaryRoleOf(global: ConfigRecord, name: string): unknown {
  if (!(WORKFLOW_ROLES as readonly string[]).includes(name)) return undefined;
  return valueAt(global, [...roleConfigKeys(name as WorkflowRole)]);
}

/**
 * `args` without any `--max-turns`, in its spaced or `--flag=value` spelling, and the values
 * removed. The flag takes exactly one value, so the spaced form drops the next token too —
 * unless that token is another option, which would mean the value was never there.
 */
function withoutMaxTurnsArgs(args: readonly unknown[]): { args: unknown[]; dropped: string[] } {
  const kept: unknown[] = [];
  const dropped: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === MAX_TURNS_FLAG) {
      const next = args[index + 1];
      if (typeof next === 'string' && !next.startsWith('-')) {
        dropped.push(next);
        index++;
      } else {
        dropped.push('');
      }
      continue;
    }
    if (typeof token === 'string' && token.startsWith(`${MAX_TURNS_FLAG}=`)) {
      dropped.push(token.slice(MAX_TURNS_FLAG.length + 1));
      continue;
    }
    kept.push(token);
  }
  return { args: kept, dropped };
}

/**
 * One role's record, tightened against the global records that bound it, in precedence order.
 *
 * The role ceiling is the first `maxTurns` among them; a stage's is the first of each record's
 * own stage value, then that record's role value — so for one record it is "global stage, else
 * global role", and for a fallback it continues into the primary.
 */
function tightenRole(
  projectRole: ConfigRecord,
  globals: readonly unknown[],
  path: readonly string[],
  ignored: IgnoredLoosening[],
  /**
   * Overrides the role-level ceiling. A fallback's role-level `maxTurns` serves every stage
   * the role does, so it is held to the lowest global ceiling that applies to any of them.
   */
  roleCeilingOverride?: number,
): ConfigRecord {
  const records = globals.filter(isRecord);
  const roleCeiling = roleCeilingOverride ?? firstCeiling(records.map((record) => record['maxTurns']));
  let result = projectRole;
  if (raises(projectRole['maxTurns'], roleCeiling)) {
    result = without(projectRole, 'maxTurns');
    ignored.push({ path: [...path, 'maxTurns'], kind: 'max_turns', value: projectRole['maxTurns'] as number });
  }

  const stages = projectRole['stages'];
  if (isRecord(stages)) {
    let nextStages: ConfigRecord = stages;
    for (const [stage, override] of Object.entries(stages)) {
      if (!isRecord(override)) continue;
      const stageCeiling = firstCeiling(
        records.flatMap((record) => {
          const globalStages = record['stages'];
          const globalStage = isRecord(globalStages) ? globalStages[stage] : undefined;
          return [isRecord(globalStage) ? globalStage['maxTurns'] : undefined, record['maxTurns']];
        }),
      );
      if (raises(override['maxTurns'], stageCeiling)) {
        nextStages = { ...nextStages, [stage]: without(override, 'maxTurns') };
        ignored.push({
          path: [...path, 'stages', stage, 'maxTurns'],
          kind: 'max_turns',
          value: override['maxTurns'] as number,
        });
      }
    }
    if (nextStages !== stages) result = { ...result, stages: nextStages };
  }

  return result;
}

/** The lowest `maxTurns` across these records and every one of their stage overrides. */
function lowestCeiling(globals: readonly unknown[]): number | undefined {
  const values = globals.filter(isRecord).flatMap((record) => {
    const stages = record['stages'];
    const stageValues = isRecord(stages)
      ? Object.values(stages).map((stage) => (isRecord(stage) ? stage['maxTurns'] : undefined))
      : [];
    return [record['maxTurns'], ...stageValues];
  });
  const ceilings = values.map(ceilingOf).filter((value): value is number => value !== undefined);
  return ceilings.length === 0 ? undefined : Math.min(...ceilings);
}

function firstCeiling(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const ceiling = ceilingOf(value);
    if (ceiling !== undefined) return ceiling;
  }
  return undefined;
}

function ceilingOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** True only for a number above a ceiling that exists. Anything else is the schema's to judge. */
function raises(value: unknown, ceiling: number | undefined): boolean {
  return ceiling !== undefined && typeof value === 'number' && value > ceiling;
}

function without(source: ConfigRecord, key: string): ConfigRecord {
  const copy: ConfigRecord = { ...source };
  delete copy[key];
  return copy;
}

function setAt(source: ConfigRecord, path: readonly string[], value: ConfigRecord): ConfigRecord {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (rest.length === 0) return { ...source, [head]: value };
  const child = source[head];
  return { ...source, [head]: setAt(isRecord(child) ? child : {}, rest, value) };
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
