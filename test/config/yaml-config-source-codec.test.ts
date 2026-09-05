import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YamlConfigSourceCodec } from '../../src/adapters/config/yaml-config-source-codec.js';
import { ConfigSourceCodecError } from '../../src/ports/config-source-codec.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'config', name), 'utf8');

describe('YamlConfigSourceCodec', () => {
  const codec = new YamlConfigSourceCodec();

  it('preserves comments, ordering and unknown nodes while editing a known field', () => {
    const document = codec.parse(fixture('preserved.yaml'));
    expect(document.unknownPaths).toEqual(['plugin.privateToken']);

    document.set(['parallelism', 'maxTasks'], 2);
    const rendered = document.toString();
    expect(rendered).toContain('# operator note');
    expect(rendered).toContain('plugin:\n  privateToken: do-not-disclose');
    expect(rendered.indexOf('runners:')).toBeLessThan(rendered.indexOf('parallelism:'));
    expect(document.data).toMatchObject({ parallelism: { maxTasks: 2 } });
  });

  it.each([
    ['alias', 'unsupported-alias.yaml'],
    ['custom_tag', 'unsupported-tag.yaml'],
  ] as const)('rejects an unsupported %s without producing a candidate', (code, name) => {
    expect(() => codec.parse(fixture(name))).toThrowError(ConfigSourceCodecError);
    try {
      codec.parse(fixture(name));
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });

  it('rejects malformed YAML and non-mapping roots with distinct diagnostics', () => {
    expect(() => codec.parse('runners: [broken\n')).toThrowError(
      expect.objectContaining({ code: 'syntax' }),
    );
    expect(() => codec.parse('- one\n- two\n')).toThrowError(
      expect.objectContaining({ code: 'root_not_mapping' }),
    );
  });
});
