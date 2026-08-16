import { describe, it, expect } from 'vitest';
import { resolveRole, resolveFallback, RoleResolutionError } from '../../src/core/role.js';
import { GlobalConfigSchema, type GlobalConfig, type RunnerCapabilitiesMap } from '../../src/core/role.js';

const fullCapabilities = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
} as const;

const capabilities: RunnerCapabilitiesMap = { claude: fullCapabilities };

function config(overrides: Record<string, unknown> = {}): GlobalConfig {
  return GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli', enabled: false } },
    roles: {
      architect: { runner: 'claude', effort: 'very_high' },
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

describe('resolveRole', () => {
  it('resolves every role the spec defines', () => {
    const roles = [
      'architect',
      'sdd',
      'planner',
      'planReviewer',
      'executor.trivial',
      'executor.normal',
      'executor.complex',
      'verification',
      'finalReviewer',
    ] as const;

    for (const role of roles) {
      const resolved = resolveRole(role, config(), capabilities);
      expect(resolved.runner, role).toBe('claude');
    }
  });

  it('flattens the nested executor config into a logical role', () => {
    // The YAML nests executors for readability; the core speaks in flat roles.
    expect(resolveRole('executor.complex', config(), capabilities).reasoning).toBe('high');
    expect(resolveRole('executor.trivial', config(), capabilities).reasoning).toBe('low');
  });

  it('omits the model when none is configured (AD-13)', () => {
    expect(resolveRole('sdd', config(), capabilities).model).toBeUndefined();
  });

  it('carries the timeout so no runner can hang forever (R-11)', () => {
    expect(resolveRole('sdd', config(), capabilities).timeoutSeconds).toBe(900);
  });
});

describe('configuration errors surface at resolution, not at run time (R-05)', () => {
  it('rejects a role pointing at an unknown runner', () => {
    const broken = config({
      roles: { ...config().roles, sdd: { runner: 'ghost', effort: 'high', timeoutSeconds: 900 } },
    });

    expect(() => resolveRole('sdd', broken, capabilities)).toThrowError(RoleResolutionError);
    try {
      resolveRole('sdd', broken, capabilities);
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('unknown_runner');
      expect((error as Error).message).toContain('ghost');
      expect((error as Error).message).toContain('sdd');
    }

    const noRunnersConfig = {
      ...config(),
      runners: {},
    };
    try {
      resolveRole('sdd', noRunnersConfig, {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('(none)');
    }
  });

  it('rejects a role pointing at a disabled runner', () => {
    const broken = config({
      roles: { ...config().roles, sdd: { runner: 'codex', effort: 'high', timeoutSeconds: 900 } },
    });
    try {
      resolveRole('sdd', broken, { ...capabilities, codex: fullCapabilities });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('runner_disabled');
    }
  });

  it('rejects a runner that cannot run non-interactively', () => {
    // Without this the orchestrator would hang on a prompt no one can answer.
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportsNonInteractive: false },
    };
    try {
      resolveRole('sdd', config(), caps);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('missing_capability');
    }
  });

  it('rejects a runner that cannot be pointed at a working directory', () => {
    // agent-flow always runs an agent against a specific repository. A runner
    // that ignores cwd would silently operate on whatever directory it pleased.
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportsWorkingDirectory: false },
    };
    try {
      resolveRole('sdd', config(), caps);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('missing_capability');
      expect((error as Error).message).toMatch(/working directory/i);
    }
  });

  it('rejects a read-only stage on a runner with no read-only mode', () => {
    // Discovery, SDD and planning must not be able to write (§35). If the
    // runner cannot promise that, the answer is to stop, not to hope.
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportsReadOnly: false },
    };
    try {
      resolveRole('sdd', config(), caps, { readOnly: true });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('missing_capability');
      expect((error as Error).message).toMatch(/read-only/i);
    }
  });

  it('allows a write stage on the same runner', () => {
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportsReadOnly: false },
    };
    expect(() => resolveRole('executor.normal', config(), caps, { readOnly: false })).not.toThrow();
  });

  it('does not treat a missing capability as a reason to fall back (§55)', () => {
    // Fallback is for infrastructure failures. A capability gap is a mistake in
    // the user's configuration and has to stay visible.
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportsNonInteractive: false },
    };
    try {
      resolveRole('sdd', config(), caps);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).fallbackEligible).toBe(false);
    }
  });

  it('rejects a runner with no capability entry at all', () => {
    try {
      resolveRole('sdd', config(), {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('unknown_runner');
    }
  });
});

describe('reasoning clamping during resolution (R-15)', () => {
  it('lowers the level and flags it when the runner cannot go that high', () => {
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportedReasoningLevels: ['low', 'medium', 'high'] },
    };

    const resolved = resolveRole('architect', config(), caps);
    expect(resolved.reasoning).toBe('high');
    expect(resolved.reasoningClamped).toBe(true);
  });

  it('leaves reasoning alone when the runner supports the request', () => {
    const resolved = resolveRole('architect', config(), capabilities);
    expect(resolved.reasoning).toBe('very_high');
    expect(resolved.reasoningClamped).toBe(false);
  });
});

describe('structured output requirement', () => {
  it('reports the strategy so a stage can decide about a repair loop', () => {
    // Not an error when it is `prompted` — the stage compensates by validating
    // and re-prompting. It is an error only if the stage demanded `native`.
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, structuredOutputStrategy: 'prompted' },
    };
    const resolved = resolveRole('planner', config(), caps);
    expect(resolved.structuredOutputStrategy).toBe('prompted');
  });

  it('fails when a stage requires native enforcement and the runner cannot', () => {
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, structuredOutputStrategy: 'prompted' },
    };
    try {
      resolveRole('planner', config(), caps, { nativeStructuredOutput: true });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('missing_capability');
    }
  });
});

describe('resolveFallback', () => {
  const fallbackConfig = (role: string, runner: string): GlobalConfig =>
    GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
      roles: {
        architect: { runner: 'claude', effort: 'very_high' },
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
      fallback: { enabled: true, roles: { [role]: { runner, effort: 'medium' } } },
    });

  const codexCaps: RunnerCapabilitiesMap = { codex: fullCapabilities };

  it('resolves a declared, usable fallback as its own configuration', () => {
    const resolved = resolveFallback(
      'verification',
      fallbackConfig('verification', 'codex'),
      codexCaps,
    );
    expect(resolved).not.toBeUndefined();
    expect(resolved?.runner).toBe('codex');
  });

  it('returns undefined when fallback is disabled or not configured for the role', () => {
    expect(
      resolveFallback('sdd', GlobalConfigSchema.parse({ runners: {}, roles: fallbackConfig('sdd', 'codex').roles, fallback: { enabled: false } }), codexCaps),
    ).toBeUndefined();
    // A role absent from fallback.roles has no fallback.
    const noEntry = GlobalConfigSchema.parse({
      runners: { codex: { type: 'codex-cli' } },
      roles: fallbackConfig('sdd', 'codex').roles,
      fallback: { enabled: true, roles: {} },
    });
    expect(resolveFallback('sdd', noEntry, codexCaps)).toBeUndefined();
  });

  it('returns undefined when the fallback runner is disabled or unknown', () => {
    const disabled = GlobalConfigSchema.parse({
      runners: { codex: { type: 'codex-cli', enabled: false } },
      roles: fallbackConfig('sdd', 'codex').roles,
      fallback: { enabled: true, roles: { sdd: { runner: 'codex', effort: 'medium' } } },
    });
    expect(resolveFallback('sdd', disabled, codexCaps)).toBeUndefined();

    const unknown = GlobalConfigSchema.parse({
      runners: {},
      roles: fallbackConfig('sdd', 'ghost').roles,
      fallback: { enabled: true, roles: { sdd: { runner: 'ghost', effort: 'medium' } } },
    });
    expect(resolveFallback('sdd', unknown, {})).toBeUndefined();
  });

  it('returns undefined when the fallback cannot satisfy the stage requirement', () => {
    // A fallback that cannot offer what the stage demands is no fallback, and
    // quietly using it would break the guarantee the requirement expresses
    // (§55): a read-only stage has to stay read-only even when the primary
    // runner is down.
    const caps: RunnerCapabilitiesMap = {
      codex: { ...fullCapabilities, supportsNonInteractive: false },
    };
    expect(resolveFallback('sdd', fallbackConfig('sdd', 'codex'), caps)).toBeUndefined();

    const noCwd: RunnerCapabilitiesMap = {
      codex: { ...fullCapabilities, supportsWorkingDirectory: false },
    };
    expect(resolveFallback('sdd', fallbackConfig('sdd', 'codex'), noCwd)).toBeUndefined();

    const noReadOnly: RunnerCapabilitiesMap = {
      codex: { ...fullCapabilities, supportsReadOnly: false },
    };
    expect(resolveFallback('sdd', fallbackConfig('sdd', 'codex'), noReadOnly, { readOnly: true }))
      .toBeUndefined();

    const prompted: RunnerCapabilitiesMap = {
      codex: { ...fullCapabilities, structuredOutputStrategy: 'prompted' },
    };
    expect(
      resolveFallback('planner', fallbackConfig('planner', 'codex'), prompted, {
        nativeStructuredOutput: true,
      }),
    ).toBeUndefined();
  });

  it('clamps fallback reasoning to what the fallback runner supports', () => {
    const caps: RunnerCapabilitiesMap = {
      codex: { ...fullCapabilities, supportedReasoningLevels: ['low', 'medium', 'high'] },
    };
    const requested = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
      roles: fallbackConfig('architect', 'codex').roles,
      fallback: {
        enabled: true,
        roles: { architect: { runner: 'codex', effort: 'very_high' } },
      },
    });
    const resolved = resolveFallback('architect', requested, caps);
    expect(resolved?.reasoning).toBe('high');
    expect(resolved?.reasoningClamped).toBe(true);
  });
});
