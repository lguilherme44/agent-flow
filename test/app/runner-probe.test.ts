import { describe, it, expect } from 'vitest';
import { FakeAgentRunner } from '../fakes/fake-agent-runner.js';
import { PROBE_PROMPT, probeRunner } from '../../src/app/runner-probe.js';
import { assessHealth, withProbeEvidence, type ObservedRunner } from '../../src/core/health.js';
import { GlobalConfigSchema } from '../../src/contracts/index.js';

/**
 * AF-H04 — `doctor --deep` actually probes.
 *
 * The flag existed, parsed, and printed that live probing was not implemented.
 * The shallow check's own note tells the reader to use `--deep` "to check for
 * real", so the gap was not cosmetic: authentication was the one thing the cheap
 * path deliberately could not answer, and the expensive path did not answer it
 * either.
 */

const CAPS = {
  supportedReasoningLevels: ['medium', 'high'],
  supportsReadOnly: true,
  supportsNonInteractive: true,
  supportsWorkingDirectory: true,
  structuredOutputStrategy: 'native',
  nonInteractiveToolGrants: { fileEdit: true, commandExecution: true },
} as const;

describe('probeRunner asks the cheapest real question', () => {
  it('reports healthy when the runner answers', async () => {
    const runner = new FakeAgentRunner('any', CAPS).pushText('ok');

    const result = await probeRunner(runner, { workingDirectory: '/repo' });

    expect(result).toMatchObject({ id: 'any', outcome: 'healthy' });
  });

  it('never lets a probe write', async () => {
    // A health check has no business being allowed to change the repository.
    const runner = new FakeAgentRunner('any', CAPS).pushText('ok');

    await probeRunner(runner, { workingDirectory: '/repo' });

    expect(runner.lastCall?.permissions).toBe('read-only');
    expect(runner.lastCall?.prompt).toBe(PROBE_PROMPT);
  });

  it('spends the least effort the runner supports', async () => {
    // Paying for reasoning to answer "ok" would spend the quota this exists to
    // protect. `low` is not offered here, so `medium` is the floor.
    const runner = new FakeAgentRunner('any', CAPS).pushText('ok');

    await probeRunner(runner, { workingDirectory: '/repo' });

    expect(runner.lastCall?.reasoning).toBe('medium');
  });

  it('bounds itself in time', async () => {
    const runner = new FakeAgentRunner('any', CAPS).pushText('ok');

    await probeRunner(runner, { workingDirectory: '/repo', timeoutSeconds: 12 });

    expect(runner.lastCall?.timeoutSeconds).toBe(12);
  });

  it('does not judge what the runner said', async () => {
    // Only that it answered. Grading the reply would turn output quality into
    // an environment verdict, which is exactly the confusion §55 forbids.
    const runner = new FakeAgentRunner('any', CAPS).pushText('I am afraid I cannot do that');

    expect((await probeRunner(runner, { workingDirectory: '/repo' })).outcome).toBe('healthy');
  });

  it.each([
    ['auth_required', 'auth_required'],
    ['quota_exceeded', 'quota_exceeded'],
    ['runner_unavailable', 'runner_unavailable'],
  ] as const)('keeps %s as its own outcome', async (errorCode, outcome) => {
    const runner = new FakeAgentRunner('any', CAPS).pushFailure(errorCode);

    expect((await probeRunner(runner, { workingDirectory: '/repo' })).outcome).toBe(outcome);
  });

  it.each(['timeout', 'invalid_output', 'execution_failed', 'blocked'] as const)(
    'collapses %s into execution_failed',
    async (errorCode) => {
      // The runner was there and authenticated; this call did not work out.
      const runner = new FakeAgentRunner('any', CAPS).pushFailure(errorCode);

      expect((await probeRunner(runner, { workingDirectory: '/repo' })).outcome).toBe(
        'execution_failed',
      );
    },
  );

  it('carries the runner’s own message, never a credential', async () => {
    const runner = new FakeAgentRunner('any', CAPS).pushFailure('auth_required', 'not logged in');

    expect((await probeRunner(runner, { workingDirectory: '/repo' })).detail).toBe('not logged in');
  });
});

describe('probe evidence reaches the verdict', () => {
  const config = () =>
    GlobalConfigSchema.parse({
      runners: { alpha: { type: 'claude-code-cli' }, beta: { type: 'codex-cli' } },
      roles: {
        architect: { runner: 'alpha', effort: 'high' },
        sdd: { runner: 'alpha', effort: 'high' },
        planner: { runner: 'beta', effort: 'high' },
        planReviewer: { runner: 'alpha', effort: 'high' },
        executors: {
          trivial: { runner: 'beta', effort: 'low' },
          normal: { runner: 'beta', effort: 'medium' },
          complex: { runner: 'beta', effort: 'high' },
        },
        verification: { runner: 'beta', effort: 'medium' },
        finalReviewer: { runner: 'alpha', effort: 'very_high' },
      },
    });

  const unverified: ObservedRunner[] = [
    { id: 'alpha', installed: true, executable: true, auth: 'unknown' },
    { id: 'beta', installed: true, executable: true, auth: 'unknown' },
  ];

  it('turns an unverified runner into a verified one', () => {
    const observed = withProbeEvidence(unverified, [{ id: 'alpha', outcome: 'healthy' }]);

    expect(observed.find((r) => r.id === 'alpha')?.auth).toBe('available');
    expect(observed.find((r) => r.id === 'beta')?.auth).toBe('unknown');
  });

  it('fails the environment when credentials are genuinely missing', () => {
    // The whole point of paying for the probe: the shallow check treats
    // `unknown` as usable, so a runner with no credentials looked fine.
    const observed = withProbeEvidence(unverified, [{ id: 'beta', outcome: 'auth_required' }]);
    const verdict = assessHealth(config(), observed);

    expect(verdict.status).toBe('FAIL');
    expect(verdict.orphanRoles).toContain('planner');
  });

  it('marks a runner that could not be started as not executable', () => {
    const observed = withProbeEvidence(unverified, [
      { id: 'beta', outcome: 'runner_unavailable' },
    ]);

    expect(observed.find((r) => r.id === 'beta')?.executable).toBe(false);
  });

  it('treats a spent quota as working credentials, not a broken environment', () => {
    // A billing window is not a property of this machine, and failing on it
    // would make `doctor --strict` flap in CI over something self-resolving.
    const observed = withProbeEvidence(unverified, [{ id: 'beta', outcome: 'quota_exceeded' }]);

    expect(observed.find((r) => r.id === 'beta')?.auth).toBe('available');
    expect(assessHealth(config(), observed).status).toBe('OK');
  });

  it('changes nothing on a failed call', () => {
    // A bad answer is not a broken runner. Treating output quality as an
    // infrastructure fault is the confusion the fallback policy exists to stop.
    const observed = withProbeEvidence(unverified, [
      { id: 'beta', outcome: 'execution_failed' },
    ]);

    expect(observed).toEqual(unverified);
  });

  it('leaves runners nobody probed exactly as they were', () => {
    expect(withProbeEvidence(unverified, [])).toEqual(unverified);
  });
});
