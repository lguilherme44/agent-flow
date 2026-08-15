import { stringify as stringifyYaml, parseDocument } from 'yaml';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ExitCode, type ExitCodeValue } from './exit-codes.js';
import type { GlobalOptions } from './index.js';
import { loadConfig } from '../config/loader.js';
import { nodeAdapters } from './adapters.js';

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

function setByPath(doc: ReturnType<typeof parseDocument>, path: string, value: unknown): void {
  const parts = path.split('.');
  doc.setIn(parts, value);
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
  const configPath = options.global
    ? globals.globalConfigPath
    : `${globals.cwd}/.agent-flow/config.yaml`;

  let parsedValue: unknown = rawValue;
  if (rawValue === 'true') parsedValue = true;
  else if (rawValue === 'false') parsedValue = false;
  else if (!Number.isNaN(Number(rawValue)) && rawValue.trim() !== '') parsedValue = Number(rawValue);
  else {
    try {
      parsedValue = JSON.parse(rawValue);
    } catch {
      parsedValue = rawValue;
    }
  }

  let content = '';
  try {
    content = await readFile(configPath, 'utf8');
  } catch {
    content = '';
  }

  const doc = parseDocument(content || '{}');
  setByPath(doc, key, parsedValue);

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, String(doc), 'utf8');

  process.stdout.write(`Updated ${key} in ${configPath}\n`);
  return ExitCode.OK;
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
