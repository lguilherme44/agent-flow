import { describe, expect, it } from 'vitest';
import type { ConfigEditorFieldView, ConfigEditorView } from '@contracts/index.js';
import {
  blockedRunnerDependencies,
  cliCommandFor,
  configInvalidationPredicate,
  effectSummary,
  fieldInputValue,
  operationForField,
  operationForDynamicField,
  operationsToRemoveDynamicEntity,
  dynamicEntityPrefixes,
  roleNeeds,
  routedFieldPaths,
  runnerIdsOf,
  sectionFields,
} from './crew-config';

const field = (path: string[], overrides: Partial<ConfigEditorFieldView> = {}): ConfigEditorFieldView => ({
  path,
  explicitValue: undefined,
  effectiveValue: undefined,
  origin: 'default',
  editable: true,
  effect: 'next_execution_context',
  valueType: 'string',
  ...overrides,
});

describe('crew configuration model', () => {
  it('uses unset to inherit and parses booleans, integers and lists for explicit edits', () => {
    expect(operationForField(field(['fallback', 'enabled']), '', true)).toEqual({ kind: 'unset', path: ['fallback', 'enabled'] });
    expect(operationForField(field(['fallback', 'enabled'], { effectiveValue: true, valueType: 'boolean' }), 'false')).toEqual({ kind: 'set', path: ['fallback', 'enabled'], value: false });
    expect(operationForField(field(['parallelism', 'maxTasks'], { effectiveValue: 2, valueType: 'integer' }), '3')).toEqual({ kind: 'set', path: ['parallelism', 'maxTasks'], value: 3 });
    expect(operationForField(field(['fallback', 'on'], { effectiveValue: ['quota_exceeded'], valueType: 'string_list' }), 'quota_exceeded, auth_required')).toEqual({
      kind: 'set', path: ['fallback', 'on'], value: ['quota_exceeded', 'auth_required'],
    });
  });

  it('uses catalog value types for absent fields and creates every dynamic path without a hard-coded provider', () => {
    expect(operationForField(field(['roles', 'architect', 'timeoutSeconds'], { valueType: 'integer' }), '1200')).toEqual({
      kind: 'set', path: ['roles', 'architect', 'timeoutSeconds'], value: 1200,
    });
    expect(operationForDynamicField({ path: ['teams', '*', 'members', '*', 'roles'], valueType: 'string_list', editable: true, effect: 'next_execution_context' }, ['delivery', 'builder'], 'executor.normal, planner')).toEqual({
      kind: 'set', path: ['teams', 'delivery', 'members', 'builder', 'roles'], value: ['executor.normal', 'planner'],
    });
    expect(operationForDynamicField({ path: ['validationCommands', '*'], valueType: 'string', editable: true, effect: 'next_execution_context' }, ['contract'], 'npm run contract')).toEqual({
      kind: 'set', path: ['validationCommands', 'contract'], value: 'npm run contract',
    });
  });

  it('removes all explicit leaves of a dynamic entity and preserves unrelated entries', () => {
    const fields = [
      field(['quality', 'gates', 'test', 'category'], { explicitValue: 'test' }),
      field(['quality', 'gates', 'test', 'required'], { explicitValue: true }),
      field(['quality', 'gates', 'lint', 'required'], { explicitValue: true }),
    ];
    expect(operationsToRemoveDynamicEntity(['quality', 'gates', 'test'], fields)).toEqual([
      { kind: 'unset', path: ['quality', 'gates', 'test', 'category'] },
      { kind: 'unset', path: ['quality', 'gates', 'test', 'required'] },
    ]);
  });

  it('discovers nested dynamic entities for generic removal controls', () => {
    const fields = [field(['runners', 'local', 'type']), field(['teams', 'delivery', 'members', 'builder', 'runner'])];
    const templates = [
      { path: ['runners', '*', 'type'], valueType: 'string' as const, editable: true, effect: 'next_execution_context' as const },
      { path: ['teams', '*', 'members', '*', 'runner'], valueType: 'string' as const, editable: true, effect: 'next_execution_context' as const },
    ];
    expect(dynamicEntityPrefixes(fields, templates)).toEqual([
      ['runners', 'local'], ['teams', 'delivery'], ['teams', 'delivery', 'members', 'builder'],
    ]);
  });

  it('keeps inherited values visually distinct from explicit values and groups Teams by name', () => {
    const view: ConfigEditorView = {
      target: { scope: 'project', projectId: 'flowcanvas' }, revision: 'sha256:missing', exists: false, unknownKeys: [],
      dynamicFields: [],
      fields: [
        field(['parallelism', 'maxTasks'], { effectiveValue: 1, origin: 'global' }),
        field(['teams', 'reviewers', 'name'], { explicitValue: 'Reviewers', effectiveValue: 'Reviewers', origin: 'project' }),
      ],
    };
    expect(fieldInputValue(view.fields[0]!)).toBe('');
    expect(fieldInputValue(view.fields[1]!)).toBe('Reviewers');
    expect(sectionFields(view.fields).get('Teams')?.[0]?.path).toEqual(['teams', 'reviewers', 'name']);
  });

  it('blocks runner removal while roles, fallback routes or Teams still reference it', () => {
    const fields = [
      field(['roles', 'architect', 'runner'], { effectiveValue: 'moe' }),
      field(['fallback', 'roles', 'architect', 'runner'], { effectiveValue: 'moe' }),
      field(['teams', 'local', 'members', 'builder', 'runner'], { effectiveValue: 'moe' }),
      field(['roles', 'planner', 'runner'], { effectiveValue: 'codex' }),
    ];
    expect(blockedRunnerDependencies('moe', fields)).toEqual([
      'roles.architect.runner',
      'fallback.roles.architect.runner',
      'teams.local.members.builder.runner',
    ]);
    expect(blockedRunnerDependencies('unused', fields)).toEqual([]);
  });

  it('reads both requirement signals before calling a role a writer', () => {
    // `discovery` is read-only *and* needs a working directory: reading the repository is
    // not writing to it. Judging by the working directory alone called architect a writer.
    expect(roleNeeds({ requiresReadOnly: true, requiresWorkingDirectory: true })).toBe('reads files');
    expect(roleNeeds({ requiresReadOnly: false, requiresWorkingDirectory: true })).toBe('writes files');
    // `sdd` carries its whole input, which is why an inference endpoint can serve it.
    expect(roleNeeds({ requiresReadOnly: true, requiresWorkingDirectory: false })).toBe('text only');
  });

  it('lists the runner ids a source declares, and the role paths a table already owns', () => {
    const fields = [
      field(['runners', 'moe', 'type']),
      field(['runners', 'moe', 'enabled']),
      field(['runners', 'claude', 'type']),
      // Four segments: a nested leaf elsewhere is not a runner id.
      field(['teams', 'x', 'members', 'y']),
    ];
    expect(runnerIdsOf(fields)).toEqual(['claude', 'moe']);
    expect([...routedFieldPaths([{ configKeys: ['roles', 'executors', 'trivial'] }])]).toEqual([
      'roles.executors.trivial.runner',
      'roles.executors.trivial.model',
      'roles.executors.trivial.effort',
    ]);
  });

  it('prints the terminal equivalent of an edit, quoting only what a shell would eat', () => {
    expect(cliCommandFor('global', { kind: 'set', path: ['roles', 'planner', 'runner'], value: 'codex' }))
      .toBe('agent-flow config set roles.planner.runner codex --global');
    // Project scope is the CLI's default, so it takes no flag.
    expect(cliCommandFor('project', { kind: 'unset', path: ['parallelism', 'maxTasks'] }))
      .toBe('agent-flow config unset parallelism.maxTasks');
    // A path with spaces, and a list as the CLI reads one.
    expect(cliCommandFor('global', { kind: 'set', path: ['runners', 'local', 'command'], value: '/opt/my runner' }))
      .toBe("agent-flow config set runners.local.command '/opt/my runner' --global");
    // The CLI runs `JSON.parse` on the value before falling back to a string, so a list
    // has to be JSON: `a,b` would run and store the string "a,b".
    expect(cliCommandFor('global', { kind: 'set', path: ['ui', 'allowedHosts'], value: ['a', 'b'] }))
      .toBe(String.raw`agent-flow config set ui.allowedHosts '["a","b"]' --global`);
    expect(cliCommandFor('global', { kind: 'set', path: ['forge', 'labels'], value: '' }))
      .toBe("agent-flow config set forge.labels '' --global");
  });

  it('explains restart, next-run and execution-context timing and scopes cache invalidation', () => {
    expect(effectSummary(['next_execution_context', 'server_restart'])).toBe('after a server restart');
    expect(effectSummary(['next_execution_context', 'next_run'])).toBe('to the next run');
    expect(effectSummary(['next_execution_context'])).toBe('to the next execution context');
    const global = configInvalidationPredicate('global', 'flowcanvas');
    expect(global('/api/v1/config/editor?scope=project&projectId=other')).toBe(true);
    expect(global('/api/v1/runs?projectId=flowcanvas')).toBe(false);
    const project = configInvalidationPredicate('project', 'flowcanvas');
    expect(project('/api/v1/config?projectId=flowcanvas')).toBe(true);
    expect(project('/api/v1/agents?projectId=other')).toBe(false);
  });
});
