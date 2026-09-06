import { useState } from 'react';
import type { ConfigEditorFieldView, ConfigEditorView, RoleRouteView, RunnerHealthView, RunnerModelsView, RunnerTypeView } from '@contracts/index.js';
import type { ConfigEditorOperation } from '../../lib/api';
import { Chip, Empty, Skeleton } from '../../components/ui';
import { words } from '../../lib/tone';
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
  const ids = runnerIdsOf(view.fields);
  const [adding, setAdding] = useState(false);
  return (
    <section className="crew-runners" aria-labelledby="runners-grid">
      <div className="section__head">
        <h3 id="runners-grid" className="eyebrow" style={{ margin: 0 }}>Runners</h3>
        <span className="section__count">{ids.length} declared · {types.data?.length ?? '—'} types supported</span>
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
            <span>Add runner</span>
            <small>{types.data === undefined ? 'types unavailable' : `${String(types.data.length)} types supported`}</small>
          </button>}
      </div>
      {types.error === undefined ? null : <Empty error>Runner types could not be read, so a new runner cannot be described here.</Empty>}
    </section>
  );
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
  const fields = runnerLeafFields(view.fields, id);
  const type = String(fields.find(({ path }) => path[2] === 'type')?.effectiveValue ?? '');
  const enabled = fields.find(({ path }) => path[2] === 'enabled')?.effectiveValue !== false;
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
          <span className="runner-card__type mono">{type || '(no type)'}</span>
        </div>
        {switchField === undefined
          ? null
          : <RunnerField field={switchField} operations={operations} onChange={onChange} compact />}
        {health === undefined
          ? null
          : <Chip tone={!health.installed || !health.executable ? 'bad' : health.auth === 'unknown' ? 'idle' : 'ok'}>
            {!health.installed ? 'missing' : words(health.auth)}
          </Chip>}
      </div>
      {declared === undefined
        ? <p className="runner-card__unknown">Type <code>{type || '(unset)'}</code> is not one this installation supports.</p>
        : <p className="runner-card__caps">
          <span className="tag">{declared.capabilities.supportsWorkingDirectory ? 'works in the repo' : 'text only'}</span>
          <span className="tag">{declared.capabilities.supportsReadOnly ? 'can read-only' : 'no read-only mode'}</span>
          <span className="tag">{declared.capabilities.structuredOutputStrategy}</span>
        </p>}
      <details className="runner-card__more">
        <summary>{fields.length} setting{fields.length === 1 ? '' : 's'}</summary>
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
        <span className="mono">{model === undefined ? 'runner default' : String(model)}</span>
        <span>{used} role{used === 1 ? '' : 's'}</span>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          aria-label={`Remove runner ${id}`}
          disabled={removals.length === 0 || blocked.length > 0}
          title={blocked.length === 0 ? undefined : `Referenced by ${blocked.join(', ')}`}
          onClick={() => onOperations([...operations, ...removals])}
        >
          Remove
        </button>
      </div>
      {blocked.length === 0
        ? null
        : <small className="runner-card__blocked" title={blocked.join(', ')}>
          Referenced by {blocked.length} route{blocked.length === 1 ? '' : 's'}
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
      <span className="runner-card__switch" title={field.effectiveValue === false ? 'disabled' : 'enabled'}>
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
          <option value="">Choose a type</option>
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
            placeholder={field.secretEnv === true ? 'NAME_OF_ENV_VAR' : undefined}
            onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
          />
          {field.secretEnv === true ? <small>The variable's name. The key itself never enters the file.</small> : null}
        </div>
      ))}
      <div className="runner-card__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn--sm" disabled={!valid} onClick={create}>Add runner</button>
      </div>
      {taken ? <small className="runner-card__blocked">A runner called {id.trim()} already exists.</small> : null}
    </div>
  );
}
