import { isMap, parseDocument, visit, type Document } from 'yaml';
import { isKnownConfigPath, isKnownConfigPathPrefix } from '../../config/config-fields.js';
import {
  ConfigSourceCodecError,
  type ConfigPath,
  type ConfigSourceCodec,
  type ConfigSourceDocument,
} from '../../ports/config-source-codec.js';

export class YamlConfigSourceCodec implements ConfigSourceCodec {
  parse(source: string): ConfigSourceDocument {
    const document = parseDocument(source.trim() === '' ? '{}' : source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });

    let hasAlias = false;
    let hasCustomTag = false;
    visit(document, {
      Alias: () => { hasAlias = true; },
      Node: (_key, node) => {
        if (node.tag?.startsWith('!') && !node.tag.startsWith('tag:yaml.org,2002:')) hasCustomTag = true;
      },
    });

    if (hasAlias) throw new ConfigSourceCodecError('alias', 'YAML aliases are not supported.');
    if (hasCustomTag) throw new ConfigSourceCodecError('custom_tag', 'Custom YAML tags are not supported.');
    if (document.errors.length > 0) throw new ConfigSourceCodecError('syntax', document.errors[0]?.message ?? 'Invalid YAML.');
    if (!isMap(document.contents)) throw new ConfigSourceCodecError('root_not_mapping', 'Expected a YAML mapping at the top level.');
    return new YamlConfigSourceDocument(document);
  }
}

class YamlConfigSourceDocument implements ConfigSourceDocument {
  constructor(private readonly document: Document) {}

  get data(): Record<string, unknown> {
    return this.document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  }

  get unknownPaths(): readonly string[] {
    const paths: string[] = [];
    collectUnknown(this.data, [], paths);
    return paths.sort();
  }

  set(path: ConfigPath, value: unknown): void {
    this.document.setIn([...path], value);
  }

  unset(path: ConfigPath): void {
    this.document.deleteIn([...path]);
  }

  toString(): string {
    return String(this.document);
  }
}

function collectUnknown(value: unknown, path: string[], output: string[]): void {
  if (Array.isArray(value)) {
    if (isKnownConfigPath(path)) return;
    value.forEach((entry, index) => collectUnknown(entry, [...path, String(index)], output));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    if (!isKnownConfigPath(path)) output.push(path.join('.'));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (isKnownConfigPathPrefix(childPath) || isKnownConfigPath(childPath)) collectUnknown(child, childPath, output);
    else collectAllLeaves(child, childPath, output);
  }
}

function collectAllLeaves(value: unknown, path: string[], output: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) output.push(path.join('.'));
    else value.forEach((entry, index) => collectAllLeaves(entry, [...path, String(index)], output));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) output.push(path.join('.'));
    else entries.forEach(([key, child]) => collectAllLeaves(child, [...path, key], output));
    return;
  }
  output.push(path.join('.'));
}
