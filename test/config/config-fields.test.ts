import { describe, expect, it } from 'vitest';
import { REASONING_ORDER } from '../../src/contracts/common.schema.js';
import { FORGE_PROVIDERS } from '../../src/contracts/forge.schema.js';
import { QUALITY_CATEGORIES } from '../../src/contracts/review.schema.js';
import { UTILITY_MODEL_ADAPTERS } from '../../src/contracts/utility-model-config.schema.js';
import { configFieldAt, configFieldCatalog } from '../../src/config/config-fields.js';

describe('config field catalog', () => {
  it('describes dynamic runner and role leaves in both scopes', () => {
    expect(configFieldAt(['runners', 'moe', 'contextWindow'], 'project')).toMatchObject({
      section: 'runners',
      valueType: 'integer',
      editable: true,
      effect: 'next_execution_context',
    });
    expect(configFieldAt(['roles', 'executors', 'normal', 'effort'], 'project')).toMatchObject({
      section: 'roles',
      valueType: 'reasoning_level',
      editable: true,
    });
  });

  it('locks machine-owned fields in project scope with an explicit reason', () => {
    expect(configFieldAt(['ui', 'workspaceDepth'], 'project')).toMatchObject({
      editable: false,
      reason: 'global_only',
      effect: 'server_restart',
    });
    expect(configFieldAt(['project', 'name'], 'global')).toBeUndefined();
    expect(configFieldAt(['project', 'name'], 'project')).toMatchObject({
      editable: true,
      section: 'project',
    });
  });

  it('carries the accepted values of every closed field, from the schema that owns them', () => {
    expect(configFieldAt(['forge', 'provider'], 'global')).toMatchObject({ valueType: 'enum', options: FORGE_PROVIDERS });
    expect(configFieldAt(['utilityModel', 'adapter'], 'global')).toMatchObject({ options: UTILITY_MODEL_ADAPTERS });
    expect(configFieldAt(['quality', 'gates', 'test', 'category'], 'global')).toMatchObject({ options: QUALITY_CATEGORIES });
    expect(configFieldAt(['roles', 'planner', 'effort'], 'global')).toMatchObject({ valueType: 'reasoning_level', options: REASONING_ORDER });
    // An open field must not carry a list: a select over four of the infinite model names
    // a runner accepts would be a lie the browser cannot detect.
    expect(configFieldAt(['roles', 'planner', 'model'], 'global')?.options).toBeUndefined();
  });

  it('leaves no closed field without its values', () => {
    const closed = configFieldCatalog.filter(({ valueType }) => valueType === 'enum' || valueType === 'reasoning_level');
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.filter(({ options }) => options === undefined || options.length === 0)).toEqual([]);
  });

  it('contains no duplicate path patterns', () => {
    const patterns = configFieldCatalog.map((field) => field.path.join('.'));
    expect(new Set(patterns).size).toBe(patterns.length);
    expect(patterns.length).toBeGreaterThan(40);
  });
});
