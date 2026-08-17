import { describe, it, expect } from 'vitest';
import type { ReasoningLevel } from '../../src/contracts/index.js';
import {
  renderCapabilityReport,
  unresolvableRoles,
  type CapabilityObservation,
} from '../../src/cli/doctor.js';

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
      expect(unresolvableRoles([unresolvable(), observation()])).toEqual(['sdd']);
      expect(unresolvableRoles([observation()])).toEqual([]);
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
