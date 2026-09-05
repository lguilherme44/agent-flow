import { stringify as stringifyYaml } from 'yaml';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import type { GlobalOptions } from './index.js';
import { loadConfig } from '../config/loader.js';
import { nodeAdapters } from './adapters.js';
import { createConfigEditor, ConfigEditorTargetError, type ConfigEditOperation, type ConfigTarget } from '../app/config-editor.js';
import { YamlConfigSourceCodec } from '../adapters/config/yaml-config-source-codec.js';
import { SchemaConfigSemanticValidator } from '../adapters/config/semantic-validator.js';
import type { ConfigDiagnostic } from '../ports/config-semantic-validator.js';

export interface ConfigCommandOptions {
  readonly global?: boolean;
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let curr: unknown = obj;
  for (const part of parts) {
    if (typeof curr === 'object' && curr !== null && part in curr) {
      curr = (curr as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return curr;
}

export async function runConfigGetCommand(
  key: string,
  options: ConfigCommandOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const adapters = nodeAdapters();
  const loaded = await loadConfig({
    fs: adapters.fs,
    projectDir: globals.cwd,
    globalConfigPath: globals.globalConfigPath,
  });

  const target = options.global ? loaded.global : loaded;
  const val = getByPath(target, key);

  if (val === undefined) {
    process.stderr.write(`Key "${key}" not found in ${options.global ? 'global' : 'effective'} configuration.\n`);
    return ExitCode.CONFIG_ERROR;
  }

  if (globals.json || typeof val === 'object') {
    process.stdout.write(`${JSON.stringify(val, null, 2)}\n`);
  } else {
    process.stdout.write(`${String(val)}\n`);
  }

  return ExitCode.OK;
}

export async function runConfigSetCommand(
  key: string,
  rawValue: string,
  options: ConfigCommandOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  return runConfigEditCommand(key, { kind: 'set', path: key.split('.'), value: parseConfigValue(rawValue) }, options, globals);
}

export async function runConfigUnsetCommand(
  key: string,
  options: ConfigCommandOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  return runConfigEditCommand(key, { kind: 'unset', path: key.split('.') }, options, globals);
}

async function runConfigEditCommand(
  key: string,
  operation: ConfigEditOperation,
  options: ConfigCommandOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const configPath = options.global
    ? globals.globalConfigPath
    : `${globals.cwd}/.agent-flow/config.yaml`;
  const adapters = nodeAdapters();
  const editor = createConfigEditor({
    fs: adapters.fs,
    codec: new YamlConfigSourceCodec(),
    semanticValidator: new SchemaConfigSemanticValidator(),
    globalConfigPath: globals.globalConfigPath,
    resolveProjectDir: (projectId) => projectId === 'current' ? globals.cwd : undefined,
  });
  const target: ConfigTarget = options.global ? { scope: 'global' } : { scope: 'project', projectId: 'current' };
  try {
    // `describe` supplies the exact source revision. Validation and apply are the
    // same Module calls used by HTTP; the CLI owns only argument/output translation.
    const view = await editor.describe(target);
    const validation = await editor.validate({ target, operations: [operation] });
    if (!validation.valid) return writeConfigFailure(validation.diagnostics, globals.json);

    const result = await editor.apply({ target, operations: [operation], expectedRevision: view.revision });
    if (result.status === 'invalid') return writeConfigFailure(result.validation.diagnostics, globals.json);
    if (result.status === 'conflict') {
      process.stderr.write(globals.json
        ? `${JSON.stringify({ error: 'revision_conflict', revision: result.view.revision })}\n`
        : 'Configuration changed while it was being saved; retry the command.\n');
      return ExitCode.CONFIG_ERROR;
    }

    process.stdout.write(`${operation.kind === 'unset' ? 'Inherited' : 'Updated'} ${key} in ${configPath}\n`);
    return ExitCode.OK;
  } catch (error) {
    const message = error instanceof ConfigEditorTargetError
      ? error.message
      : 'The configuration could not be read or saved.';
    process.stderr.write(globals.json
      ? `${JSON.stringify({ error: 'config_error', message })}\n`
      : `${message}\n`);
    return ExitCode.CONFIG_ERROR;
  }
}

export async function runConfigListCommand(
  options: ConfigCommandOptions,
  globals: GlobalOptions,
): Promise<ExitCodeValue> {
  const adapters = nodeAdapters();
  const loaded = await loadConfig({
    fs: adapters.fs,
    projectDir: globals.cwd,
    globalConfigPath: globals.globalConfigPath,
  });

  const target = options.global ? loaded.global : loaded;
  if (globals.json) {
    process.stdout.write(`${JSON.stringify(target, null, 2)}\n`);
  } else {
    process.stdout.write(stringifyYaml(target));
  }

  return ExitCode.OK;
}

function parseConfigValue(rawValue: string): unknown {
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  if (!Number.isNaN(Number(rawValue)) && rawValue.trim() !== '') return Number(rawValue);
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function writeConfigFailure(diagnostics: readonly ConfigDiagnostic[], json: boolean): ExitCodeValue {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: 'config_invalid', diagnostics })}\n`);
  } else {
    for (const diagnostic of diagnostics) {
      const path = diagnostic.path.length === 0 ? 'configuration' : diagnostic.path.join('.');
      process.stderr.write(`${path}: ${diagnostic.message}\n`);
    }
  }
  return ExitCode.CONFIG_ERROR;
}
