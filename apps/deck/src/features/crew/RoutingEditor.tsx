import { useState } from 'react';
import type { ConfigEditorFieldView, ConfigEditorView, RoleRouteView, RunnerTypeView } from '@contracts/index.js';
import type { ConfigEditorOperation } from '../../lib/api';
import { Empty, Skeleton } from '../../components/ui';
import { displayValue, pathLabel, roleNeeds, runnerIdsOf } from './crew-config';
import { FieldControl } from './FieldControl';

/**
 * Who occupies each post, as one row per role.
 *
 * The page already showed this table — resolved, correct, and read-only — while the way
 * to change any of it was a collapsed accordion of dotted paths. Both halves of the
 * question live here now: what a role is configured to use, and what that configuration
 * actually resolves to, side by side.
 *
 * The resolved column is the server's answer about the *saved* file, so a row with an
 * unsaved edit says so rather than pretending to have re-resolved it here. Resolution
 * needs runner capabilities the browser does not have, and a guess in this column is
 * worse than a stale truth: it is the column people trust.
 */
export function RoutingEditor({ view, roles, types, operations, onChange, onOperations }: {
  readonly view: ConfigEditorView;
  readonly roles: { readonly data: readonly RoleRouteView[] | undefined; readonly loading: boolean; readonly error: unknown };
  readonly types: readonly RunnerTypeView[] | undefined;
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
  readonly onOperations: (operations: ConfigEditorOperation[]) => void;
}) {
  const runners = runnerIdsOf(view.fields);
  return (
    <section className="crew-roles" aria-labelledby="role-routing">
      <div className="section__head">
        <h3 id="role-routing" className="eyebrow" style={{ margin: 0 }}>Roles</h3>
        <span className="section__count">{roles.data?.length ?? 9} posts · {runners.length} runners declared</span>
      </div>
      {roles.error !== undefined
        ? <Empty error>Routing could not be read.</Empty>
        : roles.loading
          ? <Skeleton rows={4} />
          : <>
            <AssignAll view={view} roles={roles.data ?? []} types={types} runners={runners} operations={operations} onOperations={onOperations} />
            <div className="table-wrap"><table className="table crew-roles__table">
            <thead><tr><th>role</th><th>needs</th><th>runner</th><th>model</th><th>effort</th><th>resolves to</th></tr></thead>
            <tbody>{(roles.data ?? []).map((role) => (
              <RoutingRow key={role.role} role={role} view={view} runners={runners} operations={operations} onChange={onChange} />
            ))}</tbody>
            </table></div>
          </>}
    </section>
  );
}

/**
 * Every post at once, skipping the ones this runner cannot hold.
 *
 * "Point the whole crew at claude" was a nine-row edit, and it is the first thing anybody
 * does with a second provider installed. A runner with no working directory cannot take
 * the executors — the resolver refuses it — so those rows are left alone and counted
 * rather than written and rejected on save.
 */
function AssignAll({ view, roles, types, runners, operations, onOperations }: {
  readonly view: ConfigEditorView;
  readonly roles: readonly RoleRouteView[];
  readonly types: readonly RunnerTypeView[] | undefined;
  readonly runners: readonly string[];
  readonly operations: readonly ConfigEditorOperation[];
  readonly onOperations: (operations: ConfigEditorOperation[]) => void;
}) {
  const [pick, setPick] = useState('');
  const capabilities = runnerCapabilities(view.fields, types, pick);
  const eligible = roles.filter((role) => canServe(role, capabilities));
  const skipped = roles.length - eligible.length;
  const assign = (): void => {
    if (pick === '' || eligible.length === 0) return;
    const paths = new Set(eligible.map((role) => pathLabel([...role.configKeys, 'runner'])));
    onOperations([
      ...operations.filter((operation) => !paths.has(pathLabel(operation.path))),
      ...eligible.map((role): ConfigEditorOperation => ({ kind: 'set', path: [...role.configKeys, 'runner'], value: pick })),
    ]);
  };
  return (
    <div className="crew-bulk">
      <label htmlFor="assign-all">Assign every role to</label>
      <select id="assign-all" className="input mono" value={pick} onChange={(event) => setPick(event.target.value)}>
        <option value="">Choose a runner</option>
        {runners.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      <button type="button" className="btn btn--sm" disabled={pick === '' || eligible.length === 0} onClick={assign}>
        Apply to {eligible.length} role{eligible.length === 1 ? '' : 's'}
      </button>
      {pick !== '' && skipped > 0
        ? <small>{skipped} left as {skipped === 1 ? 'it is' : 'they are'}: {pick} has no working directory, so it cannot serve a role that writes.</small>
        : null}
    </div>
  );
}

/** What the picked runner can do, from its declared type. Unknown type means unknown. */
function runnerCapabilities(fields: readonly ConfigEditorFieldView[], types: readonly RunnerTypeView[] | undefined, id: string): RunnerTypeView['capabilities'] | undefined {
  if (id === '') return undefined;
  const type = fields.find((field) => pathLabel(field.path) === `runners.${id}.type`)?.effectiveValue;
  return types?.find((entry) => entry.type === type)?.capabilities;
}

/** A role a runner cannot serve is one the resolver would refuse (§3, core/role). */
function canServe(role: RoleRouteView, capabilities: RunnerTypeView['capabilities'] | undefined): boolean {
  if (capabilities === undefined) return true;
  if (role.requiresWorkingDirectory && !capabilities.supportsWorkingDirectory) return false;
  return !(role.requiresReadOnly && !capabilities.supportsReadOnly);
}

function RoutingRow({ role, view, runners, operations, onChange }: {
  readonly role: RoleRouteView;
  readonly view: ConfigEditorView;
  readonly runners: readonly string[];
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
}) {
  const pending = operations.some((operation) => pathLabel(operation.path).startsWith(`${pathLabel(role.configKeys)}.`));
  return (
    <tr data-pending={pending} data-unresolved={role.error !== undefined}>
      <td>
        <span className="crew-roles__name mono">{role.role}</span>
        <small>{role.prompts.join(', ')}</small>
      </td>
      <td>
        <span className="tag-list">
          <span className="tag" data-writes={role.requiresWorkingDirectory && !role.requiresReadOnly}>{roleNeeds(role)}</span>
          {role.requiresNativeStructuredOutput ? <span className="tag">structured</span> : null}
        </span>
      </td>
      <RoutingCell role={role} view={view} leaf="runner" options={runners} operations={operations} onChange={onChange} />
      <RoutingCell role={role} view={view} leaf="model" operations={operations} onChange={onChange} />
      <RoutingCell role={role} view={view} leaf="effort" operations={operations} onChange={onChange} />
      <td className="crew-roles__resolved">
        {role.error === undefined
          ? <>
            <span className="mono">{role.resolved?.runner ?? '—'}{role.resolved?.model === undefined ? '' : ` · ${role.resolved.model}`}</span>
            {role.resolved?.reasoningClamped === true
              ? <small>effort {role.configured.reasoning} ran as {role.resolved.reasoning} — the runner's ceiling</small>
              : null}
          </>
          : <span className="crew-roles__error">{role.error.message}</span>}
        {pending ? <small className="crew-roles__pending">unsaved — resolves again after saving</small> : null}
      </td>
    </tr>
  );
}

/**
 * Where this cell's value comes from, in three words.
 *
 * An unset model is not an empty one: it means the runner applies whatever model it is
 * already configured with, which is the shipped default and deliberate (AD-13). Saying
 * "inherits not set" under it described the schema instead of the behaviour.
 */
function originNote(field: ConfigEditorFieldView, inherited: boolean): string {
  if (!inherited) return `set in ${field.origin ?? 'this source'}`;
  return field.effectiveValue === undefined ? 'the runner decides' : `inherits ${displayValue(field.effectiveValue)}`;
}

/** One editable leaf of a role's route, addressed by the path the server published. */
function RoutingCell({ role, view, leaf, options, operations, onChange }: {
  readonly role: RoleRouteView;
  readonly view: ConfigEditorView;
  readonly leaf: 'runner' | 'model' | 'effort';
  readonly options?: readonly string[];
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
}) {
  const label = pathLabel([...role.configKeys, leaf]);
  const field = view.fields.find((entry) => pathLabel(entry.path) === label);
  if (field === undefined) return <td className="faint">not editable here</td>;

  const operation = [...operations].reverse().find((entry) => pathLabel(entry.path) === label);
  const raw = operation?.kind === 'set'
    ? String(operation.value)
    : operation?.kind === 'unset'
      ? ''
      : field.explicitValue === undefined ? '' : String(field.explicitValue);
  const inherited = field.explicitValue === undefined && operation === undefined;
  const id = `route-${label}`;
  return (
    <td>
      <label className="visually-hidden" htmlFor={id}>{label}</label>
      <FieldControl
        id={id}
        field={field}
        raw={raw}
        inherited={inherited}
        {...(options === undefined ? {} : { options })}
        onChange={(value, inherit) => onChange(field, value, inherit)}
      />
      <small className="crew-roles__origin">{originNote(field, inherited)}</small>
    </td>
  );
}
