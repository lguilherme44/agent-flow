import { describe, it, expect } from 'vitest';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { FallbackRunner, type FallbackEvent } from '../../src/adapters/runners/fallback-runner.js';
import type { AgentRunInput } from '../../src/ports/index.js';
import { RUNNER_ERROR_CODES } from '../../src/contracts/index.js';
import type { ResolvedAgentConfig } from '../../src/core/role.js';

/** The fallback role's own resolved configuration, as the factory supplies it. */
const secondaryConfig: ResolvedAgentConfig = {
  role: 'executor.normal',
  runner: 'codex',
  reasoning: 'very_high',
  reasoningClamped: false,
  requestedReasoning: 'very_high',
  supportedReasoningLevels: ['low', 'medium', 'high', 'very_high'],
  timeoutSeconds: 900,
  structuredOutputStrategy: 'native',
};

const input: AgentRunInput = {
  prompt: 'do the thing',
  reasoning: 'very_high',
  workingDirectory: '/repo',
  permissions: 'read-only',
  timeoutSeconds: 900,
};

function pair(options: { primaryUnhealthy?: boolean } = {}) {
  const primary = new FakeAgentRunner('claude');
  const secondary = new FakeAgentRunner('codex');
  const events: FallbackEvent[] = [];

  const runner = new FallbackRunner({
    primary,
    secondary,
    secondaryConfig,
    ...(options.primaryUnhealthy === undefined
      ? {}
      : { primaryUnhealthy: options.primaryUnhealthy }),
    onFallback: (event) => {
      events.push(event);
    },
  });

  return { runner, primary, secondary, events };
}

describe('failures a fallback may act on (§55)', () => {
  for (const code of ['quota_exceeded', 'auth_required', 'runner_unavailable'] as const) {
    it(`routes to the secondary on ${code}`, async () => {
      const { runner, primary, secondary } = pair();
      primary.pushFailure(code);
      secondary.pushText('done');

      const result = await runner.run(input);

      expect(result.ok).toBe(true);
      expect(secondary.calls).toHaveLength(1);
    });
  }

  it('records what was replaced and why', async () => {
    const { runner, primary, secondary, events } = pair();
    primary.pushFailure('quota_exceeded');
    secondary.pushText('done');

    await runner.run(input);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from: 'claude',
      to: 'codex',
      errorCode: 'quota_exceeded',
      reasoningClamped: false,
    });
    // The replacement's own configuration travels with the event, so a result
    // file can say what actually ran.
    expect(events[0]?.config.runner).toBe('codex');
  });
});

describe('failures a fallback must NOT act on (§55)', () => {
  // The rule that makes fallback safe. Routing a quality problem to another
  // model replaces a visible failure with a quiet one — which is the whole
  // reason this list is enforced by the type rather than by convention.
  const FORBIDDEN = RUNNER_ERROR_CODES.filter(
    (code) => !['quota_exceeded', 'auth_required', 'runner_unavailable'].includes(code),
  );

  it('covers every remaining error code', () => {
    expect([...FORBIDDEN].sort()).toEqual(
      ['timeout', 'execution_failed', 'invalid_output', 'blocked'].sort(),
    );
  });

  for (const code of FORBIDDEN) {
    it(`surfaces ${code} instead of trying the secondary`, async () => {
      const { runner, primary, secondary } = pair();
      primary.pushFailure(code);
      secondary.pushText('should never be reached');

      const result = await runner.run(input);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorCode).toBe(code);
      expect(secondary.calls).toHaveLength(0);
    });
  }

  it('reports no fallback event for a quality failure', async () => {
    const { runner, primary, events } = pair();
    primary.pushFailure('invalid_output');

    await runner.run(input);
    expect(events).toEqual([]);
  });
});

describe('success path', () => {
  it('does not involve the secondary when the primary succeeds', async () => {
    const { runner, primary, secondary } = pair();
    primary.pushText('done');

    const result = await runner.run(input);

    expect(result.ok && result.text).toBe('done');
    expect(secondary.calls).toHaveLength(0);
  });
});

describe('there is no fallback of the fallback', () => {
  it('surfaces the secondary failure rather than looking further', async () => {
    // One attempt, then a visible failure. Chaining would turn an outage into
    // an unbounded search across providers.
    const { runner, primary, secondary } = pair();
    primary.pushFailure('quota_exceeded');
    secondary.pushFailure('quota_exceeded');

    const result = await runner.run(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('quota_exceeded');
    expect(secondary.calls).toHaveLength(1);
  });

  it('still reports which runner the failure came from (AF-R04)', async () => {
    // A substitution that also failed is still a substitution. Without this,
    // an outage across both providers was recorded against the primary alone,
    // and the fallback left no trace of having fired at all.
    const { runner, primary, secondary } = pair();
    primary.pushFailure('quota_exceeded');
    secondary.pushFailure('runner_unavailable');

    const result = await runner.run(input);

    expect(result.provenance?.runner).toBe('codex');
    expect(result.provenance?.substitutedFor).toEqual({
      runner: 'claude',
      errorCode: 'quota_exceeded',
    });
  });
});

describe('known-unhealthy primary (AD-16)', () => {
  it('skips the primary entirely', async () => {
    // Health was already established. Spending a doomed call per task to
    // rediscover it is waste the user pays for.
    const { runner, primary, secondary } = pair({ primaryUnhealthy: true });
    secondary.pushText('done');

    const result = await runner.run(input);

    expect(primary.calls).toHaveLength(0);
    expect(secondary.calls).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it('still reports the substitution', async () => {
    const { runner, secondary, events } = pair({ primaryUnhealthy: true });
    secondary.pushText('done');

    await runner.run(input);
    expect(events[0]?.errorCode).toBe('runner_unavailable');
  });
});

describe('reasoning clamping on the replacement (R-15)', () => {
  it('lowers the level when the secondary cannot reach it, and says so', async () => {
    const primary = new FakeAgentRunner('claude');
    const secondary = new FakeAgentRunner('codex', {
      supportedReasoningLevels: ['low', 'medium', 'high'],
      supportsReadOnly: true,
      supportsNonInteractive: true,
      supportsWorkingDirectory: true,
      structuredOutputStrategy: 'native',
      nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
    });

    const events: FallbackEvent[] = [];
    const runner = new FallbackRunner({
      primary,
      secondary,
      secondaryConfig: { ...secondaryConfig, reasoning: 'high', reasoningClamped: true },
      onFallback: (event) => {
        events.push(event);
      },
    });

    primary.pushFailure('quota_exceeded');
    secondary.pushText('done');

    await runner.run(input);

    expect(secondary.lastCall?.reasoning).toBe('high');
    expect(events[0]?.reasoningClamped).toBe(true);
  });

  it('leaves reasoning alone when the secondary supports it', async () => {
    const { runner, primary, secondary, events } = pair();
    primary.pushFailure('auth_required');
    secondary.pushText('done');

    await runner.run(input);

    expect(secondary.lastCall?.reasoning).toBe('very_high');
    expect(events[0]?.reasoningClamped).toBe(false);
  });
});

describe('transparency to the core', () => {
  it('presents the primary identity and capabilities', async () => {
    // A stage asks a runner to run. That it may be two runners underneath is
    // not something the core should have to model.
    const { runner, primary } = pair();
    expect(runner.id).toBe('claude');
    expect(runner.capabilities()).toEqual(primary.capabilities());
  });

  it('passes the input through unchanged apart from clamping', async () => {
    const { runner, primary, secondary } = pair();
    primary.pushFailure('quota_exceeded');
    secondary.pushText('done');

    await runner.run({ ...input, prompt: 'exact prompt', permissions: 'write' });

    expect(secondary.lastCall?.prompt).toBe('exact prompt');
    expect(secondary.lastCall?.permissions).toBe('write');
  });
});
