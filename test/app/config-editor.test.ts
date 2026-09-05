import { describe, expect, it } from 'vitest';
import { YamlConfigSourceCodec } from '../../src/adapters/config/yaml-config-source-codec.js';
import { SchemaConfigSemanticValidator } from '../../src/adapters/config/semantic-validator.js';
import { createConfigEditor } from '../../src/app/config-editor.js';
import { DEFAULT_GLOBAL_CONFIG_YAML } from '../../src/config/defaults.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';

const GLOBAL = '/home/.agent-flow/config.yaml';
const PROJECT_DIR = '/work/demo';
const PROJECT = `${PROJECT_DIR}/.agent-flow/config.yaml`;
const projectYaml = `project:\n  name: demo\n  type: node\ncommands: {}\npaths:\n  source: [src]\n  tests: [test]\n`;

function world(global = DEFAULT_GLOBAL_CONFIG_YAML, project = projectYaml) {
  const fs = new InMemoryFileSystem();
  fs.seed(GLOBAL, global);
  fs.seed(PROJECT, project);
  const editor = createConfigEditor({
    fs,
    codec: new YamlConfigSourceCodec(),
    semanticValidator: new SchemaConfigSemanticValidator(),
    globalConfigPath: GLOBAL,
    resolveProjectDir: (id) => id === 'demo' ? PROJECT_DIR : undefined,
  });
  return { fs, editor };
}

describe('ConfigEditor', () => {
  it('materializes schema defaults with origins and value types while keeping source values explicit', async () => {
    const { editor } = world('runners:\n  claude:\n    type: claude-code-cli\nroles:\n  architect:\n    runner: claude\n  sdd:\n    runner: claude\n  planner:\n    runner: claude\n  planReviewer:\n    runner: claude\n  executors:\n    trivial: { runner: claude }\n    normal: { runner: claude }\n    complex: { runner: claude }\n  verification: { runner: claude }\n  finalReviewer: { runner: claude }\n');
    const view = await editor.describe({ scope: 'global' });

    expect(view.fields.find((entry) => entry.path.join('.') === 'quality.blockOnMedium')).toMatchObject({
      explicitValue: undefined, effectiveValue: true, origin: 'default', valueType: 'boolean',
    });
    expect(view.fields.find((entry) => entry.path.join('.') === 'roles.architect.timeoutSeconds')).toMatchObject({
      explicitValue: undefined, effectiveValue: 900, origin: 'default', valueType: 'integer',
    });
    expect(view.fields.find((entry) => entry.path.join('.') === 'forge.publish.enabled')).toMatchObject({
      explicitValue: undefined, effectiveValue: false, origin: 'default', valueType: 'boolean',
    });
  });

  it('publishes every wildcard field as an editable dynamic template in the allowed scope', async () => {
    const { editor } = world();
    const global = await editor.describe({ scope: 'global' });
    const project = await editor.describe({ scope: 'project', projectId: 'demo' });

    expect(global.dynamicFields).toHaveLength(67);
    expect(project.dynamicFields).toHaveLength(68);
    expect(global.dynamicFields.map((entry) => entry.path.join('.'))).toEqual(expect.arrayContaining([
      'runners.*.type', 'teams.*.members.*.runner', 'roles.architect.stages.*.runner',
      'fallback.roles.*.runner', 'quality.gates.*.category',
    ]));
    expect(project.dynamicFields.map((entry) => entry.path.join('.'))).toContain('validationCommands.*');
    expect(project.dynamicFields.find((entry) => entry.path.join('.') === 'teams.*.name')).toMatchObject({ editable: false, reason: 'global_only' });
    // A template for a closed field carries its values too: the editor that creates an
    // entry has the same right to offer them as the editor that changes one.
    expect(global.dynamicFields.find((entry) => entry.path.join('.') === 'quality.gates.*.category')?.options)
      .toEqual(expect.arrayContaining(['lint', 'unit']));
    expect(global.dynamicFields.find((entry) => entry.path.join('.') === 'roles.architect.stages.*.effort')?.options)
      .toEqual(['low', 'medium', 'high', 'very_high']);
  });

  it('hands a closed field the values it accepts, and an open one none', async () => {
    const { editor } = world();
    const view = await editor.describe({ scope: 'global' });
    const at = (path: string) => view.fields.find((entry) => entry.path.join('.') === path);

    expect(at('forge.provider')).toMatchObject({ valueType: 'enum', options: ['none', 'github'] });
    expect(at('roles.planner.effort')).toMatchObject({ valueType: 'reasoning_level', options: ['low', 'medium', 'high', 'very_high'] });
    expect(at('roles.planner.model')?.options).toBeUndefined();
    expect(at('parallelism.maxTasks')?.options).toBeUndefined();
  });
  it('preserves comments and unknown YAML while atomically applying a known edit', async () => {
    const source = `${DEFAULT_GLOBAL_CONFIG_YAML}\n# operator extension\nplugin:\n  privateToken: do-not-disclose\n`;
    const { fs, editor } = world(source);
    const before = await editor.describe({ scope: 'global' });
    const result = await editor.apply({
      target: { scope: 'global' }, expectedRevision: before.revision,
      operations: [{ kind: 'set', path: ['parallelism', 'maxTasks'], value: 2 }],
    });

    expect(result.status).toBe('applied');
    expect(await fs.readFile(GLOBAL)).toContain('# operator extension\nplugin:\n  privateToken: do-not-disclose');
    expect(fs.writes).toEqual([`${GLOBAL}.tmp`, GLOBAL]);
  });

  it('returns path diagnostics and leaves invalid candidates byte-identical', async () => {
    const { fs, editor } = world();
    const original = await fs.readFile(GLOBAL);
    const before = await editor.describe({ scope: 'global' });
    const validation = await editor.validate({
      target: { scope: 'global' },
      operations: [{ kind: 'set', path: ['parallelism', 'maxTasks'], value: 0 }],
    });
    const result = await editor.apply({
      target: { scope: 'global' }, expectedRevision: before.revision,
      operations: [{ kind: 'set', path: ['parallelism', 'maxTasks'], value: 0 }],
    });

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', path: ['parallelism', 'maxTasks'] }));
    expect(result.status).toBe('invalid');
    expect(await fs.readFile(GLOBAL)).toBe(original);
    expect(fs.writes).toEqual([]);
  });

  it('reports an invalid source without replacing its original bytes', async () => {
    const source = 'runners: [broken\n';
    const { fs, editor } = world(source);
    const validation = await editor.validate({ target: { scope: 'global' }, operations: [] });
    const result = await editor.apply({
      target: { scope: 'global' }, expectedRevision: validation.revision, operations: [],
    });

    expect(validation).toMatchObject({ valid: false });
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({ code: 'yaml_syntax', path: [] }));
    expect(result.status).toBe('invalid');
    expect(await fs.readFile(GLOBAL)).toBe(source);
    expect(fs.writes).toEqual([]);
  });

  it('rejects a global-only project edit before producing a candidate', async () => {
    const { fs, editor } = world();
    const original = await fs.readFile(PROJECT);
    const validation = await editor.validate({
      target: { scope: 'project', projectId: 'demo' },
      operations: [{ kind: 'set', path: ['ui', 'workspaceDepth'], value: 4 }],
    });

    expect(validation).toMatchObject({ valid: false });
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({
      code: 'global_only', path: ['ui', 'workspaceDepth'],
    }));
    expect(await fs.readFile(PROJECT)).toBe(original);
  });

  it('restores inheritance by removing a project override and recomputing the effective value', async () => {
    const { fs, editor } = world(undefined, `${projectYaml}parallelism:\n  maxTasks: 3\n`);
    const before = await editor.describe({ scope: 'project', projectId: 'demo' });
    expect(before.fields.find((field) => field.path.join('.') === 'parallelism.maxTasks')).toMatchObject({
      explicitValue: 3, effectiveValue: 3, origin: 'project',
    });
    const result = await editor.apply({
      target: { scope: 'project', projectId: 'demo' }, expectedRevision: before.revision,
      operations: [{ kind: 'unset', path: ['parallelism', 'maxTasks'] }],
    });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error('expected applied result');
    expect(result.view.fields.find((field) => field.path.join('.') === 'parallelism.maxTasks')).toMatchObject({
      explicitValue: undefined, effectiveValue: 1, origin: 'global',
    });
    expect(await fs.readFile(PROJECT)).not.toContain('maxTasks: 3');
  });

  it('blocks runner removal while roles still reference it', async () => {
    const configured = DEFAULT_GLOBAL_CONFIG_YAML
      .replace('\nroles:\n', '\n  local:\n    type: codex-cli\n    enabled: true\n\nroles:\n')
      .replace('  architect:\n    runner: claude', '  architect:\n    runner: local');
    const { fs, editor } = world(configured);
    const original = await fs.readFile(GLOBAL);
    const validation = await editor.validate({
      target: { scope: 'global' }, operations: [{ kind: 'unset', path: ['runners', 'local', 'type'] }],
    });

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid_runner', path: ['roles', 'architect', 'runner'] }));
    expect(await fs.readFile(GLOBAL)).toBe(original);
  });

  it('reports a missing runner referenced by a stage override at the reference path', async () => {
    const { editor } = world();
    const validation = await editor.validate({
      target: { scope: 'global' },
      operations: [{ kind: 'set', path: ['roles', 'architect', 'stages', 'discovery', 'runner'], value: 'missing' }],
    });

    expect(validation.valid).toBe(false);
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid_runner', path: ['roles', 'architect', 'stages', 'discovery', 'runner'],
    }));
  });

  it('leaves the original intact when the atomic filesystem adapter fails before rename', async () => {
    const { fs, editor } = world();
    const original = await fs.readFile(GLOBAL);
    const before = await editor.describe({ scope: 'global' });
    fs.failNextAtomicWriteAfterTemp = true;

    await expect(editor.apply({
      target: { scope: 'global' }, expectedRevision: before.revision,
      operations: [{ kind: 'set', path: ['parallelism', 'maxTasks'], value: 2 }],
    })).rejects.toThrow('simulated crash between write and rename');
    expect(await fs.readFile(GLOBAL)).toBe(original);
  });

  it('allows exactly one of two concurrent saves with the same revision', async () => {
    const { editor } = world();
    const before = await editor.describe({ scope: 'global' });
    const [first, second] = await Promise.all([
      editor.apply({ target: { scope: 'global' }, expectedRevision: before.revision, operations: [{ kind: 'set', path: ['parallelism', 'maxTasks'], value: 2 }] }),
      editor.apply({ target: { scope: 'global' }, expectedRevision: before.revision, operations: [{ kind: 'set', path: ['parallelism', 'maxTasks'], value: 3 }] }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['applied', 'conflict']);
    const conflict = first.status === 'conflict' ? first : second;
    if (conflict.status !== 'conflict') throw new Error('expected conflict result');
    expect(conflict.view.revision).not.toBe(before.revision);
    expect(conflict.view.fields.find((field) => field.path.join('.') === 'parallelism.maxTasks')?.effectiveValue).toBe(2);
  });
});
