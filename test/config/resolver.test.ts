import { describe, expect, it } from 'vitest';
import {
  PROJECT_OWN_KEYS,
  PROJECT_OVERRIDABLE_KEYS,
  resolveConfigSources,
} from '../../src/config/resolver.js';

describe('resolveConfigSources', () => {
  it('resolves nested project overrides without dropping inherited siblings', () => {
    const resolved = resolveConfigSources({
      defaults: {
        roles: {
          planner: { runner: 'claude', effort: 'medium' },
          architect: { runner: 'claude', effort: 'high' },
        },
      },
      global: { roles: { planner: { effort: 'high' } } },
      project: {
        project: { name: 'demo', type: 'node' },
        roles: { planner: { runner: 'local' } },
      },
    });

    expect(resolved.effectiveGlobal).toMatchObject({
      roles: {
        planner: { runner: 'local', effort: 'high' },
        architect: { runner: 'claude', effort: 'high' },
      },
    });
    expect(resolved.originOf('roles.planner.runner')).toBe('project');
    expect(resolved.originOf('roles.planner.effort')).toBe('global');
    expect(resolved.originOf('roles.architect.runner')).toBe('default');
  });

  it('ignores global-only project values but retains project-owned values', () => {
    const resolved = resolveConfigSources({
      defaults: { ui: { workspaceDepth: 2 } },
      global: { ui: { workspaceDepth: 4 } },
      project: {
        project: { name: 'demo', type: 'node' },
        ui: { workspaceDepth: 6 },
      },
    });

    expect(resolved.effectiveGlobal).toEqual({ ui: { workspaceDepth: 4 } });
    expect(resolved.originOf('ui.workspaceDepth')).toBe('global');
    expect(resolved.originOf('project.name')).toBe('project');
    expect(PROJECT_OVERRIDABLE_KEYS).toContain('roles');
    expect(PROJECT_OWN_KEYS).toContain('project');
  });
});
