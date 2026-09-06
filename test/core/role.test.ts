import { describe, it, expect } from 'vitest';
import {
  resolveRole,
  resolveFallback,
  permissionReadiness,
  RoleResolutionError,
} from '../../src/core/role.js';
import { GlobalConfigSchema, type GlobalConfig, type RunnerCapabilitiesMap } from '../../src/core/role.js';

const fullCapabilities = {
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
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

  /**
   * The same case as above, in the state the product actually reaches (PRI-26).
   *
   * The test above hands `codex` a capability entry. `buildRegistry` never does — it skips
   * a disabled runner entirely, so the map has no key for it. The guard used to read
   * `!runnerConfig || !runnerCapabilities`, which meant the real state took the
   * `unknown_runner` branch and the `runner_disabled` branch below it was unreachable from
   * anywhere but a test that had constructed a state the registry cannot produce.
   *
   * What reached the screen, six times at once, was self-contradictory:
   *
   *     Role "architect" is configured to use runner "claude", which is not
   *     registered. Known runners: claude, codex, agy
   *
   * Not registered, and there it is in the list — "known" was read off the declared
   * runners and "registered" off the enabled ones. The one fact the operator needed, that
   * a toggle was off, was the one the sentence did not carry.
   */
  it('says a disabled runner is turned off, not that it is unknown', () => {
    const broken = config({
      roles: { ...config().roles, sdd: { runner: 'codex', effort: 'high', timeoutSeconds: 900 } },
    });

    try {
      // No `codex` key: exactly what `buildRegistry` leaves behind for a disabled runner.
      resolveRole('sdd', broken, capabilities);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('runner_disabled');
      const message = (error as Error).message;
      expect(message).toContain('turned off');
      expect(message).toContain('runners.codex.enabled');
      // The sentence that made the screen unreadable: never say unknown about a runner
      // the same message is about to list.
      expect(message).not.toContain('not declared');
      expect(message).not.toContain('no registered adapter');
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

  it('rejects a runner with no working directory when the stage reads the repository', () => {
    // A stage that explores or edits the project needs a runner that can be pointed at
    // it; one that ignored cwd would silently operate on whatever directory it pleased.
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportsWorkingDirectory: false },
    };
    try {
      resolveRole('sdd', config(), caps, { workingDirectory: true });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as RoleResolutionError).kind).toBe('missing_capability');
      expect((error as Error).message).toMatch(/working directory/i);
    }
  });

  it('accepts a runner with no working directory when the stage needs none', () => {
    // **The control the previous rule never had.** The resolver required a working
    // directory of every runner, on the grounds that "every role requires" one — and nine
    // of the eleven shipped prompts disprove it. `sdd`, `planning`, both reviews,
    // `verification` and `final-review` receive their whole input as variables and open no
    // file, which is what makes an inference endpoint a legitimate runner for them.
    const caps: RunnerCapabilitiesMap = {
      claude: { ...fullCapabilities, supportsWorkingDirectory: false },
    };

    expect(() => resolveRole('sdd', config(), caps)).not.toThrow();
    expect(resolveRole('sdd', config(), caps).runner).toBe('claude');
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
    // Only when the stage actually reads the repository. Without that requirement the
    // fallback is perfectly usable — nine of the eleven shipped prompts open no file.
    expect(
      resolveFallback('sdd', fallbackConfig('sdd', 'codex'), noCwd, { workingDirectory: true }),
    ).toBeUndefined();
    expect(resolveFallback('sdd', fallbackConfig('sdd', 'codex'), noCwd)).toBeDefined();

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

/**
 * AD-30 and AD-31, where the capability gap becomes a resolution decision.
 *
 * The evidence run's first failure: a role configured at `medium` against a model offering
 * only `low` and `high`. `capabilities()` took no argument, so the resolver was fed the
 * *CLI's* levels, found `medium` among them, and invoked a runner with an effort the pair
 * did not support — costing a task attempt to discover it.
 *
 * The machinery to prevent that already existed. `clampReasoning`, the `reasoningClamped`
 * field and the `reasoning_clamped` degradation had never fired, because they were being
 * fed the wrong set. Feeding them the pair's set is the whole change.
 */
describe('capabilities are resolved for the (runner, model) pair (AD-30, AD-31, I-20)', () => {
  /** A runner whose answer depends on the model, as an adapter with knowledge would be. */
  const perModel: RunnerCapabilitiesMap = {
    claude: (model?: string) =>
      model === 'narrow-model'
        ? { ...fullCapabilities, supportedReasoningLevels: ['low', 'high'] }
        : fullCapabilities,
  };

  const withModel = (model: string | undefined, effort: string): GlobalConfig =>
    GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' } },
      roles: {
        architect: { runner: 'claude', effort: 'high' },
        sdd: { runner: 'claude', effort: 'high' },
        planner: { runner: 'claude', effort: 'high' },
        planReviewer: { runner: 'claude', effort: 'high' },
        executors: {
          trivial: { runner: 'claude', effort: 'low' },
          normal: { runner: 'claude', effort, ...(model === undefined ? {} : { model }) },
          complex: { runner: 'claude', effort: 'high' },
        },
        verification: { runner: 'claude', effort: 'medium' },
        finalReviewer: { runner: 'claude', effort: 'high' },
      },
    });

  it('accepts a plain record, exactly as every existing caller passes', () => {
    // Source compatibility is half of AD-30's claim. A map of records must keep working, or
    // the twenty call sites that write one inline become a migration.
    const resolved = resolveRole('executor.normal', withModel(undefined, 'medium'), capabilities);
    expect(resolved.reasoning).toBe('medium');
    expect(resolved.reasoningClamped).toBe(false);
  });

  it('clamps to the nearest level below when the model does not offer the configured one', () => {
    // The evidence run's TASK-002 attempt 1, reproduced: `medium` against a model offering
    // `low` and `high` resolves to `low`, recorded — never to `high`, which would spend
    // more of the user's quota than they asked for.
    const resolved = resolveRole(
      'executor.normal',
      withModel('narrow-model', 'medium'),
      perModel,
    );

    expect(resolved.reasoning).toBe('low');
    expect(resolved.reasoningClamped).toBe(true);
  });

  it('does not clamp the same effort when the model does offer it', () => {
    // The control: the clamp is a property of the pair, not of the effort. Same role, same
    // effort, different model, no clamp.
    const resolved = resolveRole('executor.normal', withModel('wide-model', 'medium'), perModel);

    expect(resolved.reasoning).toBe('medium');
    expect(resolved.reasoningClamped).toBe(false);
  });

  it('resolves the run rather than refusing it (AD-31)', () => {
    // Refusing would satisfy R-05 — a capability gap is a configuration error — and would
    // stop the run and demand a human, which is the behaviour this milestone exists to
    // remove. The refusal path stays for gaps clamping cannot resolve.
    expect(() =>
      resolveRole('executor.normal', withModel('narrow-model', 'medium'), perModel),
    ).not.toThrow();
  });

  it('still refuses a gap that clamping cannot resolve', () => {
    // Read-only, non-interactive, working directory and native structured output are not
    // matters of degree, so they remain configuration errors rather than clamps.
    const noReadOnly: RunnerCapabilitiesMap = {
      claude: () => ({ ...fullCapabilities, supportsReadOnly: false }),
    };

    expect(() =>
      resolveRole('sdd', withModel(undefined, 'high'), noReadOnly, { readOnly: true }),
    ).toThrow(RoleResolutionError);
  });

  it('passes the role’s own model, not another role’s', () => {
    // The bug a single shared lookup would introduce: every role resolving against
    // whichever model happened to be asked about first.
    const seen: (string | undefined)[] = [];
    const recording: RunnerCapabilitiesMap = {
      claude: (model?: string) => {
        seen.push(model);
        return fullCapabilities;
      },
    };

    resolveRole('executor.normal', withModel('narrow-model', 'medium'), recording);
    resolveRole('executor.trivial', withModel('narrow-model', 'medium'), recording);

    expect(seen).toEqual(['narrow-model', undefined]);
  });

  it('resolves a fallback against the fallback’s model, never the primary’s', () => {
    // A fallback entry is a role in its own right: it carries its own runner, model and
    // effort, and sending the primary's model to it would name a model that runner has
    // never heard of.
    const seen: (string | undefined)[] = [];
    const recording: RunnerCapabilitiesMap = {
      codex: (model?: string) => {
        seen.push(model);
        return { ...fullCapabilities, supportedReasoningLevels: ['low', 'high'] };
      },
    };

    const requested = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
      roles: withModel(undefined, 'medium').roles,
      fallback: {
        enabled: true,
        roles: { architect: { runner: 'codex', model: 'fallback-model', effort: 'medium' } },
      },
    });

    const resolved = resolveFallback('architect', requested, recording);

    expect(seen).toEqual(['fallback-model']);
    expect(resolved?.reasoning).toBe('low');
    expect(resolved?.reasoningClamped).toBe(true);
  });

  it('treats an unregistered runner the same whichever form the map takes', () => {
    const empty: RunnerCapabilitiesMap = {};
    expect(() => resolveRole('executor.normal', withModel(undefined, 'medium'), empty)).toThrow(
      RoleResolutionError,
    );
  });

  /**
   * C-03's evidence requirement, carried on the resolution rather than recomputed.
   *
   * "A `reasoning_clamped` degradation records requested, effective, supported set and
   * reason." The effective level is on the result already; the other two were thrown away
   * at the moment they were known. A caller that had to recompute them would have to reach
   * for the capabilities map a second time, and the second answer is the one that drifts.
   */
  it('carries the requested level and the supported set, so the clamp can explain itself', () => {
    const resolved = resolveRole('executor.normal', withModel('narrow-model', 'medium'), perModel);

    expect(resolved.requestedReasoning).toBe('medium');
    expect(resolved.supportedReasoningLevels).toEqual(['low', 'high']);
    expect(resolved.reasoning).toBe('low');
  });

  it('carries them identically when nothing was clamped', () => {
    // Present whether or not the clamp fired: a field that only appears on the unhappy
    // path is a field every reader has to guard.
    const resolved = resolveRole('executor.normal', withModel('wide-model', 'medium'), perModel);

    expect(resolved.requestedReasoning).toBe('medium');
    expect(resolved.reasoning).toBe('medium');
    expect(resolved.reasoningClamped).toBe(false);
  });

  it('carries them on a fallback resolution too', () => {
    const requested = GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
      roles: withModel(undefined, 'medium').roles,
      fallback: {
        enabled: true,
        roles: { architect: { runner: 'codex', model: 'fallback-model', effort: 'medium' } },
      },
    });

    const resolved = resolveFallback('architect', requested, {
      codex: () => ({ ...fullCapabilities, supportedReasoningLevels: ['low', 'high'] }),
    });

    expect(resolved?.requestedReasoning).toBe('medium');
    expect(resolved?.supportedReasoningLevels).toEqual(['low', 'high']);
  });
});

/**
 * C-04 (AR-01) — permission readiness is a capability, and a warning, never a block.
 *
 * `supportsNonInteractive: true` says the process will not stop at a prompt. It does not
 * say the agent may run the tools the work requires. One runner in the evidence run was
 * genuinely non-interactive and still failed: it asked to run a shell command, local policy
 * demanded a confirmation, nobody was present, and the run recorded `execution_failed`.
 *
 * AD-32 splits the two properties. This is the reader that turns the split into a finding
 * a person can act on — before an attempt is spent discovering it.
 */
describe('permission readiness (AD-32, C-04)', () => {
  const granted = { fileEdit: true, commandExecution: true };
  const noCommands = { fileEdit: true, commandExecution: false };

  it('produces no finding when the runner may run what a write stage needs', () => {
    expect(
      permissionReadiness({
        capabilities: { ...fullCapabilities, nonInteractiveToolGrants: granted },
        permissions: 'write',
        runner: 'claude',
        model: 'sonnet',
      }),
    ).toBeUndefined();
  });

  it('names the runner, the model and the tool class when a grant is missing', () => {
    const finding = permissionReadiness({
      capabilities: { ...fullCapabilities, nonInteractiveToolGrants: noCommands },
      permissions: 'write',
      runner: 'agy',
      model: 'gemini-3.1-pro-high',
    });

    expect(finding?.failureClass).toBe('permission_not_ready');
    expect(finding?.runner).toBe('agy');
    expect(finding?.model).toBe('gemini-3.1-pro-high');
    expect(finding?.toolClass).toBe('commandExecution');
    // "Something is not ready" is the sentence the taxonomy forbids: a finding that
    // escalates has to name the one action that resolves it.
    expect(finding?.action.length).toBeGreaterThan(0);
  });

  it('says nothing about a read-only stage, which asks for no tools', () => {
    // A stage that only observes does not need a command grant, and warning about it
    // would train the reader to ignore the warning that matters.
    expect(
      permissionReadiness({
        capabilities: { ...fullCapabilities, nonInteractiveToolGrants: noCommands },
        permissions: 'read-only',
        runner: 'agy',
      }),
    ).toBeUndefined();
  });

  it('reports a missing file-edit grant, which a write stage also needs', () => {
    const finding = permissionReadiness({
      capabilities: {
        ...fullCapabilities,
        nonInteractiveToolGrants: { fileEdit: false, commandExecution: true },
      },
      permissions: 'write',
      runner: 'codex',
    });

    expect(finding?.toolClass).toBe('fileEdit');
  });

  it('is a finding, not a refusal — resolution still succeeds (C-04)', () => {
    // "Execution is not blocked by the warning alone." A capability gap that clamping
    // cannot resolve refuses; a permission gap is a fact about the environment that a
    // person grants, and stopping the run would not help them grant it any sooner.
    const ungranted: RunnerCapabilitiesMap = {
      claude: () => ({ ...fullCapabilities, nonInteractiveToolGrants: noCommands }),
    };

    expect(() => resolveRole('executor.normal', config(), ungranted)).not.toThrow();
  });
});
