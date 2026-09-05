import type { ConfigEditorDynamicFieldView, ConfigEditorFieldView } from '@contracts/index.js';
import type { ConfigEditorOperation } from '../../lib/api';

const SECTION_NAMES: Record<string, string> = {
  runners: 'Runners', roles: 'Routing', fallback: 'Fallback', teams: 'Teams',
  project: 'Project', commands: 'Commands', paths: 'Paths', validationCommands: 'Validation commands',
  parallelism: 'Parallelism', retry: 'Retry', git: 'Git', approval: 'Approval', recovery: 'Recovery',
  execution: 'Execution', ui: 'UI', utilityModel: 'Utility model', collaboration: 'Collaboration',
  quality: 'Quality', review: 'Review', forge: 'Forge', rules: 'Rules', version: 'General',
};

export function pathLabel(path: readonly (string | number)[]): string {
  return path.map(String).join('.');
}

export function fieldInputValue(field: ConfigEditorFieldView): string {
  return field.explicitValue === undefined
    ? ''
    : Array.isArray(field.explicitValue)
      ? field.explicitValue.join(', ')
      : String(field.explicitValue);
}

/** A value as a person reads it. `undefined` is a state, not an empty string. */
export function displayValue(value: unknown): string {
  if (value === undefined) return 'not set';
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * Every runner id this source can route to, from the paths the server expanded.
 *
 * Derived rather than typed by hand: a runner exists because `runners.<id>.<leaf>` is in
 * the view, which is the same evidence the resolver works from. A role pointing at an id
 * that is not here is a broken route, and the control says so instead of silently
 * offering a list the value is not in.
 */
export function runnerIdsOf(fields: readonly ConfigEditorFieldView[]): readonly string[] {
  const ids = new Set<string>();
  for (const { path } of fields) {
    if (path.length === 3 && String(path[0]) === 'runners') ids.add(String(path[1]));
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * What a role needs from its runner, as one phrase.
 *
 * Two independent signals, and reading either alone gets it backwards. `architect` runs
 * `discovery`, which is `permissions: read-only` *and* `workingDirectory: true` — it
 * reads the repository without writing a line, so labelling it by the working directory
 * alone calls it a writer. `sdd` is read-only with no working directory at all: it
 * carries its whole input, which is exactly why it can run on an inference endpoint.
 */
export function roleNeeds(role: { readonly requiresReadOnly: boolean; readonly requiresWorkingDirectory: boolean }): 'writes files' | 'reads files' | 'text only' {
  if (!role.requiresWorkingDirectory) return 'text only';
  return role.requiresReadOnly ? 'reads files' : 'writes files';
}

/**
 * The `agent-flow config` line that performs one operation.
 *
 * Both adapters call the same use case, so an edit made here has an exact terminal
 * equivalent — and printing it is what makes that claim checkable rather than a sentence
 * in the footer. `--global` is the flag the CLI actually takes; project scope is the
 * default there, so it carries none.
 *
 * The value is written the way `parseConfigValue` reads it, which is not the way this
 * screen displays it: that function tries `JSON.parse` before falling back to a plain
 * string, so a list has to arrive as JSON. Joining it with commas produces a command that
 * runs and stores the wrong thing — a string where an array belongs — which is worse than
 * no command at all.
 */
export function cliCommandFor(scope: 'global' | 'project', operation: ConfigEditorOperation): string {
  const flag = scope === 'global' ? ' --global' : '';
  const key = pathLabel(operation.path);
  if (operation.kind === 'unset') return `agent-flow config unset ${key}${flag}`;
  const value = Array.isArray(operation.value) ? JSON.stringify(operation.value) : String(operation.value);
  return `agent-flow config set ${key} ${shellArgument(value)}${flag}`;
}

function shellArgument(value: string): string {
  return value === '' || /[\s"'$`\\|&;<>()*?[\]{}#~!]/.test(value) ? `'${value.replaceAll("'", `'\\''`)}'` : value;
}

/** One runner's own leaves, in the order the card shows them. */
export function runnerLeafFields(fields: readonly ConfigEditorFieldView[], id: string): readonly ConfigEditorFieldView[] {
  const order = ['type', 'enabled', 'model', 'command', 'baseUrl', 'apiKeyEnv', 'args', 'contextWindow'];
  const own = fields.filter(({ path }) => path.length === 3 && String(path[0]) === 'runners' && String(path[1]) === id);
  return [...own].sort((left, right) => order.indexOf(String(left.path[2])) - order.indexOf(String(right.path[2])));
}

/** The paths a role-routing table already edits, so no accordion repeats them. */
export function routedFieldPaths(roles: readonly { readonly configKeys: readonly string[] }[]): ReadonlySet<string> {
  return new Set(roles.flatMap(({ configKeys }) => ['runner', 'model', 'effort'].map((leaf) => pathLabel([...configKeys, leaf]))));
}

/** The items of a list value, whatever shape the source stored it in. */
export function listItems(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((item) => item !== '');
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Which layer this value came from, in one line.
 *
 * The layer is the useful half of a configuration screen: "maxTasks is 1" invites an edit
 * here, "maxTasks is 1, inherited from global" says the edit belongs somewhere else.
 */
export function originLabel(field: ConfigEditorFieldView, inherited: boolean): string {
  if (!field.editable) return 'Global only';
  return inherited
    ? `Inherited from ${field.origin ?? 'default'}`
    : `Explicit in ${field.origin ?? 'this source'}`;
}

/**
 * When a field's timing is worth a word.
 *
 * Nearly every field takes effect on the next execution context, so saying it under all
 * of them said nothing under any of them. The two that behave differently keep their note.
 */
export function effectNote(effect: ConfigEditorFieldView['effect']): string | undefined {
  if (effect === 'server_restart') return 'needs a server restart';
  if (effect === 'next_run') return 'applies to the next run';
  return undefined;
}

/**
 * Whether a field earns a row when inherited values are folded away.
 *
 * A field being edited stays visible whatever the filter says: hiding the row a person is
 * typing in because their edit has not been saved yet is the filter eating its own input.
 */
export function isFieldShown(field: ConfigEditorFieldView, edited: boolean, showInherited: boolean): boolean {
  return showInherited || edited || field.explicitValue !== undefined;
}

export function operationForField(field: ConfigEditorFieldView, raw: string, inherit = false): ConfigEditorOperation {
  if (inherit) return { kind: 'unset', path: field.path };
  return { kind: 'set', path: field.path, value: parseFieldValue(field.valueType, raw) };
}

export function operationForDynamicField(field: ConfigEditorDynamicFieldView, identifiers: readonly string[], raw: string): ConfigEditorOperation {
  let index = 0;
  const path = field.path.map((segment) => segment === '*' ? identifiers[index++]?.trim() ?? '' : segment);
  if (path.some((segment) => segment === '')) throw new Error('Every dynamic identifier is required.');
  return { kind: 'set', path, value: parseFieldValue(field.valueType, raw) };
}

function parseFieldValue(valueType: ConfigEditorFieldView['valueType'], raw: string): unknown {
  let value: unknown = raw;
  if (valueType === 'boolean') value = raw === 'true';
  else if (valueType === 'integer' || valueType === 'number') value = Number(raw);
  else if (valueType === 'string_list') value = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return value;
}

export function operationsToRemoveDynamicEntity(prefix: readonly (string | number)[], fields: readonly ConfigEditorFieldView[]): ConfigEditorOperation[] {
  return fields
    .filter(({ path, explicitValue }) => explicitValue !== undefined && prefix.every((part, index) => String(path[index]) === String(part)))
    .map(({ path }) => ({ kind: 'unset' as const, path }));
}

export function dynamicEntityPrefixes(fields: readonly ConfigEditorFieldView[], templates: readonly ConfigEditorDynamicFieldView[]): readonly (readonly (string | number)[])[] {
  const prefixes = new Map<string, readonly (string | number)[]>();
  for (const template of templates) {
    for (const field of fields) {
      if (field.path.length !== template.path.length || !template.path.every((part, index) => part === '*' || String(field.path[index]) === part)) continue;
      template.path.forEach((part, index) => {
        if (part !== '*') return;
        const prefix = field.path.slice(0, index + 1);
        prefixes.set(pathLabel(prefix), prefix);
      });
    }
  }
  return [...prefixes.values()].sort((left, right) => pathLabel(left).localeCompare(pathLabel(right)));
}

export function sectionFields(fields: readonly ConfigEditorFieldView[]): ReadonlyMap<string, readonly ConfigEditorFieldView[]> {
  const sections = new Map<string, ConfigEditorFieldView[]>();
  for (const field of fields) {
    const head = String(field.path[0] ?? 'general');
    const name = SECTION_NAMES[head] ?? head;
    const values = sections.get(name) ?? [];
    values.push(field);
    sections.set(name, values);
  }
  return sections;
}


export function blockedRunnerDependencies(runnerId: string, fields: readonly ConfigEditorFieldView[]): string[] {
  return fields
    .filter((field) => {
      const path = pathLabel(field.path);
      return field.effectiveValue === runnerId
        && (path.startsWith('roles.') || path.startsWith('fallback.roles.') || path.startsWith('teams.'))
        && path.endsWith('.runner');
    })
    .map(({ path }) => pathLabel(path));
}

export function effectSummary(effects: readonly ConfigEditorFieldView['effect'][]): string {
  if (effects.includes('server_restart')) return 'after a server restart';
  if (effects.includes('next_run')) return 'to the next run';
  return 'to the next execution context';
}

export function configInvalidationPredicate(scope: 'global' | 'project', projectId: string): (key: string) => boolean {
  return (key) => {
    if (scope === 'global') return key.includes('/config') || key.includes('/agents') || key.includes('/runners/health');
    if (!key.includes(`projectId=${encodeURIComponent(projectId)}`)) return false;
    return key.includes('/config') || key.includes('/agents') || key.includes('/runners/health');
  };
}
