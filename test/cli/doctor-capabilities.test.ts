import { describe, it, expect } from 'vitest';
import type { ReasoningLevel } from '../../src/contracts/index.js';
import { renderCapabilityReport, renderVerdict } from '../../src/cli/doctor.js';
import { observeCapabilities, rolesThatCannotRun, type CapabilityObservation } from '../../src/app/diagnostics.js';
import type { RoleRoute } from '../../src/app/role-routes.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';

/** The mark the report uses for something that cannot work, as opposed to a warning. */
const CROSS_MARK = '✗';
import { probeRunner, PROBE_PROMPT, TOOL_USE_PROBE_PROMPT } from '../../src/app/runner-probe.js';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import type { RunnerCapabilities } from '../../src/ports/index.js';

/**
 * AR-01's `doctor` half.
 *
 * Two distinct duties, and conflating them is what made the evidence run's first failure
 * invisible. **Capability discovery is mechanical and free**: it reads what the resolved
 * (runner, model) pair declares and compares it with what the roles ask for, spending
 * nothing. **A live probe costs quota**, stays behind the flag it already had, and is now
 * asked a harder question — because `probeRunner` used `cheapestReasoning` and would
 * therefore never have exercised the `medium` that actually broke.
 */

const CAPS: RunnerCapabilities = {
  supportedReasoningLevels: ['low', 'medium', 'high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'prompted',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
};

type ResolvedObservation = Extract<CapabilityObservation, { kind: 'resolved' }>;

const observation = (overrides: Partial<ResolvedObservation> = {}): CapabilityObservation => ({
  kind: 'resolved',
  role: 'executor.normal',
  runner: 'agy',
  model: 'gemini-3.1-pro-high',
  requestedReasoning: 'medium',
  effectiveReasoning: 'low',
  supportedReasoningLevels: ['low', 'high'],
  reasoningClamped: true,
  permissions: 'write',
  ...overrides,
});

describe("a write role's command grants (FR-021)", () => {
  it('lists the prefixes the role may run under the role', () => {
    const lines = renderCapabilityReport([
      observation({ commandGrants: { any: false, prefixes: ['npm run lint', 'npm run typecheck:deck'] } }),
    ]);
    const role = lines.findIndex((line) => line.includes('executor.normal'));
    const grants = lines.findIndex((line) => line.includes('may run: npm run lint, npm run typecheck:deck'));

    expect(grants).toBeGreaterThan(role);
    expect(role).toBeGreaterThanOrEqual(0);
  });

  it('says the role may run any command, and lists nothing beside it', () => {
    const lines = renderCapabilityReport([
      observation({ commandGrants: { any: true, prefixes: ['npm run lint'] } }),
    ]).join('\n');

    expect(lines).toContain('may run any command');
    expect(lines).not.toContain('may run: ');
  });

  it('prints nothing when the runner reports no grant, or reports an empty one', () => {
    // The control for both lines above: the same observation without the field.
    for (const lines of [
      renderCapabilityReport([observation()]).join('\n'),
      renderCapabilityReport([observation({ commandGrants: { any: false, prefixes: [] } })]).join('\n'),
    ]) {
      expect(lines).not.toContain('may run');
    }
  });
});

describe('mechanical capability discovery (AR-01)', () => {
  it('names the requested effort, the effective one and the supported set', () => {
    const lines = renderCapabilityReport([observation()]).join('\n');

    expect(lines).toContain('executor.normal');
    expect(lines).toContain('agy');
    expect(lines).toContain('gemini-3.1-pro-high');
    expect(lines).toContain('medium');
    expect(lines).toContain('low');
    expect(lines).toContain('high');
  });

  it('says the effort will be clamped, before anything has run', () => {
    // This is the whole point of the section: the AF-2026-002 configuration was visibly
    // wrong on disk, and nothing looked at it until an attempt had been spent.
    const lines = renderCapabilityReport([observation()]).join('\n');
    expect(lines).toMatch(/clamp/i);
  });

  it('says nothing about clamping when the pair offers what the role asks for', () => {
    const lines = renderCapabilityReport([
      observation({
        model: 'gemini-3.7-flash-medium',
        effectiveReasoning: 'medium',
        supportedReasoningLevels: ['low', 'medium', 'high'],
        reasoningClamped: false,
      }),
    ]).join('\n');

    expect(lines).not.toMatch(/clamp/i);
  });

  it('warns when a write stage’s runner cannot execute commands (C-04)', () => {
    const lines = renderCapabilityReport([
      observation({
        reasoningClamped: false,
        effectiveReasoning: 'medium',
        supportedReasoningLevels: ['low', 'medium', 'high'],
        permissionFinding: {
          failureClass: 'permission_not_ready',
          runner: 'agy',
          model: 'gemini-3.1-pro-high',
          toolClass: 'commandExecution',
          action: 'Grant non-interactive command execution to "agy"',
        },
      }),
    ]).join('\n');

    expect(lines).toMatch(/permission_not_ready/);
    expect(lines).toContain('commandExecution');
    // The specific grant needed, not a generic "check your permissions".
    expect(lines).toContain('Grant non-interactive command execution');
  });

  /**
   * The hole AR-01 left, found by pointing a read-only role at a runner with no read-only
   * mode: the role vanished from the report and `doctor` still said OK.
   *
   * `assessHealth` reports a role with nowhere to run only when the *runner* is unusable —
   * not installed, not authenticated. A **capability** gap is a different fault: the runner
   * is perfectly healthy and simply cannot do what this role's prompts require. Nothing
   * looked at that, so the most complete configuration error the tool can detect was the
   * one it rendered as silence.
   */
  describe('a role that cannot resolve at all', () => {
    const unresolvable = (): CapabilityObservation => ({
      kind: 'unresolvable',
      role: 'sdd',
      runner: 'agy',
      requestedReasoning: 'high',
      errorKind: 'missing_capability',
      reason: 'Role "sdd" must run read-only, but runner "agy" offers no read-only mode.',
    });

    it('is reported rather than skipped', () => {
      const lines = renderCapabilityReport([unresolvable()]).join('\n');

      expect(lines).toContain('sdd');
      expect(lines).toContain('agy');
      expect(lines).toMatch(/read-only/);
    });

    it('is marked as a failure, not as a warning', () => {
      // The distinction that matters: a missing tool grant is a warning because execution
      // proceeds. A role that cannot resolve means the run dies at that stage, every time.
      const lines = renderCapabilityReport([unresolvable()]).join('\n');
      expect(lines).toContain(CROSS_MARK);
    });

    it('is counted, so the command can refuse instead of printing OK', () => {
      expect(rolesThatCannotRun([unresolvable(), observation()])).toEqual(['sdd']);
      expect(rolesThatCannotRun([observation()])).toEqual([]);
    });
  });

  it('is a warning: nothing in the report claims the environment is unusable', () => {
    const lines = renderCapabilityReport([
      observation({
        permissionFinding: {
          failureClass: 'permission_not_ready',
          runner: 'agy',
          toolClass: 'commandExecution',
          action: 'Grant non-interactive command execution to "agy"',
        },
      }),
    ]).join('\n');

    expect(lines).not.toMatch(/\bFAIL\b/);
  });
});

describe('the live probe stays opt-in and gets harder (AR-01)', () => {
  it('asks the cheapest question once when no efforts are named', async () => {
    // Backward compatible by construction: the existing call site passes no efforts and
    // gets exactly the probe it had.
    const runner = new FakeAgentRunner('agy', CAPS);
    await probeRunner(runner, { workingDirectory: '/repo' });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.prompt).toBe(PROBE_PROMPT);
    expect(runner.calls[0]?.reasoning).toBe('low');
  });

  it('exercises every configured effort, which cheapestReasoning never would', async () => {
    const runner = new FakeAgentRunner('agy', CAPS);

    await probeRunner(runner, {
      workingDirectory: '/repo',
      efforts: ['low', 'medium', 'high'] satisfies ReasoningLevel[],
    });

    expect(runner.calls.map((call) => call.reasoning)).toEqual(['low', 'medium', 'high']);
  });

  it('reports which effort failed, rather than collapsing to one verdict', async () => {
    const runner = new FakeAgentRunner('agy', CAPS);
    runner.push({ ok: true, text: 'ok', durationMs: 1 });
    runner.push({ ok: false, errorCode: 'execution_failed', raw: 'unsupported effort', durationMs: 1 });
    runner.push({ ok: true, text: 'ok', durationMs: 1 });

    const result = await probeRunner(runner, {
      workingDirectory: '/repo',
      efforts: ['low', 'medium', 'high'],
    });

    expect(result.efforts).toEqual([
      { reasoning: 'low', outcome: 'healthy' },
      { reasoning: 'medium', outcome: 'execution_failed', detail: 'unsupported effort' },
      { reasoning: 'high', outcome: 'healthy' },
    ]);
    expect(result.outcome).toBe('execution_failed');
  });

  it('runs the tool-use probe read-only, and only when asked', async () => {
    // "Minimal, read-only, and no automatic permission escalation." The probe asks the
    // agent to read; it never asks for write permission, and it never passes a
    // skip-permissions flag — that flag is the containment AD-14 assigns to the runner.
    const runner = new FakeAgentRunner('agy', CAPS);

    await probeRunner(runner, { workingDirectory: '/repo', toolUse: true });

    const toolCall = runner.calls.find((call) => call.prompt === TOOL_USE_PROBE_PROMPT);
    expect(toolCall).toBeDefined();
    expect(toolCall?.permissions).toBe('read-only');
    expect(runner.calls.every((call) => call.permissions === 'read-only')).toBe(true);
  });

  it('turns a denied tool into an actionable finding rather than a generic failure', async () => {
    const runner = new FakeAgentRunner('agy', CAPS);
    runner.push({ ok: true, text: 'ok', durationMs: 1 });
    runner.push({
      ok: false,
      errorCode: 'execution_failed',
      raw: 'soft-denying tool confirmation "Bash"\npermission check failed',
      durationMs: 1,
    });

    const result = await probeRunner(runner, { workingDirectory: '/repo', toolUse: true });

    expect(result.toolUse?.outcome).toBe('execution_failed');
    expect(result.toolUse?.detail).toContain('soft-denying');
  });

  it('does not run the tool-use probe by default', async () => {
    const runner = new FakeAgentRunner('agy', CAPS);
    const result = await probeRunner(runner, { workingDirectory: '/repo' });

    expect(runner.calls.some((call) => call.prompt === TOOL_USE_PROBE_PROMPT)).toBe(false);
    expect(result.toolUse).toBeUndefined();
  });
});


describe('the verdict says what it means (§95)', () => {
  it('qualifies OK when something was not checked, and leaves it bare when nothing was', () => {
    // Measured on a live run: `doctor` printed `OK` with authentication unverified for
    // every runner. `OK` is the last line and the one a person acts on, and the run they
    // started from it would have died on its first model call.
    //
    // `assessHealth` refuses to call this DEGRADED on purpose — a shallow check never
    // probes auth, so it would be true on every healthy machine. The status stays; the
    // sentence stops overstating it.
    const unverified = renderVerdict({ status: 'OK', notes: ['authentication not verified for: claude'] });
    expect(unverified).toContain('OK');
    expect(unverified).toMatch(/see the note above/);

    const clean = renderVerdict({ status: 'OK', notes: [] });
    expect(clean).toBe('OK');
  });
});

describe("a role's turn ceiling (maxTurns)", () => {
  const route = (maxTurns: number | undefined): RoleRoute => ({
    role: 'architect',
    prompts: ['discovery'],
    requirements: { readOnly: true },
    configured: {
      runner: 'claude',
      reasoning: 'high',
      timeoutSeconds: 900,
      ...(maxTurns === undefined ? {} : { maxTurns }),
    },
    resolved: { runner: 'claude', reasoning: 'high', reasoningClamped: false, structuredOutput: 'prompted' },
  });
  const observed = (maxTurns: number | undefined, supportsMaxTurns: boolean | undefined) =>
    observeCapabilities([route(maxTurns)], {
      claude: { ...CAPS, ...(supportsMaxTurns === undefined ? {} : { supportsMaxTurns }) },
    });

  it('prints the ceiling under the role when its runner enforces it', () => {
    const lines = renderCapabilityReport(observed(40, true));
    const role = lines.findIndex((line) => line.includes('architect'));
    const ceiling = lines.findIndex((line) => line.includes('max turns: 40'));

    expect(role).toBeGreaterThanOrEqual(0);
    expect(ceiling).toBeGreaterThan(role);
    expect(lines.join('\n')).not.toContain('does not enforce');
  });

  it('warns when the runner does not enforce one, and when it never said', () => {
    for (const supports of [false, undefined]) {
      const text = renderCapabilityReport(observed(40, supports)).join('\n');
      expect(text, String(supports)).toContain('⚠ maxTurns is 40, but runner "claude" does not enforce a turn ceiling');
      expect(text, String(supports)).not.toContain('max turns: 40');
    }
  });

  it('says nothing about turns when the role sets no ceiling', () => {
    const [only] = observed(undefined, true);
    expect(only).not.toHaveProperty('turnCeilings');
    expect(renderCapabilityReport([only as CapabilityObservation]).join('\n')).not.toMatch(/max ?turns/i);
  });
});

describe('turn ceilings beyond the role line: stages and the fallback', () => {
  const ENFORCES = { ...CAPS, supportsMaxTurns: true };
  const IGNORES = { ...CAPS, supportsMaxTurns: false };
  const caps = { claude: ENFORCES, local: IGNORES, codex: IGNORES };

  const config = (architect: Record<string, unknown>, fallback: Record<string, unknown> = {}) =>
    GlobalConfigSchema.parse({
      runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
      roles: {
        architect: { runner: 'claude', effort: 'high', ...architect },
        sdd: { runner: 'claude', effort: 'high' },
        planner: { runner: 'claude', effort: 'high' },
        planReviewer: { runner: 'claude', effort: 'high' },
        executors: {
          trivial: { runner: 'claude', effort: 'low' },
          normal: { runner: 'claude', effort: 'high' },
          complex: { runner: 'claude', effort: 'high' },
        },
        verification: { runner: 'claude', effort: 'medium' },
        finalReviewer: { runner: 'claude', effort: 'high' },
      },
      fallback: { enabled: true, roles: fallback },
    });

  const route = (maxTurns: number | undefined, fallbackRunner?: string): RoleRoute => ({
    role: 'architect',
    prompts: ['discovery'],
    requirements: { readOnly: true },
    configured: { runner: 'claude', reasoning: 'high', timeoutSeconds: 900, ...(maxTurns === undefined ? {} : { maxTurns }) },
    resolved: { runner: 'claude', reasoning: 'high', reasoningClamped: false, structuredOutput: 'prompted' },
    ...(fallbackRunner === undefined
      ? {}
      : { fallback: { runner: fallbackRunner, reasoning: 'high', reasoningClamped: false, structuredOutput: 'prompted' } }),
  });

  it("prints a stage override's own ceiling", () => {
    const text = renderCapabilityReport(
      observeCapabilities([route(60)], caps, config({ maxTurns: 60, stages: { discovery: { maxTurns: 20 } } })),
    ).join('\n');
    expect(text).toContain('max turns: 60');
    expect(text).toContain('max turns: 20 (stage discovery)');
  });

  it('warns when a stage is sent to a runner that does not enforce the ceiling', () => {
    const text = renderCapabilityReport(
      observeCapabilities([route(60)], caps, config({ maxTurns: 60, stages: { 'architecture-impact': { runner: 'local' } } })),
    ).join('\n');
    expect(text).toContain('max turns: 60');
    expect(text).toContain('⚠ maxTurns is 60 (stage architecture-impact), but runner "local" does not enforce a turn ceiling');
  });

  it("warns when the primary's ceiling carries over to a fallback that ignores it", () => {
    const text = renderCapabilityReport(
      observeCapabilities([route(60, 'codex')], caps, config({ maxTurns: 60 }, { architect: { runner: 'codex', effort: 'high' } })),
    ).join('\n');
    expect(text).toContain('⚠ maxTurns is 60 (fallback), but runner "codex" does not enforce a turn ceiling');
  });

  it("prints the fallback's own ceiling when it declares one and its runner enforces it", () => {
    const text = renderCapabilityReport(
      observeCapabilities(
        [route(60, 'claude')],
        caps,
        config({ maxTurns: 60 }, { architect: { runner: 'claude', effort: 'high', maxTurns: 15 } }),
      ),
    ).join('\n');
    expect(text).toContain('max turns: 15 (fallback)');
  });

  it('adds nothing for a stage override that changes neither the ceiling nor the runner', () => {
    const [only] = observeCapabilities([route(60)], caps, config({ maxTurns: 60, stages: { discovery: { effort: 'low' } } }));
    expect((only as Extract<CapabilityObservation, { kind: 'resolved' }>).turnCeilings).toEqual([
      { scope: 'role', runner: 'claude', maxTurns: 60, enforced: true },
    ]);
  });
});

describe("the fallback line shows the ceiling that carries over for each stage", () => {
  const caps = { claude: { ...CAPS, supportsMaxTurns: true }, codex: { ...CAPS, supportsMaxTurns: true } };
  const config = GlobalConfigSchema.parse({
    runners: { claude: { type: 'claude-code-cli' }, codex: { type: 'codex-cli' } },
    roles: {
      architect: { runner: 'claude', effort: 'high' },
      sdd: { runner: 'claude', effort: 'high' },
      planner: { runner: 'claude', effort: 'high' },
      planReviewer: { runner: 'claude', effort: 'high' },
      executors: {
        trivial: { runner: 'claude', effort: 'low' },
        normal: { runner: 'claude', effort: 'high', maxTurns: 60, stages: { implementation: { maxTurns: 30 } } },
        complex: { runner: 'claude', effort: 'high' },
      },
      verification: { runner: 'claude', effort: 'medium' },
      finalReviewer: { runner: 'claude', effort: 'high' },
    },
    fallback: { enabled: true, roles: { 'executor.normal': { runner: 'codex', effort: 'high', maxTurns: 45 } } },
  });
  const route: RoleRoute = {
    role: 'executor.normal',
    prompts: ['implementation'],
    requirements: {},
    configured: { runner: 'claude', reasoning: 'high', timeoutSeconds: 900, maxTurns: 60 },
    resolved: { runner: 'claude', reasoning: 'high', reasoningClamped: false, structuredOutput: 'prompted' },
    fallback: { runner: 'codex', reasoning: 'high', reasoningClamped: false, structuredOutput: 'prompted' },
  };

  it('prints min(fallback, primary) for the role and for the stage with a lower ceiling', () => {
    const text = renderCapabilityReport(observeCapabilities([route], caps, config)).join('\n');
    expect(text).toContain('max turns: 45 (fallback)');
    expect(text).toContain('max turns: 30 (fallback, stage implementation)');
    expect(text).not.toContain('max turns: 45 (fallback, stage implementation)');
  });
});
