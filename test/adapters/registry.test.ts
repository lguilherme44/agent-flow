import { describe, it, expect } from 'vitest';
import { FakeProcessRunner } from '../fakes/fake-process-runner.js';
import { InMemoryFileSystem } from '../fakes/in-memory-file-system.js';
import { buildRegistry, RegistryError } from '../../src/adapters/runners/registry.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';
import { resolveRole } from '../../src/core/role.js';

const proc = () => new FakeProcessRunner();

/** Registry dependencies; some adapters write temp files, so fs is required. */
const deps = (processRunner: FakeProcessRunner = proc()) => ({
  processRunner,
  fs: new InMemoryFileSystem(),
});

function config(overrides: Record<string, unknown> = {}) {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'medium' },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'very_high' },
    },
    ...overrides,
  });
}

describe('building the registry', () => {
  it('instantiates a runner declared in configuration', () => {
    const registry = buildRegistry(config(), deps());
    expect(registry.ids()).toEqual(['claude']);
    expect(registry.get('claude').id).toBe('claude');
  });

  it('works with exactly one runner — the alpha requirement (C-4)', () => {
    // The whole alpha checkpoint runs on a machine that never installed a
    // second CLI. Nothing here may assume two.
    const registry = buildRegistry(config(), deps());
    expect(() => registry.capabilities()).not.toThrow();
    expect(Object.keys(registry.capabilities())).toEqual(['claude']);
  });

  it('skips a disabled runner entirely', () => {
    const registry = buildRegistry(
      config({
        runners: {
          claude: { type: 'claude-code-cli' },
          codex: { type: 'codex-cli', enabled: false },
        },
      }),
      deps(),
    );

    expect(registry.ids()).toEqual(['claude']);
    expect(() => registry.get('codex')).toThrowError(RegistryError);
  });

  it('rejects an unknown adapter type with the supported list', () => {
    try {
      buildRegistry(config({ runners: { weird: { type: 'telepathy' } } }), deps());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as Error).message).toContain('telepathy');
      expect((error as Error).message).toContain('claude-code-cli');
    }
  });

  it('honours a command override from configuration', () => {
    const registry = buildRegistry(
      config({ runners: { claude: { type: 'claude-code-cli', command: '/opt/claude' } } }),
      deps(),
    );
    expect(registry.get('claude')).toBeDefined();
  });
});

describe('validation happens at load, not mid-run (R-05)', () => {
  it('accepts a configuration where every role has a registered runner', () => {
    const registry = buildRegistry(config(), deps());
    expect(() => registry.validateRoles(config())).not.toThrow();
  });

  it('rejects a role pointing at a runner that was never registered', () => {
    // Discovering this halfway through a run would waste the quota already
    // spent on earlier stages.
    const broken = config({
      roles: {
        ...config().roles,
        planner: { runner: 'ghost', effort: 'high', timeoutSeconds: 900 },
      },
    });
    const registry = buildRegistry(config(), deps());

    expect(() => registry.validateRoles(broken)).toThrowError(RegistryError);
    try {
      registry.validateRoles(broken);
    } catch (error) {
      expect((error as Error).message).toContain('planner');
      expect((error as Error).message).toContain('ghost');
    }
  });

  it('reports every broken role at once, not just the first', () => {
    // Fixing configuration one error per run is a miserable loop.
    const broken = config({
      roles: {
        ...config().roles,
        planner: { runner: 'ghost', effort: 'high', timeoutSeconds: 900 },
        verification: { runner: 'phantom', effort: 'low', timeoutSeconds: 900 },
      },
    });
    const registry = buildRegistry(config(), deps());

    try {
      registry.validateRoles(broken);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('planner');
      expect((error as Error).message).toContain('verification');
    }
  });

  it('rejects a role pointing at a disabled runner', () => {
    const cfg = config({
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli', enabled: false } },
      roles: {
        ...config().roles,
        planner: { runner: 'codex', effort: 'high', timeoutSeconds: 900 },
      },
    });
    const registry = buildRegistry(cfg, deps());
    expect(() => registry.validateRoles(cfg)).toThrowError(RegistryError);
  });
});

describe('registry feeds the role resolver', () => {
  it('supplies capabilities so roles resolve without touching an adapter', () => {
    // core/role.ts must never import a runner. It reasons over capabilities.
    const cfg = config();
    const registry = buildRegistry(cfg, deps());

    const resolved = resolveRole('finalReviewer', cfg, registry.capabilities());

    expect(resolved.runner).toBe('claude');
    expect(resolved.reasoning).toBe('very_high');
    expect(resolved.reasoningClamped).toBe(false);
    expect(resolved.structuredOutputStrategy).toBe('native');
  });

  it('lets a read-only stage resolve against a runner that supports it', () => {
    const cfg = config();
    const registry = buildRegistry(cfg, deps());
    expect(() => resolveRole('sdd', cfg, registry.capabilities(), { readOnly: true })).not.toThrow();
  });
});

describe('health', () => {
  it('collects health for every registered runner', async () => {
    const registry = buildRegistry(
      config(),
      deps(proc().always({ exitCode: 0, stdout: '2.1.226 (Claude Code)' })),
    );

    const health = await registry.health();
    expect(health['claude']?.installed).toBe(true);
    expect(health['claude']?.executable).toBe(true);
  });

  it('reports installed-but-not-executable as its own state', async () => {
    // The real Codex failure: npm package present, native binary missing.
    const registry = buildRegistry(
      config(),
      deps(proc().always({ spawnFailed: true, exitCode: null, stderr: 'ENOENT' })),
    );

    const health = await registry.health();
    expect(health['claude']?.installed).toBe(false);
    expect(health['claude']?.executable).toBe(false);
  });
});
