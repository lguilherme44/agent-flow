import { useState } from 'react';
import type { ConfigEditorFieldView, ConfigEditorView, RoleRouteView, RunnerHealthView, RunnerModelsView, RunnerTypeView } from '@contracts/index.js';
import type { ConfigEditorOperation } from '../../lib/api';
import { Chip, Empty, Skeleton } from '../../components/ui';
import { useT, word, type Dictionary } from '../../lib/i18n';
import { blockedRunnerDependencies, operationsToRemoveDynamicEntity, pathLabel, runnerIdsOf, runnerLeafFields } from './crew-config';
import { FieldControl } from './FieldControl';

/**
 * The agents this machine has, as objects rather than as forty dotted keys.
 *
 * A runner was eight rows in a `Runners` accordion — `runners.claude.type`,
 * `runners.claude.enabled`, and so on — with its health reported in a separate card at
 * the bottom of the page that the configuration never mentioned. One card per runner puts
 * the identity, the switch, the model, the reported health and the roles that depend on
 * it in the one place a person asks about them.
 */
export function RunnerGrid({ view, roles, health, types, models, operations, onChange, onOperations }: {
  readonly view: ConfigEditorView;
  readonly roles: readonly RoleRouteView[] | undefined;
  readonly health: { readonly data: readonly RunnerHealthView[] | undefined; readonly loading: boolean; readonly error: unknown };
  readonly types: { readonly data: readonly RunnerTypeView[] | undefined; readonly error: unknown };
  readonly models: readonly RunnerModelsView[] | undefined;
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
  readonly onOperations: (operations: ConfigEditorOperation[]) => void;
}) {
  const t = useT();
  const ids = runnerIdsOf(view.fields);
  const [adding, setAdding] = useState(false);
  return (
    <section className="crew-runners" aria-labelledby="runners-grid">
      <div className="section__head">
        <h3 id="runners-grid" className="eyebrow" style={{ margin: 0 }}>{t.crew.runners}</h3>
        <span className="section__count">{t.crew.declaredAndTypes(ids.length, types.data?.length)}</span>
      </div>
      {health.loading && ids.length === 0 ? <Skeleton rows={2} /> : null}
      <div className="runner-cards">
        {ids.map((id) => (
          <RunnerCard
            key={id}
            id={id}
            view={view}
            roles={roles}
            health={health.data?.find((entry) => entry.id === id)}
            types={types.data}
            models={models?.find((entry) => entry.id === id)?.models}
            operations={operations}
            onChange={onChange}
            onOperations={onOperations}
          />
        ))}
        {adding
          ? <AddRunner view={view} types={types} onCancel={() => setAdding(false)} onCreate={(next) => { setAdding(false); onOperations([...operations, ...next]); }} />
          : <button type="button" className="runner-card runner-card--add" onClick={() => setAdding(true)}>
            <span aria-hidden="true">+</span>
            <span>{t.crew.addRunner}</span>
            <small>{types.data === undefined ? t.crew.typesUnavailable : t.crew.typesSupported(types.data.length)}</small>
          </button>}
      </div>
      {types.error === undefined ? null : <Empty error>{t.crew.typesCouldNotRead}</Empty>}
    </section>
  );
}

/**
 * Whether this runner is on, counting the switch the operator has already flipped.
 *
 * Read from the pending operations first and from `effectiveValue` only as the fallback.
 * The control itself has always resolved its own value this way; the *card* did not, so
 * flipping the switch left the card lit and undimmed until the change was saved — the one
 * moment when saying something is still useful.
 */
function pendingEnabled(
  fields: readonly ConfigEditorFieldView[],
  operations: readonly ConfigEditorOperation[],
): boolean {
  const field = fields.find(({ path }) => path[2] === 'enabled');
  if (field === undefined) return true;

  const label = pathLabel(field.path);
  const operation = [...operations].reverse().find((entry) => pathLabel(entry.path) === label);
  // `unset` returns the key to whatever the layer beneath declares, which the view already
  // carries as the effective value — the pending edit removes an override, not the answer.
  if (operation?.kind === 'set') return operation.value !== false && operation.value !== 'false';
  return field.effectiveValue !== false;
}

/**
 * The sentence a switched-off runner owes the roles still pointing at it.
 *
 * Assembled here rather than interpolated across JSX so it renders as one text node. Split
 * across five expressions it read the same on screen and was unmatchable by any query that
 * asks for a sentence — which is how a message ends up untested for the one thing it says.
 */
function brokenBySwitch(t: Dictionary, routes: number): string {
  return t.crew.brokenBySwitch(routes);
}

function RunnerCard({ id, view, roles, health, types, models, operations, onChange, onOperations }: {
  readonly id: string;
  readonly view: ConfigEditorView;
  readonly roles: readonly RoleRouteView[] | undefined;
  readonly health: RunnerHealthView | undefined;
  readonly types: readonly RunnerTypeView[] | undefined;
  /** What this runner reported it can be pointed at. A suggestion, never a constraint. */
  readonly models: readonly string[] | undefined;
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
  readonly onOperations: (operations: ConfigEditorOperation[]) => void;
}) {
  const t = useT();
  const fields = runnerLeafFields(view.fields, id);
  const type = String(fields.find(({ path }) => path[2] === 'type')?.effectiveValue ?? '');
  const enabled = pendingEnabled(fields, operations);
  const declared = types?.find((entry) => entry.type === type);
  const used = (roles ?? []).filter((role) => role.resolved?.runner === id || role.configured.runner === id).length;
  const blocked = blockedRunnerDependencies(id, view.fields);
  const removals = operationsToRemoveDynamicEntity(['runners', id], view.fields);
  const switchField = fields.find(({ path }) => path[2] === 'enabled');
  const model = fields.find(({ path }) => path[2] === 'model')?.effectiveValue;
  return (
    <div className="runner-card" data-off={!enabled}>
      <div className="runner-card__top">
        <div className="runner-card__name">
          <span className="runner-card__id mono">{id}</span>
          <span className="runner-card__type mono">{type || t.crew.noType}</span>
        </div>
        {switchField === undefined
          ? null
          : <RunnerField field={switchField} operations={operations} onChange={onChange} compact />}
        {health === undefined
          ? null
          : <Chip tone={!health.installed || !health.executable ? 'bad' : health.auth === 'unknown' ? 'idle' : 'ok'}>
            {!health.installed ? t.crew.missing : word(t, health.auth)}
          </Chip>}
      </div>
      {declared === undefined
        ? <p className="runner-card__unknown">{t.crew.typeBefore}<code>{type || t.crew.unset}</code>{t.crew.typeAfter}</p>
        : <p className="runner-card__caps">
          <span className="tag">{declared.capabilities.supportsWorkingDirectory ? t.crew.worksInRepo : t.crew.textOnly}</span>
          <span className="tag">{declared.capabilities.supportsReadOnly ? t.crew.canReadOnly : t.crew.noReadOnly}</span>
          <span className="tag">{declared.capabilities.structuredOutputStrategy}</span>
        </p>}
      <details className="runner-card__more">
        <summary>{t.crew.settingCount(fields.length)}</summary>
        <div className="runner-card__fields">
          {fields.filter(({ path }) => path[2] !== 'enabled').map((field) => (
            <RunnerField
              key={pathLabel(field.path)}
              field={field}
              operations={operations}
              onChange={onChange}
              {...(field.path[2] === 'model' && models !== undefined ? { suggestions: models } : {})}
            />
          ))}
        </div>
      </details>
      <div className="runner-card__foot">
        <span className="mono">{model === undefined ? t.crew.runnerDefault : String(model)}</span>
        <span>{t.crew.roleCount(used)}</span>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          aria-label={t.crew.removeRunner(id)}
          disabled={removals.length === 0 || blocked.length > 0}
          title={blocked.length === 0 ? undefined : t.crew.referencedBy(blocked.join(', '))}
          onClick={() => onOperations([...operations, ...removals])}
        >
          {t.crew.remove}
        </button>
      </div>
      {blocked.length === 0
        ? null
        : enabled
          ? <small className="runner-card__blocked" title={blocked.join(', ')}>
            {t.crew.referencedByRoutes(blocked.length)}
          </small>
          /**
           * Turned off with routes still pointing here (PRI-27).
           *
           * `Remove` is already refused while any route references this runner, and the
           * switch beside it was not — for the same consequence. Every one of those roles
           * resolves to `runner_disabled` and cannot run, and until PRI-26 the error they
           * produced said the runner was "not registered" while listing it as known.
           *
           * A live config had exactly this: three lines of project YAML turning `claude`
           * off, six roles still on it, and six red rows underneath explaining themselves
           * badly. The card knew — it prints the route count — and said nothing about what
           * the switch had just done.
           *
           * Stated rather than refused. Turning a runner off and re-pointing its roles in
           * one edit is a legitimate thing to do, and the change bar validates before any
           * of it is written. Silence is the only wrong answer.
           */
          : <small className="runner-card__broken" title={blocked.join(', ')}>
            {brokenBySwitch(t, blocked.length)}
          </small>}
    </div>
  );
}

function RunnerField({ field, operations, onChange, compact = false, suggestions }: {
  readonly field: ConfigEditorFieldView;
  readonly operations: readonly ConfigEditorOperation[];
  readonly onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void;
  /** Renders the control alone, for the switch that sits in the card's header. */
  readonly compact?: boolean;
  readonly suggestions?: readonly string[];
}) {
  const t = useT();
  const label = pathLabel(field.path);
  const leaf = String(field.path[2]);
  const operation = [...operations].reverse().find((entry) => pathLabel(entry.path) === label);
  const raw = operation?.kind === 'set'
    ? Array.isArray(operation.value) ? operation.value.join(', ') : String(operation.value)
    : operation?.kind === 'unset'
      ? ''
      : field.explicitValue === undefined ? '' : Array.isArray(field.explicitValue) ? field.explicitValue.join(', ') : String(field.explicitValue);
  const control = (
    <FieldControl
      id={`runner-${label}`}
      field={field}
      raw={raw}
      inherited={field.explicitValue === undefined && operation === undefined}
      {...(suggestions === undefined ? {} : { suggestions })}
      onChange={(value, inherit) => onChange(field, value, inherit)}
    />
  );
  if (compact) {
    return (
      <span className="runner-card__switch" title={field.effectiveValue === false ? t.crew.disabled : t.crew.enabled}>
        <label className="visually-hidden" htmlFor={`runner-${label}`}>{label}</label>
        {control}
      </span>
    );
  }
  return (
    <div className="runner-field">
      <label className="runner-field__name" htmlFor={`runner-${label}`}>
        <span className="visually-hidden">{`${String(field.path[0])}.${String(field.path[1])}.`}</span>{leaf}
      </label>
      {control}
    </div>
  );
}

/**
 * Declaring a runner, type first.
 *
 * The type decides which keys exist — a CLI takes a `command`, an endpoint takes a
 * `baseUrl` and the *name* of an environment variable — so asking for it first is what
 * makes the rest of the form answerable. The server supplies both the list and the keys;
 * nothing here knows what a runner type is called.
 */
function AddRunner({ view, types, onCancel, onCreate }: {
  readonly view: ConfigEditorView;
  readonly types: { readonly data: readonly RunnerTypeView[] | undefined; readonly error: unknown };
  readonly onCancel: () => void;
  readonly onCreate: (operations: ConfigEditorOperation[]) => void;
}) {
  const t = useT();
  const [id, setId] = useState('');
  const [type, setType] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const selected = types.data?.find((entry) => entry.type === type);
  const taken = runnerIdsOf(view.fields).includes(id.trim());
  const missing = (selected?.fields ?? []).filter((field) => field.required && (values[field.name] ?? '').trim() === '');
  const valid = /^[a-z][a-z0-9-]{0,31}$/.test(id.trim()) && selected !== undefined && !taken && missing.length === 0;

  const create = (): void => {
    if (selected === undefined || !valid) return;
    onCreate([
      { kind: 'set', path: ['runners', id.trim(), 'type'], value: selected.type },
      { kind: 'set', path: ['runners', id.trim(), 'enabled'], value: true },
      ...selected.fields.flatMap((field): ConfigEditorOperation[] => {
        const raw = (values[field.name] ?? '').trim();
        if (raw === '') return [];
        const value = field.name === 'contextWindow' ? Number(raw) : field.name === 'args' ? raw.split(',').map((item) => item.trim()).filter(Boolean) : raw;
        return [{ kind: 'set', path: ['runners', id.trim(), field.name], value }];
      }),
    ]);
  };

  return (
    <div className="runner-card runner-card--form">
      <div className="runner-field">
        <label className="runner-field__name" htmlFor="new-runner-id">id</label>
        <input id="new-runner-id" className="input mono" value={id} placeholder="local" onChange={(event) => setId(event.target.value)} />
      </div>
      <div className="runner-field">
        <label className="runner-field__name" htmlFor="new-runner-type">type</label>
        <select id="new-runner-type" className="input mono" value={type} onChange={(event) => { setType(event.target.value); setValues({}); }}>
          <option value="">{t.crew.chooseType}</option>
          {(types.data ?? []).map((entry) => <option key={entry.type} value={entry.type}>{entry.type}</option>)}
        </select>
      </div>
      {(selected?.fields ?? []).map((field) => (
        <div className="runner-field" key={field.name}>
          <label className="runner-field__name" htmlFor={`new-runner-${field.name}`}>{field.name}{field.required ? ' *' : ''}</label>
          <input
            id={`new-runner-${field.name}`}
            className="input mono"
            value={values[field.name] ?? ''}
            placeholder={field.secretEnv === true ? t.crew.envVarPlaceholder : undefined}
            onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
          />
          {field.secretEnv === true ? <small>{t.crew.secretEnvNote}</small> : null}
        </div>
      ))}
      <div className="runner-card__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>{t.common.cancel}</button>
        <button type="button" className="btn btn--sm" disabled={!valid} onClick={create}>{t.crew.addRunner}</button>
      </div>
      {taken ? <small className="runner-card__blocked">{t.crew.runnerExists(id.trim())}</small> : null}
    </div>
  );
}
