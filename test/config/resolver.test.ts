import { describe, expect, it } from 'vitest';
import {
  PROJECT_OWN_KEYS,
  PROJECT_OVERRIDABLE_KEYS,
  filterProjectLoosenings,
  isToolGrantArg,
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

  it('lets a project override worktree, and never trust (FR-012, FR-021)', () => {
    expect(PROJECT_OVERRIDABLE_KEYS).toContain('worktree');
    expect(PROJECT_OVERRIDABLE_KEYS).not.toContain('trust');
    expect(PROJECT_OWN_KEYS).not.toContain('trust');
  });

  it('replaces a global worktree.copy list whole with the project one', () => {
    const resolved = resolveConfigSources({
      defaults: { worktree: { copy: [], copyToReadOnly: false } },
      global: { worktree: { copy: ['a', 'c'] } },
      project: { project: { name: 'demo', type: 'node' }, worktree: { copy: ['b'] } },
    });

    expect(resolved.effectiveGlobal).toEqual({ worktree: { copy: ['b'], copyToReadOnly: false } });
    expect(resolved.originOf('worktree.copy')).toBe('project');
    expect(resolved.originOf('worktree.copyToReadOnly')).toBe('default');
  });

  it('keeps trust out of the overlay, so a project cannot trust itself (SEC-001)', () => {
    const resolved = resolveConfigSources({
      defaults: { trust: { projectConfig: [] } },
      global: { trust: { projectConfig: ['/home/u/wk'] } },
      project: {
        project: { name: 'demo', type: 'node' },
        trust: { projectConfig: ['/repo'] },
        // Positive control: the same project record's overridable key does apply.
        worktree: { copy: ['b'] },
      },
    });

    expect(resolved.effectiveGlobal).toMatchObject({ trust: { projectConfig: ['/home/u/wk'] }, worktree: { copy: ['b'] } });
    expect(resolved.originOf('trust.projectConfig')).toBe('global');
  });
});

describe('the project config only tightens unless trusted (N4)', () => {
  const DEFAULTS = {
    runners: { claude: { type: 'claude-code-cli', args: [], dangerouslySkipPermissions: false } },
    approval: { requiredBeforeImplementation: true },
    parallelism: { maxTasks: 1 },
  };
  const GLOBAL = { runners: { claude: { args: ['--verbose'] } } };
  const PROJECT_ID = { project: { name: 'demo', type: 'node' } };

  const resolve = (project: Record<string, unknown>, projectTrusted?: boolean) =>
    resolveConfigSources({
      defaults: DEFAULTS,
      global: GLOBAL,
      project: { ...PROJECT_ID, ...project },
      ...(projectTrusted === undefined ? {} : { projectTrusted }),
    });

  describe('each of the four loosenings is ignored when untrusted (AC-17)', () => {
    it('drops dangerouslySkipPermissions: true and keeps the default', () => {
      const resolved = resolve({ runners: { claude: { dangerouslySkipPermissions: true } } }, false);

      expect(resolved.effectiveGlobal).toMatchObject({ runners: { claude: { dangerouslySkipPermissions: false } } });
      expect(resolved.ignoredLoosenings).toEqual([
        { path: ['runners', 'claude', 'dangerouslySkipPermissions'], kind: 'skip_permissions' },
      ]);
      expect(resolved.originOf('runners.claude.dangerouslySkipPermissions')).toBe('default');
    });

    it('drops a granting args list whole and keeps the global list', () => {
      const resolved = resolve({ runners: { claude: { args: ['--allowedTools', 'Bash(x)'] } } }, false);

      expect(resolved.effectiveGlobal).toMatchObject({ runners: { claude: { args: ['--verbose'] } } });
      expect(resolved.ignoredLoosenings).toEqual([
        { path: ['runners', 'claude', 'args'], kind: 'tool_grant_args' },
      ]);
      expect(resolved.originOf('runners.claude.args')).toBe('global');
    });

    it('drops mcp, which neither the global file nor the defaults set', () => {
      const resolved = resolve({ runners: { claude: { mcp: { config: 'mcp.json', servers: ['index'] } } } }, false);
      const claude = (resolved.effectiveGlobal['runners'] as Record<string, Record<string, unknown>>)['claude'];

      expect(claude).toBeDefined();
      expect(claude).not.toHaveProperty('mcp');
      expect(resolved.ignoredLoosenings).toEqual([{ path: ['runners', 'claude', 'mcp'], kind: 'mcp' }]);
      expect(resolved.originOf('runners.claude.mcp')).toBeUndefined();
      expect(resolved.originOf('runners.claude.mcp.config')).toBeUndefined();
    });

    it('drops approval.requiredBeforeImplementation: false and keeps the default', () => {
      const resolved = resolve({ approval: { requiredBeforeImplementation: false } }, false);

      expect(resolved.effectiveGlobal).toMatchObject({ approval: { requiredBeforeImplementation: true } });
      expect(resolved.ignoredLoosenings).toEqual([
        { path: ['approval', 'requiredBeforeImplementation'], kind: 'approval' },
      ]);
      expect(resolved.originOf('approval.requiredBeforeImplementation')).toBe('default');
    });

    it('keeps the global value when the global file set the loosened key itself', () => {
      const resolved = resolveConfigSources({
        defaults: DEFAULTS,
        global: { approval: { requiredBeforeImplementation: false } },
        project: { ...PROJECT_ID, approval: { requiredBeforeImplementation: false } },
      });

      // The operator's own choice stands; only the project's attempt is reported.
      expect(resolved.effectiveGlobal).toMatchObject({ approval: { requiredBeforeImplementation: false } });
      expect(resolved.originOf('approval.requiredBeforeImplementation')).toBe('global');
      expect(resolved.ignoredLoosenings).toHaveLength(1);
    });
  });

  it('applies all four, and reports nothing, when the project is trusted (AC-18)', () => {
    const loosenings = {
      runners: {
        claude: {
          dangerouslySkipPermissions: true,
          args: ['--allowedTools', 'Bash(x)'],
          mcp: { config: 'mcp.json', servers: [] },
        },
      },
      approval: { requiredBeforeImplementation: false },
    };
    const trusted = resolve(loosenings, true);

    expect(trusted.effectiveGlobal).toMatchObject({
      runners: {
        claude: {
          dangerouslySkipPermissions: true,
          args: ['--allowedTools', 'Bash(x)'],
          mcp: { config: 'mcp.json', servers: [] },
        },
      },
      approval: { requiredBeforeImplementation: false },
    });
    expect(trusted.ignoredLoosenings).toEqual([]);
    expect(trusted.originOf('runners.claude.dangerouslySkipPermissions')).toBe('project');
    expect(trusted.originOf('runners.claude.args')).toBe('project');
    expect(trusted.originOf('runners.claude.mcp')).toBe('project');
    expect(trusted.originOf('approval.requiredBeforeImplementation')).toBe('project');

    // Positive control: the same record, untrusted, loses all four.
    expect(resolve(loosenings, false).ignoredLoosenings.map(({ kind }) => kind)).toEqual([
      'skip_permissions', 'tool_grant_args', 'mcp', 'approval',
    ]);
  });

  it('treats the project as untrusted when projectTrusted is omitted', () => {
    const resolved = resolve({ runners: { claude: { dangerouslySkipPermissions: true } } });

    expect(resolved.effectiveGlobal).toMatchObject({ runners: { claude: { dangerouslySkipPermissions: false } } });
    expect(resolved.ignoredLoosenings).toHaveLength(1);
  });

  describe('restrictions and choices apply as today (AC-19)', () => {
    const TIGHTENINGS: readonly [string, Record<string, unknown>][] = [
      ['requiredBeforeImplementation: true', { approval: { requiredBeforeImplementation: true } }],
      ['dangerouslySkipPermissions: false', { runners: { claude: { dangerouslySkipPermissions: false } } }],
      ['a grant-free args list', { runners: { claude: { args: ['--model-endpoint', 'http://127.0.0.1:1'] } } }],
      ['an empty args list', { runners: { claude: { args: [] } } }],
      ['a runner the project declares', { runners: { local: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1' } } }],
      ['a model and an effort', { roles: { planner: { runner: 'claude', model: 'm', effort: 'high' } } }],
      ['parallelism', { parallelism: { maxTasks: 3 } }],
      ['retry', { retry: { maxAttempts: 5 } }],
      ['fallback', { fallback: { enabled: false } }],
      ['language', { language: 'pt-BR' }],
      ['worktree', { worktree: { copy: ['.env.test'] } }],
    ];

    for (const [label, project] of TIGHTENINGS) {
      it(`applies ${label}`, () => {
        const untrusted = resolve(project, false);

        // "As today" is the unfiltered overlay, which is what a trusted project still gets.
        expect(untrusted.effectiveGlobal).toEqual(resolve(project, true).effectiveGlobal);
        expect(untrusted.ignoredLoosenings).toEqual([]);
        expect(untrusted.effectiveGlobal).toMatchObject(project);
      });
    }

    it('positive control: an empty args list really replaces the global one', () => {
      const resolved = resolve({ runners: { claude: { args: [] } } }, false);
      expect(resolved.effectiveGlobal).toMatchObject({ runners: { claude: { args: [] } } });
      expect(resolved.originOf('runners.claude.args')).toBe('project');
    });
  });

  it('detects each spelling of a grant token', () => {
    for (const token of ['--allowedTools', '--allowedTools=Bash(x)', '--allowed-tools', '--allowed-tools=Bash(x)', '--dangerously-skip-permissions', '--permission-mode', '--permission-mode=bypassPermissions']) {
      expect(isToolGrantArg(token), token).toBe(true);
    }
    for (const token of ['--allowedToolsX', '--disallowedTools', 'Bash(--allowedTools)', '--verbose', '']) {
      expect(isToolGrantArg(token), token).toBe(false);
    }
  });

  it('drops an args list that grants in the = form, or anywhere in the list', () => {
    for (const args of [['--allowedTools=Bash(x)'], ['--verbose', '--allowed-tools', 'Bash(x)'], ['--permission-mode=bypassPermissions']]) {
      const resolved = resolve({ runners: { claude: { args } } }, false);
      expect(resolved.effectiveGlobal, args.join(' ')).toMatchObject({ runners: { claude: { args: ['--verbose'] } } });
      expect(resolved.ignoredLoosenings).toEqual([{ path: ['runners', 'claude', 'args'], kind: 'tool_grant_args' }]);
    }
  });

  it('ignores mcp and a grant on a runner only the project declares', () => {
    const resolved = resolve({
      runners: {
        mine: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', args: ['--dangerously-skip-permissions'], mcp: { config: 'x.json' } },
      },
    }, false);
    const mine = (resolved.effectiveGlobal['runners'] as Record<string, Record<string, unknown>>)['mine'];

    // The runner itself is a choice and stays; only its loosenings go.
    expect(mine).toEqual({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1' });
    expect(resolved.ignoredLoosenings).toEqual([
      { path: ['runners', 'mine', 'args'], kind: 'tool_grant_args' },
      { path: ['runners', 'mine', 'mcp'], kind: 'mcp' },
    ]);
    expect(resolved.originOf('runners.mine.mcp')).toBeUndefined();
    expect(resolved.originOf('runners.mine.type')).toBe('project');
  });

  it('leaves the caller\'s project record untouched', () => {
    const project = {
      ...PROJECT_ID,
      runners: { claude: { dangerouslySkipPermissions: true, args: ['--allowedTools', 'Bash(x)'] } },
      approval: { requiredBeforeImplementation: false },
    };
    const before = structuredClone(project);

    const { filtered, ignored } = filterProjectLoosenings(project);

    expect(project).toEqual(before);
    expect(ignored).toHaveLength(3);
    expect(filtered).toEqual({ ...PROJECT_ID, runners: { claude: {} }, approval: {} });
  });
});

describe('a project may only lower maxTurns', () => {
  const resolve = (global: Record<string, unknown>, project: Record<string, unknown>, projectTrusted = false) =>
    resolveConfigSources({ defaults: {}, global, project, projectTrusted }).effectiveGlobal as {
      roles?: Record<string, Record<string, unknown>>;
      fallback?: { roles?: Record<string, Record<string, unknown>> };
    };

  it('lowers a global ceiling', () => {
    const roles = resolve({ roles: { architect: { maxTurns: 50 } } }, { roles: { architect: { maxTurns: 20 } } }).roles;
    expect(roles?.['architect']?.['maxTurns']).toBe(20);
  });

  it('never raises one, trusted or not', () => {
    for (const trusted of [false, true]) {
      const roles = resolve(
        { roles: { architect: { maxTurns: 50 } } },
        { roles: { architect: { maxTurns: 80, effort: 'low' } } },
        trusted,
      ).roles;
      expect(roles?.['architect']?.['maxTurns'], String(trusted)).toBe(50);
      // Only the raising value is dropped; the rest of the override still applies.
      expect(roles?.['architect']?.['effort']).toBe('low');
    }
  });

  it('sets one where the operator set none', () => {
    const roles = resolve({ roles: { architect: { effort: 'high' } } }, { roles: { architect: { maxTurns: 30 } } }).roles;
    expect(roles?.['architect']?.['maxTurns']).toBe(30);
  });

  it('applies to the nested executor tiers', () => {
    const roles = resolve(
      { roles: { executors: { normal: { maxTurns: 60 }, complex: { maxTurns: 90 } } } },
      { roles: { executors: { normal: { maxTurns: 100 }, complex: { maxTurns: 45 } } } },
    ).roles as Record<string, Record<string, Record<string, unknown>>> | undefined;
    expect(roles?.['executors']?.['normal']?.['maxTurns']).toBe(60);
    expect(roles?.['executors']?.['complex']?.['maxTurns']).toBe(45);
  });

  it('holds a stage override to the global stage value, else the global role value', () => {
    const roles = resolve(
      { roles: { architect: { maxTurns: 50, stages: { sdd: { maxTurns: 10 } } } } },
      { roles: { architect: { stages: { sdd: { maxTurns: 15 }, discovery: { maxTurns: 70, runner: 'local' } } } } },
    ).roles as Record<string, { stages?: Record<string, Record<string, unknown>> }> | undefined;
    expect(roles?.['architect']?.stages?.['sdd']?.['maxTurns']).toBe(10);
    expect(roles?.['architect']?.stages?.['discovery']?.['maxTurns']).toBeUndefined();
    expect(roles?.['architect']?.stages?.['discovery']?.['runner']).toBe('local');
  });

  it('applies to fallback roles too', () => {
    const fallback = resolve(
      { fallback: { roles: { architect: { maxTurns: 30 } } } },
      { fallback: { roles: { architect: { maxTurns: 99 } } } },
    ).fallback;
    expect(fallback?.roles?.['architect']?.['maxTurns']).toBe(30);
  });

  it('does not attribute a dropped value to the project', () => {
    const resolved = resolveConfigSources({
      defaults: {},
      global: { roles: { architect: { maxTurns: 50 } } },
      project: { roles: { architect: { maxTurns: 80 } } },
    });
    expect(resolved.originOf('roles.architect.maxTurns')).toBe('global');
  });
});

describe('maxTurns raises are reported, and closed in args and fallbacks too', () => {
  const resolved = (global: Record<string, unknown>, project: Record<string, unknown>, projectTrusted = false) =>
    resolveConfigSources({ defaults: {}, global, project, projectTrusted });

  it('reports each dropped ceiling with its path and value', () => {
    const result = resolved(
      { roles: { architect: { maxTurns: 50, stages: { sdd: { maxTurns: 10 } } } } },
      { roles: { architect: { maxTurns: 80, stages: { sdd: { maxTurns: 15 } } } } },
      true,
    );
    expect(result.ignoredLoosenings).toEqual([
      { path: ['roles', 'architect', 'maxTurns'], kind: 'max_turns', value: 80 },
      { path: ['roles', 'architect', 'stages', 'sdd', 'maxTurns'], kind: 'max_turns', value: 15 },
    ]);
  });

  it('reports nothing for a ceiling that only lowers', () => {
    const result = resolved({ roles: { architect: { maxTurns: 50 } } }, { roles: { architect: { maxTurns: 20 } } });
    expect(result.ignoredLoosenings).toEqual([]);
  });

  // Measured on claude 2.1.281 with a prompt needing two Read calls: `--max-turns 1 --max-turns 5`
  // finished with `subtype: "success"` after 3 turns, and `--max-turns 5 --max-turns 1` stopped
  // with `error_max_turns`. The last flag wins, and `RunnerConfig.args` ride after the
  // adapter's own — so a project arg would replace `roles.*.maxTurns`. Screened either way.
  it('drops --max-turns from project runner args, in both spellings, trusted or not', () => {
    for (const trusted of [false, true]) {
      const result = resolved(
        { runners: { claude: { type: 'claude-code-cli' } } },
        { runners: { claude: { args: ['--max-turns', '9999', '--verbose', '--max-turns=500'] } } },
        trusted,
      );
      const runners = result.effectiveGlobal['runners'] as Record<string, { args?: unknown[] }>;
      expect(runners['claude']?.args, String(trusted)).toEqual(['--verbose']);
      expect(result.ignoredLoosenings, String(trusted)).toEqual([
        { path: ['runners', 'claude', 'args'], kind: 'max_turns', value: '9999, 500' },
      ]);
    }
  });

  it('leaves args without the flag exactly as written', () => {
    const result = resolved({}, { runners: { claude: { args: ['--verbose'] } } }, true);
    expect((result.effectiveGlobal['runners'] as Record<string, { args?: unknown[] }>)['claude']?.args).toEqual(['--verbose']);
    expect(result.ignoredLoosenings).toEqual([]);
  });

  it('holds a fallback the operator never declared to the global primary ceiling', () => {
    const result = resolved(
      { roles: { architect: { maxTurns: 50 } } },
      { fallback: { roles: { architect: { runner: 'local', maxTurns: 1000 } } } },
    );
    const effective = result.effectiveGlobal as {
      roles: Record<string, { maxTurns?: number }>;
      fallback: { roles: Record<string, { maxTurns?: number; runner?: string }> };
    };
    // The fallback declares none, so it runs with the primary's (FallbackRunner): 50.
    expect(effective.fallback.roles['architect']?.maxTurns).toBeUndefined();
    expect(effective.fallback.roles['architect']?.runner).toBe('local');
    expect(effective.fallback.roles['architect']?.maxTurns ?? effective.roles['architect']?.maxTurns).toBe(50);
    expect(result.ignoredLoosenings).toEqual([
      { path: ['fallback', 'roles', 'architect', 'maxTurns'], kind: 'max_turns', value: 1000 },
    ]);
  });

  it('holds a fallback stage override to the primary stage ceiling', () => {
    const result = resolved(
      { roles: { executors: { normal: { maxTurns: 60, stages: { implementation: { maxTurns: 30 } } } } } },
      { fallback: { roles: { 'executor.normal': { stages: { implementation: { maxTurns: 45 } } } } } },
    );
    expect(result.ignoredLoosenings).toEqual([
      {
        path: ['fallback', 'roles', 'executor.normal', 'stages', 'implementation', 'maxTurns'],
        kind: 'max_turns',
        value: 45,
      },
    ]);
  });
});

describe("a project fallback is held to the lowest ceiling of any stage its role serves", () => {
  it('drops a fallback value above a primary stage ceiling, though below the primary role one', () => {
    const result = resolveConfigSources({
      defaults: {},
      global: { roles: { executors: { normal: { maxTurns: 60, stages: { implementation: { maxTurns: 30 } } } } } },
      project: { fallback: { roles: { 'executor.normal': { runner: 'codex', maxTurns: 45 } } } },
    });
    const fallback = (result.effectiveGlobal['fallback'] as { roles: Record<string, { maxTurns?: number }> }).roles;
    expect(fallback['executor.normal']?.maxTurns).toBeUndefined();
    expect(result.ignoredLoosenings).toEqual([
      { path: ['fallback', 'roles', 'executor.normal', 'maxTurns'], kind: 'max_turns', value: 45 },
    ]);
  });

  it('keeps one at or below every stage ceiling', () => {
    const result = resolveConfigSources({
      defaults: {},
      global: { roles: { executors: { normal: { maxTurns: 60, stages: { implementation: { maxTurns: 30 } } } } } },
      project: { fallback: { roles: { 'executor.normal': { runner: 'codex', maxTurns: 25 } } } },
    });
    const fallback = (result.effectiveGlobal['fallback'] as { roles: Record<string, { maxTurns?: number }> }).roles;
    expect(fallback['executor.normal']?.maxTurns).toBe(25);
    expect(result.ignoredLoosenings).toEqual([]);
  });
});
