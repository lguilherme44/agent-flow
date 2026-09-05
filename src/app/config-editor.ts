import { createHash } from 'node:crypto';
import { configFieldAt, configFieldCatalog, type ConfigFieldEffect, type ConfigFieldValueType, type ConfigScope } from '../config/config-fields.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../config/defaults.js';
import { projectConfigPath } from '../config/loader.js';
import { resolveConfigSources, type ConfigRecord, type ConfigValueOrigin } from '../config/resolver.js';
import { ConfigSourceCodecError, type ConfigPath, type ConfigSourceCodec, type ConfigSourceDocument } from '../ports/config-source-codec.js';
import type { ConfigDiagnostic, ConfigSemanticValidator } from '../ports/config-semantic-validator.js';
import type { FileSystem } from '../ports/file-system.js';
import { serializeConfigWrite } from './config-write-queue.js';

const MISSING_REVISION = 'sha256:missing';

export interface ConfigTarget {
  readonly scope: ConfigScope;
  readonly projectId?: string;
}

export type ConfigEditOperation =
  | { readonly kind: 'set'; readonly path: ConfigPath; readonly value: unknown }
  | { readonly kind: 'unset'; readonly path: ConfigPath };

export interface ConfigEditRequest {
  readonly target: ConfigTarget;
  readonly operations: readonly ConfigEditOperation[];
}

export interface ConfigApplyRequest extends ConfigEditRequest {
  readonly expectedRevision: string;
}

export interface ConfigEditField {
  readonly path: ConfigPath;
  readonly explicitValue: unknown;
  readonly effectiveValue: unknown;
  readonly origin?: ConfigValueOrigin;
  readonly editable: boolean;
  readonly reason?: 'global_only';
  readonly effect: ConfigFieldEffect;
  readonly valueType: ConfigFieldValueType;
  /** The accepted values of a closed field, so an editor can offer them rather than guess. */
  readonly options?: readonly string[];
}

export interface ConfigDynamicField {
  readonly path: readonly string[];
  readonly editable: boolean;
  readonly reason?: 'global_only';
  readonly effect: ConfigFieldEffect;
  readonly valueType: ConfigFieldValueType;
  readonly options?: readonly string[];
}

export interface ConfigEditView {
  readonly target: ConfigTarget;
  readonly revision: string;
  readonly exists: boolean;
  readonly fields: readonly ConfigEditField[];
  readonly dynamicFields: readonly ConfigDynamicField[];
  /** Unknown values are intentionally omitted from this read model. */
  readonly unknownPaths: readonly string[];
}

export interface ConfigEffectiveChange {
  readonly path: ConfigPath;
  readonly before: unknown;
  readonly after: unknown;
  readonly effect: ConfigFieldEffect;
}

export interface ConfigValidation {
  readonly valid: boolean;
  readonly revision: string;
  readonly diagnostics: readonly ConfigDiagnostic[];
  readonly changes: readonly ConfigEffectiveChange[];
}

export type ConfigApplyResult =
  | { readonly status: 'applied'; readonly view: ConfigEditView; readonly changes: readonly ConfigEffectiveChange[] }
  | { readonly status: 'conflict'; readonly view: ConfigEditView }
  | { readonly status: 'invalid'; readonly validation: ConfigValidation };

export interface ConfigEditor {
  describe(target: ConfigTarget): Promise<ConfigEditView>;
  validate(request: ConfigEditRequest): Promise<ConfigValidation>;
  apply(request: ConfigApplyRequest): Promise<ConfigApplyResult>;
}

export interface ConfigEditorOptions {
  readonly fs: FileSystem;
  readonly codec: ConfigSourceCodec;
  readonly semanticValidator: ConfigSemanticValidator;
  readonly globalConfigPath: string;
  /** Registry seam. A project id never becomes a filesystem path by itself. */
  readonly resolveProjectDir: (projectId: string) => string | undefined;
}

export class ConfigEditorTargetError extends Error {
  constructor(readonly code: 'project_required' | 'project_not_found', message: string) {
    super(message);
    this.name = 'ConfigEditorTargetError';
  }
}

export function createConfigEditor(options: ConfigEditorOptions): ConfigEditor {
  return new ConfigEditorModule(options);
}

class ConfigEditorModule implements ConfigEditor {
  private readonly defaults: ConfigRecord;

  constructor(private readonly options: ConfigEditorOptions) {
    const sourceDefaults = options.codec.parse(DEFAULT_GLOBAL_CONFIG_YAML).data;
    this.defaults = options.semanticValidator.normalize({ effectiveGlobal: sourceDefaults }).effectiveGlobal;
  }

  async describe(target: ConfigTarget): Promise<ConfigEditView> {
    return this.viewOf(await this.readState(target));
  }

  async validate(request: ConfigEditRequest): Promise<ConfigValidation> {
    try {
      const state = await this.readState(request.target);
      return this.validateState(state, request.operations).validation;
    } catch (error) {
      if (!(error instanceof ConfigSourceCodecError)) throw error;
      return this.sourceFailure(request.target, error);
    }
  }

  async apply(request: ConfigApplyRequest): Promise<ConfigApplyResult> {
    const path = this.pathOf(request.target);
    return serializeConfigWrite(path, async () => {
      // The digest is re-read inside the per-path critical section. Moving this
      // read outside the queue turns two equal revisions into a lost update.
      let state: SourceState;
      try {
        state = await this.readState(request.target);
      } catch (error) {
        if (!(error instanceof ConfigSourceCodecError)) throw error;
        return { status: 'invalid', validation: await this.sourceFailure(request.target, error) };
      }
      if (state.revision !== request.expectedRevision) {
        return { status: 'conflict', view: this.viewOf(state) };
      }

      const checked = this.validateState(state, request.operations);
      if (!checked.validation.valid || checked.candidate === undefined) {
        return { status: 'invalid', validation: checked.validation };
      }

      const content = checked.candidate.toString();
      await this.options.fs.writeFileAtomic(path, content);
      const saved: SourceState = {
        ...state,
        exists: true,
        source: content,
        revision: revisionOf(content, true),
        document: checked.candidate,
      };
      return { status: 'applied', view: this.viewOf(saved), changes: checked.validation.changes };
    });
  }

  private validateState(state: SourceState, operations: readonly ConfigEditOperation[]): CheckedCandidate {
    const diagnostics: ConfigDiagnostic[] = [];
    for (const operation of operations) {
      const field = configFieldAt(operation.path, state.target.scope);
      if (field === undefined) diagnostics.push(diagnostic('unknown_path', operation.path, 'This configuration path is not editable.'));
      else if (!field.editable) diagnostics.push(diagnostic('global_only', operation.path, 'This field can only be edited in global scope.'));
    }
    if (diagnostics.length > 0) return invalid(state, diagnostics);

    let candidate: ConfigSourceDocument;
    try {
      candidate = this.options.codec.parse(state.source);
      for (const operation of operations) {
        if (operation.kind === 'set') candidate.set(operation.path, operation.value);
        else candidate.unset(operation.path);
      }
      // Reparse rendered output: the exact bytes written must be the bytes that
      // passed syntax and unsupported-node checks.
      candidate = this.options.codec.parse(candidate.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid YAML candidate.';
      const code = error instanceof ConfigSourceCodecError ? `yaml_${error.code}` : 'yaml_invalid';
      return invalid(state, [diagnostic(code, [], message)]);
    }

    const sources = state.target.scope === 'global'
      ? { defaults: this.defaults, global: candidate.data, project: state.projectDocument?.data }
      : { defaults: this.defaults, global: state.globalDocument.data, project: candidate.data };
    const resolved = resolveConfigSources(sources);
    diagnostics.push(...this.options.semanticValidator.validate({
      effectiveGlobal: resolved.effectiveGlobal,
      ...(sources.project === undefined ? {} : { projectSource: sources.project }),
    }));

    const before = this.viewOf(state);
    const candidateState: SourceState = state.target.scope === 'global'
      ? { ...state, document: candidate, source: candidate.toString(), globalDocument: candidate }
      : { ...state, document: candidate, source: candidate.toString(), projectDocument: candidate };
    const after = this.viewOf(candidateState);
    const changes = changedFields(before, after, operations);
    return {
      validation: { valid: !diagnostics.some(({ severity }) => severity === 'error'), revision: state.revision, diagnostics, changes },
      candidate,
    };
  }

  private async readState(target: ConfigTarget): Promise<SourceState> {
    const path = this.pathOf(target);
    const exists = await this.options.fs.exists(path);
    const source = exists ? await this.options.fs.readFile(path) : '{}\n';
    const globalSource = target.scope === 'global'
      ? source
      : await this.readOptional(this.options.globalConfigPath);
    const projectPath = target.projectId === undefined ? undefined : projectConfigPath(this.projectDir(target.projectId));
    const projectSource = target.scope === 'project'
      ? source
      : projectPath === undefined ? undefined : await this.readOptional(projectPath);
    return {
      target,
      path,
      source,
      exists,
      revision: revisionOf(source, exists),
      document: this.options.codec.parse(source),
      globalDocument: this.options.codec.parse(globalSource ?? '{}\n'),
      ...(projectSource === undefined ? {} : { projectDocument: this.options.codec.parse(projectSource) }),
    };
  }

  private viewOf(state: SourceState): ConfigEditView {
    const global = state.target.scope === 'global' ? state.document.data : state.globalDocument.data;
    const project = state.target.scope === 'project' ? state.document.data : state.projectDocument?.data;
    const resolved = resolveConfigSources({ defaults: this.defaults, global, project });
    const normalized = this.options.semanticValidator.normalize({
      effectiveGlobal: resolved.effectiveGlobal,
      ...(project === undefined ? {} : { projectSource: project }),
    });
    const explicit = state.document.data;
    const paths = concreteCatalogPaths(configFieldCatalog.map(({ path }) => path), [this.defaults, global, project ?? {}]);
    const fields = paths.flatMap((path): ConfigEditField[] => {
      const definition = configFieldAt(path, state.target.scope);
      if (definition === undefined) return [];
      const ownValue = valueAt(explicit, path);
      const projectOwned = path[0] !== undefined && ['project', 'commands', 'validationCommands', 'paths', 'rules'].includes(String(path[0]));
      const effectiveValue = projectOwned
        ? valueAt(normalized.projectSource ?? {}, path)
        : valueAt(normalized.effectiveGlobal, path);
      return [{
        path,
        explicitValue: ownValue,
        effectiveValue,
        origin: state.target.scope === 'global'
          ? valueAt(global, path) === undefined ? resolved.originOf(path) : 'global'
          : resolved.originOf(path),
        editable: definition.editable,
        ...(definition.reason === undefined ? {} : { reason: definition.reason }),
        effect: definition.effect,
        valueType: definition.valueType,
        ...(definition.options === undefined ? {} : { options: definition.options }),
      }];
    });
    const dynamicFields = configFieldCatalog.flatMap((definition): ConfigDynamicField[] => {
      if (!definition.path.includes('*')) return [];
      const field = configFieldAt(definition.path, state.target.scope);
      return field === undefined ? [] : [{
        path: definition.path,
        editable: field.editable,
        ...(field.reason === undefined ? {} : { reason: field.reason }),
        effect: field.effect,
        valueType: field.valueType,
        ...(field.options === undefined ? {} : { options: field.options }),
      }];
    });
    return { target: state.target, revision: state.revision, exists: state.exists, fields, dynamicFields, unknownPaths: state.document.unknownPaths };
  }

  private pathOf(target: ConfigTarget): string {
    if (target.scope === 'global') return this.options.globalConfigPath;
    if (target.projectId === undefined) throw new ConfigEditorTargetError('project_required', 'Project scope requires a registered project id.');
    return projectConfigPath(this.projectDir(target.projectId));
  }

  private projectDir(projectId: string): string {
    const directory = this.options.resolveProjectDir(projectId);
    if (directory === undefined) throw new ConfigEditorTargetError('project_not_found', `Unknown project '${projectId}'.`);
    return directory;
  }

  private async readOptional(path: string): Promise<string | undefined> {
    return await this.options.fs.exists(path) ? this.options.fs.readFile(path) : undefined;
  }

  private async sourceFailure(target: ConfigTarget, error: ConfigSourceCodecError): Promise<ConfigValidation> {
    const path = this.pathOf(target);
    const exists = await this.options.fs.exists(path);
    const source = exists ? await this.options.fs.readFile(path) : '{}\n';
    return {
      valid: false,
      revision: revisionOf(source, exists),
      diagnostics: [diagnostic(`yaml_${error.code}`, [], error.message)],
      changes: [],
    };
  }
}

interface SourceState {
  readonly target: ConfigTarget;
  readonly path: string;
  readonly source: string;
  readonly exists: boolean;
  readonly revision: string;
  readonly document: ConfigSourceDocument;
  readonly globalDocument: ConfigSourceDocument;
  readonly projectDocument?: ConfigSourceDocument;
}

interface CheckedCandidate {
  readonly validation: ConfigValidation;
  readonly candidate?: ConfigSourceDocument;
}

function invalid(state: SourceState, diagnostics: readonly ConfigDiagnostic[]): CheckedCandidate {
  return { validation: { valid: false, revision: state.revision, diagnostics, changes: [] } };
}

function diagnostic(code: string, path: ConfigPath, message: string): ConfigDiagnostic {
  return { severity: 'error', code, path, message, action: 'Correct the request before saving.' };
}

function revisionOf(source: string, exists: boolean): string {
  return exists ? `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}` : MISSING_REVISION;
}

function valueAt(source: ConfigRecord, path: ConfigPath): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function concreteCatalogPaths(patterns: readonly (readonly string[])[], sources: readonly ConfigRecord[]): ConfigPath[] {
  const paths: ConfigPath[] = [];
  for (const pattern of patterns) expandPattern(pattern, 0, [], sources.map((source) => source), paths);
  const unique = new Map(paths.map((path) => [path.join('.'), path]));
  return [...unique.values()].sort((left, right) => left.join('.').localeCompare(right.join('.')));
}

function expandPattern(pattern: readonly string[], index: number, path: string[], values: readonly unknown[], output: ConfigPath[]): void {
  if (index === pattern.length) { output.push(path); return; }
  const segment = pattern[index];
  if (segment === undefined) return;
  if (segment !== '*') {
    expandPattern(pattern, index + 1, [...path, segment], values.map((value) => record(value)[segment]), output);
    return;
  }
  const keys = new Set(values.flatMap((value) => Object.keys(record(value))));
  for (const key of keys) expandPattern(pattern, index + 1, [...path, key], values.map((value) => record(value)[key]), output);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function changedFields(before: ConfigEditView, after: ConfigEditView, operations: readonly ConfigEditOperation[]): ConfigEffectiveChange[] {
  return operations.flatMap((operation) => {
    const prior = before.fields.find((field) => samePath(field.path, operation.path));
    const next = after.fields.find((field) => samePath(field.path, operation.path));
    if (next === undefined || Object.is(prior?.effectiveValue, next.effectiveValue)) return [];
    return [{ path: operation.path, before: prior?.effectiveValue, after: next.effectiveValue, effect: next.effect }];
  });
}

function samePath(left: ConfigPath, right: ConfigPath): boolean {
  return left.length === right.length && left.every((segment, index) => String(segment) === String(right[index]));
}
