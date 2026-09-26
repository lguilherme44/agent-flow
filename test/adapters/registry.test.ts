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

/** A project that grants its executor nothing: every construction below except the grant tests. */
const NO_GRANTS = { commandGrants: [] };

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
    const registry = buildRegistry(config(), deps(), NO_GRANTS);
    expect(registry.ids()).toEqual(['claude']);
    expect(registry.get('claude').id).toBe('claude');
  });

  it('works with exactly one runner — the alpha requirement (C-4)', () => {
    // The whole alpha checkpoint runs on a machine that never installed a
    // second CLI. Nothing here may assume two.
    const registry = buildRegistry(config(), deps(), NO_GRANTS);
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
      NO_GRANTS,
    );

    expect(registry.ids()).toEqual(['claude']);
    expect(() => registry.get('codex')).toThrowError(RegistryError);
  });

  it('rejects an unknown adapter type with the supported list', () => {
    try {
      buildRegistry(config({ runners: { weird: { type: 'telepathy' } } }), deps(), NO_GRANTS);
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
      NO_GRANTS,
    );
    expect(registry.get('claude')).toBeDefined();
  });
});

describe('validation happens at load, not mid-run (R-05)', () => {
  it('accepts a configuration where every role has a registered runner', () => {
    const registry = buildRegistry(config(), deps(), NO_GRANTS);
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
    const registry = buildRegistry(config(), deps(), NO_GRANTS);

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
    const registry = buildRegistry(config(), deps(), NO_GRANTS);

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
    const registry = buildRegistry(cfg, deps(), NO_GRANTS);
    expect(() => registry.validateRoles(cfg)).toThrowError(RegistryError);
  });
});

describe('registry feeds the role resolver', () => {
  it('supplies capabilities so roles resolve without touching an adapter', () => {
    // core/role.ts must never import a runner. It reasons over capabilities.
    const cfg = config();
    const registry = buildRegistry(cfg, deps(), NO_GRANTS);

    const resolved = resolveRole('finalReviewer', cfg, registry.capabilities());

    expect(resolved.runner).toBe('claude');
    expect(resolved.reasoning).toBe('very_high');
    expect(resolved.reasoningClamped).toBe(false);
    expect(resolved.structuredOutputStrategy).toBe('native');
  });

  it('lets a read-only stage resolve against a runner that supports it', () => {
    const cfg = config();
    const registry = buildRegistry(cfg, deps(), NO_GRANTS);
    expect(() => resolveRole('sdd', cfg, registry.capabilities(), { readOnly: true })).not.toThrow();
  });
});

describe('health', () => {
  it('collects health for every registered runner', async () => {
    const registry = buildRegistry(
      config(),
      deps(proc().always({ exitCode: 0, stdout: '2.1.226 (Claude Code)' })),
      NO_GRANTS,
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
      NO_GRANTS,
    );

    const health = await registry.health();
    expect(health['claude']?.installed).toBe(false);
    expect(health['claude']?.executable).toBe(false);
  });
});

describe('execution.passEnv reaches the adapters (PRI-17)', () => {
  it('hands every CLI adapter what the operator declared', async () => {
    // The wiring test, not the policy test — `core/process-environment.ts` decides what
    // the list *means*, and this asserts the list arrives at all. It is the kind of thing
    // that typechecks while doing nothing: `envPass` is optional at every hop, so an
    // adapter that dropped it would compile, pass its own tests, and quietly give the
    // operator's declared variable to nobody.
    const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: 'ok' });

    const registry = buildRegistry(
      config({
        execution: { passEnv: ['ACME_'] },
        runners: {
          claude: { type: 'claude-code-cli', enabled: true },
          codex: { type: 'codex-cli', enabled: true },
          agy: { type: 'agy-cli', enabled: true },
        },
      }),
      { processRunner, fs: new InMemoryFileSystem() },
      NO_GRANTS,
    );

    for (const id of ['claude', 'codex', 'agy']) {
      processRunner.calls.length = 0;

      await registry.get(id).run({
        prompt: 'hello',
        reasoning: 'low',
        workingDirectory: '/repo',
        permissions: 'read-only',
        timeoutSeconds: 30,
      });

      const spawned = processRunner.calls.at(-1);
      expect(spawned?.envPass, `${id} dropped execution.passEnv`).toEqual(['ACME_']);
      // And it never asks to inherit: that is reserved for Git and for the operator's own
      // validation commands, both of which say why at their call site.
      expect(spawned?.envMode, `${id} asked to inherit the whole environment`).toBeUndefined();
    }
  });
});

describe('command grants reach the adapter that can spell them (FR-008)', () => {
  const write = {
    prompt: 'hello',
    reasoning: 'low',
    workingDirectory: '/repo',
    permissions: 'write',
    timeoutSeconds: 30,
  } as const;

  const threeRunners = () => config({
    runners: {
      claude: { type: 'claude-code-cli', enabled: true },
      codex: { type: 'codex-cli', enabled: true },
      agy: { type: 'agy-cli', enabled: true },
    },
  });

  it('requires the grants argument, so a forgotten call site does not compile', () => {
    // The assertion is the directive: `npm run typecheck` fails if the call below compiles.
    // @ts-expect-error — `buildRegistry` takes the project's grants as a required third argument.
    const forgotten = () => buildRegistry(config(), deps());
    expect(forgotten).toBeTypeOf('function');
  });

  it('hands the grants and the platform to the claude adapter', async () => {
    const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: 'ok' });
    const registry = buildRegistry(
      threeRunners(),
      { processRunner, fs: new InMemoryFileSystem(), platform: 'win32' },
      { commandGrants: ['npm run lint'] },
    );

    await registry.get('claude').run(write);
    const args = processRunner.calls.at(-1)?.args ?? [];
    const bash = args.indexOf('Bash(npm run lint:*)');
    expect(bash).toBeGreaterThan(0);
    expect(args[bash + 1]).toBe('PowerShell(npm run lint:*)');
  });

  it('leaves the argv of every other adapter as it was (FR-002)', async () => {
    const processRunner = new FakeProcessRunner().always({ exitCode: 0, stdout: 'ok' });
    const argvOf = async (grants: readonly string[], id: string) => {
      processRunner.calls.length = 0;
      const registry = buildRegistry(threeRunners(), { processRunner, fs: new InMemoryFileSystem() }, { commandGrants: grants });
      await registry.get(id).run(write);
      return processRunner.calls.at(-1)?.args;
    };

    for (const id of ['codex', 'agy']) {
      expect(await argvOf(['npm run lint'], id), id).toEqual(await argvOf([], id));
    }
    // Positive control: the same comparison on the adapter that does read them differs.
    expect(await argvOf(['npm run lint'], 'claude')).not.toEqual(await argvOf([], 'claude'));
  });

  it('reports prefixes only from the adapter that parses its grants (FR-007)', () => {
    const registry = buildRegistry(
      config({
        runners: {
          claude: { type: 'claude-code-cli', enabled: true },
          codex: { type: 'codex-cli', enabled: true },
          agy: { type: 'agy-cli', enabled: true },
          local: { type: 'openai-compatible', enabled: true, baseUrl: 'http://127.0.0.1:8080/v1' },
        },
      }),
      deps(),
      { commandGrants: ['npm run lint'] },
    );
    const grantsOf = (id: string) => registry.get(id).capabilities().nonInteractiveToolGrants;

    for (const id of ['codex', 'agy', 'local']) {
      expect(grantsOf(id).grantedCommandPrefixes, id).toBeUndefined();
      expect(grantsOf(id).grantsAnyCommand, id).toBeUndefined();
    }
    expect(grantsOf('claude').grantedCommandPrefixes).toEqual(['npm run lint']);
  });
});
