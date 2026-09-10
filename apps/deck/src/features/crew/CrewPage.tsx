import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigEditorFieldView, ConfigEditorScope, ConfigEditorView, ConfigValidationView, ConfigView, ProjectView, RoleRouteView, RunnerHealthView, RunnerModelsView, RunnerTypeView } from '@contracts/index.js';
import { ApiError, api, keys, type ConfigEditorOperation } from '../../lib/api';
import { invalidate, useResource } from '../../lib/store';
import { Empty, NoProjectsYet, Skeleton } from '../../components/ui';
import { useT } from '../../lib/i18n';
import { blockedRunnerDependencies, configInvalidationPredicate, dynamicEntityPrefixes, effectNote, fieldInputValue, isFieldShown, operationForDynamicField, operationForField, operationsToRemoveDynamicEntity, originLabel, pathLabel, routedFieldPaths, sectionFields } from './crew-config';
import { ChangeBar } from './ChangeBar';
import { FieldControl } from './FieldControl';
import { RoutingEditor } from './RoutingEditor';
import { RunnerGrid } from './RunnerGrid';

/** The active crew and the configuration sources that resolve it. */
export function CrewPage({ projectId }: { projectId?: string }) {
  const t = useT();
  const projects = useResource(keys.projects(), api.projects);
  const [selectedProject, setSelectedProject] = useState(projectId);
  const [configScope, setConfigScope] = useState<ConfigEditorScope>('global');
  const project = projects.data?.find(({ id }) => id === (selectedProject ?? projectId)) ?? projects.data?.[0];
  const scope = project?.id;
  const roles = useResource<RoleRouteView[]>(scope === undefined ? null : keys.agents(scope), () => api.agents(scope), { refreshMs: 60_000 });
  const health = useResource<RunnerHealthView[]>(scope === undefined ? null : keys.runnersHealth(scope), () => api.runnersHealth(scope), { refreshMs: 60_000 });
  const types = useResource<RunnerTypeView[]>(keys.runnerTypes(), api.runnerTypes);
  // What each runner says it can be pointed at. Costs a spawn per runner, so it refreshes
  // rarely: a model list changes when a CLI is upgraded, not while somebody is editing.
  const models = useResource<RunnerModelsView[]>(scope === undefined ? null : keys.runnerModels(scope), () => api.runnerModels(scope));
  // Which files the two scopes are. Read from the one endpoint that already publishes
  // them: a screen that edits a file should say which file.
  const sources = useResource<ConfigView>(scope === undefined ? null : keys.config(scope), () => api.config(scope));

  useEffect(() => {
    if (selectedProject === undefined && projects.data?.[0] !== undefined) setSelectedProject(projects.data[0].id);
  }, [projects.data, selectedProject]);

  if (projects.error !== undefined) return <main className="page"><Empty error>{t.common.couldNotReadProjects}</Empty></main>;
  if (projects.loading) return <main className="page"><Skeleton rows={6} /></main>;
  // Loading and having none are different answers, and one spinner used to serve both.
  if (project === undefined) return <main className="page"><NoProjectsYet what={t.crew.configureVerb} /></main>;

  const unresolved = (roles.data ?? []).filter((role) => role.error !== undefined).length;
  return (
    <main className="page">
      <div className="page-head crew-head">
        <div><span className="eyebrow">{t.nav.crew}</span><h1 className="page-head__title">{t.crew.title}</h1><p className="page-head__sub">{t.crew.resolvedAgainst(roles.data?.length ?? 9, health.data?.length, project.name)}{unresolved > 0 ? ` ${t.crew.unresolvedCount(unresolved)}` : ''}</p></div>
        <label className="crew-control">{t.common.project}<select className="input" value={project.id} onChange={(event) => setSelectedProject(event.target.value)}>{projects.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      <div className="crew-scope" role="group" aria-label={t.crew.scopeAria}>
        <ScopeButton
          scope="global"
          active={configScope}
          onPick={setConfigScope}
          title={t.crew.globalConfiguration}
          path={sources.data?.sources.globalPath}
          note={t.crew.appliesEverywhere}
        />
        <ScopeButton
          scope="project"
          active={configScope}
          onPick={setConfigScope}
          title={t.crew.thisProject(project.name)}
          path={sources.data?.sources.projectPath}
          note={t.crew.committedWithRepo}
        />
      </div>
      <ConfigPanel key={`${configScope}/${project.id}`} scope={configScope} project={project} roles={roles} health={health} types={types} models={models} />
    </main>
  );
}

/**
 * A scope, named by the file it writes.
 *
 * Two buttons reading "Global configuration" and "Project configuration" said which of
 * two things was selected and nothing about what either one *was* — and the difference
 * that matters is that one of these files gets committed and read by everybody who
 * clones the repository.
 */
function ScopeButton({ scope, active, onPick, title, path, note }: {
  readonly scope: ConfigEditorScope;
  readonly active: ConfigEditorScope;
  readonly onPick: (scope: ConfigEditorScope) => void;
  readonly title: string;
  readonly path: string | undefined;
  readonly note: string;
}) {
  return (
    <button type="button" className="crew-scope__pick" aria-pressed={active === scope} onClick={() => onPick(scope)}>
      <b>{title}</b>
      <small className="mono">{path ?? '…'}</small>
      <small>{note}</small>
    </button>
  );
}

function ConfigPanel({ scope, project, roles, health, types, models }: {
  scope: ConfigEditorScope;
  project: ProjectView;
  roles: ReturnType<typeof useResource<RoleRouteView[]>>;
  health: ReturnType<typeof useResource<RunnerHealthView[]>>;
  types: ReturnType<typeof useResource<RunnerTypeView[]>>;
  models: ReturnType<typeof useResource<RunnerModelsView[]>>;
}) {
  const projectId = scope === 'project' ? project.id : undefined;
  const resourceKey = keys.configEditor(scope, projectId);
  const resource = useResource(resourceKey, () => api.configEditor(scope, projectId));
  const [freshView, setFreshView] = useState<ConfigEditorView>();
  const view = freshView ?? resource.data;
  const [operations, setOperations] = useState<ConfigEditorOperation[]>([]);
  const [validation, setValidation] = useState<ConfigValidationView>();
  const [state, setState] = useState<'idle' | 'validating' | 'saving' | 'saved' | 'conflict'>('idle');
  const [message, setMessage] = useState<string>();
  /**
   * Inherited values are folded away by default.
   *
   * The source this page edits sets a couple of dozen values; the catalog describes more
   * than a hundred. Showing every one of them made the handful somebody actually chose
   * indistinguishable from the defaults they never touched.
   */
  const [showInherited, setShowInherited] = useState(false);
  /**
   * Two tabs, because the page answers two different questions.
   *
   * Crew is "who does what, with which model". Everything else — recovery budgets, forge,
   * collaboration, review, git — is the operator's machine, and roughly a hundred fields
   * of it. Both were one scroll, and the hundred buried the nine.
   */
  const [tab, setTab] = useState<'crew' | 'advanced'>('crew');
  const requestSequence = useRef(0);
  // The role table owns runner, model and effort. Leaving them in the accordion too
  // would be two controls over one value, disagreeing for as long as one is stale.
  const t = useT();
  const routed = useMemo(() => routedFieldPaths(roles.data ?? []), [roles.data]);
  const advancedFields = useMemo(
    () => (view?.fields ?? []).filter((field) => !routed.has(pathLabel(field.path)) && String(field.path[0]) !== 'runners'),
    [view, routed],
  );
  const sections = useMemo(() => sectionFields(t, advancedFields), [t, advancedFields]);

  const validate = (next: ConfigEditorOperation[]): void => {
    setOperations(next); setMessage(undefined);
    if (next.length === 0) { setValidation(undefined); setState('idle'); return; }
    const sequence = ++requestSequence.current;
    setState('validating');
    void api.validateConfig(scope, projectId, next).then((result) => {
      if (sequence !== requestSequence.current) return;
      setValidation(result); setState('idle');
    }).catch((error: unknown) => {
      if (sequence !== requestSequence.current) return;
      setMessage(error instanceof Error ? error.message : t.crew.couldNotValidate); setState('idle');
    });
  };

  const updateField = (field: ConfigEditorFieldView, raw: string, inherit = false): void => {
    validate([...operations.filter((operation) => pathLabel(operation.path) !== pathLabel(field.path)), operationForField(field, raw, inherit)]);
  };

  const apply = (): void => {
    if (view === undefined || validation?.valid !== true) return;
    setState('saving'); setMessage(undefined);
    void api.applyConfig(scope, projectId, view.revision, operations).then((result) => {
      setFreshView(result.view); setOperations([]); setValidation(undefined); setState('saved');
      invalidate(configInvalidationPredicate(scope, project.id));
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        const current = error.detail?.view;
        if (isEditorView(current)) setFreshView(current);
        ++requestSequence.current;
        setOperations([]);
        setValidation(undefined);
        setState('conflict'); setMessage(`${error.message} ${t.crew.reviewFreshState}`); return;
      }
      setState('idle'); setMessage(error instanceof Error ? error.message : t.crew.couldNotSave);
    });
  };

  if (resource.error !== undefined) return <section className="section"><Empty error>{t.crew.couldNotRead}</Empty></section>;
  if (resource.loading || view === undefined) return <section className="section"><Skeleton rows={6} /></section>;
  return (
    <section className="section crew-editor" aria-labelledby="configuration-editor">
      <div className="section__head"><div><h2 id="configuration-editor" className="eyebrow" style={{ margin: 0 }}>{t.crew.scopeSource(scope === 'global' ? t.crew.scopeGlobal : t.crew.scopeProject)}</h2><span className="section__count">{view.exists ? t.crew.sourcePresent : t.crew.sourceWillBeCreated} · {t.crew.revision(view.revision.slice(0, 18))}</span></div></div>
      {scope === 'project' ? <div className="notice" data-tone="warn" role="status">{t.crew.savingTouchesTree}</div> : null}
      {view.unknownKeys.length > 0 ? <div className="notice" data-tone="idle" role="status">{t.crew.unknownKeys(view.unknownKeys.length)}</div> : null}
      {message === undefined ? null : <div className="empty empty--error" role="alert">{message}</div>}
      {validation?.diagnostics.map((diagnostic) => <div key={`${diagnostic.code}/${pathLabel(diagnostic.path)}`} className="empty empty--error" role="alert"><strong>{pathLabel(diagnostic.path) || t.crew.configurationWord}:</strong> {diagnostic.message}</div>)}
      <div className="crew-tabs" role="tablist" aria-label={t.crew.areaAria}>
        <button type="button" role="tab" aria-selected={tab === 'crew'} onClick={() => setTab('crew')}>{t.nav.crew}</button>
        <button type="button" role="tab" aria-selected={tab === 'advanced'} onClick={() => setTab('advanced')}>
          {t.crew.advanced} <span className="crew-tabs__count">{advancedFields.length}</span>
        </button>
      </div>
      {tab === 'crew' ? <>
        <RunnerGrid view={view} roles={roles.data} health={health} types={types} models={models.data} operations={operations} onChange={updateField} onOperations={validate} />
        <RoutingEditor view={view} roles={roles} types={types.data} models={models.data} operations={operations} onChange={updateField} onOperations={validate} />
      </> : <>
      <div className="crew-filter">
        <span>{t.crew.fieldsSetHere(advancedFields.filter(({ explicitValue }) => explicitValue !== undefined).length, advancedFields.length)}</span>
        <label className="crew-filter__toggle"><input type="checkbox" checked={showInherited} onChange={(event) => setShowInherited(event.target.checked)} />{t.crew.showInherited}</label>
      </div>
      <DynamicConfiguration view={view} operations={operations} onChange={validate} />
      <div className="crew-sections">{[...sections].map(([head, section]) => {
        const fields = section.fields;
        const shown = fields.filter((field) => isFieldShown(field, pendingFor(field, operations) !== undefined, showInherited));
        // Opened by the configuration's own key, never by the heading: the heading is
        // language and the key is not.
        return <details className="panel crew-section" key={head} open={head === 'runners' || head === 'parallelism'}>
          <summary><h3>{section.name}</h3><span>{shown.length === fields.length ? t.crew.fieldCount(fields.length) : t.crew.fieldsOf(shown.length, fields.length)}</span></summary>
          {shown.length === 0
            ? <p className="crew-section__empty">{t.crew.allInherit(fields.length)} <button type="button" className="btn btn--sm" onClick={() => setShowInherited(true)}>{t.crew.showInherited}</button></p>
            : <div className="crew-fields">{shown.map((field) => <ConfigField key={pathLabel(field.path)} field={field} operations={operations} onChange={updateField} />)}</div>}
        </details>;
      })}</div>
      </>}
      <ChangeBar
        scope={scope}
        projectPath={project.path}
        operations={operations}
        validation={validation}
        state={state}
        activeRunId={project.currentRunId}
        onDiscard={() => validate([])}
        onSave={apply}
      />
    </section>
  );
}

function DynamicConfiguration({ view, operations, onChange }: { view: ConfigEditorView; operations: readonly ConfigEditorOperation[]; onChange: (operations: ConfigEditorOperation[]) => void }) {
  const t = useT();
  const editable = view.dynamicFields.filter((field) => field.editable);
  const [selectedPath, setSelectedPath] = useState(editable[0]?.path.join('.') ?? '');
  const [identifiers, setIdentifiers] = useState<string[]>([]);
  const [rawValue, setRawValue] = useState('');
  const selected = editable.find(({ path }) => path.join('.') === selectedPath);
  // Runners are declared and removed on their own cards, so they are not repeated here.
  const entities = dynamicEntityPrefixes(view.fields, view.dynamicFields).filter((prefix) => String(prefix[0]) !== 'runners');
  const add = (): void => {
    if (selected === undefined) return;
    try {
      const operation = operationForDynamicField(selected, identifiers, rawValue);
      onChange([...operations.filter((entry) => pathLabel(entry.path) !== pathLabel(operation.path)), operation]);
    } catch { /* required identifiers keep the action disabled */ }
  };
  return <details className="panel crew-section crew-dynamic">
    <summary><h3>{t.crew.dynamicConfiguration}</h3><span>{t.crew.fieldTemplates(editable.length)}</span></summary>
    <div className="dynamic-create">
      <label>{t.crew.knownField}<select className="input mono" value={selectedPath} onChange={(event) => { setSelectedPath(event.target.value); setIdentifiers([]); setRawValue(''); }}><option value="">{t.crew.selectAField}</option>{editable.map((field) => <option key={field.path.join('.')} value={field.path.join('.')}>{field.path.join('.')}</option>)}</select></label>
      {selected?.path.flatMap((part, index) => part === '*' ? [<label key={index}>{t.crew.identifierFor(String(selected.path.slice(0, index).filter((item) => item !== '*').at(-1) ?? t.crew.entryWord))}<input className="input mono" value={identifiers[selected.path.slice(0, index + 1).filter((item) => item === '*').length - 1] ?? ''} onChange={(event) => { const wildcardIndex = selected.path.slice(0, index + 1).filter((item) => item === '*').length - 1; setIdentifiers((current) => { const next = [...current]; next[wildcardIndex] = event.target.value; return next; }); }} /></label>] : [])}
      <label>{t.crew.valueWord}<input className="input mono" value={rawValue} onChange={(event) => setRawValue(event.target.value)} /></label>
      <button type="button" className="btn" disabled={selected === undefined || identifiers.length < (selected?.path.filter((part) => part === '*').length ?? 0) || identifiers.some((id) => id.trim() === '')} onClick={add}>{t.crew.addConfigurationField}</button>
    </div>
    {entities.length === 0 ? null : <div className="dynamic-remove"><strong>{t.crew.configuredEntries}</strong>{entities.map((prefix) => {
      const operationsForEntity = operationsToRemoveDynamicEntity(prefix, view.fields);
      const runnerId = prefix[0] === 'runners' && prefix.length === 2 ? String(prefix[1]) : undefined;
      const dependencies = runnerId === undefined ? [] : blockedRunnerDependencies(runnerId, view.fields);
      const removeLabel = runnerId === undefined ? t.crew.removeEntity(pathLabel(prefix)) : t.crew.removeRunner(runnerId);
      return <div key={pathLabel(prefix)}><code>{pathLabel(prefix)}</code><button type="button" className="btn btn--danger btn--sm" aria-label={removeLabel} disabled={operationsForEntity.length === 0 || dependencies.length > 0} onClick={() => onChange([...operations, ...operationsForEntity])}>{removeLabel}</button>{dependencies.length === 0 ? null : <small>{t.crew.referencedBy(dependencies.join(', '))}</small>}</div>;
    })}</div>}
  </details>;
}

function ConfigField({ field, operations, onChange }: { field: ConfigEditorFieldView; operations: readonly ConfigEditorOperation[]; onChange: (field: ConfigEditorFieldView, raw: string, inherit?: boolean) => void }) {
  const t = useT();
  const pending = pendingFor(field, operations);
  const raw = pending?.kind === 'set' ? Array.isArray(pending.value) ? pending.value.join(', ') : String(pending.value) : pending?.kind === 'unset' ? '' : fieldInputValue(field);
  const inherited = field.explicitValue === undefined && pending === undefined;
  const label = pathLabel(field.path);
  const timing = effectNote(t, field.effect);
  return <div className="crew-field" data-inherited={inherited}>
    <label htmlFor={`config-${label}`}><code>{label}</code></label>
    <div className="crew-field__input">
      <FieldControl id={`config-${label}`} field={field} raw={raw} inherited={inherited} onChange={(value, inherit) => onChange(field, value, inherit)} />
      {field.explicitValue === undefined ? null : <button type="button" className="btn btn--sm" disabled={!field.editable} onClick={() => onChange(field, '', true)}>{t.crew.inheritButton}</button>}
    </div>
    <small>{originLabel(t, field, inherited)}{timing === undefined ? '' : ` · ${timing}`}</small>
  </div>;
}

/** The last operation aimed at this path, which is the one the controls must reflect. */
function pendingFor(field: ConfigEditorFieldView, operations: readonly ConfigEditorOperation[]): ConfigEditorOperation | undefined {
  return [...operations].reverse().find((operation) => pathLabel(operation.path) === pathLabel(field.path));
}



function isEditorView(value: unknown): value is ConfigEditorView { return typeof value === 'object' && value !== null && Array.isArray((value as { fields?: unknown }).fields) && typeof (value as { revision?: unknown }).revision === 'string'; }
