import { useState } from 'react';
import type { ConfigEditorFieldView, ConfigEditorView, RoleRouteView, RunnerModelsView, RunnerTypeView } from '@contracts/index.js';
import type { ConfigEditorOperation } from '../../lib/api';
import { Empty, Skeleton } from '../../components/ui';
import { level, useT, type Dictionary } from '../../lib/i18n';
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
export function RoutingEditor({ view, roles, types, models, operations, onChange, onOperations }: {
  readonly view: ConfigEditorView;
  readonly roles: { readonly data: readonly RoleRouteView[] | undefined; readonly loading: boolean; readonly error: unknown };
  readonly types: readonly RunnerTypeView[] | undefined;
  readonly models: readonly RunnerModelsView[] | undefined;
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
  readonly onOperations: (operations: ConfigEditorOperation[]) => void;
}) {
  const t = useT();
  const runners = runnerIdsOf(view.fields);
  return (
    <section className="crew-roles" aria-labelledby="role-routing">
      <div className="section__head">
        <h3 id="role-routing" className="eyebrow" style={{ margin: 0 }}>{t.crew.roles}</h3>
        <span className="section__count">{t.crew.postsAndRunners(roles.data?.length ?? 9, runners.length)}</span>
      </div>
      {roles.error !== undefined
        ? <Empty error>{t.crew.routingCouldNotRead}</Empty>
        : roles.loading
          ? <Skeleton rows={4} />
          : <>
            <AssignAll view={view} roles={roles.data ?? []} types={types} runners={runners} operations={operations} onOperations={onOperations} />
            <div className="table-wrap"><table className="table crew-roles__table">
            <thead><tr><th>{t.crew.colRole}</th><th>{t.crew.colNeeds}</th><th>{t.inspector.runner}</th><th>{t.inspector.model}</th><th>{t.crew.colEffort}</th><th>{t.crew.colResolves}</th></tr></thead>
            <tbody>{(roles.data ?? []).map((role) => (
              <RoutingRow key={role.role} role={role} view={view} runners={runners} models={models} operations={operations} onChange={onChange} />
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
 * does with a second provider installed. Some rows a given runner cannot take — the
 * resolver refuses them — so they are left alone and counted rather than written and
 * rejected on save.
 *
 * **The count was right and the sentence explaining it was wrong.** It named one of the
 * two possible reasons regardless of which check failed, so pointing everything at `agy`
 * skipped the six read-only posts and blamed a missing working directory — the opposite of
 * the truth, since `agy` is the runner that writes. The reason is derived per role now.
 */
function AssignAll({ view, roles, types, runners, operations, onOperations }: {
  readonly view: ConfigEditorView;
  readonly roles: readonly RoleRouteView[];
  readonly types: readonly RunnerTypeView[] | undefined;
  readonly runners: readonly string[];
  readonly operations: readonly ConfigEditorOperation[];
  readonly onOperations: (operations: ConfigEditorOperation[]) => void;
}) {
  const t = useT();
  const [pick, setPick] = useState('');
  const capabilities = runnerCapabilities(view.fields, types, pick);
  const eligible = roles.filter((role) => refusalFor(role, capabilities) === undefined);
  const skipped = roles.length - eligible.length;
  // Every distinct reason, in the order the checks run. A runner can fail both — an
  // inference endpoint has neither — and naming one of two is how the wrong one gets named.
  const reasons = [...new Set(roles.flatMap((role) => refusalFor(role, capabilities) ?? []))];
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
      <label htmlFor="assign-all">{t.crew.assignEveryRole}</label>
      <select id="assign-all" className="input mono" value={pick} onChange={(event) => setPick(event.target.value)}>
        <option value="">{t.crew.chooseRunner}</option>
        {runners.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      <button type="button" className="btn btn--sm" disabled={pick === '' || eligible.length === 0} onClick={assign}>
        {t.crew.applyToRoles(eligible.length)}
      </button>
      {pick !== '' && skipped > 0
        ? <small>
            {t.crew.leftAsIs(skipped, pick)}{' '}
            {reasons.map((reason) => refusalText(t, reason)).join(t.crew.andItJoin)}.
          </small>
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
/**
 * Why this runner cannot hold this post, or nothing.
 *
 * Returns the *reason* rather than a boolean, because the sentence under the bulk bar used
 * to hard-code one of the two — "has no working directory, so it cannot serve a role that
 * writes" — whichever check had actually failed. Against `agy` that is wrong twice over:
 * the failing check is read-only, and `agy` is precisely the runner that *can* write. An
 * operator read it, believed the opposite of the truth, and had no way to tell.
 */
function refusalFor(
  role: RoleRouteView,
  capabilities: RunnerTypeView['capabilities'] | undefined,
): 'no working directory' | 'no read-only mode' | undefined {
  if (capabilities === undefined) return undefined;
  if (role.requiresWorkingDirectory && !capabilities.supportsWorkingDirectory) return 'no working directory';
  if (role.requiresReadOnly && !capabilities.supportsReadOnly) return 'no read-only mode';
  return undefined;
}

/** What each reason means for the posts it blocks, in the words the row headings use. */
function refusalText(t: Dictionary, reason: 'no working directory' | 'no read-only mode'): string {
  return reason === 'no working directory' ? t.crew.refusalNoWorkdir : t.crew.refusalNoReadOnly;
}

function RoutingRow({ role, view, runners, models, operations, onChange }: {
  readonly role: RoleRouteView;
  readonly view: ConfigEditorView;
  readonly runners: readonly string[];
  readonly models: readonly RunnerModelsView[] | undefined;
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
}) {
  const t = useT();
  const pending = operations.some((operation) => pathLabel(operation.path).startsWith(`${pathLabel(role.configKeys)}.`));
  // The models offered are the ones the runner *this row points at* reported. Offering
  // every runner's models here would suggest a Gemini id for a role routed to Claude.
  const routed = String(view.fields.find((field) => pathLabel(field.path) === pathLabel([...role.configKeys, 'runner']))?.effectiveValue ?? '');
  const suggested = models?.find((entry) => entry.id === routed)?.models;
  return (
    <tr data-pending={pending} data-unresolved={role.error !== undefined}>
      <td>
        {/* The role id is the configuration key this row edits. Never translated. */}
        <span className="crew-roles__name mono">{role.role}</span>
        <small>{role.prompts.join(', ')}</small>
      </td>
      <td>
        <span className="tag-list">
          <span className="tag" data-writes={role.requiresWorkingDirectory && !role.requiresReadOnly}>{t.crew.needs[roleNeeds(role)]}</span>
          {role.requiresNativeStructuredOutput ? <span className="tag">{t.crew.structured}</span> : null}
        </span>
      </td>
      <RoutingCell role={role} view={view} leaf="runner" options={runners} operations={operations} onChange={onChange} />
      <RoutingCell role={role} view={view} leaf="model" {...(suggested === undefined ? {} : { suggestions: suggested })} operations={operations} onChange={onChange} />
      <RoutingCell role={role} view={view} leaf="effort" operations={operations} onChange={onChange} />
      <td className="crew-roles__resolved">
        {role.error === undefined
          ? <>
            <span className="mono">{role.resolved?.runner ?? t.common.none}{role.resolved?.model === undefined ? '' : ` · ${role.resolved.model}`}</span>
            {role.resolved?.reasoningClamped === true
              ? <small>{t.crew.clampedEffort(level(t, role.configured.reasoning), level(t, role.resolved.reasoning))}</small>
              : null}
          </>
          : <span className="crew-roles__error">{role.error.message}</span>}
        {pending ? <small className="crew-roles__pending">{t.crew.unsavedResolves}</small> : null}
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
function originNote(t: Dictionary, field: ConfigEditorFieldView, inherited: boolean): string {
  if (!inherited) return t.crew.setIn(field.origin ?? t.crew.thisSource);
  return field.effectiveValue === undefined ? t.crew.runnerDecides : t.crew.inherits(displayValue(t, field.effectiveValue));
}

/** One editable leaf of a role's route, addressed by the path the server published. */
function RoutingCell({ role, view, leaf, options, suggestions, operations, onChange }: {
  readonly role: RoleRouteView;
  readonly view: ConfigEditorView;
  readonly leaf: 'runner' | 'model' | 'effort';
  readonly options?: readonly string[];
  readonly suggestions?: readonly string[];
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
}) {
  const t = useT();
  const label = pathLabel([...role.configKeys, leaf]);
  const field = view.fields.find((entry) => pathLabel(entry.path) === label);
  if (field === undefined) return <td className="faint">{t.crew.notEditableHere}</td>;

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
        {...(suggestions === undefined ? {} : { suggestions })}
        onChange={(value, inherit) => onChange(field, value, inherit)}
      />
      <small className="crew-roles__origin">{originNote(t, field, inherited)}</small>
    </td>
  );
}
